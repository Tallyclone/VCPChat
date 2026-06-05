const fs = require("fs-extra");
const path = require("path");
const { messageKey } = require("../core/identity");
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
          merged: true,
        });
        continue;
      }
      if (knownIds.has(operation.operation_id)) continue;
      rows.push({
        operation,
        status: "pending",
        attempts: 0,
        next_attempt_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        key,
      });
      enqueued.push({
        operation_id: operation.operation_id,
        key,
        action: operation.action,
      });
    }
    await writeQueueRows(config.queuePath, rows, logger);
    return enqueued;
  }

  async function markSubmitted(row, response) {
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
    const now = Date.now();
    const remaining = [];
    for (const row of rows) {
      if (row.status === "submitted") continue;
      const next = Date.parse(row.next_attempt_at || 0);
      if (Number.isFinite(next) && next > now) {
        remaining.push(row);
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
