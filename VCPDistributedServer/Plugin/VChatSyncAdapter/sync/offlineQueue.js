const fs = require("fs-extra");
const path = require("path");
const { checksumJson } = require("../core/hash");
const { messageKey, operationId } = require("../core/identity");
const { canUploadInMode } = require("./modePolicy");

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function moveWithRetry(source, target, logger, attempts = 5) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await fs.move(source, target, { overwrite: true });
      return;
    } catch (error) {
      lastError = error;
      if (logger && logger.warn) {
        logger.warn("offline queue atomic move retry", {
          target,
          attempt: attempt + 1,
          error: error.message,
        });
      }
      await wait(Math.min(1000, 100 * 2 ** attempt));
    }
  }
  throw lastError;
}

function assertValidQueueBody(body) {
  for (const line of body.split(/\r?\n/).filter(Boolean)) {
    JSON.parse(line);
  }
}

async function readQueueLines(queuePath, logger) {
  await fs.ensureFile(queuePath);
  const raw = await fs.readFile(queuePath, "utf8");
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const rows = [];
  const corrupt = [];
  for (const line of lines) {
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      corrupt.push(line);
    }
  }
  if (corrupt.length > 0) {
    const corruptPath = `${queuePath}.corrupt-${Date.now()}`;
    await fs.writeFile(corruptPath, corrupt.join("\n"), "utf8");
    logger.warn("offline queue had corrupt lines; isolated them", {
      corruptPath,
      count: corrupt.length,
    });
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
    await moveWithRetry(tmp, queuePath, logger);
  } catch (error) {
    await fs.remove(tmp).catch(() => {});
    throw error;
  }
}

