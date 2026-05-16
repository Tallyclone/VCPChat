const fs = require("fs-extra");
const path = require("path");
const crypto = require("crypto");
const { atomicWriteJson } = require("../projector/atomicWriter");
const { projectEvents } = require("../projector/appDataProjector");
const { checksumJson, checksumBuffer } = require("../core/hash");
const { safeConfigDto } = require("../core/safeConfigDto");
const { uploadLocalAttachment } = require("./attachmentSync");
const { scanAppData } = require("../scanner/appDataScanner");
const { messageKey } = require("../core/identity");
const {
  relativeAppDataPath,
  isHistoryPath,
  parseHistoryIdentity,
  isConfigPath,
  isAttachmentLikePath,
} = require("../utils/pathRules");

function normalizeId(value) {
  return String(value || "")
    .trim()
    .toLocaleLowerCase();
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
        return !relativePath.startsWith("sync/backups/");
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

async function buildLocalManifest(config, options = {}) {
  const messages = [];
  const configs = [];
  const attachments = [];
  const rewritten = [];
  const conflicts = await scanNormalizedIdConflicts(config.appDataPath);
  if (conflicts.length > 0 && !options.allowConflicts) {
    return { ok: false, conflicts, messages, configs, attachments, rewritten };
  }

  await walk(config.appDataPath, async (filePath) => {
    const relativePath = relativeAppDataPath(config.appDataPath, filePath);
    if (relativePath.startsWith("sync/")) return;
    if (isHistoryPath(relativePath)) {
      const identity = parseHistoryIdentity(relativePath);
      const history = await fs.readJson(filePath).catch(() => null);
      if (!Array.isArray(history)) return;
      let changed = false;
      history.forEach((message, index) => {
        if (!message || typeof message !== "object") return;
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
      const dto = safeConfigDto(relativePath, parsed);
      if (dto.schema === "unsupported_config") return;
      const checksum = checksumJson(dto.checksum_source);
      configs.push({
        ...dto,
        checksum,
        payload: {
          ...dto,
          checksum,
        },
      });
      return;
    }
    if (isAttachmentLikePath(relativePath)) {
      const buffer = await fs.readFile(filePath).catch(() => null);
      if (!buffer) return;
      attachments.push({
        hash: checksumBuffer(buffer),
        ext: path.extname(filePath),
        filename: path.basename(filePath),
        size_bytes: buffer.length,
        relative_path: relativePath,
      });
    }
  });

  return {
    ok: true,
    device_id: config.deviceId,
    generated_at: new Date().toISOString(),
    messages,
    configs,
    attachments,
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
  logger
) {
  const latestSeq = response.latest_seq || 0;
  const now = new Date().toISOString();
  let messages = 0;
  let configs = 0;

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
        bootstrap_baseline: true,
        updated_at: now,
      });
      configs += 1;
    }
  });

  if (logger && logger.info) {
    logger.info("bootstrap primary local index baseline recorded", {
      messages,
      configs,
      latestSeq,
    });
  }

  return { messages, configs, latest_seq: latestSeq };
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
  await backupAppData(config, "bootstrap-primary", logger);
  const manifest = await buildLocalManifest(config, { logger });
  if (!manifest.ok) return manifest;

  // Keep the sync center strictly empty until /bootstrap/import runs.
  // Uploading attachment files first writes attachments/change_log rows and makes
  // bootstrap_primary fail with "center is not empty".
  const response = await centerClient.importBootstrap({
    ...manifest,
    mode: "bootstrap_primary",
  });

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
        config
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

  const baselineIndex = await recordBootstrapPrimaryBaseline(
    localIndex,
    manifest,
    response,
    logger
  );

  const state = runtime.state;
  state.mode = "active";
  state.last_applied_seq = response.latest_seq || 0;
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
    baseline_index: baselineIndex,
    post_bootstrap_scan: postBootstrapScan.summary,
    manifest_summary: {
      messages: manifest.messages.length,
      configs: manifest.configs.length,
      attachments: manifest.attachments.length,
      rewritten: manifest.rewritten.length,
    },
  };
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

async function joinExisting(runtime) {
  const { config, centerClient, localIndex, writeIntentLock, logger } = runtime;
  await backupAppData(config, "join-existing", logger);
  const exported = await centerClient.exportBootstrap();
  const baseline = exported.baseline || {};
  const events = Array.isArray(exported.changes) ? exported.changes : [];
  const projectionEvents =
    events.length > 0 ? events : buildBaselineEvents(baseline);
  const projection = await projectEvents(projectionEvents, {
    config,
    localIndex,
    writeIntentLock,
    logger,
    centerClient,
  });
  if (projection.failedSeq)
    throw new Error(
      `join_existing projection failed at seq ${projection.failedSeq}`
    );
  runtime.state.mode = "active";
  runtime.state.last_applied_seq = exported.latest_seq || 0;
  runtime.state.bootstrap_completed_at = new Date().toISOString();
  await runtime.writeState(runtime.state);
  return {
    ok: true,
    mode: "active",
    latest_seq: runtime.state.last_applied_seq,
    projection,
    baseline_projection: events.length === 0,
  };
}

async function mergeExisting(runtime) {
  const local = await buildLocalManifest(runtime.config, {
    logger: runtime.logger,
    allowConflicts: true,
  });
  const exported = await runtime.centerClient.exportBootstrap();
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
  const report = {
    ok: true,
    mode: "merge_existing_report",
    generated_at: new Date().toISOString(),
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
    diffs: {
      messages: messageDiff,
      configs: configDiff,
      attachments: attachmentDiff,
    },
    normalized_id_conflicts: local.conflicts,
    default_action: "report_only_no_delete",
  };
  await fs.ensureDir(runtime.config.syncDir);
  await fs.writeJson(
    path.join(runtime.config.syncDir, "merge_report.json"),
    report,
    { spaces: 2 }
  );
  return report;
}

module.exports = {
  scanNormalizedIdConflicts,
  buildLocalManifest,
  recordBootstrapPrimaryBaseline,
  bootstrapPrimary,
  joinExisting,
  mergeExisting,
  backupAppData,
};
