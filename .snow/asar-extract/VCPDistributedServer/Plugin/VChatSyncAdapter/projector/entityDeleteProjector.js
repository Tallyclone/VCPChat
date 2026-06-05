const path = require("path");
const fs = require("fs-extra");
const { atomicWriteJson } = require("./atomicWriter");
const { checksumJson } = require("../core/hash");
const {
  assertInsideAppData,
  assertSafePathSegment,
  safeJoinAppData,
} = require("../utils/pathRules");

function entityPayload(event) {
  return event.payload || {};
}

function topicIdentity(event) {
  const payload = entityPayload(event);
  const itemType = String(event.item_type || payload.item_type || "");
  const itemId = String(event.item_id || payload.item_id || "");
  const topicId = String(
    event.topic_id ||
      payload.topic_id ||
      event.entity_id ||
      payload.entity_id ||
      ""
  );
  return { item_type: itemType, item_id: itemId, topic_id: topicId };
}

function itemIdentity(event) {
  const payload = entityPayload(event);
  const itemType = String(event.item_type || payload.item_type || "");
  const itemId = String(
    event.item_id ||
      payload.item_id ||
      event.entity_id ||
      payload.entity_id ||
      ""
  );
  return { item_type: itemType, item_id: itemId };
}

function topicKey(identity) {
  return `${identity.item_type}:${identity.item_id}:${identity.topic_id}`;
}

function historyPathForTopic(appDataPath, identity) {
  return safeJoinAppData(
    appDataPath,
    "UserData",
    encodeURIComponent(identity.item_id),
    "topics",
    encodeURIComponent(identity.topic_id),
    "history.json"
  );
}

function itemUserDataTopicsPath(appDataPath, identity) {
  return safeJoinAppData(
    appDataPath,
    "UserData",
    encodeURIComponent(identity.item_id),
    "topics"
  );
}

function configPathForItem(appDataPath, identity) {
  const itemId = assertSafePathSegment(identity.item_id, "item_id");
  if (identity.item_type === "agent") {
    return safeJoinAppData(appDataPath, "Agents", itemId, "config.json");
  }
  if (identity.item_type === "group") {
    return safeJoinAppData(appDataPath, "AgentGroups", itemId, "config.json");
  }
  return null;
}

function validateTopicDelete(event, identity) {
  if (event.action !== "delete") {
    throw new Error(
      `unsupported topic delete projector action at seq ${event.seq}`
    );
  }
  if (!identity.item_type || !identity.item_id || !identity.topic_id) {
    throw new Error(`invalid topic delete identity at seq ${event.seq}`);
  }
}

function validateItemDelete(event, identity) {
  if (event.action !== "delete") {
    throw new Error(
      `unsupported item delete projector action at seq ${event.seq}`
    );
  }
  if (!identity.item_type || !identity.item_id) {
    throw new Error(`invalid item delete identity at seq ${event.seq}`);
  }
}

async function applyTopicDeleteEvent(event, context) {
  const { config, localIndex, writeIntentLock, logger } = context;
  const identity = topicIdentity(event);
  validateTopicDelete(event, identity);

  const filePath = historyPathForTopic(config.appDataPath, identity);
  const relativePath = assertInsideAppData(config.appDataPath, filePath);
  const expectedChecksum = checksumJson([]);
  await writeIntentLock.record({
    relative_path: relativePath,
    filePath,
    source: "sync_projector",
    expectedChecksum,
    ttl_ms: 60000,
    expireAt: Date.now() + 60000,
  });
  await atomicWriteJson(filePath, [], { logger });
  await localIndex.batchUpdate(async () => {
    const key = topicKey(identity);
    await localIndex.deleteMessagesByTopic(key);
    await localIndex.deleteTopicSnapshot(key);
  });
  return { seq: event.seq, kind: "topic", relativePath };
}

async function clearTopicHistoriesForItem(identity, context) {
  const { config, writeIntentLock, logger } = context;
  const topicsDir = itemUserDataTopicsPath(config.appDataPath, identity);
  if (!(await fs.pathExists(topicsDir))) return 0;
  const entries = await fs.readdir(topicsDir);
  let cleared = 0;
  for (const entry of entries) {
    const topicDir = path.join(topicsDir, entry);
    const stat = await fs.stat(topicDir).catch(() => null);
    if (!stat || !stat.isDirectory()) continue;
    const filePath = path.join(topicDir, "history.json");
    const relativePath = assertInsideAppData(config.appDataPath, filePath);
    const expectedChecksum = checksumJson([]);
    await writeIntentLock.record({
      relative_path: relativePath,
      filePath,
      source: "sync_projector",
      expectedChecksum,
      ttl_ms: 60000,
      expireAt: Date.now() + 60000,
    });
    await atomicWriteJson(filePath, [], { logger });
    cleared += 1;
  }
  return cleared;
}

async function removeItemConfig(identity, context) {
  const { config, localIndex, writeIntentLock } = context;
  const filePath = configPathForItem(config.appDataPath, identity);
  if (!filePath) return null;
  const relativePath = assertInsideAppData(config.appDataPath, filePath);
  await writeIntentLock.record({
    relative_path: relativePath,
    filePath,
    source: "sync_projector",
    expectedChecksum: null,
    ttl_ms: 60000,
    expireAt: Date.now() + 60000,
  });
  await fs.remove(filePath);
  await localIndex.deleteFile(relativePath);
  return relativePath;
}

async function applyItemDeleteEvent(event, context) {
  const { localIndex } = context;
  const identity = itemIdentity(event);
  validateItemDelete(event, identity);

  const clearedTopics = await clearTopicHistoriesForItem(identity, context);
  const removedConfig = await removeItemConfig(identity, context);
  await localIndex.batchUpdate(async () => {
    await localIndex.deleteMessagesByItem(identity.item_type, identity.item_id);
    await localIndex.deleteTopicSnapshotsByItem(
      identity.item_type,
      identity.item_id
    );
  });
  return { seq: event.seq, kind: "item", clearedTopics, removedConfig };
}

async function applyEntityDeleteEvents(events, context) {
  const applied = [];
  for (const event of events) {
    if (event.entity_type === "topic") {
      applied.push(await applyTopicDeleteEvent(event, context));
    } else if (event.entity_type === "item") {
      applied.push(await applyItemDeleteEvent(event, context));
    }
  }
  return { applied: applied.length, results: applied };
}

module.exports = {
  applyEntityDeleteEvents,
  applyTopicDeleteEvent,
  applyItemDeleteEvent,
  topicIdentity,
  itemIdentity,
};
