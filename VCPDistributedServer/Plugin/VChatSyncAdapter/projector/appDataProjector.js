const path = require("path");
const fs = require("fs-extra");
const { atomicWriteJson } = require("./atomicWriter");
const {
  applyEventToHistory,
  updateIndexForMessageEvent,
  eventIdentity,
  topicKey,
} = require("./historyProjector");
const { checksumJson } = require("../core/hash");
const {
  normalizeSlashes,
  safeJoinAppData,
  assertInsideAppData,
} = require("../utils/pathRules");
const { rewriteMessageAttachments } = require("../sync/attachmentSync");
const { applyConfigEvents, readLocalConfig } = require("./configProjector");
const { applyAttachmentEvents } = require("./attachmentProjector");
const { applyEntityDeleteEvents } = require("./entityDeleteProjector");
const { applyAvatarEvents } = require("./avatarProjector");
const { applyThemeEvents } = require("./themeProjector");
const { CONFIG_SCHEMAS, cloneJsonValue } = require("../core/configSchema");

function configPathForTopicOwner(appDataPath, itemType, itemId) {
  if (!itemType || !itemId) return null;
  if (itemType === "agent") {
    return safeJoinAppData(appDataPath, "Agents", itemId, "config.json");
  }
  if (itemType === "group") {
    return safeJoinAppData(appDataPath, "AgentGroups", itemId, "config.json");
  }
  return null;
}

function topicIdOf(topic) {
  return topic && (topic.id || topic.topic_id || topic.topicId);
}

function topicCreatedAt(topic) {
  const value = Number(
    topic && (topic.createdAt || topic.created_at || topic.timestamp || 0)
  );
  return Number.isFinite(value) ? value : 0;
}

function topicMetaFromEvent(event, identity = {}) {
  const payload = event.payload || {};
  const message = payload.message || {};
  const rawTopic =
    payload.topic &&
    typeof payload.topic === "object" &&
    !Array.isArray(payload.topic)
      ? payload.topic
      : message.topic &&
        typeof message.topic === "object" &&
        !Array.isArray(message.topic)
      ? message.topic
      : {};
  const topic = cloneJsonValue(rawTopic) || {};
  const topicId =
    identity.topic_id ||
    event.topic_id ||
    payload.topic_id ||
    payload.topicId ||
    topic.id ||
    topic.topic_id ||
    topic.topicId ||
    event.entity_id ||
    payload.id;
  const name =
    payload.name ||
    payload.title ||
    payload.topic_title ||
    payload.topicTitle ||
    topic.name ||
    topic.title ||
    topic.topic_title ||
    topic.topicTitle ||
    topicId;
  const createdAt =
    topic.createdAt ||
    topic.created_at ||
    payload.createdAt ||
    payload.created_at ||
    payload.timestamp ||
    message.timestamp ||
    Date.now();
  return {
    ...topic,
    id: String(topicId || ""),
    name: String(name || topicId || "新话题"),
    createdAt,
    locked:
      topic.locked !== undefined
        ? topic.locked
        : payload.locked !== undefined
        ? Boolean(payload.locked)
        : true,
    unread:
      topic.unread !== undefined
        ? topic.unread
        : payload.unread !== undefined
        ? Boolean(payload.unread)
        : false,
    creatorSource:
      topic.creatorSource ||
      topic.creator_source ||
      payload.creatorSource ||
      payload.creator_source ||
      "sync",
  };
}

async function writeOwnerConfig(context, identity, nextConfig) {
  const { config, writeIntentLock, localIndex, logger } = context;
  const filePath = configPathForTopicOwner(
    config.appDataPath,
    identity.item_type,
    identity.item_id
  );
  if (!filePath) return false;
  const expectedChecksum = checksumJson(nextConfig);
  const relativePath = assertInsideAppData(config.appDataPath, filePath);
  await writeIntentLock.record({
    relative_path: relativePath,
    filePath,
    source: "sync_projector",
    expectedChecksum,
    ttl_ms: 60000,
    expireAt: Date.now() + 60000,
  });
  await atomicWriteJson(filePath, nextConfig, { logger });
  await localIndex.setFile(relativePath, {
    kind: "config",
    checksum: expectedChecksum,
    last_known_checksum: expectedChecksum,
    local_projection_checksum: expectedChecksum,
    snapshot_json: nextConfig,
    updated_at: new Date().toISOString(),
  });
  return true;
}

