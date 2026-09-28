const fs = require("fs-extra");
const path = require("path");
const crypto = require("crypto");
const { atomicWriteJson } = require("../projector/atomicWriter");
const { projectEvents } = require("../projector/appDataProjector");
const { checksumJson, checksumBuffer } = require("../core/hash");
const { safeConfigDto } = require("../core/safeConfigDto");
const { schemaForPath, mergeProjectedConfig } = require("../core/configSchema");
const { isPlaceholderMessage } = require("../diff/historyDiffEngine");

const {
  collectAttachmentRefs,
  uploadLocalAttachment,
} = require("./attachmentSync");
const { scanThemePackages } = require("./themePackageSync");
const { uploadThemeAsset } = require("../diff/themeDiffEngine");
const { scanAppData } = require("../scanner/appDataScanner");
const { messageKey } = require("../core/identity");
const {
  relativeAppDataPath,
  isHistoryPath,
  parseHistoryIdentity,
  isConfigPath,
  isAttachmentLikePath,
  isAvatarPath,
  isSafeUserAvatarUrlPath,
  parseAvatarIdentity,
  safeJoinAppData,
} = require("../utils/pathRules");

function normalizeId(value) {
  return String(value || "")
    .trim()
    .toLocaleLowerCase();
}

function normalizeUserAvatarRelativePath(value) {
  const relativePath = String(value || "")
    .trim()
    .replace(/\\/g, "/");
  if (!relativePath || !isSafeUserAvatarUrlPath(relativePath)) return null;
  return relativePath;
}

function addBootstrapAttachment(attachmentsByHash, attachment) {
  const hash = attachment && attachment.hash ? String(attachment.hash) : "";
  if (!hash) return false;
  if (!attachmentsByHash.has(hash)) {
    attachmentsByHash.set(hash, attachment);
    return true;
  }
  const existing = attachmentsByHash.get(hash) || {};
  if (attachment && attachment.relative_path) {
    const paths = new Set(existing.relative_paths || []);
    if (existing.relative_path) paths.add(existing.relative_path);
    paths.add(attachment.relative_path);
    existing.relative_paths = [...paths];
  }
  if (attachment && attachment.settings_user_avatar) {
    existing.settings_user_avatar = true;
    existing.settings_user_avatar_relative_path =
      attachment.settings_user_avatar_relative_path || attachment.relative_path;
  }
  attachmentsByHash.set(hash, existing);
  return false;
}

function mimeFromAvatarFile(buffer, filePath) {
  if (buffer && buffer.length >= 8 && buffer.readUInt32BE(0) === 0x89504e47) {
    return "image/png";
  }
  if (
    buffer &&
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    buffer &&
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return null;
}

function addBootstrapAvatar(avatarsByOwner, avatar) {
  if (!avatar || !avatar.owner_type || !avatar.owner_id) return false;
  const key = `${avatar.owner_type}:${avatar.owner_id}`;
  avatarsByOwner.set(key, avatar);
  return true;
}

async function addLocalAvatarEntity(
  config,
  relativePath,
  ownerIdentity,
  attachmentsByHash,
  avatarsByOwner,
  metadata = {}
) {
  if (!relativePath || !ownerIdentity) return;
  const filePath = safeJoinAppData(config.appDataPath, relativePath);
  const buffer = await fs.readFile(filePath).catch(() => null);
  if (!buffer) return;
  const hash = checksumBuffer(buffer);
  const ext = path.extname(filePath);
  const attachment = {
    hash,
    ext,
    filename: path.basename(filePath),
    size_bytes: buffer.length,
    relative_path: relativePath,
  };
  if (metadata.source === "settings.userAvatarUrl") {
    attachment.settings_user_avatar = true;
    attachment.settings_user_avatar_relative_path = relativePath;
  }
  addBootstrapAttachment(attachmentsByHash, attachment);
  addBootstrapAvatar(avatarsByOwner, {
    owner_type: ownerIdentity.owner_type,
    owner_id: ownerIdentity.owner_id,
    hash,
    mime_type: mimeFromAvatarFile(buffer, filePath),
    ext,
    relative_path: relativePath,
    metadata,
    operation_id: `bootstrap.avatar.${config.deviceId}.${ownerIdentity.owner_type}:${ownerIdentity.owner_id}`,
  });
}

async function addSettingsUserAvatarAttachment(
  config,
  parsedSettings,
  attachmentsByHash,
  avatarsByOwner
) {
  const relativePath = normalizeUserAvatarRelativePath(
    parsedSettings && parsedSettings.userAvatarUrl
  );
  if (!relativePath) return;
  await addLocalAvatarEntity(
    config,
    relativePath,
    { owner_type: "user", owner_id: "user_avatar" },
    attachmentsByHash,
    avatarsByOwner,
    { source: "settings.userAvatarUrl" }
  );
}
function stableMessageId(identity, message, index) {
  const contentForHash =
    typeof message.content === "string"
      ? message.content
      : JSON.stringify(message.content ?? "");
  const input = [
    identity.item_type,
    identity.item_id,
    identity.topic_id,
    index,
    message.timestamp || message.createdAt || message.time || "",
    message.role || "",
    crypto.createHash("sha256").update(contentForHash).digest("hex"),
  ].join("|");
  return `sync_${crypto
    .createHash("sha256")
    .update(input)
    .digest("hex")
    .slice(0, 24)}`;
}

async function walk(dir, visitor) {
  if (!(await fs.pathExists(dir))) return;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(fullPath, visitor);
    else await visitor(fullPath);
  }
}

function addConflict(
  conflicts,
  type,
  entityType,
  scope,
  normalizedId,
  originalIds,
  paths
) {
  const unique = [...new Set(originalIds.filter(Boolean))];
  if (unique.length <= 1) return;
  conflicts.push({
    type,
    entity_type: entityType,
    scope,
    normalized_id: normalizedId,
    original_ids: unique,
    paths: [...new Set(paths.filter(Boolean))],
    resolution_required: true,
  });
}

