const fs = require("fs-extra");
const path = require("path");
const { checksumJson } = require("../core/hash");
const { messageKey, operationId } = require("../core/identity");
const { isPlaceholderMessage } = require("../diff/historyDiffEngine");
const { safeJoinAppData } = require("../utils/pathRules");
const { readStableJson } = require("../watcher/stableFileReader");

function topicIdOf(topic) {
  return topic && (topic.id || topic.topic_id || topic.topicId);
}

function normalizeTopicForRepair(topic, fallbackId) {
  const id = String(topicIdOf(topic) || fallbackId || "");
  if (!id) return null;
  const createdAt =
    topic && (topic.createdAt || topic.created_at || topic.timestamp || 0);
  return {
    id,
    name: (topic && (topic.name || topic.title || topic.topic_title)) || id,
    createdAt: createdAt || Date.now(),
    locked: topic && topic.locked !== undefined ? !!topic.locked : true,
    unread: topic && topic.unread !== undefined ? !!topic.unread : false,
    creatorSource:
      (topic && (topic.creatorSource || topic.creator_source)) || "repair",
  };
}

async function buildTopicUpsert(runtime, identity) {
  const { config } = runtime;
  const ownerDir = identity.item_type === "group" ? "AgentGroups" : "Agents";
  const configPath = safeJoinAppData(
    config.appDataPath,
    ownerDir,
    identity.item_id,
    "config.json"
  );
  let parsed = null;
  try {
    parsed = await fs.readJson(configPath);
  } catch (_) {}
  const topicSource = (
    Array.isArray(parsed && parsed.topics) ? parsed.topics : []
  ).find(
    (topic) => String(topicIdOf(topic) || "") === String(identity.topic_id)
  );
  const topic = normalizeTopicForRepair(topicSource, identity.topic_id);
  if (!topic) return null;
  const checksum = checksumJson(topic);
  return {
    operation_id: operationId(
      config.deviceId,
      "topic.upsert.repair",
      {
        item_type: identity.item_type,
        item_id: identity.item_id,
        topic_id: identity.topic_id,
        id: identity.topic_id,
      },
      checksum
    ),
    device_id: config.deviceId,
    entity_type: "topic",
    action: "upsert",
    item_type: identity.item_type,
    item_id: identity.item_id,
    topic_id: identity.topic_id,
    entity_id: identity.topic_id,
    payload: {
      item_type: identity.item_type,
      item_id: identity.item_id,
      topic_id: identity.topic_id,
      topic,
      source: "repair_topic_parent_check",
      repair: true,
    },
  };
}

async function queryCenterTopic(centerClient, identity) {
  if (!centerClient || typeof centerClient.checkTopics !== "function") {
    return { skipped: true, exists: null };
  }
  const response = await centerClient.checkTopics([
    {
      item_type: identity.item_type,
      item_id: identity.item_id,
      topic_id: identity.topic_id,
    },
  ]);
  const row = (response.results || [])[0];
  return {
    skipped: !!response.skipped,
    response,
    exists: row ? row.exists === true : false,
  };
}

function topicKeyOf(identity) {
  return `${identity.item_type}:${identity.item_id}:${identity.topic_id}`;
}

function queueMessageIds(rows, identity) {
  const ids = new Set();
  for (const row of rows || []) {
    const op = row && row.operation;
    if (!op || op.entity_type !== "message") continue;
    if (
      op.item_type === identity.item_type &&
      op.item_id === identity.item_id &&
      op.topic_id === identity.topic_id
    ) {
      ids.add(op.entity_id || (op.payload && op.payload.message_id));
    }
  }
  return ids;
}

async function readQueueRows(queuePath) {
  if (!(await fs.pathExists(queuePath))) return [];
  const raw = await fs.readFile(queuePath, "utf8");
  const rows = [];
  for (const line of raw.split(/\r?\n/).filter(Boolean)) {
    try {
      rows.push(JSON.parse(line));
    } catch (_) {}
  }
  return rows;
}

function buildMessageCreate(identityBase, message, deviceId) {
  const identity = { ...identityBase, id: String(message.id) };
  const checksum = checksumJson(message);
  return {
    operation_id: operationId(
      deviceId,
      "message.create.repair",
      identity,
      checksum
    ),
    device_id: deviceId,
    entity_type: "message",
    action: "create",
    item_type: identity.item_type,
    item_id: identity.item_id,
    topic_id: identity.topic_id,
    entity_id: identity.id,
    payload: {
      item_type: identity.item_type,
      item_id: identity.item_id,
      topic_id: identity.topic_id,
      message_id: identity.id,
      message,
      attachments: [],
      local_checksum: checksum,
      repair: true,
    },
  };
}