async function upsertTopicInOwnerConfig(context, identity, topicMeta) {
  const filePath = configPathForTopicOwner(
    context.config.appDataPath,
    identity.item_type,
    identity.item_id
  );
  if (!filePath || !topicMeta.id) return false;
  const localConfig = await readLocalConfig(filePath);
  const topics = Array.isArray(localConfig.topics)
    ? localConfig.topics.map((topic) => cloneJsonValue(topic))
    : [];
  const incomingId = String(topicMeta.id);
  let found = false;
  const nextTopics = topics.map((topic) => {
    const id = topicIdOf(topic);
    if (!id || String(id) !== incomingId) return topic;
    found = true;
    return {
      ...topic,
      ...cloneJsonValue(topicMeta),
      id: topic.id || incomingId,
    };
  });
  if (!found) {
    nextTopics.unshift(cloneJsonValue(topicMeta));
    nextTopics.sort((a, b) => topicCreatedAt(b) - topicCreatedAt(a));
  }
  return writeOwnerConfig(context, identity, {
    ...localConfig,
    topics: nextTopics,
  });
}

async function requireTopicInOwnerConfig(context, identity) {
  const filePath = configPathForTopicOwner(
    context.config.appDataPath,
    identity.item_type,
    identity.item_id
  );
  if (!filePath) {
    const error = new Error(
      `message parent owner config missing for topic ${identity.topic_id}`
    );
    error.failedSeq = identity.seq;
    throw error;
  }
  const localConfig = await readLocalConfig(filePath);
  const topics = Array.isArray(localConfig.topics) ? localConfig.topics : [];
  const found = topics.some(
    (topic) =>
      String(topicIdOf(topic) || "") === String(identity.topic_id || "")
  );
  if (!found) {
    const error = new Error(
      `message parent topic missing in owner config: ${identity.item_type}:${identity.item_id}:${identity.topic_id}`
    );
    error.failedSeq = identity.seq;
    throw error;
  }
  return true;
}