async function scanNormalizedIdConflicts(appDataPath) {
  const conflicts = [];
  const scopes = new Map();
  const itemScopes = new Map();
  const add = (scope, entityType, id, sourcePath) => {
    const normalized = normalizeId(id);
    if (!normalized) return;
    const key = `${entityType}:${scope}:${normalized}`;
    if (!scopes.has(key))
      scopes.set(key, { entityType, scope, normalized, ids: [], paths: [] });
    scopes.get(key).ids.push(String(id));
    scopes.get(key).paths.push(sourcePath);
  };

  for (const [dirName, entityType] of [
    ["Agents", "agent"],
    ["AgentGroups", "group"],
  ]) {
    const root = path.join(appDataPath, dirName);
    if (!(await fs.pathExists(root))) continue;
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const itemScope = `${entityType}:${entry.name}`;
      itemScopes.set(entry.name, itemScope);
      add("global", entityType, entry.name, path.join(dirName, entry.name));
      const configPath = path.join(root, entry.name, "config.json");
      if (await fs.pathExists(configPath)) {
        const cfg = await fs.readJson(configPath).catch(() => null);
        const topics = Array.isArray(cfg && cfg.topics) ? cfg.topics : [];
        for (const topic of topics) {
          if (topic && topic.id)
            add(
              itemScope,
              "topic",
              topic.id,
              path.join(dirName, entry.name, "config.json")
            );
        }
      }
    }
  }

  const userData = path.join(appDataPath, "UserData");
  if (await fs.pathExists(userData)) {
    for (const itemDir of await fs.readdir(userData, { withFileTypes: true })) {
      if (!itemDir.isDirectory() || itemDir.name === "attachments") continue;
      const topicsDir = path.join(userData, itemDir.name, "topics");
      if (!(await fs.pathExists(topicsDir))) continue;
      const itemScope =
        itemScopes.get(itemDir.name) || `userdata:${itemDir.name}`;
      for (const topicDir of await fs.readdir(topicsDir, {
        withFileTypes: true,
      })) {
        if (topicDir.isDirectory()) {
          add(
            itemScope,
            "topic",
            topicDir.name,
            path.join("UserData", itemDir.name, "topics", topicDir.name)
          );
        }
      }
    }
  }

  for (const row of scopes.values()) {
    addConflict(
      conflicts,
      "normalized_id_conflict",
      row.entityType,
      row.scope,
      row.normalized,
      row.ids,
      row.paths
    );
  }
  return conflicts;
}

async function backupAppData(config, label, logger) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const appDataParent = path.dirname(config.appDataPath);
  const appDataBackupDir = `${path.basename(config.appDataPath)}_sync_backups`;
  const backupRoot = path.join(
    appDataParent,
    appDataBackupDir,
    `${label}-${stamp}`
  );
  await fs.ensureDir(backupRoot);
  if (await fs.pathExists(config.appDataPath)) {
    await fs.copy(config.appDataPath, path.join(backupRoot, "AppData"), {
      filter: (src) => {
        const relativePath = relativeAppDataPath(config.appDataPath, src);
        if (!relativePath) return true;
        const normalized = relativePath.replace(/\\/g, "/");
        const baseName = path.basename(normalized);
        // Exclude sync/ working directory
        if (normalized === "sync" || normalized.startsWith("sync/"))
          return false;
        // Exclude databases/ — derived index rebuilt from AppData JSON, contains CDS lock files
        if (normalized === "databases" || normalized.startsWith("databases/"))
          return false;
        // Exclude temporary/backup files
        if (/\.backup-[^/]*$/i.test(baseName)) return false;
        if (/\.tmp(?:-|$)/i.test(baseName)) return false;
        if (/^(?:state|local_index)\.json\.tmp/i.test(baseName)) return false;
        return true;
      },
    });
  }
  if (logger && logger.warn)
    logger.warn("AppData backup created before bootstrap operation", {
      backupRoot,
      label,
    });
  return backupRoot;
}

async function pauseRuntimeServices(runtime, reason) {
  if (!runtime) return;
  const { logger } = runtime;
  const stopped = [];
  const stopOne = async (name, service) => {
    if (!service || typeof service.stop !== "function") return;
    try {
      await service.stop();
      stopped.push(name);
    } catch (error) {
      if (logger && logger.warn) {
        logger.warn("runtime service stop failed before bootstrap operation", {
          name,
          reason,
          error: error.message,
        });
      }
    }
  };
  await stopOne("watcher", runtime.watcher);
  await stopOne("themeWatcher", runtime.themeWatcher);
  await stopOne("pullLoop", runtime.pullLoop);
  await stopOne("offlineQueue", runtime.offlineQueue);
  runtime.runtimeServicesStarted = false;
  if (logger && logger.info) {
    logger.info("runtime services paused before bootstrap operation", {
      reason,
      stopped,
    });
  }
}

// Restart the services paused by pauseRuntimeServices() when a bootstrap
// operation aborts. index.js injects runtime.resumeRuntimeServices so this
// module never has to require("../index.js") (that would be circular and
// previously produced "startRuntimeServicesIfActive is not a function").
async function resumeRuntimeServicesAfterFailure(
  runtime,
  reason,
  originalError,
  logger
) {
  if (!runtime || runtime.runtimeServicesStarted) return;
  const resume = runtime.resumeRuntimeServices;
  if (typeof resume !== "function") {
    if (logger && logger.warn) {
      logger.warn("runtime resume hook unavailable after bootstrap failure", {
        reason,
        originalError: originalError && originalError.message,
      });
    }
    return;
  }
  try {
    await resume();
  } catch (resumeError) {
    if (logger && logger.error) {
      logger.error(
        "failed to resume runtime services after bootstrap failure",
        {
          reason,
          originalError: originalError && originalError.message,
          resumeError: resumeError.message,
        }
      );
    }
  }
}

async function persistRuntimeState(runtime, nextState) {
  if (typeof runtime.writeState === "function") {
    await runtime.writeState(nextState);
  }
  if (!runtime.state) runtime.state = {};
  Object.assign(runtime.state, nextState);
}

// Reuse a previously reserved import session (persisted in state.json) so a
// retried bootstrap_primary sends the same session_id. Center replays the
// stored result for a completed session instead of refusing the import.
async function reserveBootstrapImportSession(runtime, mode) {
  const state = runtime.state || {};
  const pending = state.bootstrap_import_session;
  if (pending && pending.mode === mode && pending.session_id) {
    return pending.session_id;
  }
  const sessionId = `bootstrap.${(runtime.config && runtime.config.deviceId) || "unknown"}.${mode}.${Date.now()}.${crypto
    .randomUUID()
    .slice(0, 8)}`;
  await persistRuntimeState(runtime, {
    ...state,
    bootstrap_import_session: {
      mode,
      session_id: sessionId,
      reserved_at: new Date().toISOString(),
    },
  });
  return sessionId;
}

