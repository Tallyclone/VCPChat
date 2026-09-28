const fs = require("fs-extra");
const path = require("path");
const { checksumJson } = require("../core/hash");
const { messageKey, operationId } = require("../core/identity");
const { canUploadInMode } = require("./modePolicy");
const { moveWithRetry, listOrphanTmpFiles } = require("../projector/atomicWriter");

const MAX_RETRY_DELAY_MS = 5 * 60 * 1000;
// A permanent Center rejection (validation error) is retried a few times in
// case it was caused by a Center that is mid-upgrade, then dead-lettered.
const PERMANENT_REJECTION_MAX_ATTEMPTS = 3;
// A parent topic that keeps being reported missing by Center after repeated
// repair attempts cannot be fixed from this device automatically.
const TOPIC_MISSING_MAX_ATTEMPTS = 20;
const TOPIC_REPAIR_MAX_ATTEMPTS = 5;

function assertValidQueueBody(body) {
  for (const line of body.split(/\r?\n/).filter(Boolean)) {
    JSON.parse(line);
  }
}

function parseQueueBody(raw) {
  const rows = [];
  const corrupt = [];
  for (const line of String(raw || "").split(/\r?\n/).filter(Boolean)) {
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      corrupt.push(line);
    }
  }
  return { rows, corrupt };
}

function rejectedQueuePathFor(queuePath) {
  return path.join(path.dirname(queuePath), "offline_queue.rejected.jsonl");
}

// A queue write that failed between "temp file written" and "temp file renamed"
// leaves the newest intent only in the temp file. Older adapter versions
// deleted the destination before renaming, so the main file could vanish
// entirely. Recover every such orphan by merging its rows back: Center is
// idempotent per operation_id, so re-submitting an already-applied row only
// yields its stored result.
async function recoverOrphanQueueRows(queuePath, rows, orphanPaths, logger) {
  const byId = new Map();
  for (const row of rows) {
    const id = row && row.operation && row.operation.operation_id;
    if (id) byId.set(id, row);
  }
  let recovered = 0;
  let corruptLines = 0;
  const sorted = [...orphanPaths].sort();
  for (const orphanPath of sorted) {
    const raw = await fs.readFile(orphanPath, "utf8").catch(() => "");
    const parsed = parseQueueBody(raw);
    corruptLines += parsed.corrupt.length;
    for (const row of parsed.rows) {
      const id = row && row.operation && row.operation.operation_id;
      if (!id) continue;
      const existing = byId.get(id);
      if (!existing) {
        if (row.status === "submitting") row.status = "pending";
        rows.push(row);
        byId.set(id, row);
        recovered += 1;
        continue;
      }
      if (Number(row.attempts || 0) > Number(existing.attempts || 0)) {
        Object.assign(existing, row);
        if (existing.status === "submitting") existing.status = "pending";
      }
    }
  }
  await writeQueueRows(queuePath, rows, logger);
  for (const orphanPath of sorted) {
    await fs.remove(orphanPath).catch(() => {});
  }
  if (logger && logger.warn) {
    logger.warn("offline queue recovered rows from orphaned temp files", {
      queuePath,
      orphan_files: sorted.length,
      recovered_rows: recovered,
      corrupt_lines: corruptLines,
      total_rows: rows.length,
    });
  }
  return recovered;
}

async function readQueueLines(queuePath, logger) {
  await fs.ensureFile(queuePath);
  const raw = await fs.readFile(queuePath, "utf8");
  const { rows, corrupt } = parseQueueBody(raw);
  if (corrupt.length > 0) {
    const corruptPath = `${queuePath}.corrupt-${Date.now()}`;
    await fs.writeFile(corruptPath, corrupt.join("\n"), "utf8");
    logger.warn("offline queue had corrupt lines; isolated them", {
      corruptPath,
      count: corrupt.length,
    });
  }
  const orphans = await listOrphanTmpFiles(queuePath);
  if (orphans.length > 0) {
    await recoverOrphanQueueRows(queuePath, rows, orphans, logger);
  }
  return rows;
}

