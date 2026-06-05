const fs = require("fs-extra");
const path = require("path");
const crypto = require("crypto");
const { atomicWriteJson } = require("../projector/atomicWriter");
const { projectEvents } = require("../projector/appDataProjector");
const { checksumJson, checksumBuffer } = require("../core/hash");
const { safeConfigDto } = require("../core/safeConfigDto");
const {
  collectAttachmentRefs,
  uploadLocalAttachment,
} = require("./attachmentSync");
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
  const { config, centerClient, localIndex, writeIntentLock, logger } = runtime;
  await backupAppData(config, "merge-existing", logger);
  const local = await buildLocalManifest(config, {
    logger,
    allowConflicts: true,
  });
  const exported = await centerClient.exportBootstrap();
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
  const projection = await projectEvents(projectionEvents, {
    config,
    localIndex,
    writeIntentLock,
    logger,
    centerClient,
  });
  if (projection.failedSeq) {
    throw new Error(
      `merge_existing projection failed at seq ${projection.failedSeq}`
    );
  }

  runtime.state.mode = "active";
  runtime.state.last_applied_seq = exported.latest_seq || 0;
  runtime.state.bootstrap_completed_at = new Date().toISOString();
  runtime.state.merge_completed_at = new Date().toISOString();
  await runtime.writeState(runtime.state);

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