async function clearBootstrapImportSession(runtime) {
  if (!runtime.state || !runtime.state.bootstrap_import_session) return;
  const nextState = { ...runtime.state };
  delete nextState.bootstrap_import_session;
  if (typeof runtime.writeState === "function") {
    await runtime.writeState(nextState);
  }
  delete runtime.state.bootstrap_import_session;
}

async function buildLocalManifest(config, options = {}) {
  const messages = [];
  const configs = [];
  const attachmentsByHash = new Map();
  const avatarsByOwner = new Map();
  const themes = [];
  const rewritten = [];
  const conflicts = await scanNormalizedIdConflicts(config.appDataPath);
  if (conflicts.length > 0 && !options.allowConflicts) {
    return {
      ok: false,
      conflicts,
      messages,
      configs,
      attachments: [...attachmentsByHash.values()],
      avatars: [...avatarsByOwner.values()],
      themes,
      rewritten,
    };
  }

  await walk(config.appDataPath, async (filePath) => {
    const relativePath = relativeAppDataPath(config.appDataPath, filePath);
    if (relativePath.startsWith("sync/")) return;
    if (isHistoryPath(relativePath)) {
      const identity = parseHistoryIdentity(relativePath, {
        appDataPath: config.appDataPath,
      });
      const history = await fs.readJson(filePath).catch(() => null);
      if (!Array.isArray(history)) return;
      let changed = false;
      history.forEach((message, index) => {
        if (isPlaceholderMessage(message, { allowMissingId: true })) return;
        if (!message.id) {
          message.id = stableMessageId(identity, message, index);
          changed = true;
        }
        messages.push({
          item_type: identity.item_type,
          item_id: identity.item_id,
          topic_id: identity.topic_id,
          id: message.id,
          local_order: index,
          message: { ...message },
          attachments: Array.isArray(message.attachments)
            ? message.attachments
            : [],
          checksum: checksumJson(message),
        });
      });
      if (changed) {
        await atomicWriteJson(filePath, history, { logger: options.logger });
        rewritten.push(relativePath);
      }
      return;
    }
    if (isConfigPath(relativePath)) {
      const parsed = await fs.readJson(filePath).catch(() => null);
      if (!parsed) return;
      const dto = safeConfigDto(relativePath, parsed, {
        profile: options.profile || "bootstrap",
        syncProfileConfig: options.syncProfileConfig,
      });
      if (
        dto.schema === "skip" ||
        dto.schema === "unsupported_config" ||
        dto.syncable === false
      ) {
        return;
      }
      const checksum = checksumJson(dto.checksum_source);
      configs.push({
        ...dto,
        checksum,
        payload: {
          ...dto,
          checksum,
        },
      });
      if (dto.schema === "settings" && dto.safe_projection_json.userAvatarUrl) {
        await addSettingsUserAvatarAttachment(
          config,
          parsed,
          attachmentsByHash,
          avatarsByOwner
        );
      }
      return;
    }

    if (isAttachmentLikePath(relativePath)) {
      const avatarIdentity = isAvatarPath(relativePath)
        ? parseAvatarIdentity(relativePath)
        : null;
      if (avatarIdentity) {
        await addLocalAvatarEntity(
          config,
          relativePath,
          avatarIdentity,
          attachmentsByHash,
          avatarsByOwner,
          { source: "appData.avatar" }
        );
        return;
      }
      const buffer = await fs.readFile(filePath).catch(() => null);
      if (!buffer) return;
      addBootstrapAttachment(attachmentsByHash, {
        hash: checksumBuffer(buffer),
        ext: path.extname(filePath),
        filename: path.basename(filePath),
        size_bytes: buffer.length,
        relative_path: relativePath,
      });
    }
  });

  for (const themePackage of await scanThemePackages(config)) {
    themes.push({
      ...themePackage.payload,
      assets: themePackage.payload.assets || [],
      operation_id: `bootstrap.theme_package.${config.deviceId}.${themePackage.theme_id}`,
    });
  }

  return {
    ok: true,
    device_id: config.deviceId,
    generated_at: new Date().toISOString(),
    messages,
    configs,
    attachments: [...attachmentsByHash.values()],
    avatars: [...avatarsByOwner.values()],
    themes,
    conflicts,
    rewritten,
  };
}

function topicKeyFromMessage(row) {
  return `${row.item_type}:${row.item_id}:${row.topic_id}`;
}