async function queryCenterMessages(centerClient, identity, localMessages) {
  if (!centerClient || typeof centerClient.checkMessages !== "function") {
    return { skipped: true, resultsById: new Map() };
  }
  const request = localMessages.map((entry) => ({
    item_type: identity.item_type,
    item_id: identity.item_id,
    topic_id: identity.topic_id,
    message_id: entry.id,
    checksum: entry.checksum,
  }));
  const response = await centerClient.checkMessages(request);
  const resultsById = new Map();
  for (const result of response.results || []) {
    if (result && result.message_id) resultsById.set(result.message_id, result);
  }
  return { skipped: !!response.skipped, response, resultsById };
}

async function repairTopic(runtime, options = {}) {
  const { config, localIndex, offlineQueue, centerClient, logger } = runtime;
  const identity = {
    item_type: String(options.item_type || options.itemType || ""),
    item_id: String(options.item_id || options.itemId || ""),
    topic_id: String(options.topic_id || options.topicId || ""),
  };
  const dryRun = options.dryRun !== false && options.dry_run !== false;
  if (!identity.item_type || !identity.item_id || !identity.topic_id) {
    throw new Error("item_type, item_id and topic_id are required");
  }

  const historyPath = safeJoinAppData(
    config.appDataPath,
    "UserData",
    identity.item_id,
    "topics",
    identity.topic_id,
    "history.json"
  );
  const relativeHistoryPath = path
    .relative(config.appDataPath, historyPath)
    .replace(/\\/g, "/");
  const read = await readStableJson(historyPath);
  if (!read.ok || !Array.isArray(read.value)) {
    throw new Error(
      `history.json is not readable array: ${read.error || "invalid root"}`
    );
  }

  const localMessages = read.value
    .filter((message) => !isPlaceholderMessage(message))
    .map((message) => ({
      id: String(message.id),
      message,
      checksum: checksumJson(message),
      key: messageKey({ ...identity, id: String(message.id) }),
    }));

  const tKey = topicKeyOf(identity);
  const indexRows = localIndex.listMessagesByTopic(tKey);
  const queueRows = await readQueueRows(config.queuePath);
  const queuedIds = queueMessageIds(queueRows, identity);
  const centerTopicCheck = await queryCenterTopic(centerClient, identity).catch(
    (error) => {
      if (logger && logger.warn) {
        logger.warn(
          "repairTopic center topic check failed; falling back to message repair",
          {
            error: error.message,
            identity,
          }
        );
      }
      return { skipped: true, error: error.message, exists: null };
    }
  );
  const centerCheck = await queryCenterMessages(
    centerClient,
    identity,
    localMessages
  ).catch((error) => {
    if (logger && logger.warn) {
      logger.warn(
        "repairTopic center check failed; falling back to local metadata",
        {
          error: error.message,
          identity,
        }
      );
    }
    return { skipped: true, error: error.message, resultsById: new Map() };
  });

  const topicOperation =
    centerTopicCheck.exists === false
      ? await buildTopicUpsert(runtime, identity)
      : null;

  const missingInLocalIndex = [];
  const missingInCenter = [];
  const checksumConflicts = [];
  const toEnqueue = [];

  for (const entry of localMessages) {
    const indexRow = indexRows[entry.key] || null;
    const centerRow = centerCheck.resultsById.get(entry.id);
    if (!indexRow) missingInLocalIndex.push(entry.id);
    if (centerRow && centerRow.exists && centerRow.checksum_match === false) {
      checksumConflicts.push(entry.id);
      continue;
    }
    const centerMissing = centerRow
      ? centerRow.exists === false
      : !centerCheck.skipped
      ? true
      : false;
    if (centerMissing) missingInCenter.push(entry.id);

    const shouldRepairMessage =
      centerMissing || (centerCheck.skipped && !indexRow);
    if (!queuedIds.has(entry.id) && shouldRepairMessage) {
      toEnqueue.push(entry);
    }
  }

  let enqueued = [];
  if (!dryRun) {
    const operations = [];
    if (topicOperation) operations.push(topicOperation);
    operations.push(
      ...toEnqueue.map((entry) =>
        buildMessageCreate(identity, entry.message, config.deviceId)
      )
    );
    if (operations.length > 0) {
      enqueued = await offlineQueue.enqueueMany(operations, {
        mode: runtime.state.mode || "active",
      });
    }
  }

  return {
    ok: true,
    dryRun,
    item_type: identity.item_type,
    item_id: identity.item_id,
    topic_id: identity.topic_id,
    historyPath: relativeHistoryPath,
    local_count: localMessages.length,
    local_index_count: Object.keys(indexRows).length,
    queue_count: queuedIds.size,
    center_topic_check_skipped: !!centerTopicCheck.skipped,
    center_topic_exists: centerTopicCheck.exists,
    parent_topic_to_enqueue: topicOperation ? topicOperation.entity_id : null,
    center_check_skipped: !!centerCheck.skipped,
    missing_in_local_index: missingInLocalIndex,
    missing_in_center: missingInCenter,
    checksum_conflicts: checksumConflicts,
    to_enqueue: toEnqueue.map((entry) => entry.id),
    enqueued_count: enqueued.length,
    enqueued,
  };
}

module.exports = { repairTopic };
