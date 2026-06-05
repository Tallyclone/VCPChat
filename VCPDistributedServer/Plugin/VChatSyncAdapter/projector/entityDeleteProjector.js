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

function groupMemberIdentity(event) {
  const payload = entityPayload(event);
  const groupId = String(
    event.item_id ||
      payload.group_id ||
      payload.item_id ||
      payload.groupId ||
      ""
  );
  const memberId = String(
    event.member_id ||
      event.entity_id ||
      payload.member_id ||
      payload.memberId ||
      ""
  );
  return { item_type: "group", item_id: groupId, member_id: memberId };
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

function itemDirectoryPath(appDataPath, identity) {
  const itemId = assertSafePathSegment(identity.item_id, "item_id");
  if (identity.item_type === "agent") {
    return safeJoinAppData(appDataPath, "Agents", itemId);
  }
  if (identity.item_type === "group") {
    return safeJoinAppData(appDataPath, "AgentGroups", itemId);
  }
  return null;
}

function itemUserDataPath(appDataPath, identity) {
  const itemId = assertSafePathSegment(identity.item_id, "item_id");
  return safeJoinAppData(appDataPath, "UserData", itemId);
}

function topicIdOf(topic) {
  return topic && (topic.id || topic.topic_id || topic.topicId);
}

async function updateConfigFile(context, filePath, mutator) {
  const { config, localIndex, writeIntentLock, logger } = context;
  if (!filePath || !(await fs.pathExists(filePath))) return false;
  const localConfig = await fs.readJson(filePath);
  if (
    !localConfig ||
    typeof localConfig !== "object" ||
    Array.isArray(localConfig)
  ) {
    return false;
  }
  const next = mutator({ ...localConfig });
  if (!next) return false;
  const expectedChecksum = checksumJson(next);
  const relativePath = assertInsideAppData(config.appDataPath, filePath);
  await writeIntentLock.record({
    relative_path: relativePath,
    filePath,
    source: "sync_projector",
    expectedChecksum,
    ttl_ms: 60000,
    expireAt: Date.now() + 60000,
  });
  await atomicWriteJson(filePath, next, { logger });
  await localIndex.setFile(relativePath, {
    kind: "config",
    checksum: expectedChecksum,
    last_known_checksum: expectedChecksum,
    local_projection_checksum: expectedChecksum,
    snapshot_json: next,
    last_applied_seq: null,
    updated_at: new Date().toISOString(),
  });
  return true;
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

async function clearTopicHistoryFile(event, context) {
  const { config, localIndex, writeIntentLock, logger } = context;
  const identity = topicIdentity(event);
  validateTopicDelete(event, identity);

  const filePath = historyPathForTopic(config.appDataPath, identity);
  const relativePath = assertInsideAppData(config.appDataPath, filePath);
  const existed = await fs.pathExists(filePath);
  if (existed) {
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
  }
  await localIndex.deleteMessagesByTopic(topicKey(identity));
  return { identity, relativePath, cleared: existed };
}

async function removeTopicDirectory(event, context) {
  const { config, localIndex, writeIntentLock } = context;
  const identity = topicIdentity(event);
  validateTopicDelete(event, identity);

  const filePath = historyPathForTopic(config.appDataPath, identity);
  const topicDir = path.dirname(filePath);
  const relativePath = assertInsideAppData(config.appDataPath, topicDir);
  const existed = await fs.pathExists(topicDir);
  if (existed) {
    await writeIntentLock.record({
      relative_path: relativePath,
      filePath: topicDir,
      source: "sync_projector",
      expectedChecksum: null,
      ttl_ms: 60000,
      expireAt: Date.now() + 60000,
    });
    await fs.remove(topicDir);
  }
  await localIndex.deleteMessagesByTopic(topicKey(identity));
  return { identity, relativePath, removed: existed };
}

async function applyTopicDeleteEvent(event, context) {
  const { localIndex } = context;
  const { identity, relativePath, removed } = await removeTopicDirectory(
    event,
    context
  );
  await updateConfigFile(
    context,
    configPathForItem(context.config.appDataPath, identity),
    (localConfig) => {
      if (!Array.isArray(localConfig.topics)) return null;
      const nextTopics = localConfig.topics.filter(
        (topic) => String(topicIdOf(topic)) !== String(identity.topic_id)
      );
      if (nextTopics.length === localConfig.topics.length) return null;
      return { ...localConfig, topics: nextTopics };
    }
  );
  await localIndex.deleteTopicSnapshot(topicKey(identity));
  return { seq: event.seq, kind: "topic", relativePath, removed };
}

async function applyTopicHistoryDeleteEvent(event, context) {
  const { relativePath, cleared } = await clearTopicHistoryFile(event, context);
  return { seq: event.seq, kind: "topic_history", relativePath, cleared };
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

async function removeItemDirectory(identity, context) {
  const { config, writeIntentLock } = context;
  const dirPath = itemDirectoryPath(config.appDataPath, identity);
  if (!dirPath) return null;
  const relativePath = assertInsideAppData(config.appDataPath, dirPath);
  await writeIntentLock.record({
    relative_path: relativePath,
    filePath: dirPath,
    source: "sync_projector",
    expectedChecksum: null,
    ttl_ms: 60000,
    expireAt: Date.now() + 60000,
  });
  await fs.remove(dirPath);
  return relativePath;
}

async function removeItemUserData(identity, context) {
  const { config, writeIntentLock } = context;
  const dataPath = itemUserDataPath(config.appDataPath, identity);
  const relativePath = assertInsideAppData(config.appDataPath, dataPath);
  await writeIntentLock.record({
    relative_path: relativePath,
    filePath: dataPath,
    source: "sync_projector",
    expectedChecksum: null,
    ttl_ms: 60000,
    expireAt: Date.now() + 60000,
  });
  await fs.remove(dataPath);
  return relativePath;
}

async function applyItemDeleteEvent(event, context) {
  const { localIndex } = context;
  const identity = itemIdentity(event);
  validateItemDelete(event, identity);

  const clearedTopics = await clearTopicHistoriesForItem(identity, context);
  const removedConfig = await removeItemConfig(identity, context);
  const removedDir = await removeItemDirectory(identity, context);
  const removedUserData = await removeItemUserData(identity, context);
  await localIndex.batchUpdate(async () => {
    await localIndex.deleteMessagesByItem(identity.item_type, identity.item_id);
    await localIndex.deleteTopicSnapshotsByItem(
      identity.item_type,
      identity.item_id
    );
  });
  return {
    seq: event.seq,
    kind: "item",
    clearedTopics,
    removedConfig,
    removedDir,
    removedUserData,
  };
}

async function applyGroupMemberDeleteEvent(event, context) {
  const identity = groupMemberIdentity(event);
  if (!identity.item_id || !identity.member_id) {
    throw new Error(`invalid group member delete identity at seq ${event.seq}`);
  }
  const filePath = configPathForItem(context.config.appDataPath, identity);
  const changed = await updateConfigFile(context, filePath, (localConfig) => {
    const members = Array.isArray(localConfig.members)
      ? localConfig.members
      : [];
    const nextMembers = members.filter(
      (member) => String(member) !== identity.member_id
    );
    const memberTags =
      localConfig.memberTags &&
      typeof localConfig.memberTags === "object" &&
      !Array.isArray(localConfig.memberTags)
        ? { ...localConfig.memberTags }
        : null;
    const hadMember = nextMembers.length !== members.length;
    const hadTags =
      memberTags &&
      Object.prototype.hasOwnProperty.call(memberTags, identity.member_id);
    if (!hadMember && !hadTags) return null;
    if (memberTags) delete memberTags[identity.member_id];
    const next = { ...localConfig, members: nextMembers };
    if (memberTags) next.memberTags = memberTags;
    return next;
  });
  return { seq: event.seq, kind: "group_member", changed };
}

async function applyEntityDeleteEvents(events, context) {
  const applied = [];
  for (const event of events) {
    if (event.entity_type === "topic") {
      applied.push(await applyTopicDeleteEvent(event, context));
    } else if (event.entity_type === "topic_history") {
      applied.push(await applyTopicHistoryDeleteEvent(event, context));
    } else if (event.entity_type === "item") {
      applied.push(await applyItemDeleteEvent(event, context));
    } else if (event.entity_type === "group_member") {
      applied.push(await applyGroupMemberDeleteEvent(event, context));
    }
  }
  return { applied: applied.length, results: applied };
}

module.exports = {
  applyEntityDeleteEvents,
  applyTopicDeleteEvent,
  applyTopicHistoryDeleteEvent,
  applyItemDeleteEvent,
  applyGroupMemberDeleteEvent,
  topicIdentity,
  itemIdentity,
  groupMemberIdentity,
};