async function recordBootstrapPrimaryBaseline(
  localIndex,
  manifest,
  response,
  logger,
  config
) {
  const latestSeq = response.latest_seq || 0;
  const now = new Date().toISOString();
  let messages = 0;
  let configs = 0;
  let avatars = 0;
  let themes = 0;
  let themeAssets = 0;

  await localIndex.batchUpdate(async () => {
    for (const row of manifest.messages || []) {
      const identity = {
        item_type: row.item_type,
        item_id: row.item_id,
        topic_id: row.topic_id,
        id: row.id,
      };
      await localIndex.setMessage(messageKey(identity), {
        identity,
        topic_key: topicKeyFromMessage(row),
        last_known_checksum: row.checksum,
        local_projection_checksum: row.checksum,
        last_applied_seq: latestSeq,
        pending_operation_id: null,
        pending_action: null,
        pending_status: null,
        bootstrap_baseline: true,
        updated_at: now,
      });
      messages += 1;
    }

    for (const cfg of manifest.configs || []) {
      const relativePath = cfg.relative_path || cfg.entity_id;
      if (!relativePath) continue;
      await localIndex.setFile(relativePath, {
        kind: "config",
        checksum: cfg.checksum,
        last_known_checksum: cfg.checksum,
        local_projection_checksum: cfg.checksum,
        last_applied_seq: latestSeq,
        pending_operation_id: null,
        pending_status: null,
        snapshot_json:
          cfg.safe_projection_json ||
          (cfg.payload && cfg.payload.safe_projection_json) ||
          null,
        bootstrap_baseline: true,
        updated_at: now,
      });
      configs += 1;
    }

    for (const avatar of manifest.avatars || []) {
      const relativePath = avatar.relative_path;
      if (!relativePath) continue;
      await localIndex.setFile(relativePath, {
        kind: "avatar",
        owner_type: avatar.owner_type,
        owner_id: avatar.owner_id,
        hash: avatar.hash,
        ext: avatar.ext,
        size: avatar.size_bytes || avatar.sizeBytes || undefined,
        local_path: path.join(config.appDataPath, relativePath),
        uploaded: true,
        avatar_operation_submitted: true,
        avatar_operation_hash: avatar.hash,
        avatar_operation_id:
          avatar.operation_id ||
          `bootstrap.avatar.${config.deviceId}.${avatar.owner_type}:${avatar.owner_id}`,
        checksum_status: "verified",
        bootstrap_baseline: true,
        last_applied_seq: latestSeq,
        updated_at: now,
      });
      avatars += 1;
    }

    for (const theme of manifest.themes || []) {
      const themeId = theme.theme_id || theme.themeId;
      if (!themeId) continue;
      const manifestJson = theme.manifest || theme.manifest_json || {};
      const cssRelativePath =
        (manifestJson.css && manifestJson.css.relative_path) ||
        `styles/themes/${themeId}.css`;
      await localIndex.setFile(cssRelativePath, {
        kind: "theme_package",
        theme_id: themeId,
        checksum: theme.checksum,
        css_path: cssRelativePath,
        relative_path: cssRelativePath,
        asset_hashes: (theme.assets || [])
          .map((asset) => asset.asset_hash || asset.hash)
          .filter(Boolean),
        uploaded: true,
        bootstrap_baseline: true,
        last_applied_seq: latestSeq,
        updated_at: now,
      });
      themes += 1;
      for (const asset of theme.assets || []) {
        const assetHash = asset.asset_hash || asset.hash;
        if (!assetHash) continue;
        await localIndex.setFile(`theme_asset:${assetHash}`, {
          kind: "theme_asset",
          theme_id: themeId,
          asset_hash: assetHash,
          asset_type: asset.asset_type || asset.assetType || "wallpaper",
          slot: asset.slot || "default",
          filename: asset.filename,
          mime_type: asset.mime_type || asset.mime || null,
          size_bytes: asset.size_bytes || asset.sizeBytes || 0,
          relative_path: asset.relative_path || asset.relativePath || null,
          // Bootstrap import only records theme asset metadata in Center.
          // The actual binary must still be uploaded later via /themes/assets.
          uploaded: false,
          binary_uploaded: false,
          metadata_baseline: true,
          bootstrap_baseline: true,
          last_applied_seq: latestSeq,
          updated_at: now,
        });
        themeAssets += 1;
      }
    }
  });

  if (logger && logger.info) {
    logger.info("bootstrap primary local index baseline recorded", {
      messages,
      configs,
      avatars,
      themes,
      themeAssets,
      latestSeq,
    });
  }

  return { messages, configs, avatars, latest_seq: latestSeq };
}

async function bootstrapPrimary(runtime, options = {}) {
  const {
    config,
    centerClient,
    localIndex,
    offlineQueue,
    writeIntentLock,
    logger,
  } = runtime;
  await pauseRuntimeServices(runtime, "bootstrap_primary");
  try {
    await backupAppData(config, "bootstrap-primary", logger);
    const manifest = await buildLocalManifest(config, { logger });
    if (!manifest.ok) {
      const error = new Error("bootstrap_primary manifest validation failed");
      error.result = manifest;
      throw error;
    }

    // Keep the sync center strictly empty until /bootstrap/import runs.
    // Uploading attachment files first writes attachments/change_log rows and makes
    // bootstrap_primary fail with "center is not empty".
    //
    // The session ID is persisted before the request so a retry after a lost
    // response (or after a restart) replays the same session and Center can
    // return the completed result instead of refusing a non-empty import.
    const sessionId = await reserveBootstrapImportSession(runtime, "bootstrap_primary");
    const response = await centerClient.importBootstrap({
      ...manifest,
      mode: "bootstrap_primary",
      session_id: sessionId,
    });
    await clearBootstrapImportSession(runtime);

    const attachmentUploadErrors = [];
    for (const attachment of manifest.attachments) {
      const absolutePath = path.join(
        config.appDataPath,
        attachment.relative_path || ""
      );
      if (!attachment.relative_path || !(await fs.pathExists(absolutePath)))
        continue;
      try {
        await uploadLocalAttachment(
          attachment.relative_path,
          absolutePath,
          localIndex,
          centerClient,
          config,
          attachment.settings_user_avatar
            ? {
                avatarIdentity: { owner_type: "user", owner_id: "user_avatar" },
                avatarOperationRelativePath: attachment.relative_path,
                avatarOperationMetadata: { source: "settings.userAvatarUrl" },
              }
            : {}
        );
      } catch (error) {
        attachmentUploadErrors.push({
          relative_path: attachment.relative_path,
          error: error.message,
        });
        if (logger && logger.warn) {
          logger.warn(
            "bootstrap attachment upload failed after baseline import",
            {
              relativePath: attachment.relative_path,
              error: error.message,
            }
          );
        }
      }
    }

    const themeUploadErrors = [];
    for (const themePackage of await scanThemePackages(config)) {
      for (const asset of themePackage.assets || []) {
        if (!asset.absolute_path || !(await fs.pathExists(asset.absolute_path)))
          continue;
        try {
          await uploadThemeAsset(centerClient, themePackage, asset, config);
        } catch (error) {
          themeUploadErrors.push({
            theme_id: themePackage.theme_id,
            asset_hash: asset.asset_hash,
            relative_path: asset.relative_path,
            error: error.message,
          });
          if (logger && logger.warn) {
            logger.warn(
              "bootstrap theme asset upload failed after baseline import",
              {
                theme_id: themePackage.theme_id,
                asset_hash: asset.asset_hash,
                relativePath: asset.relative_path,
                error: error.message,
              }
            );
          }
        }
      }
    }

    const baselineIndex = await recordBootstrapPrimaryBaseline(
      localIndex,
      manifest,
      response,
      logger,
      config
    );

    // 回写权威配置: 从 Center 返回的 authoritative_configs 中获取带有完整 order_rank 的配置写回磁盘
    if (Array.isArray(response.authoritative_configs)) {
      for (const authCfg of response.authoritative_configs) {
        const relativePath = authCfg.relative_path || authCfg.entity_id;
        if (!relativePath) continue;
        const snapshot = authCfg.safe_projection_json || authCfg.payload;
        if (!snapshot) continue;
        const filePath = path.join(config.appDataPath, relativePath);
        try {
          let mergedContent = snapshot;
          if (await fs.pathExists(filePath)) {
            const existing = await fs.readJson(filePath).catch(() => null);
            const schema = schemaForPath(relativePath);
            if (schema && schema !== "skip" && existing) {
              mergedContent = mergeProjectedConfig(existing, snapshot, {
                schema,
                profile: authCfg.profile || "bootstrap",
                projection_fields: authCfg.projection_fields,
                deleted_fields: authCfg.deleted_fields || [],
              });
            }
          }
          await atomicWriteJson(filePath, mergedContent, { logger });
          const checksum = checksumJson(snapshot);
          await localIndex.setFile(relativePath, {
            kind: "config",
            checksum,
            last_known_checksum: checksum,
            local_projection_checksum: checksum,
            last_applied_seq: response.latest_seq || 0,
            pending_operation_id: null,
            pending_status: null,
            snapshot_json: snapshot,
            bootstrap_baseline: true,
            updated_at: new Date().toISOString(),
          });
        } catch (writeErr) {
          if (logger && logger.warn) {
            logger.warn("bootstrap authoritative config write-back failed", {
              relativePath,
              error: writeErr.message,
            });
          }
        }
      }
    }

    const state = runtime.state;
    state.mode = "active";
    state.last_applied_seq = response.latest_seq || 0;
    if (response.generation) state.center_generation = response.generation;
    state.bootstrap_completed_at = new Date().toISOString();
    await runtime.writeState(state);
    const postBootstrapScan = await scanAppData(
      config.appDataPath,
      localIndex,
      offlineQueue,
      writeIntentLock,
      logger,
      {
        mode: "active",
        deviceId: config.deviceId,
        centerClient,
        config,
      }
    );
    return {
      ok: true,
      mode: "active",
      import: response,
      attachment_upload_errors: attachmentUploadErrors,
      theme_upload_errors: themeUploadErrors,
      baseline_index: baselineIndex,
      post_bootstrap_scan: postBootstrapScan.summary,
      manifest_summary: {
        messages: manifest.messages.length,
        configs: manifest.configs.length,
        attachments: manifest.attachments.length,
        avatars: (manifest.avatars || []).length,
        themes: manifest.themes.length,
        rewritten: manifest.rewritten.length,
      },
    };
  } catch (error) {
    await resumeRuntimeServicesAfterFailure(
      runtime,
      "bootstrap_primary",
      error,
      logger
    );
    throw error;
  }
}