function createOfflineQueue(config, centerClient, localIndex, logger) {
  let timer = null;
  let stopped = true;
  let retryMs = config.queueIntervalMs;
  let modeProvider = () => "uninitialized";

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
    const responseData =
      error && error.response && error.response.data
        ? error.response.data
        : null;
    const responseCode = responseData && responseData.code;
    if (responseCode === "MESSAGE_UPDATE_TARGET_MISSING") return true;
    const responseError =
      responseData && (responseData.error || responseData.message);
    const message = String(
      responseError || (error && error.message) || row.last_error || ""
    ).toLowerCase();
    return message.includes("message update target does not exist");
  }

  async function rollbackRemoteExistenceAssumption(row, error) {
    if (!row || !row.key) return false;
    const local = localIndex.getMessage(row.key);
    if (!local) return false;
    await localIndex.setMessage(row.key, {
      ...local,
      last_known_server_version: null,
      pending_operation_id: null,
      pending_action: null,
      pending_status: "needs_create",
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

  function topicKeyForOperation(operation) {
    if (!operation) return null;
    const payload = operation.payload || {};
    const itemType = operation.item_type || payload.item_type;
    const itemId = operation.item_id || payload.item_id;
    const topicId = operation.topic_id || payload.topic_id || payload.topicId;
    if (!itemType || !itemId || !topicId) return null;
    return `${itemType}:${itemId}:${topicId}`;
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
    if (isMessageCreateOrUpdate(operation)) return 3;
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

  function shouldDelayMessageForTopic(row, rows) {
    if (!row || !isMessageCreateOrUpdate(row.operation)) {
      return { delay: false };
    }
    const topicKey = topicKeyForOperation(row.operation);
    if (!topicKey) return { delay: false };

    const snapshot = localIndex.getTopicSnapshot(topicKey);
    if (
      snapshot &&
      (snapshot.last_known_server_version != null ||
        snapshot.last_applied_seq ||
        snapshot.confirmed_at ||
        snapshot.bootstrap_baseline)
    ) {
      return { delay: false };
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

    if (!snapshot || !snapshot.local_checksum) {
      const startedAt = Date.parse(row.topic_wait_started_at || 0);
      const now = Date.now();
      if (!Number.isFinite(startedAt) || startedAt <= 0) {
        row.topic_wait_started_at = new Date(now).toISOString();
        row.topic_wait_attempts = 1;
        return {
          delay: true,
          reason: "waiting_for_config_topic_observation",
          delayMs: 1500,
        };
      }
      if (now - startedAt < 10000) {
        row.topic_wait_attempts = Number(row.topic_wait_attempts || 0) + 1;
        return {
          delay: true,
          reason: "waiting_for_config_topic_observation",
          delayMs: 1500,
        };
      }

      if (!row.real_topic_operation_missing_logged_at) {
        row.real_topic_operation_missing_logged_at = new Date(
          now
        ).toISOString();
        logger.warn(
          "message parent topic has no observed real topic operation before submit",
          {
            operation_id: row.operation && row.operation.operation_id,
            topic_key: topicKey,
            wait_ms: now - startedAt,
            topic_wait_attempts: row.topic_wait_attempts || 0,
            snapshot_exists: !!snapshot,
            snapshot_has_local_checksum: !!(
              snapshot && snapshot.local_checksum
            ),
            hint: "real topic upsert must be generated from config.topics[] before this message; adapter will submit without synthetic topic and Center may reject with MESSAGE_TOPIC_MISSING",
          }
        );
      }
    }

    return { delay: false };
  }

  function mergePendingCreate(rows, operation, key) {
    const existing = rows.find(
      (row) =>
        row.key === key &&
        row.operation &&
        row.operation.action === "create" &&
        row.status !== "submitted"
    );
    if (!existing) return false;
    existing.operation = operation;
    existing.status = "pending";
    existing.updated_at = new Date().toISOString();
    existing.next_attempt_at = new Date().toISOString();
    return true;
  }

  async function enqueueMany(operations, options = {}) {
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
    const knownIds = new Set(
      rows.map((row) => row.operation && row.operation.operation_id)
    );
    const enqueued = [];
    const addRow = (operation, key, metadata = {}) => {
      if (!operation || knownIds.has(operation.operation_id)) return false;
      rows.push({
        operation,
        status: "pending",
        attempts: 0,
        next_attempt_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        key,
        ...metadata,
      });
      knownIds.add(operation.operation_id);
      enqueued.push({
        operation_id: operation.operation_id,
        key,
        action: operation.action,
        entity_type: operation.entity_type,
        ...metadata,
      });
      return true;
    };

    for (const operation of operations) {
      const key = operationKey(operation);
      if (
        operation.action === "create" &&
        key &&
        mergePendingCreate(rows, operation, key)
      ) {
        enqueued.push({
          operation_id: operation.operation_id,
          key,
          action: operation.action,
          entity_type: operation.entity_type,
          merged: true,
        });
        continue;
      }
      if (addRow(operation, key)) {
        await markTopicPending(operation);
      }
    }
    await writeQueueRows(config.queuePath, rows, logger);
    return enqueued;
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
          confirmed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      }
      return;
    }
    if (!row.key) return;
    if (row.operation && row.operation.action === "delete") {
      await localIndex.deleteMessage(row.key);
      return;
    }
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
      await localIndex.setMessage(row.key, {
        ...local,
        last_known_server_version:
          response.version === undefined
            ? local.last_known_server_version
            : response.version,
        last_applied_seq: response.seq || local.last_applied_seq,
        pending_operation_id: null,
        pending_action: null,
        pending_status: null,
        updated_at: new Date().toISOString(),
      });
    }
  }

  async function processOnce() {
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
    const remaining = [];
    const knownIds = new Set(
      rows.map((row) => row.operation && row.operation.operation_id)
    );

    for (const row of orderedRows) {
      if (row.status === "submitted") continue;
      const next = Date.parse(row.next_attempt_at || 0);
      if (Number.isFinite(next) && next > now) {
        remaining.push(row);
        continue;
      }

      const topicKey = topicKeyForOperation(row.operation);
      const snapshot = topicKey ? localIndex.getTopicSnapshot(topicKey) : null;
      const needsRealTopicRepair =
        isMessageCreateOrUpdate(row.operation) &&
        topicKey &&
        !hasPendingTopicUpsert(rows, topicKey) &&
        (!snapshot || !snapshot.local_checksum) &&
        !(
          snapshot &&
          (snapshot.last_known_server_version != null ||
            snapshot.last_applied_seq ||
            snapshot.confirmed_at ||
            snapshot.bootstrap_baseline)
        );

      if (needsRealTopicRepair) {
        const repairOperation = await buildRealTopicUpsertFromConfig(
          row.operation
        );
        if (repairOperation && !knownIds.has(repairOperation.operation_id)) {
          const repairRow = {
            operation: repairOperation,
            status: "pending",
            attempts: 0,
            next_attempt_at: new Date(0).toISOString(),
            created_at: new Date().toISOString(),
            key: topicKey,
            repair_reason:
              "missing_real_parent_topic_upsert_from_config_topics",
          };
          remaining.push(repairRow);
          knownIds.add(repairOperation.operation_id);
          await markTopicPending(repairOperation);
          row.status = "pending";
          row.last_error = "waiting_for_repaired_parent_topic_upsert";
          row.next_attempt_at = new Date(Date.now() + 1500).toISOString();
          remaining.push(row);
          logger.warn(
            "enqueued real parent topic upsert from config.topics[] before message submit",
            {
              operation_id: row.operation && row.operation.operation_id,
              repair_operation_id: repairOperation.operation_id,
              topic_key: topicKey,
            }
          );
          continue;
        }
      }

      const topicGate = shouldDelayMessageForTopic(row, rows);
      if (topicGate.delay) {
        row.status = "pending";
        row.last_error = topicGate.reason;
        row.next_attempt_at = new Date(
          Date.now() + topicGate.delayMs
        ).toISOString();
        remaining.push(row);
        logger.warn("message submit delayed until parent topic is confirmed", {
          operation_id: row.operation && row.operation.operation_id,
          topic_key: topicKeyForOperation(row.operation),
          reason: topicGate.reason,
          delay_ms: topicGate.delayMs,
        });
        continue;
      }
      try {
        row.status = "submitting";
        row.attempts = Number(row.attempts || 0) + 1;
        const response = await centerClient.submitOperation(row.operation);
        if (response && response.ok !== false) {
          await markSubmitted(row, response);
          retryMs = config.queueIntervalMs;
          continue;
        }
        throw new Error(
          response && response.error ? response.error : "operation rejected"
        );
      } catch (error) {
        if (isMissingUpdateTargetError(error, row)) {
          const repaired = await rollbackRemoteExistenceAssumption(row, error);
          logger.warn(
            "queue row converted from missing update target to recreate-on-rescan",
            {
              key: row.key,
              operation_id: row.operation && row.operation.operation_id,
              repaired,
              error: error.message,
            }
          );
          continue;
        }
        row.status = "pending";
        row.last_error = error.message;
        row.next_attempt_at = new Date(Date.now() + retryMs).toISOString();
        retryMs = Math.min(retryMs * 2, 5 * 60 * 1000);
        remaining.push(row);
      }
    }
    await writeQueueRows(config.queuePath, remaining, logger);
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
      const rows = await readQueueLines(config.queuePath, logger);
      return rows.reduce(
        (acc, row) => {
          acc.total += 1;
          acc[row.status || "pending"] =
            (acc[row.status || "pending"] || 0) + 1;
          return acc;
        },
        { total: 0 }
      );
    },
  };
}

module.exports = { createOfflineQueue, readQueueLines };