function uniqueTopicIds(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const id = String(value || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function reorderTopics(topics, orderEvent) {
  const payload = orderEvent.payload || {};
  const identity =
    orderEvent._topicOrderIdentity || topicOrderIdentityFromEvent(orderEvent);
  const list = Array.isArray(topics)
    ? topics.map((topic) => cloneJsonValue(topic))
    : [];
  const byId = new Map();
  const withoutMoved = [];
  for (const topic of list) {
    const id = topicIdOf(topic);
    if (id) byId.set(String(id), topic);
    if (!identity.topic_id || String(id || "") !== String(identity.topic_id)) {
      withoutMoved.push(topic);
    }
  }

  if (orderEvent.action === "replace") {
    const orderedIds = uniqueTopicIds(
      payload.topics_order || payload.order || []
    );
    const used = new Set();
    const ordered = [];
    for (const id of orderedIds) {
      const topic = byId.get(id);
      if (!topic) continue;
      ordered.push(topic);
      used.add(id);
    }
    for (const topic of list) {
      const id = topicIdOf(topic);
      if (!id || used.has(String(id))) continue;
      ordered.push(topic);
    }
    return ordered;
  }

  if (orderEvent.action !== "move" || !identity.topic_id) return list;
  const moved = byId.get(String(identity.topic_id));
  if (!moved) return list;
  const mode = String(payload.mode || payload.position || "move_to_front");
  if (mode === "move_before") {
    const beforeId = String(
      payload.before_topic_id || payload.beforeTopicId || ""
    );
    const index = withoutMoved.findIndex(
      (topic) => String(topicIdOf(topic) || "") === beforeId
    );
    if (index >= 0) withoutMoved.splice(index, 0, moved);
    else withoutMoved.unshift(moved);
    return withoutMoved;
  }
  if (mode === "move_after") {
    const afterId = String(
      payload.after_topic_id || payload.afterTopicId || ""
    );
    const index = withoutMoved.findIndex(
      (topic) => String(topicIdOf(topic) || "") === afterId
    );
    if (index >= 0) withoutMoved.splice(index + 1, 0, moved);
    else withoutMoved.unshift(moved);
    return withoutMoved;
  }
  return [moved, ...withoutMoved];
}

function topicOrderSource(orderEvent) {
  const payload = orderEvent.payload || {};
  return String(payload.source || orderEvent.source || "manual");
}

function topicOrderMode(orderEvent) {
  const payload = orderEvent.payload || {};
  return String(payload.mode || payload.position || "move_to_front");
}

function pendingActivityKey(identity) {
  return `${identity.item_type}:${identity.item_id}:${identity.topic_id}`;
}

function ensurePendingTopicActivityOrder(context) {
  if (!context.config._pendingTopicActivityOrder) {
    Object.defineProperty(context.config, "_pendingTopicActivityOrder", {
      value: new Map(),
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return context.config._pendingTopicActivityOrder;
}

function recordPendingTopicActivityOrder(context, event, identity) {
  if (!identity.item_type || !identity.item_id || !identity.topic_id)
    return false;
  const pending = ensurePendingTopicActivityOrder(context);
  const payload = event.payload || {};
  const activityAt = Number(
    payload.activity_at ||
      payload.activityAt ||
      payload.updated_at ||
      payload.updatedAt ||
      event.created_at ||
      event.createdAt ||
      event.seq ||
      Date.now()
  );
  const key = pendingActivityKey(identity);
  const previous = pending.get(key);
  if (previous && Number(previous.activity_at || 0) > activityAt) return true;
  pending.set(key, {
    ...identity,
    activity_at: Number.isFinite(activityAt) ? activityAt : Date.now(),
    seq: Number(event.seq || 0),
    device_id: event.device_id || null,
    recorded_at: new Date().toISOString(),
  });
  return true;
}

function sameTopicOrder(leftTopics, rightTopics) {
  const left = Array.isArray(leftTopics) ? leftTopics : [];
  const right = Array.isArray(rightTopics) ? rightTopics : [];
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (
      String(topicIdOf(left[index]) || "") !==
      String(topicIdOf(right[index]) || "")
    ) {
      return false;
    }
  }
  return true;
}

function applyActivityOrderToTopics(topics, pendingItems) {
  const list = Array.isArray(topics) ? topics.slice() : [];
  const byId = new Map();
  for (const topic of list) {
    const id = topicIdOf(topic);
    if (id) byId.set(String(id), topic);
  }
  const activeIds = uniqueTopicIds(
    pendingItems
      .slice()
      .sort((a, b) => {
        const activityDelta =
          Number(b.activity_at || 0) - Number(a.activity_at || 0);
        if (activityDelta !== 0) return activityDelta;
        return Number(b.seq || 0) - Number(a.seq || 0);
      })
      .map((item) => item.topic_id)
  ).filter((id) => byId.has(String(id)));
  if (activeIds.length === 0) return list;
  const activeSet = new Set(activeIds.map((id) => String(id)));
  const next = [];
  for (const id of activeIds) next.push(byId.get(String(id)));
  for (const topic of list) {
    const id = topicIdOf(topic);
    if (!id || !activeSet.has(String(id))) next.push(topic);
  }
  return next;
}

async function applyPendingTopicActivityOrder(context, filter = {}) {
  const pending = ensurePendingTopicActivityOrder(context);
  const groups = new Map();
  for (const [key, item] of pending.entries()) {
    if (filter.item_type && item.item_type !== filter.item_type) continue;
    if (filter.item_id && item.item_id !== filter.item_id) continue;
    const ownerKey = `${item.item_type}:${item.item_id}`;
    if (!groups.has(ownerKey)) groups.set(ownerKey, []);
    groups.get(ownerKey).push({ key, item });
  }

  const maxOwners = Math.max(
    1,
    Number(context.config.topicActivityOrderMaxOwnersPerRun || 3)
  );
  let scannedOwners = 0;
  let appliedOwners = 0;
  let appliedTopics = 0;
  for (const entries of groups.values()) {
    if (scannedOwners >= maxOwners) break;
    scannedOwners += 1;
    const identity = entries[0].item;
    const filePath = configPathForTopicOwner(
      context.config.appDataPath,
      identity.item_type,
      identity.item_id
    );
    if (!filePath) continue;
    const localConfig = await readLocalConfig(filePath);
    const currentTopics = Array.isArray(localConfig.topics)
      ? localConfig.topics
      : [];
    const nextTopics = applyActivityOrderToTopics(
      currentTopics,
      entries.map((entry) => entry.item)
    );
    const changed = !sameTopicOrder(currentTopics, nextTopics);
    if (changed) {
      await writeOwnerConfig(context, identity, {
        ...localConfig,
        topics: nextTopics,
      });
      appliedOwners += 1;
    }
    for (const entry of entries) pending.delete(entry.key);
    appliedTopics += entries.length;
  }
  return {
    ok: true,
    owners: appliedOwners,
    scanned_owners: scannedOwners,
    deferred_owners: Math.max(0, groups.size - scannedOwners),
    topics: appliedTopics,
    pending: pending.size,
  };
}

async function applyTopicOrderEvent(context, event) {
  const identity =
    event._topicOrderIdentity || topicOrderIdentityFromEvent(event);
  if (
    event.action === "move" &&
    topicOrderSource(event) === "activity" &&
    topicOrderMode(event) === "move_to_front"
  ) {
    return recordPendingTopicActivityOrder(context, event, identity);
  }
  const filePath = configPathForTopicOwner(
    context.config.appDataPath,
    identity.item_type,
    identity.item_id
  );
  if (!filePath) return false;
  const localConfig = await readLocalConfig(filePath);
  const nextTopics = reorderTopics(localConfig.topics, event);
  return writeOwnerConfig(context, identity, {
    ...localConfig,
    topics: nextTopics,
  });
}

function topicIdentityFromTopicEvent(event) {
  const payload = event.payload || {};
  const itemType = String(
    event.item_type || payload.item_type || payload.owner_type || ""
  );
  const itemId = String(
    event.item_id || payload.item_id || payload.owner_id || ""
  );
  const topicId = String(
    event.topic_id ||
      payload.topic_id ||
      payload.topicId ||
      event.entity_id ||
      payload.id ||
      ""
  );
  return { item_type: itemType, item_id: itemId, topic_id: topicId };
}

function topicOrderIdentityFromEvent(event) {
  const payload = event.payload || {};
  return {
    item_type: String(
      event.item_type || payload.item_type || payload.owner_type || ""
    ),
    item_id: String(
      event.item_id ||
        payload.item_id ||
        payload.owner_id ||
        event.entity_id ||
        ""
    ),
    topic_id: String(
      event.topic_id || payload.topic_id || payload.topicId || ""
    ),
  };
}

function historyPathFor(appDataPath, identity) {
  return path.join(
    appDataPath,
    "UserData",
    encodeURIComponent(identity.item_id),
    "topics",
    encodeURIComponent(identity.topic_id),
    "history.json"
  );
}

function groupEvents(events) {
  const topicBuckets = new Map();
  const configEvents = [];
  const attachmentEvents = [];
  const entityDeleteEvents = [];
  const avatarEvents = [];
  const themeEvents = [];
  const topicOrderEvents = [];
  const unsupportedEvents = [];

  for (const event of events) {
    if (event.entity_type === "message") {
      const identity = eventIdentity(event);
      const key = topicKey(identity);
      if (
        !identity.item_type ||
        !identity.item_id ||
        !identity.topic_id ||
        !identity.id
      ) {
        unsupportedEvents.push(event);
        continue;
      }
      if (!topicBuckets.has(key))
        topicBuckets.set(key, { identity, events: [] });
      topicBuckets.get(key).events.push(event);
    } else if (
      (event.entity_type === "topic" ||
        event.entity_type === "topic_history" ||
        event.entity_type === "item" ||
        event.entity_type === "group_member") &&
      event.action === "delete"
    ) {
      entityDeleteEvents.push(event);
    } else if (
      event.entity_type === "topic" &&
      ["create", "update", "upsert"].includes(event.action)
    ) {
      const identity = topicIdentityFromTopicEvent(event);
      if (!identity.item_type || !identity.item_id || !identity.topic_id) {
        unsupportedEvents.push(event);
        continue;
      }
      configEvents.push({ ...event, _topicUpsertIdentity: identity });
    } else if (event.entity_type === "topic_order") {
      const identity = topicOrderIdentityFromEvent(event);
      if (!identity.item_type || !identity.item_id) {
        unsupportedEvents.push(event);
        continue;
      }
      topicOrderEvents.push({ ...event, _topicOrderIdentity: identity });
    } else if (CONFIG_SCHEMAS[event.entity_type]) {
      configEvents.push(event);
    } else if (event.entity_type === "attachment") {
      attachmentEvents.push(event);
    } else if (event.entity_type === "avatar") {
      avatarEvents.push(event);
    } else if (
      event.entity_type === "theme_package" ||
      event.entity_type === "theme_asset"
    ) {
      themeEvents.push(event);
    } else {
      unsupportedEvents.push(event);
    }
  }

  return {
    topicBuckets,
    configEvents,
    attachmentEvents,
    entityDeleteEvents,
    avatarEvents,
    themeEvents,
    topicOrderEvents,
    unsupportedEvents,
  };
}

async function readHistoryArray(filePath) {
  if (!(await fs.pathExists(filePath))) return [];
  const value = await fs.readJson(filePath);
  if (!Array.isArray(value))
    throw new Error(`history.json root must be array: ${filePath}`);
  return value;
}

async function prepareTopicBucket(bucket, context) {
  const { config } = context;
  await requireTopicInOwnerConfig(context, {
    ...bucket.identity,
    seq: bucket.events[0] && bucket.events[0].seq,
  });
  const filePath = historyPathFor(config.appDataPath, bucket.identity);
  const history = await readHistoryArray(filePath);
  const applied = [];
  for (const event of bucket.events) {
    const result = applyEventToHistory(history, event);
    if (result && result.message) {
      result.message = await rewriteMessageAttachments(result.message, context);
    }
    applied.push({ seq: event.seq, event, result });
  }
  const expectedChecksum = checksumJson(history);
  const relativePath = normalizeSlashes(
    path.relative(config.appDataPath, filePath)
  );
  return { bucket, filePath, relativePath, history, expectedChecksum, applied };
}

async function commitPreparedTopic(prepared, context) {
  const { localIndex, writeIntentLock, logger } = context;
  await writeIntentLock.record({
    relative_path: prepared.relativePath,
    filePath: prepared.filePath,
    source: "sync_projector",
    expectedChecksum: prepared.expectedChecksum,
    ttl_ms: 60000,
    expireAt: Date.now() + 60000,
  });
  await atomicWriteJson(prepared.filePath, prepared.history, { logger });
  await localIndex.batchUpdate(async () => {
    for (const item of prepared.applied) {
      await updateIndexForMessageEvent(localIndex, item.event, item.result);
    }
    await localIndex.setTopicSnapshot(topicKey(prepared.bucket.identity), {
      topic_key: topicKey(prepared.bucket.identity),
      message_count: prepared.history.length,
      local_projection_checksum: prepared.expectedChecksum,
      last_projected_seq:
        prepared.bucket.events[prepared.bucket.events.length - 1].seq,
      projected_at: new Date().toISOString(),
    });
  });
  return {
    filePath: prepared.filePath,
    relativePath: prepared.relativePath,
    applied: prepared.applied,
  };
}

async function projectEvents(events, context) {
  if (!Array.isArray(events) || events.length === 0) {
    return {
      appliedSeqs: [],
      failedSeq: null,
      topics: 0,
      configs: 0,
      attachments: 0,
      entityDeletes: 0,
      themes: 0,
      skipped: 0,
    };
  }

  const sorted = [...events].sort((a, b) => Number(a.seq) - Number(b.seq));
  const appliedSeqs = [];
  const counts = {
    topics: 0,
    configs: 0,
    attachments: 0,
    entityDeletes: 0,
    themes: 0,
    skipped: 0,
  };

  try {
    for (const event of sorted) {
      const {
        topicBuckets,
        configEvents,
        attachmentEvents,
        entityDeleteEvents,
        avatarEvents,
        themeEvents,
        topicOrderEvents,
        unsupportedEvents,
      } = groupEvents([event]);

      if (
        event.action === "delete" &&
        event.payload &&
        event.payload.cascaded_from
      ) {
        if (context.logger && context.logger.debug) {
          context.logger.debug("projector skipped cascaded delete event", {
            seq: event.seq,
            entity_type: event.entity_type,
            cascaded_from: event.payload.cascaded_from,
            parent_entity_type: event.payload.parent_entity_type,
            parent_entity_id: event.payload.parent_entity_id,
          });
        }
        counts.skipped += 1;
        appliedSeqs.push(event.seq);
        continue;
      }

      if (unsupportedEvents.length > 0) {
        if (context.logger && context.logger.warn) {
          context.logger.warn("projector skipped unsupported events", {
            count: unsupportedEvents.length,
          });
        }
        const error = new Error(
          `unsupported projector event at seq ${event.seq}`
        );
        error.failedSeq = event.seq;
        throw error;
      }

      if (entityDeleteEvents.length > 0) {
        const entityDeleteProjection = await applyEntityDeleteEvents(
          entityDeleteEvents,
          context
        );
        counts.entityDeletes += entityDeleteProjection.applied;
        counts.topics += entityDeleteProjection.applied;
        appliedSeqs.push(event.seq);
        continue;
      }

      if (topicOrderEvents.length > 0) {
        for (const topicOrderEvent of topicOrderEvents) {
          await applyTopicOrderEvent(context, topicOrderEvent);
        }
        counts.configs += topicOrderEvents.length;
        appliedSeqs.push(event.seq);
        continue;
      }

      if (configEvents.length > 0) {
        const topicUpsertEvents = configEvents.filter(
          (item) => item._topicUpsertIdentity
        );
        const regularConfigEvents = configEvents.filter(
          (item) => !item._topicUpsertIdentity
        );
        for (const topicEvent of topicUpsertEvents) {
          await upsertTopicInOwnerConfig(
            context,
            topicEvent._topicUpsertIdentity,
            topicMetaFromEvent(topicEvent, topicEvent._topicUpsertIdentity)
          );
        }
        if (regularConfigEvents.length > 0) {
          await applyConfigEvents(regularConfigEvents, context);
        }
        counts.configs += configEvents.length;
        appliedSeqs.push(event.seq);
        continue;
      }

      if (attachmentEvents.length > 0) {
        await applyAttachmentEvents(attachmentEvents, context);
        counts.attachments += attachmentEvents.length;
        appliedSeqs.push(event.seq);
        continue;
      }

      if (avatarEvents.length > 0) {
        const avatarProjection = await applyAvatarEvents(avatarEvents, context);
        counts.attachments += avatarProjection.applied;
        appliedSeqs.push(event.seq);
        continue;
      }

      if (themeEvents.length > 0) {
        const themeProjection = await applyThemeEvents(themeEvents, context);
        counts.themes += themeProjection.applied;
        appliedSeqs.push(event.seq);
        continue;
      }

      for (const bucket of topicBuckets.values()) {
        const prepared = await prepareTopicBucket(bucket, context);
        const committed = await commitPreparedTopic(prepared, context);
        counts.topics += 1;
        for (const item of committed.applied) appliedSeqs.push(item.seq);
      }
    }

    appliedSeqs.sort((a, b) => Number(a) - Number(b));
    return {
      appliedSeqs,
      failedSeq: null,
      ...counts,
    };
  } catch (error) {
    const failedSeq =
      error.failedSeq !== undefined
        ? { seq: error.failedSeq }
        : sorted.find((event) => !appliedSeqs.includes(event.seq));
    return {
      appliedSeqs,
      failedSeq: failedSeq ? failedSeq.seq : null,
      error,
      ...counts,
    };
  }
}

module.exports = {
  projectEvents,
  groupEvents,
  historyPathFor,
  upsertTopicInOwnerConfig,
  topicIdentityFromTopicEvent,
  applyPendingTopicActivityOrder,
};