function buildBaselineEvents(baseline = {}) {
  let seq = 1;
  return [
    ...(baseline.configs || []).map((cfg) => ({
      seq: seq++,
      baseline_seq: true,
      entity_type: cfg.schema,
      entity_id: cfg.entity_id,
      action: "baseline",
      payload: cfg,
    })),
    ...(baseline.attachments || []).map((att) => ({
      seq: seq++,
      baseline_seq: true,
      entity_type: "attachment",
      entity_id: att.hash,
      action: "baseline",
      payload: att,
    })),
    ...(baseline.avatars || []).map((avatar) => ({
      seq: seq++,
      baseline_seq: true,
      entity_type: "avatar",
      entity_id: `${avatar.owner_type}:${avatar.owner_id}`,
      action: avatar.deleted ? "delete" : "baseline",
      payload: avatar,
    })),
    ...(baseline.themes || []).flatMap((theme) => {
      const themeId = theme.theme_id || theme.themeId;
      const assets = Array.isArray(theme.assets) ? theme.assets : [];
      return [
        {
          seq: seq++,
          baseline_seq: true,
          entity_type: "theme_package",
          entity_id: themeId,
          action: theme.deleted ? "delete" : "baseline",
          version: theme.version || 1,
          payload: theme,
        },
        ...assets.map((asset) => ({
          seq: seq++,
          baseline_seq: true,
          entity_type: "theme_asset",
          entity_id: asset.asset_hash || asset.hash,
          action: "baseline",
          version: 1,
          payload: {
            ...asset,
            theme_id: asset.theme_id || themeId,
            binary_available: asset.binary_available === true,
            binary_strategy:
              asset.binary_available === true ? "local" : "download_by_hash",
          },
        })),
      ];
    }),
    ...(baseline.topics || [])
      .filter((topic) => topic.id || topic.topic_id)
      .map((topic) => ({
        seq: seq++,
        baseline_seq: true,
        entity_type: "topic",
        item_type: topic.item_type,
        item_id: topic.item_id,
        topic_id: topic.id || topic.topic_id,
        entity_id: topic.id || topic.topic_id,
        action: "baseline",
        payload: { topic: topic },
      })),
    ...(baseline.messages || []).map((msg) => ({
      seq: seq++,
      baseline_seq: true,
      entity_type: "message",
      item_type: msg.item_type,
      item_id: msg.item_id,
      topic_id: msg.topic_id,
      entity_id: msg.id,
      action: "create",
      version: msg.version,
      server_seq: msg.server_seq,
      payload: {
        message: { ...(msg.message || {}) },
        local_order: msg.local_order,
      },
    })),
  ];
}

function diffByKey(localRows, centerRows, keyFn, checksumFn) {
  const localMap = new Map(localRows.map((row) => [keyFn(row), row]));
  const centerMap = new Map(centerRows.map((row) => [keyFn(row), row]));
  const localOnly = [];
  const centerOnly = [];
  const checksumMismatch = [];
  let same = 0;
  for (const [key, localRow] of localMap.entries()) {
    const centerRow = centerMap.get(key);
    if (!centerRow) {
      localOnly.push({ key, local: localRow });
      continue;
    }
    const localChecksum = checksumFn(localRow);
    const centerChecksum = checksumFn(centerRow);
    if (localChecksum && centerChecksum && localChecksum === centerChecksum)
      same += 1;
    else checksumMismatch.push({ key, local: localRow, center: centerRow });
  }
  for (const [key, centerRow] of centerMap.entries()) {
    if (!localMap.has(key)) centerOnly.push({ key, center: centerRow });
  }
  return {
    same,
    local_only: localOnly,
    center_only: centerOnly,
    checksum_mismatch: checksumMismatch,
  };
}

function agentIdFromConfigEntityId(entityId) {
  const match = /^Agents\/([^/]+)\/config\.json$/i.exec(String(entityId || ""));
  return match ? match[1] : null;
}