async function writeQueueRows(queuePath, rows, logger) {
  const body = rows.map((row) => JSON.stringify(row)).join("\n");
  const finalBody = body ? `${body}\n` : "";
  assertValidQueueBody(finalBody);

  await fs.ensureDir(path.dirname(queuePath));
  const token = `${process.pid}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;
  const tmp = `${queuePath}.tmp-${token}`;

  try {
    await fs.writeFile(tmp, finalBody, "utf8");
    assertValidQueueBody(await fs.readFile(tmp, "utf8"));
    // Atomic in-place replace: the previous queue file stays intact until the
    // rename succeeds, so a failure here never loses queued operations.
    await moveWithRetry(tmp, queuePath, logger);
  } catch (error) {
    await fs.remove(tmp).catch(() => {});
    throw error;
  }
}

async function appendRejectedRow(rejectedPath, row, detail) {
  await fs.ensureDir(path.dirname(rejectedPath));
  await fs.appendFile(
    rejectedPath,
    `${JSON.stringify({ ...row, rejection: detail })}\n`,
    "utf8"
  );
}

function httpStatusOf(error) {
  const status = error && error.response && Number(error.response.status);
  return Number.isFinite(status) ? status : null;
}

function responseDataOf(error) {
  const data = error && error.response && error.response.data;
  return data && typeof data === "object" ? data : null;
}

function responseCodeOf(error) {
  const data = responseDataOf(error);
  return (data && data.code) || (error && error.code) || null;
}

function responseMessageOf(error) {
  const data = responseDataOf(error);
  return String(
    (data && (data.error || data.message)) || (error && error.message) || ""
  ).toLowerCase();
}

function isNetworkOrServerError(error) {
  const status = httpStatusOf(error);
  if (status === null) return true;
  return status >= 500 || [401, 403, 404, 408, 429].includes(status);
}

function createOfflineQueue(config, centerClient, localIndex, logger) {
  let timer = null;
  let stopped = true;
  let modeProvider = () => "uninitialized";
  let queueSerial = Promise.resolve();
  const rejectedQueuePath =
    config.rejectedQueuePath || rejectedQueuePathFor(config.queuePath);

  function runSerialized(task) {
    const run = queueSerial.then(task, task);
    queueSerial = run.catch(() => {});
    return run;
  }

  function retryDelayMs(attempts) {
    const base = Math.max(1, Number(config.queueIntervalMs || 5000));
    const exponent = Math.min(Math.max(Number(attempts || 1) - 1, 0), 10);
    return Math.min(MAX_RETRY_DELAY_MS, base * 2 ** exponent);
  }

  function topicIdOf(topic) {
    return topic && (topic.id || topic.topic_id || topic.topicId);
  }

  function normalizeTopicForTopicOperation(topic, topicId) {
    const source =
      topic && typeof topic === "object" && !Array.isArray(topic) ? topic : {};
    const id = topicId || topicIdOf(source);
    if (!id) return null;
    const normalized = { ...source, id: String(id) };
    if (
      !normalized.name &&
      (source.title || source.topic_title || source.topicTitle)
    ) {
      normalized.name = source.title || source.topic_title || source.topicTitle;
    }
    if (!normalized.createdAt && (source.created_at || source.timestamp)) {
      normalized.createdAt = source.created_at || source.timestamp;
    }
    return normalized;
  }

  function configPathForTopicOwner(itemType, itemId) {
    if (!config.appDataPath || !itemId) return null;
    if (itemType === "group") {
      return path.join(
        config.appDataPath,
        "AgentGroups",
        String(itemId),
        "config.json"
      );
    }
    if (itemType === "agent") {
      return path.join(
        config.appDataPath,
        "Agents",
        String(itemId),
        "config.json"
      );
    }
    return null;
  }

  async function buildRealTopicUpsertFromConfig(operation) {
    const topicKey = topicKeyForOperation(operation);
    if (!topicKey) return null;
    const payload = operation.payload || {};
    const itemType = operation.item_type || payload.item_type;
    const itemId = operation.item_id || payload.item_id;
    const topicId = operation.topic_id || payload.topic_id || payload.topicId;
    const configPath = configPathForTopicOwner(itemType, itemId);
    if (!configPath || !(await fs.pathExists(configPath))) {
      return null;
    }

    let parsed;
    try {
      parsed = await fs.readJson(configPath);
    } catch (error) {
      logger.warn(
        "failed to read owner config while repairing missing topic upsert",
        {
          topic_key: topicKey,
          configPath,
          error: error.message,
        }
      );
      return null;
    }

    const topicSource = (
      Array.isArray(parsed && parsed.topics) ? parsed.topics : []
    ).find((topic) => String(topicIdOf(topic) || "") === String(topicId));
    const topic = normalizeTopicForTopicOperation(topicSource, topicId);
    if (!topic) return null;

    const checksum = checksumJson(topic);
    return {
      operation_id: operationId(
        config.deviceId || operation.device_id || "unknown_device",
        "topic.upsert",
        {
          item_type: itemType,
          item_id: itemId,
          topic_id: topic.id,
          id: topic.id,
        },
        checksum
      ),
      device_id: config.deviceId || operation.device_id,
      entity_type: "topic",
      action: "upsert",
      item_type: itemType,
      item_id: itemId,
      topic_id: topic.id,
      entity_id: topic.id,
      payload: {
        item_type: itemType,
        item_id: itemId,
        topic_id: topic.id,
        topic,
        source: "local_config_topics_parent_repair",
      },
    };
  }

  function isMissingUpdateTargetError(error, row) {
    if (!row || !row.operation || row.operation.action !== "update")
      return false;
    if (responseCodeOf(error) === "MESSAGE_UPDATE_TARGET_MISSING") return true;
    const message = responseMessageOf(error) || String(row.last_error || "")
      .toLowerCase();
    return message.includes("message update target does not exist");
  }

  function isCreateConflictError(error, row) {
    if (
      !row ||
      !row.operation ||
      !isMessageOperation(row.operation) ||
      row.operation.action !== "create"
    ) {
      return false;
    }
    if (responseCodeOf(error) === "MESSAGE_CREATE_CONFLICT") return true;
    const data = responseDataOf(error);
    if (
      httpStatusOf(error) === 409 &&
      data &&
      data.conflict === true &&
      data.deleted !== true
    ) {
      return true;
    }
    return responseMessageOf(error).includes(
      "already exists with different checksum"
    );
  }

  function isTopicMissingError(error, row) {
    if (!row || !isMessageOperation(row.operation)) return false;
    if (responseCodeOf(error) === "MESSAGE_TOPIC_MISSING") return true;
    return responseMessageOf(error).includes(
      "message parent topic does not exist"
    );
  }

  function isDeviceNotRegisteredError(error) {
    return responseMessageOf(error).includes("device is not registered");
  }

  function isPermanentRejection(error) {
    if (isNetworkOrServerError(error)) return false;
    const data = responseDataOf(error);
    return Boolean(data && data.ok === false);
  }

  async function rollbackRemoteExistenceAssumption(row, error) {
    if (!row || !row.key) return false;
    const local = localIndex.getMessage(row.key);
    if (!local) return false;
    const ownsPending = !local.pending_operation_id ||
      local.pending_operation_id === row.operation.operation_id;
    await localIndex.setMessage(row.key, {
      ...local,
      last_known_server_version: null,
      ...(ownsPending ? {
        pending_operation_id: null,
        pending_action: null,
        pending_checksum: null,
        pending_status: "needs_create",
      } : {}),
      remote_existence_assumption_rolled_back_at: new Date().toISOString(),
      remote_existence_assumption_rollback_reason:
        (error && error.message) || "message update target does not exist",
      updated_at: new Date().toISOString(),
    });
    return true;
  }

  function operationKey(operation) {
    if (
      operation.item_type &&
      operation.item_id &&
      operation.topic_id &&
      operation.entity_id
    ) {
      return messageKey({
        item_type: operation.item_type,
        item_id: operation.item_id,
        topic_id: operation.topic_id,
        id: operation.entity_id,
      });
    }
    if (operation.entity_type && operation.entity_id) {
      return `${operation.entity_type}:${operation.entity_id}`;
    }
    return null;
  }

  function isMessageOperation(operation) {
    return !!(operation && operation.entity_type === "message");
  }

  function isMessageCreateOrUpdate(operation) {
    return (
      isMessageOperation(operation) &&
      (operation.action === "create" || operation.action === "update")
    );
  }

  function messageIdentity(operation) {
    const payload = operation.payload || {};
    return {
      item_type: operation.item_type || payload.item_type,
      item_id: operation.item_id || payload.item_id,
      topic_id: operation.topic_id || payload.topic_id,
      id: operation.entity_id || payload.message_id || payload.id,
    };
  }

  function messageChecksum(operation) {
    const payload = operation.payload || {};
    return payload.local_checksum ||
      (payload.message ? checksumJson(payload.message) : null);
  }

  function changeMessageAction(operation, action, baseVersion) {
    if (operation.action === action) return operation;
    return {
      ...operation,
      action,
      operation_id: operationId(
        operation.device_id || config.deviceId,
        `message.${action}`,
        messageIdentity(operation),
        messageChecksum(operation)
      ),
      base_version: action === "create" ? undefined : baseVersion ?? null,
    };
  }

  function repointSuccessors(rows, previousOperationId, nextOperationId) {
    if (previousOperationId === nextOperationId) return;
    for (const successor of rows) {
      if (successor.after_operation_id === previousOperationId) {
        successor.after_operation_id = nextOperationId;
      }
    }
  }

  function queueReceipt(row, metadata = {}) {
    return {
      operation_id: row.operation.operation_id,
      key: row.key,
      action: row.operation.action,
      entity_type: row.operation.entity_type,
      index_managed: isMessageOperation(row.operation),
      ...metadata,
    };
  }

  async function markMessagePending(row, options = {}) {
    if (!row.key || !isMessageOperation(row.operation)) return;
    const previous = localIndex.getMessage(row.key) || {};
    if (
      options.preserveNewer &&
      previous.pending_operation_id &&
      previous.pending_operation_id !== options.previousOperationId &&
      previous.pending_operation_id !== row.operation.operation_id
    ) return;
    if (
      row.local_observation_id &&
      Number(previous.last_local_observation_id || 0) > row.local_observation_id
    ) return;
    const identity = messageIdentity(row.operation);
    const checksum = messageChecksum(row.operation);
    if (
      previous.pending_operation_id === row.operation.operation_id &&
      previous.pending_action === row.operation.action &&
      previous.pending_status === `pending_${row.operation.action}` &&
      previous.pending_checksum === checksum &&
      (!isMessageCreateOrUpdate(row.operation) || previous.last_known_checksum === checksum) &&
      Number(previous.last_local_observation_id || 0) >= Number(row.local_observation_id || 0)
    ) return;
    await localIndex.setMessage(row.key, {
      ...previous,
      identity,
      topic_key: `${identity.item_type}:${identity.item_id}:${identity.topic_id}`,
      ...(isMessageCreateOrUpdate(row.operation) ? {
        last_known_checksum: checksum,
        local_projection_checksum: checksum,
        deleted_locally: false,
      } : { deleted_locally: row.operation.action === "delete" }),
      last_local_observation_id: Math.max(
        Number(previous.last_local_observation_id || 0),
        Number(row.local_observation_id || 0)
      ),
      pending_operation_id: row.operation.operation_id,
      pending_action: row.operation.action,
      pending_status: `pending_${row.operation.action}`,
      pending_checksum: checksum,
      updated_at: new Date().toISOString(),
    });
  }

  function topicKeyForOperation(operation) {
    if (!operation) return null;
    const payload = operation.payload || {};
    const itemType = operation.item_type || payload.item_type;
    const itemId = operation.item_id || payload.item_id;
    const topicId = operation.topic_id || payload.topic_id || payload.topicId;
    if (!itemType || !itemId || !topicId) return null;
    return `${itemType}:${itemId}:${topicId}`;
  }

  function topicIdentityForOperation(operation) {
    const payload = (operation && operation.payload) || {};
    return {
      item_type: operation.item_type || payload.item_type,
      item_id: operation.item_id || payload.item_id,
      topic_id: operation.topic_id || payload.topic_id || payload.topicId,
    };
  }

  function hasPendingTopicUpsert(rows, topicKey) {
    if (!topicKey) return false;
    return rows.some((row) => {
      const operation = row && row.operation;
      return (
        row.status !== "submitted" &&
        operation &&
        operation.entity_type === "topic" &&
        operation.action === "upsert" &&
        topicKeyForOperation(operation) === topicKey
      );
    });
  }

  function isQueuedOperation(rows, operationIdValue) {
    if (!operationIdValue) return false;
    return rows.some(
      (row) =>
        row.status !== "submitted" &&
        row.operation &&
        row.operation.operation_id === operationIdValue
    );
  }

  function isTopicConfirmed(snapshot) {
    return Boolean(
      snapshot &&
        (snapshot.last_known_server_version != null ||
          snapshot.last_applied_seq ||
          snapshot.confirmed_at ||
          snapshot.bootstrap_baseline)
    );
  }

  function submitPriority(row) {
    const operation = row && row.operation;
    if (!operation) return 50;
    if (operation.entity_type === "topic" && operation.action === "upsert") {
      return 0;
    }
    if (operation.entity_type === "topic_order") return 1;
    if (
      operation.entity_type === "agent_config" ||
      operation.entity_type === "group_config"
    ) {
      return 2;
    }
    // Every message operation shares one priority so operations on the same
    // message keep their queue (dependency) order: a delete enqueued before a
    // later restore/edit is submitted first, never after its own successor.
    if (isMessageOperation(operation)) return 3;
    return 10;
  }

  function orderedRowsForSubmit(rows) {
    return rows
      .map((row, index) => ({ row, index }))
      .sort((left, right) => {
        const byPriority = submitPriority(left.row) - submitPriority(right.row);
        if (byPriority !== 0) return byPriority;
        return left.index - right.index;
      })
      .map((entry) => entry.row);
  }

  function topicChecksumForOperation(operation) {
    const payload = (operation && operation.payload) || {};
    const topic = payload.topic || payload;
    try {
      return checksumJson(topic);
    } catch (_) {
      return null;
    }
  }

  async function markTopicPending(operation) {
    if (
      !operation ||
      operation.entity_type !== "topic" ||
      operation.action !== "upsert"
    ) {
      return;
    }
    const topicKey = topicKeyForOperation(operation);
    if (!topicKey) return;
    const previous = localIndex.getTopicSnapshot(topicKey) || {};
    await localIndex.setTopicSnapshot(topicKey, {
      ...previous,
      topic_key: topicKey,
      item_type: operation.item_type || previous.item_type,
      item_id: operation.item_id || previous.item_id,
      topic_id: operation.topic_id || operation.entity_id || previous.topic_id,
      local_checksum:
        topicChecksumForOperation(operation) || previous.local_checksum,
      pending_operation_id: operation.operation_id,
      pending_action: operation.action,
      pending_status: "pending_upsert",
      updated_at: new Date().toISOString(),
    });
  }

  async function checkTopicAtCenter(topicKey, operation, runState) {
    if (runState.topicChecks.has(topicKey)) {
      return runState.topicChecks.get(topicKey);
    }
    let result;
    if (!centerClient || typeof centerClient.checkTopics !== "function") {
      result = { unavailable: true };
    } else {
      const identity = topicIdentityForOperation(operation);
      try {
        const response = await centerClient.checkTopics([identity]);
        const row = response && Array.isArray(response.results)
          ? response.results[0]
          : null;
        if (response && response.skipped) result = { unavailable: true };
        else if (!row) result = { exists: false };
        else if (row.error) result = { error: row.error };
        else result = { exists: row.exists === true, deleted: row.deleted === true };
      } catch (error) {
        result = { error: error.message };
      }
    }
    runState.topicChecks.set(topicKey, result);
    return result;
  }

  async function enqueueTopicRepair(row, topicKey, runState) {
    const repairOperation = await buildRealTopicUpsertFromConfig(row.operation);
    if (!repairOperation || runState.knownIds.has(repairOperation.operation_id)) {
      return false;
    }
    row.topic_repair_attempts = Number(row.topic_repair_attempts || 0) + 1;
    if (row.topic_repair_attempts > TOPIC_REPAIR_MAX_ATTEMPTS) {
      return false;
    }
    const repairRow = {
      operation: repairOperation,
      status: "pending",
      attempts: 0,
      next_attempt_at: new Date(0).toISOString(),
      created_at: new Date().toISOString(),
      key: topicKey,
      repair_reason: "missing_real_parent_topic_upsert_from_config_topics",
    };
    runState.rows.push(repairRow);
    runState.knownIds.add(repairOperation.operation_id);
    await runState.persistRows();
    await markTopicPending(repairOperation);
    logger.warn(
      "enqueued real parent topic upsert from config.topics[] before message submit",
      {
        operation_id: row.operation && row.operation.operation_id,
        repair_operation_id: repairOperation.operation_id,
        topic_key: topicKey,
        repair_attempt: row.topic_repair_attempts,
      }
    );
    return true;
  }

  function waitForConfigTopicObservation(row, topicKey, snapshot) {
    const startedAt = Date.parse(row.topic_wait_started_at || 0);
    const nowMs = Date.now();
    if (!Number.isFinite(startedAt) || startedAt <= 0) {
      row.topic_wait_started_at = new Date(nowMs).toISOString();
      row.topic_wait_attempts = 1;
      return {
        delay: true,
        reason: "waiting_for_config_topic_observation",
        delayMs: 1500,
      };
    }
    if (nowMs - startedAt < 10000) {
      row.topic_wait_attempts = Number(row.topic_wait_attempts || 0) + 1;
      return {
        delay: true,
        reason: "waiting_for_config_topic_observation",
        delayMs: 1500,
      };
    }
    if (!row.real_topic_operation_missing_logged_at) {
      row.real_topic_operation_missing_logged_at = new Date(nowMs).toISOString();
      logger.warn(
        "message parent topic has no observed real topic operation before submit",
        {
          operation_id: row.operation && row.operation.operation_id,
          topic_key: topicKey,
          wait_ms: nowMs - startedAt,
          topic_wait_attempts: row.topic_wait_attempts || 0,
          snapshot_exists: !!snapshot,
          hint: "real topic upsert must be generated from config.topics[] before this message; adapter will submit without synthetic topic and Center may reject with MESSAGE_TOPIC_MISSING",
        }
      );
    }
    return { delay: false };
  }

  // Decide whether a message may be submitted now. The parent topic must be
  // known to exist at Center; a stale local marker never blocks forever.
  async function resolveParentTopicGate(row, runState) {
    if (!row || !isMessageCreateOrUpdate(row.operation)) {
      return { delay: false };
    }
    const topicKey = topicKeyForOperation(row.operation);
    if (!topicKey) return { delay: false };
    const rows = runState.rows;
    const now = new Date().toISOString();

    let snapshot = localIndex.getTopicSnapshot(topicKey);
    if (isTopicConfirmed(snapshot)) return { delay: false };

    if (
      snapshot &&
      snapshot.pending_operation_id &&
      !isQueuedOperation(rows, snapshot.pending_operation_id)
    ) {
      // The marked operation is neither queued nor confirmed: the queue row was
      // lost. Clear the marker so the topic can be verified or re-submitted.
      const stalePendingId = snapshot.pending_operation_id;
      await localIndex.setTopicSnapshot(topicKey, {
        ...snapshot,
        pending_operation_id: null,
        pending_action: null,
        pending_status: null,
        stale_pending_operation_id: stalePendingId,
        stale_pending_cleared_at: now,
        updated_at: now,
      });
      snapshot = localIndex.getTopicSnapshot(topicKey);
      logger.warn("cleared stale parent topic pending marker", {
        topic_key: topicKey,
        stale_pending_operation_id: stalePendingId,
      });
    }

    if (snapshot && snapshot.pending_operation_id) {
      return {
        delay: true,
        reason: "waiting_for_parent_topic_confirmation",
        delayMs: 1500,
      };
    }
    if (hasPendingTopicUpsert(rows, topicKey)) {
      return {
        delay: true,
        reason: "waiting_for_pending_parent_topic_upsert",
        delayMs: 1500,
      };
    }

    const identity = topicIdentityForOperation(row.operation);
    const centerState = await checkTopicAtCenter(topicKey, row.operation, runState);
    if (centerState.exists === true && !centerState.deleted) {
      await localIndex.setTopicSnapshot(topicKey, {
        ...(snapshot || {}),
        topic_key: topicKey,
        item_type: identity.item_type,
        item_id: identity.item_id,
        topic_id: identity.topic_id,
        confirmed_at: now,
        center_confirmed_at: now,
        updated_at: now,
      });
      logger.info("parent topic confirmed at center", { topic_key: topicKey });
      return { delay: false };
    }
    if (centerState.exists === true && centerState.deleted) {
      const terminal = {
        resolution: "delete_wins",
        deleted: true,
        conflict: true,
        reason: "topic_deleted",
        recorded_at: now,
      };
      await localIndex.setTopicSnapshot(topicKey, {
        ...(snapshot || {}),
        topic_key: topicKey,
        item_type: identity.item_type,
        item_id: identity.item_id,
        topic_id: identity.topic_id,
        pending_operation_id: null,
        pending_action: null,
        pending_status: "conflict_delete_wins",
        terminal_conflict: terminal,
        updated_at: now,
      });
      return { delay: false, terminal };
    }
    if (centerState.error) {
      return {
        delay: true,
        reason: "parent_topic_center_check_failed",
        delayMs: retryDelayMs(Number(row.attempts || 0) + 1),
        error: centerState.error,
      };
    }

    if (centerState.exists === false) {
      // Center does not know the topic: re-submit the real topic from
      // config.topics[] before the message, or give up after a bounded number
      // of attempts.
      if (await enqueueTopicRepair(row, topicKey, runState)) {
        return {
          delay: true,
          reason: "waiting_for_repaired_parent_topic_upsert",
          delayMs: 1500,
        };
      }
      return {
        delay: true,
        reason: "parent_topic_missing_at_center",
        delayMs: retryDelayMs(Number(row.attempts || 0) + 1),
        countTopicMissing: true,
      };
    }

    // Center cannot be asked. A previously observed real topic operation is
    // assumed to have reached Center; otherwise repair from config, and give
    // the config scan a bounded window to produce the real topic operation.
    if (snapshot && snapshot.local_checksum) return { delay: false };
    if (await enqueueTopicRepair(row, topicKey, runState)) {
      return {
        delay: true,
        reason: "waiting_for_repaired_parent_topic_upsert",
        delayMs: 1500,
      };
    }
    return waitForConfigTopicObservation(row, topicKey, snapshot);
  }

  async function enqueueManyUnlocked(operations, options = {}) {
    if (!operations || operations.length === 0) return [];
    const mode = options.mode || modeProvider();
    if (!canUploadInMode(mode)) {
      logger.warn("mode forbids upload; operations observed but not enqueued", {
        mode,
        count: operations.length,
      });
      return [];
    }
    const rows = await readQueueLines(config.queuePath, logger);
    const enqueued = [];
    const indexedRows = new Set();

    for (const source of operations) {
      let operation = JSON.parse(JSON.stringify(source));
      const localObservationId = Number(operation._local_observation_id || 0);
      delete operation._local_observation_id;
      const key = operationKey(operation);
      const duplicate = rows.find((row) =>
        row.operation && row.operation.operation_id === operation.operation_id
      );
      if (duplicate) {
        enqueued.push(queueReceipt(duplicate, { duplicate: true }));
        indexedRows.add(duplicate);
        continue;
      }
      const pending = key ? rows.filter((row) =>
        row.key === key && row.status !== "submitted"
      ) : [];
      let latest = pending[pending.length - 1];
      const local = isMessageOperation(operation) && key
        ? localIndex.getMessage(key) : null;
      if (
        localObservationId && local &&
        Number(local.last_local_observation_id || 0) > localObservationId
      ) {
        enqueued.push(queueReceipt({ operation, key }, { stale_observation: true }));
        continue;
      }

      let withdrawnDelete = null;
      if (isMessageCreateOrUpdate(operation)) {
        if (
          latest &&
          latest.operation.action === "delete" &&
          Number(latest.attempts || 0) === 0
        ) {
          // The message came back before its local delete was ever sent: the
          // delete is withdrawn and the restore/edit takes its place.
          latest.status = "submitted";
          latest.withdrawn_at = new Date().toISOString();
          latest.withdrawn_by_operation_id = operation.operation_id;
          withdrawnDelete = latest;
          const remaining = pending.filter((row) => row !== latest);
          latest = remaining[remaining.length - 1];
        }
        if (latest && isMessageCreateOrUpdate(latest.operation)) {
          if (messageChecksum(latest.operation) === messageChecksum(operation)) {
            latest.local_observation_id = Math.max(
              Number(latest.local_observation_id || 0), localObservationId
            );
            indexedRows.add(latest);
            enqueued.push(queueReceipt(latest, { duplicate: true }));
            continue;
          }
          // A transmitted create may already exist at Center even if its ACK
          // was lost. Preserve its payload and ID, then send the edit as an
          // update after that operation is confirmed.
          if (Number(latest.attempts || 0) === 0) {
            operation = changeMessageAction(
              operation, latest.operation.action, latest.operation.base_version
            );
            latest.operation = operation;
            latest.local_observation_id = localObservationId;
            latest.status = "pending";
            latest.updated_at = new Date().toISOString();
            latest.next_attempt_at = new Date().toISOString();
            indexedRows.add(latest);
            enqueued.push(queueReceipt(latest, { merged: true }));
            continue;
          }
        }
        if (
          operation.action === "create" &&
          ((latest && isMessageCreateOrUpdate(latest.operation)) ||
            (local && local.last_known_server_version != null))
        ) {
          operation = changeMessageAction(
            operation, "update", local && local.last_known_server_version
          );
        }
        if (
          !latest && !withdrawnDelete && local &&
          local.last_known_server_version != null &&
          local.last_submitted_checksum === messageChecksum(operation) &&
          local.last_known_checksum === messageChecksum(operation)
        ) {
          enqueued.push(queueReceipt({ operation, key }, { already_applied: true }));
          continue;
        }
      }

      const row = {
        operation,
        status: "pending",
        attempts: 0,
        next_attempt_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        key,
        ...(localObservationId ? { local_observation_id: localObservationId } : {}),
        ...(isMessageOperation(operation) && latest
          ? { after_operation_id: latest.operation.operation_id } : {}),
        ...(withdrawnDelete
          ? { withdrew_delete_operation_id: withdrawnDelete.operation.operation_id }
          : {}),
      };
      rows.push(row);
      indexedRows.add(row);
      enqueued.push(queueReceipt(row));
    }
    // The queue is the recovery source of truth. Never advance message/topic
    // metadata until the operation exists durably, and do it before a worker
    // can ACK it or another scanner can enqueue a newer observation.
    await writeQueueRows(
      config.queuePath,
      rows.filter((row) => row.status !== "submitted"),
      logger
    );
    const updateIndex = async () => {
      for (const row of indexedRows) {
        await markTopicPending(row.operation);
        await markMessagePending(row);
      }
    };
    if (localIndex.batchUpdate) await localIndex.batchUpdate(updateIndex);
    else await updateIndex();
    return enqueued;
  }

  async function enqueueMany(operations, options = {}) {
    return runSerialized(() => enqueueManyUnlocked(operations, options));
  }

  function isTerminalConflictResponse(response) {
    return Boolean(
      response &&
        response.conflict === true &&
        (response.resolution === "delete_wins" || response.deleted === true)
    );
  }

  async function markTerminalConflict(row, response) {
    if (!row || !row.operation) return;
    const detail = {
      resolution: response.resolution || "conflict",
      deleted: response.deleted === true,
      conflict: true,
      seq: response.seq,
      version: response.version,
      operation_id: row.operation.operation_id,
      recorded_at: new Date().toISOString(),
    };
    if (row.key && row.operation.entity_type === "message") {
      const local = localIndex.getMessage(row.key);
      if (local) {
        const ownsPending = !local.pending_operation_id ||
          local.pending_operation_id === row.operation.operation_id;
        await localIndex.setMessage(row.key, {
          ...local,
          ...(ownsPending ? {
            pending_operation_id: null,
            pending_action: null,
            pending_checksum: null,
            pending_status: "conflict_delete_wins",
          } : {}),
          terminal_conflict: detail,
          updated_at: detail.recorded_at,
        });
      }
    } else if (row.operation.entity_type === "topic") {
      const key = topicKeyForOperation(row.operation);
      const previous = key ? localIndex.getTopicSnapshot(key) : null;
      if (previous) {
        await localIndex.setTopicSnapshot(key, {
          ...previous,
          pending_operation_id: null,
          pending_action: null,
          pending_status: "conflict_delete_wins",
          terminal_conflict: detail,
        });
      }
    } else if (row.key) {
      const fileKeys = [row.key, row.operation.entity_id].filter(
        (value, index, values) => value && values.indexOf(value) === index
      );
      const fileKey = fileKeys.find((value) => localIndex.getFile(value));
      const localFile = fileKey ? localIndex.getFile(fileKey) : null;
      if (localFile) {
        await localIndex.setFile(fileKey, {
          ...localFile,
          pending_operation_id: null,
          pending_status: "conflict_delete_wins",
          terminal_conflict: detail,
          updated_at: detail.recorded_at,
        });
      }
    }
    logger.warn("queue operation reached terminal conflict", {
      operation_id: row.operation.operation_id,
      entity_type: row.operation.entity_type,
      entity_id: row.operation.entity_id,
      resolution: detail.resolution,
    });
  }

  // Center refused the operation for good (validation error). Keep the intent
  // in a dead-letter file, release the entity so later local edits can produce
  // a fresh operation, and stop retrying.
  async function rejectPermanently(row, error, reason) {
    if (!row || !row.operation) return;
    const detail = {
      reason,
      error: (error && error.message) || String(error || ""),
      code: responseCodeOf(error),
      status: httpStatusOf(error),
      response: responseDataOf(error),
      operation_id: row.operation.operation_id,
      attempts: Number(row.attempts || 0),
      recorded_at: new Date().toISOString(),
    };
    await appendRejectedRow(rejectedQueuePath, row, detail).catch((appendError) => {
      logger.error("failed to append rejected operation to dead-letter file", {
        rejectedQueuePath,
        error: appendError.message,
      });
    });
    if (row.key && isMessageOperation(row.operation)) {
      const local = localIndex.getMessage(row.key);
      if (local) {
        const ownsPending = !local.pending_operation_id ||
          local.pending_operation_id === row.operation.operation_id;
        await localIndex.setMessage(row.key, {
          ...local,
          ...(ownsPending ? {
            pending_operation_id: null,
            pending_action: null,
            pending_checksum: null,
            pending_status: "rejected",
          } : {}),
          last_rejection: detail,
          updated_at: detail.recorded_at,
        });
      }
    } else if (row.operation.entity_type === "topic") {
      const key = topicKeyForOperation(row.operation);
      const previous = key ? localIndex.getTopicSnapshot(key) : null;
      if (previous && previous.pending_operation_id === row.operation.operation_id) {
        await localIndex.setTopicSnapshot(key, {
          ...previous,
          pending_operation_id: null,
          pending_action: null,
          pending_status: "rejected",
          last_rejection: detail,
          updated_at: detail.recorded_at,
        });
      }
    } else if (row.key) {
      const fileKeys = [row.key, row.operation.entity_id].filter(
        (value, index, values) => value && values.indexOf(value) === index
      );
      const fileKey = fileKeys.find((value) => localIndex.getFile(value));
      const localFile = fileKey ? localIndex.getFile(fileKey) : null;
      if (localFile && (!localFile.pending_operation_id ||
        localFile.pending_operation_id === row.operation.operation_id)) {
        await localIndex.setFile(fileKey, {
          ...localFile,
          pending_operation_id: null,
          pending_status: "rejected",
          last_rejection: detail,
          updated_at: detail.recorded_at,
        });
      }
    }
    row.status = "submitted";
    row.rejected = detail;
    logger.error("queue operation permanently rejected by center; dead-lettered", {
      operation_id: row.operation.operation_id,
      entity_type: row.operation.entity_type,
      entity_id: row.operation.entity_id,
      reason,
      code: detail.code,
      status: detail.status,
      error: detail.error,
      rejectedQueuePath,
    });
  }

  // Center already holds this message with different content, so the create
  // can never succeed. The local edit is still the user's intent: submit it as
  // an update against the Center version under a new operation ID.
  async function convertCreateConflictToUpdate(row, error, runState) {
    const data = responseDataOf(error) || {};
    const previousOperationId = row.operation.operation_id;
    const local = row.key ? localIndex.getMessage(row.key) : null;
    const centerVersion =
      data.version !== undefined && data.version !== null &&
      Number.isInteger(Number(data.version))
        ? Number(data.version)
        : null;
    const baseVersion = centerVersion ??
      (local && local.last_known_server_version != null
        ? local.last_known_server_version
        : null);
    row.operation = changeMessageAction(row.operation, "update", baseVersion);
    row.status = "pending";
    row.attempts = 0;
    row.next_attempt_at = new Date(0).toISOString();
    row.repair_of_operation_id = previousOperationId;
    row.repair_reason = "create_conflict_converted_to_update";
    row.last_error = error.message;
    repointSuccessors(runState.rows, previousOperationId, row.operation.operation_id);
    await runState.persistRows();
    if (local) {
      await localIndex.setMessage(row.key, {
        ...local,
        last_known_server_version:
          baseVersion !== null ? baseVersion : local.last_known_server_version,
        create_conflict: {
          previous_operation_id: previousOperationId,
          center_version: centerVersion,
          center_seq: data.seq,
          recorded_at: new Date().toISOString(),
        },
        updated_at: new Date().toISOString(),
      });
    }
    await markMessagePending(row, { preserveNewer: true, previousOperationId });
    logger.warn(
      "message create conflicted with existing center message; converted to update",
      {
        key: row.key,
        previous_operation_id: previousOperationId,
        operation_id: row.operation.operation_id,
        center_version: centerVersion,
        base_version: baseVersion,
      }
    );
  }

  async function markSubmitted(row, response) {
    if (!row.operation) return;
    if (
      row.operation.entity_type === "topic" &&
      row.operation.action === "upsert"
    ) {
      const topicKey = topicKeyForOperation(row.operation);
      if (topicKey) {
        const previous = localIndex.getTopicSnapshot(topicKey) || {};
        await localIndex.setTopicSnapshot(topicKey, {
          ...previous,
          topic_key: topicKey,
          item_type: row.operation.item_type || previous.item_type,
          item_id: row.operation.item_id || previous.item_id,
          topic_id:
            row.operation.topic_id ||
            row.operation.entity_id ||
            previous.topic_id,
          local_checksum:
            topicChecksumForOperation(row.operation) || previous.local_checksum,
          last_known_server_version:
            response.version === undefined
              ? previous.last_known_server_version
              : response.version,
          last_applied_seq: response.seq || previous.last_applied_seq,
          pending_operation_id: null,
          pending_action: null,
          pending_status: null,
          terminal_conflict: null,
          confirmed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      }
      return;
    }
    if (!row.key) return;
    if (
      row.operation &&
      row.operation.entity_type &&
      row.operation.entity_type !== "message"
    ) {
      const localFile = localIndex.getFile(row.key);
      if (localFile) {
        await localIndex.setFile(row.key, {
          ...localFile,
          last_known_server_version:
            response.version === undefined
              ? localFile.last_known_server_version
              : response.version,
          last_applied_seq: response.seq || localFile.last_applied_seq,
          pending_operation_id: null,
          pending_status: null,
        });
      }
      return;
    }
    const local = localIndex.getMessage(row.key);
    if (local) {
      const ownsPending = !local.pending_operation_id ||
        local.pending_operation_id === row.operation.operation_id;
      if (row.operation.action === "delete") {
        if (ownsPending) await localIndex.deleteMessage(row.key);
        return;
      }
      const isOlderAck = Number(local.last_applied_seq || 0) > Number(response.seq || 0);
      const checksum = messageChecksum(row.operation);
      await localIndex.setMessage(row.key, {
        ...local,
        ...(!isOlderAck ? {
          last_known_server_version:
            response.version === undefined
              ? local.last_known_server_version
              : response.version,
          last_applied_seq: response.seq || local.last_applied_seq,
          ...(ownsPending ? { last_known_checksum: checksum } : {}),
        } : {}),
        last_submitted_operation_id: row.operation.operation_id,
        last_submitted_checksum: checksum,
        ...(ownsPending ? {
          pending_operation_id: null,
          pending_action: null,
          pending_status: null,
          pending_checksum: null,
        } : {}),
        updated_at: new Date().toISOString(),
      });
    }
  }

  // Remote events may have arrived since this row was enqueued. Submit against
  // the newest known Center version, and never send a create for a message
  // Center is already known to hold.
  async function refreshMessageOperationBeforeSubmit(row, runState) {
    if (!row.key || !isMessageOperation(row.operation)) return;
    if (Number(row.attempts || 0) !== 0) return;
    const local = localIndex.getMessage(row.key);
    if (!local || local.last_known_server_version == null) return;
    if (row.operation.action === "create") {
      const previousOperationId = row.operation.operation_id;
      row.operation = changeMessageAction(
        row.operation,
        "update",
        local.last_known_server_version
      );
      repointSuccessors(runState.rows, previousOperationId, row.operation.operation_id);
      await runState.persistRows();
      await markMessagePending(row, { preserveNewer: true, previousOperationId });
      return;
    }
    if (
      row.operation.action === "update" &&
      row.operation.base_version !== local.last_known_server_version
    ) {
      row.operation.base_version = local.last_known_server_version;
    }
  }

  function deferRow(row, delayMs, error, blockedKeys) {
    row.status = "pending";
    row.last_error = error;
    row.next_attempt_at = new Date(Date.now() + delayMs).toISOString();
    if (row.key) blockedKeys.add(row.key);
  }

  async function processOnceUnlocked() {
    const mode = modeProvider();
    if (!canUploadInMode(mode)) {
      logger.warn("queue processing skipped because mode forbids upload", {
        mode,
      });
      return;
    }
    const rows = await readQueueLines(config.queuePath, logger);
    const orderedRows = orderedRowsForSubmit(rows);
    const now = Date.now();
    const blockedKeys = new Set();
    const persistRows = () => writeQueueRows(
      config.queuePath, rows.filter((row) => row.status !== "submitted"), logger
    );
    const runState = {
      rows,
      persistRows,
      knownIds: new Set(
        rows.map((row) => row.operation && row.operation.operation_id)
      ),
      topicChecks: new Map(),
      reRegistered: false,
    };

    // Recover an enqueue that reached the durable queue before the process
    // stopped while writing its index. Only the newest intent owns each key.
    const latestMessages = new Map();
    for (const row of rows) {
      if (row.status !== "submitted" && isMessageOperation(row.operation)) {
        latestMessages.set(row.key, row);
      }
    }
    const recoverIndex = async () => {
      for (const row of latestMessages.values()) {
        const local = localIndex.getMessage(row.key);
        if (!local || local.last_submitted_operation_id !== row.operation.operation_id) {
          await markMessagePending(row);
        }
      }
    };
    if (localIndex.batchUpdate) await localIndex.batchUpdate(recoverIndex);
    else await recoverIndex();

    for (const row of orderedRows) {
      if (row.status === "submitted") continue;
      if (row.key && blockedKeys.has(row.key)) continue;
      if (row.after_operation_id && rows.some((previous) =>
        previous.status !== "submitted" &&
        previous.operation.operation_id === row.after_operation_id
      )) {
        if (row.key) blockedKeys.add(row.key);
        continue;
      }
      const next = Date.parse(row.next_attempt_at || 0);
      if (Number.isFinite(next) && next > now) {
        if (row.key) blockedKeys.add(row.key);
        continue;
      }

      const topicKey = topicKeyForOperation(row.operation);
      if (isMessageOperation(row.operation)) {
        const local = localIndex.getMessage(row.key);
        const snapshot = topicKey ? localIndex.getTopicSnapshot(topicKey) : null;
        const terminal = (local && local.terminal_conflict) ||
          (snapshot && snapshot.terminal_conflict);
        if (terminal && terminal.deleted === true) {
          // Once a predecessor or parent was rejected by a tombstone, later
          // edits cannot recreate it. Do not retry them as ordinary updates.
          await markTerminalConflict(row, terminal);
          row.status = "submitted";
          continue;
        }
      }

      const topicGate = await resolveParentTopicGate(row, runState);
      if (topicGate.terminal) {
        await markTerminalConflict(row, topicGate.terminal);
        row.status = "submitted";
        continue;
      }
      if (topicGate.delay) {
        if (topicGate.countTopicMissing) {
          row.topic_missing_attempts = Number(row.topic_missing_attempts || 0) + 1;
          if (row.topic_missing_attempts > TOPIC_MISSING_MAX_ATTEMPTS) {
            await rejectPermanently(
              row,
              new Error("message parent topic does not exist at center"),
              "parent_topic_missing_at_center"
            );
            continue;
          }
        }
        deferRow(row, topicGate.delayMs, topicGate.reason, blockedKeys);
        logger.warn("message submit delayed until parent topic is confirmed", {
          operation_id: row.operation && row.operation.operation_id,
          topic_key: topicKey,
          reason: topicGate.reason,
          delay_ms: topicGate.delayMs,
          error: topicGate.error,
        });
        continue;
      }
      try {
        await refreshMessageOperationBeforeSubmit(row, runState);
        const firstAttempt = Number(row.attempts || 0) === 0;
        row.status = "submitting";
        row.attempts = Number(row.attempts || 0) + 1;
        // Persist before network I/O so a restart cannot merge a new edit into
        // a create that Center may have committed without returning its ACK.
        if (firstAttempt) await persistRows();
        const response = await centerClient.submitOperation(row.operation);
        if (isTerminalConflictResponse(response)) {
          await markTerminalConflict(row, response);
          row.status = "submitted";
          continue;
        }
        if (response && response.ok !== false) {
          await markSubmitted(row, response);
          row.status = "submitted";
          continue;
        }
        const rejection = new Error(
          response && response.error ? response.error : "operation rejected"
        );
        rejection.response = { status: 409, data: response };
        throw rejection;
      } catch (error) {
        if (isMissingUpdateTargetError(error, row)) {
          const previousOperationId = row.operation.operation_id;
          const repaired = await rollbackRemoteExistenceAssumption(row, error);
          row.operation = changeMessageAction(row.operation, "create");
          row.status = "pending";
          row.attempts = 0;
          row.next_attempt_at = new Date(0).toISOString();
          row.repair_of_operation_id = previousOperationId;
          row.last_error = error.message;
          repointSuccessors(rows, previousOperationId, row.operation.operation_id);
          await persistRows();
          await markMessagePending(row, { preserveNewer: true, previousOperationId });
          if (row.key) blockedKeys.add(row.key);
          logger.warn(
            "missing message update target converted to a durable create",
            {
              key: row.key,
              operation_id: row.operation && row.operation.operation_id,
              repaired,
              error: error.message,
            }
          );
          continue;
        }
        if (isCreateConflictError(error, row)) {
          await convertCreateConflictToUpdate(row, error, runState);
          if (row.key) blockedKeys.add(row.key);
          continue;
        }
        if (isTopicMissingError(error, row)) {
          // Local metadata claimed the parent exists but Center disagrees
          // (for example after a Center restore). Drop the confirmation so the
          // next round re-verifies and re-submits the parent topic.
          const snapshot = topicKey ? localIndex.getTopicSnapshot(topicKey) : null;
          if (snapshot) {
            await localIndex.setTopicSnapshot(topicKey, {
              ...snapshot,
              last_known_server_version: null,
              last_applied_seq: null,
              confirmed_at: null,
              center_confirmed_at: null,
              bootstrap_baseline: false,
              center_parent_missing_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            });
          }
          row.topic_missing_attempts = Number(row.topic_missing_attempts || 0) + 1;
          if (row.topic_missing_attempts > TOPIC_MISSING_MAX_ATTEMPTS) {
            await rejectPermanently(row, error, "parent_topic_missing_at_center");
            continue;
          }
          deferRow(row, retryDelayMs(row.attempts), error.message, blockedKeys);
          continue;
        }
        if (isDeviceNotRegisteredError(error)) {
          if (
            !runState.reRegistered &&
            centerClient &&
            typeof centerClient.registerDevice === "function"
          ) {
            runState.reRegistered = true;
            await centerClient.registerDevice().then(
              () => logger.warn("device re-registered at center after rejection"),
              (registerError) => logger.warn("device re-registration failed", {
                error: registerError.message,
              })
            );
          }
          deferRow(row, retryDelayMs(row.attempts), error.message, blockedKeys);
          continue;
        }
        if (
          isPermanentRejection(error) &&
          Number(row.attempts || 0) >= PERMANENT_REJECTION_MAX_ATTEMPTS
        ) {
          await rejectPermanently(row, error, "center_rejected_operation");
          continue;
        }
        deferRow(row, retryDelayMs(row.attempts), error.message, blockedKeys);
      }
    }
    await persistRows();
  }

  async function processOnce() {
    return runSerialized(() => processOnceUnlocked());
  }

  async function loop() {
    if (stopped) return;
    await processOnce().catch((error) =>
      logger.warn("queue worker failed", { error: error.message })
    );
    if (!stopped) timer = setTimeout(loop, config.queueIntervalMs);
  }

  return {
    enqueueMany,
    processOnce,
    async start(options = {}) {
      if (options.modeProvider) modeProvider = options.modeProvider;
      if (!canUploadInMode(modeProvider())) {
        logger.warn(
          "queue worker started in non-upload mode; pending rows will not be submitted until active",
          { mode: modeProvider() }
        );
      }
      stopped = false;
      timer = setTimeout(loop, 1000);
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    async stats() {
      return runSerialized(async () => {
        const rows = await readQueueLines(config.queuePath, logger);
        const stats = rows.reduce(
          (acc, row) => {
            acc.total += 1;
            acc[row.status || "pending"] =
              (acc[row.status || "pending"] || 0) + 1;
            return acc;
          },
          { total: 0 }
        );
        stats.rejected_path = rejectedQueuePath;
        return stats;
      });
    },
  };
}

module.exports = {
  createOfflineQueue,
  readQueueLines,
  writeQueueRows,
  rejectedQueuePathFor,
};