function configDisplayName(configRow) {
  const payload =
    configRow && (configRow.safe_projection_json || configRow.payload || {});
  const dto = payload.safe_projection_json || payload;
  return dto && typeof dto.name === "string" ? dto.name.trim() : "";
}

function buildSameNameAgentMerge(local, center) {
  const centerByName = new Map();
  for (const cfg of center.configs || []) {
    if (cfg.schema !== "agent_config") continue;
    const name = configDisplayName(cfg);
    const agentId = agentIdFromConfigEntityId(
      cfg.entity_id || cfg.relative_path
    );
    if (name && agentId && !centerByName.has(name))
      centerByName.set(name, { cfg, agentId });
  }

  const centerMessageKeys = new Set(
    (center.messages || []).map(
      (msg) => `${msg.item_type}:${msg.item_id}:${msg.topic_id}:${msg.id}`
    )
  );
  const centerAttachmentHashes = new Set(
    (center.attachments || []).map((att) => String(att.hash || ""))
  );
  const localAttachmentsByHash = new Map(
    (local.attachments || []).map((att) => [String(att.hash || ""), att])
  );
  const remaps = [];
  const remapEvents = [];
  let seq = 1000000000;
  for (const cfg of local.configs || []) {
    if (cfg.schema !== "agent_config") continue;
    const name = configDisplayName(cfg);
    const localAgentId = agentIdFromConfigEntityId(
      cfg.entity_id || cfg.relative_path
    );
    const centerMatch = centerByName.get(name);
    if (!name || !localAgentId || !centerMatch) continue;
    if (localAgentId === centerMatch.agentId) continue;

    const messages = (local.messages || []).filter(
      (msg) => msg.item_id === localAgentId
    );
    const attachments = new Map();
    const skippedMessages = [];
    for (const msg of messages) {
      const targetMessageKey = `${msg.item_type}:${centerMatch.agentId}:${msg.topic_id}:${msg.id}`;
      if (centerMessageKeys.has(targetMessageKey)) {
        skippedMessages.push({
          id: msg.id,
          topic_id: msg.topic_id,
          reason: "center_message_id_exists",
        });
        continue;
      }
      for (const ref of collectAttachmentRefs(msg.message || {})) {
        const attachment = localAttachmentsByHash.get(ref.hash);
        attachments.set(ref.hash, {
          hash: ref.hash,
          ext: (attachment && attachment.ext) || ref.ext || "",
          filename: (attachment && attachment.filename) || ref.filename || null,
          size_bytes: attachment ? attachment.size_bytes : undefined,
          relative_path: attachment ? attachment.relative_path : undefined,
          already_in_center: centerAttachmentHashes.has(ref.hash),
        });
      }
      remapEvents.push({
        seq: seq++,
        baseline_seq: true,
        entity_type: "message",
        item_type: msg.item_type,
        item_id: centerMatch.agentId,
        topic_id: msg.topic_id,
        entity_id: msg.id,
        action: "create",
        version: msg.version,
        payload: {
          message: { ...(msg.message || {}), item_id: centerMatch.agentId },
          local_order: msg.local_order,
        },
      });
      centerMessageKeys.add(targetMessageKey);
    }
    const localAttachmentRows = [...attachments.values()];
    remaps.push({
      name,
      local_agent_id: localAgentId,
      center_agent_id: centerMatch.agentId,
      local_messages_inserted: messages.length - skippedMessages.length,
      local_messages_skipped: skippedMessages.length,
      local_attachments_referenced: localAttachmentRows.length,
      local_attachment_hashes: localAttachmentRows.map((att) => att.hash),
      local_attachments: localAttachmentRows,
      skipped_messages: skippedMessages,
      policy:
        "center_config_as_base_local_history_and_attachments_remapped_uploaded",
    });
  }
  return { remaps, events: remapEvents };
}

async function uploadSameNameAgentMergeAttachments(
  sameNameAgentMerge,
  runtimeContext
) {
  const { config, centerClient, localIndex, logger } = runtimeContext;
  const uploaded = [];
  const skipped = [];
  const failed = [];
  const seen = new Set();

  for (const remap of sameNameAgentMerge.remaps || []) {
    for (const attachment of remap.local_attachments || []) {
      const hash = String(attachment.hash || "");
      if (!hash || seen.has(hash)) continue;
      seen.add(hash);
      if (attachment.already_in_center) {
        skipped.push({
          hash,
          relative_path: attachment.relative_path,
          reason: "already_in_center_baseline",
        });
        continue;
      }
      if (!attachment.relative_path) {
        failed.push({ hash, reason: "missing_local_relative_path" });
        continue;
      }
      const absolutePath = path.join(
        config.appDataPath,
        attachment.relative_path
      );
      if (!(await fs.pathExists(absolutePath))) {
        failed.push({
          hash,
          relative_path: attachment.relative_path,
          reason: "local_attachment_file_missing",
        });
        continue;
      }
      try {
        const result = await uploadLocalAttachment(
          attachment.relative_path,
          absolutePath,
          localIndex,
          centerClient,
          config,
          { force: true }
        );
        if (result.hash !== hash) {
          failed.push({
            hash,
            actual_hash: result.hash,
            relative_path: attachment.relative_path,
            reason: "local_attachment_hash_mismatch",
          });
          continue;
        }
        if (result.uploaded) {
          uploaded.push({
            hash: result.hash,
            relative_path: attachment.relative_path,
            size: result.size,
            uploaded: true,
          });
        } else {
          failed.push({
            hash,
            relative_path: attachment.relative_path,
            reason: "center_client_upload_unavailable",
          });
        }
      } catch (error) {
        failed.push({
          hash,
          relative_path: attachment.relative_path,
          reason: error.message,
        });
        if (logger && logger.warn) {
          logger.warn("same-name agent merge attachment upload failed", {
            hash,
            relativePath: attachment.relative_path,
            error: error.message,
          });
        }
      }
    }
  }

  return {
    referenced: uploaded.length + skipped.length + failed.length,
    uploaded: uploaded.length,
    skipped: skipped.length,
    failed: failed.length,
    uploaded_items: uploaded,
    skipped_items: skipped,
    failed_items: failed,
  };
}

function sortBootstrapBaseline(baseline) {
  const compareText = (left, right) => {
    const a = String(left ?? "");
    const b = String(right ?? "");
    return a < b ? -1 : a > b ? 1 : 0;
  };
  const compareOwner = (a, b) =>
    compareText(a.item_type, b.item_type) || compareText(a.item_id, b.item_id);
  const orderValue = (value) => value === null || value === undefined
    ? Number.MAX_SAFE_INTEGER
    : Number(value);
  // Keyset pages follow immutable identities. Restore display order only after
  // all pages are assembled, before synthetic message events append to history.
  baseline.messages.sort((a, b) =>
    compareOwner(a, b) || compareText(a.topic_id, b.topic_id) ||
    orderValue(a.local_order) - orderValue(b.local_order) ||
    Number(a.server_seq || 0) - Number(b.server_seq || 0) ||
    compareText(a.id, b.id)
  );
  baseline.topics.sort((a, b) =>
    compareOwner(a, b) || orderValue(a.order_rank) - orderValue(b.order_rank) ||
    compareText(a.created_at, b.created_at) || compareText(a.id, b.id)
  );
  baseline.message_attachments.sort((a, b) =>
    compareOwner(a, b) || compareText(a.topic_id, b.topic_id) ||
    compareText(a.message_id, b.message_id) ||
    Number(a.attachment_order || 0) - Number(b.attachment_order || 0) ||
    compareText(a.attachment_hash, b.attachment_hash)
  );
}

async function exportCompleteBootstrap(centerClient, options = {}) {
  const first = await centerClient.exportBootstrap(options);
  const baselineSeq = Number(first.baseline_seq ?? first.latest_seq ?? 0);
  if (!Number.isSafeInteger(baselineSeq) || baselineSeq < 0) {
    throw new Error("bootstrap export has an invalid baseline sequence");
  }
  let replayUntilSeq = baselineSeq;
  const observePageSequence = (page) => {
    if (first.pagination !== "keyset-v1") return;
    const currentSeq = Number(page.latest_seq);
    if (!Number.isSafeInteger(currentSeq) || currentSeq < baselineSeq) {
      throw new Error("bootstrap export has an invalid page sequence");
    }
    replayUntilSeq = Math.max(replayUntilSeq, currentSeq);
  };
  observePageSequence(first);
  const baseline = { ...(first.baseline || {}) };
  const categories = [
    "messages",
    "topics",
    "configs",
    "attachments",
    "message_attachments",
    "avatars",
    "themes",
  ];

  for (const kind of categories) {
    baseline[kind] = Array.isArray(baseline[kind]) ? [...baseline[kind]] : [];
    let pageInfo = first.page && first.page[kind];
    let cursor = pageInfo && pageInfo.next_cursor;
    const seenCursors = new Set();
    while (pageInfo && pageInfo.has_more) {
      if (
        cursor === undefined ||
        cursor === null ||
        seenCursors.has(String(cursor))
      ) {
        throw new Error(
          `bootstrap pagination cursor did not advance for ${kind}`
        );
      }
      seenCursors.add(String(cursor));
      const page = await centerClient.exportBootstrap({
        ...options,
        kind,
        cursor,
        limit: pageInfo.limit || options.limit,
      });
      if (page.baseline_seq !== undefined && Number(page.baseline_seq) !== baselineSeq) {
        throw new Error(`bootstrap replay boundary changed while paging ${kind}`);
      }
      observePageSequence(page);
      const rows = page.baseline && page.baseline[kind];
      if (Array.isArray(rows)) baseline[kind].push(...rows);
      const nextPageInfo = page.page && page.page[kind];
      if (!nextPageInfo) {
        throw new Error(`bootstrap pagination metadata missing for ${kind}`);
      }
      const nextCursor = nextPageInfo.next_cursor;
      if (
        nextPageInfo.has_more &&
        (nextCursor === undefined ||
          nextCursor === null ||
          String(nextCursor) === String(cursor))
      ) {
        throw new Error(
          `bootstrap pagination cursor did not advance for ${kind}`
        );
      }
      pageInfo = nextPageInfo;
      cursor = nextCursor;
    }
  }

  if (first.pagination === "keyset-v1") sortBootstrapBaseline(baseline);
  const replayEvents = await collectBootstrapReplayEvents(centerClient, baselineSeq, replayUntilSeq);
  return {
    ...first, baseline, baseline_seq: baselineSeq, latest_seq: baselineSeq,
    generation: first.generation || null,
    replay_until_seq: replayUntilSeq,
    replay_events: replayEvents,
  };
}

async function collectBootstrapReplayEvents(centerClient, afterSeq, untilSeq) {
  const collected = [];
  // Read the complete window before touching local projections. A network
  // failure during catch-up must leave the old baseline safe to resume.
  while (afterSeq < untilSeq) {
    if (typeof centerClient.getChanges !== "function") {
      throw new Error("bootstrap catch-up requires the center changes endpoint");
    }
    const changes = await centerClient.getChanges(afterSeq, 1000);
    const events = (changes.events || []).filter((event) =>
      Number(event.seq) > afterSeq && Number(event.seq) <= untilSeq
    ).sort((a, b) => Number(a.seq) - Number(b.seq));
    if (events.length === 0 || events.some((event) => !Number.isSafeInteger(Number(event.seq)))) {
      throw new Error(`bootstrap catch-up did not advance after seq ${afterSeq}`);
    }
    collected.push(...events);
    afterSeq = Number(events[events.length - 1].seq);
  }
  return collected;
}

async function replayBootstrapWindow(exported, context) {
  const projection = await projectEvents(exported.replay_events || [], {
    ...context, bootstrapReplay: true,
  });
  if (projection.error) throw projection.error;
  return {
    last_applied_seq: exported.replay_until_seq ?? exported.baseline_seq ?? exported.latest_seq ?? 0,
    generation: exported.generation || null,
    applied: projection.appliedSeqs.length,
  };
}

async function beginBootstrapProjection(runtime, action, exported, backupRoot) {
  const nextState = {
    ...runtime.state,
    mode: "bootstrapping",
    bootstrap_pending: {
      action,
      baseline_seq: exported.baseline_seq ?? exported.latest_seq ?? 0,
      replay_until_seq: exported.replay_until_seq ?? exported.latest_seq ?? 0,
      backup_root: backupRoot,
      started_at: new Date().toISOString(),
    },
  };
  // Persist before the first file mutation so a restart cannot run ordinary
  // scans/pulls against a partially projected bootstrap.
  await runtime.writeState(nextState);
  Object.assign(runtime.state, nextState);
}

async function completeBootstrapProjection(runtime, catchup, extra = {}) {
  const nextState = {
    ...runtime.state,
    mode: "active",
    last_applied_seq: catchup.last_applied_seq,
    ...(catchup.generation ? { center_generation: catchup.generation } : {}),
    bootstrap_completed_at: new Date().toISOString(),
    ...extra,
  };
  delete nextState.bootstrap_pending;
  delete nextState.recovering_reason;
  delete nextState.center_generation_seen;
  delete nextState.center_generation_expected;
  nextState.enabled = runtime.config.enabled;
  await runtime.writeState(nextState);
  Object.assign(runtime.state, nextState);
  delete runtime.state.bootstrap_pending;
  delete runtime.state.recovering_reason;
  delete runtime.state.center_generation_seen;
  delete runtime.state.center_generation_expected;
}

async function joinExisting(runtime) {
  const { config, centerClient, localIndex, writeIntentLock, logger } = runtime;
  await pauseRuntimeServices(runtime, "join_existing");
  let projectionStarted = false;
  try {
    const backupRoot = await backupAppData(config, "join-existing", logger);
    const exported = await exportCompleteBootstrap(centerClient);
    const baseline = exported.baseline || {};
    const events = Array.isArray(exported.changes) ? exported.changes : [];
    const projectionEvents =
      events.length > 0 ? events : buildBaselineEvents(baseline);
    const context = {
      config,
      localIndex,
      writeIntentLock,
      logger,
      centerClient,
      syncProfileConfig: config.syncProfileConfig,
    };
    await beginBootstrapProjection(runtime, "join_existing", exported, backupRoot);
    projectionStarted = true;
    const projection = await projectEvents(projectionEvents, {
      ...context,
      bootstrapReplay: exported.pagination === "keyset-v1" &&
        exported.replay_until_seq > exported.baseline_seq,
    });
    if (projection.failedSeq)
      throw new Error(
        `join_existing projection failed at seq ${projection.failedSeq}`
      );
    const catchup = await replayBootstrapWindow(exported, context);
    await completeBootstrapProjection(runtime, catchup);
    projectionStarted = false;
    return {
      ok: true,
      mode: "active",
      latest_seq: runtime.state.last_applied_seq,
      projection,
      catchup,
      baseline_projection: events.length === 0,
    };
  } catch (error) {
    // Reading the export may fail safely before projection. After mutation,
    // retain the durable non-active state so a retry can rebuild the baseline.
    if (!projectionStarted) {
      await resumeRuntimeServicesAfterFailure(runtime, "join_existing", error, logger);
    }
    throw error;
  }
}

async function mergeExisting(runtime) {
  const { config, centerClient, localIndex, writeIntentLock, logger } = runtime;
  await pauseRuntimeServices(runtime, "merge_existing");
  let projectionStarted = false;
  try {
    const backupRoot = await backupAppData(config, "merge-existing", logger);
    const local = await buildLocalManifest(config, {
      logger,
      allowConflicts: true,
    });
    const exported = await exportCompleteBootstrap(centerClient);
    const center = exported.baseline || {};
    const messageDiff = diffByKey(
      local.messages,
      center.messages || [],
      (row) => `${row.item_type}:${row.item_id}:${row.topic_id}:${row.id}`,
      (row) => row.checksum || checksumJson(row.message || {})
    );
    const configDiff = diffByKey(
      local.configs,
      center.configs || [],
      (row) => row.entity_id || row.relative_path || row.schema,
      (row) =>
        row.checksum ||
        checksumJson(row.safe_projection_json || row.payload || {})
    );
    const attachmentDiff = diffByKey(
      local.attachments,
      center.attachments || [],
      (row) => row.hash,
      (row) => row.hash
    );
    const sameNameAgentMerge = buildSameNameAgentMerge(local, center);
    const sameNameAttachmentUpload = await uploadSameNameAgentMergeAttachments(
      sameNameAgentMerge,
      { config, centerClient, localIndex, logger }
    );
    const projectionEvents = [
      ...buildBaselineEvents(center),
      ...sameNameAgentMerge.events,
    ];
    const context = {
      config,
      localIndex,
      writeIntentLock,
      logger,
      centerClient,
      syncProfileConfig: config.syncProfileConfig,
    };
    await beginBootstrapProjection(runtime, "merge_existing", exported, backupRoot);
    projectionStarted = true;
    const projection = await projectEvents(projectionEvents, {
      ...context,
      bootstrapReplay: exported.pagination === "keyset-v1" &&
        exported.replay_until_seq > exported.baseline_seq,
    });
    if (projection.failedSeq) {
      throw new Error(
        `merge_existing projection failed at seq ${projection.failedSeq}`
      );
    }

    const catchup = await replayBootstrapWindow(exported, context);
    await completeBootstrapProjection(runtime, catchup, {
      merge_completed_at: new Date().toISOString(),
    });
    projectionStarted = false;

    const report = {
      ok: true,
      mode: "active",
      merge_mode: "merge_existing_center_baseline_applied",
      generated_at: new Date().toISOString(),
      latest_seq: runtime.state.last_applied_seq,
      local_counts: {
        messages: local.messages.length,
        configs: local.configs.length,
        attachments: local.attachments.length,
      },
      center_counts: {
        messages: (center.messages || []).length,
        configs: (center.configs || []).length,
        attachments: (center.attachments || []).length,
      },
      projection,
      catchup,
      diffs: {
        messages: messageDiff,
        configs: configDiff,
        attachments: attachmentDiff,
      },
      normalized_id_conflicts: local.conflicts,
      same_name_agent_merge: sameNameAgentMerge.remaps,
      same_name_agent_attachment_upload: sameNameAttachmentUpload,
      default_action:
        "center_baseline_then_local_same_name_history_attachment_remap",
    };
    await fs.ensureDir(config.syncDir);
    await fs.writeJson(path.join(config.syncDir, "merge_report.json"), report, {
      spaces: 2,
    });
    return report;
  } catch (error) {
    if (!projectionStarted) {
      await resumeRuntimeServicesAfterFailure(runtime, "merge_existing", error, logger);
    }
    throw error;
  }
}

module.exports = {
  scanNormalizedIdConflicts,
  buildLocalManifest,
  recordBootstrapPrimaryBaseline,
  exportCompleteBootstrap,
  bootstrapPrimary,
  joinExisting,
  mergeExisting,
  backupAppData,
};
