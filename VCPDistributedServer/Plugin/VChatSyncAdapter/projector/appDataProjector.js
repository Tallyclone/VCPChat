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
const { normalizeSlashes } = require("../utils/pathRules");
const { rewriteMessageAttachments } = require("../sync/attachmentSync");
const { applyConfigEvents } = require("./configProjector");
const { applyAttachmentEvents } = require("./attachmentProjector");

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
      String(event.entity_type || "").includes("config") ||
      event.entity_type === "settings"
    ) {
      configEvents.push(event);
    } else if (event.entity_type === "attachment") {
      attachmentEvents.push(event);
    } else {
      unsupportedEvents.push(event);
    }
  }

  return { topicBuckets, configEvents, attachmentEvents, unsupportedEvents };
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
    };
  }

  const sorted = [...events].sort((a, b) => Number(a.seq) - Number(b.seq));
  const { topicBuckets, configEvents, attachmentEvents, unsupportedEvents } =
    groupEvents(sorted);
  if (unsupportedEvents.length > 0 && context.logger && context.logger.warn) {
    context.logger.warn("projector skipped unsupported events", {
      count: unsupportedEvents.length,
    });
  }

  const appliedSeqs = [];
  if (sorted.length === 0) {
    return {
      appliedSeqs,
      failedSeq: null,
      topics: 0,
      configs: 0,
      attachments: 0,
      skipped: unsupportedEvents.length,
    };
  }
  try {
    if (unsupportedEvents.length > 0) {
      const blocking = unsupportedEvents.sort(
        (a, b) => Number(a.seq) - Number(b.seq)
      );
      const error = new Error(
        `unsupported projector event at seq ${blocking[0] && blocking[0].seq}`
      );
      error.failedSeq = blocking[0] ? blocking[0].seq : null;
      throw error;
    }

    const configProjection = await applyConfigEvents(configEvents, context);
    const attachmentProjection = await applyAttachmentEvents(
      attachmentEvents,
      context
    );
    for (const event of [...configEvents, ...attachmentEvents]) {
      appliedSeqs.push(event.seq);
    }

    const preparedTopics = [];
    for (const bucket of topicBuckets.values()) {
      preparedTopics.push(await prepareTopicBucket(bucket, context));
    }
    for (const prepared of preparedTopics) {
      const committed = await commitPreparedTopic(prepared, context);
      for (const item of committed.applied) appliedSeqs.push(item.seq);
    }
    appliedSeqs.sort((a, b) => Number(a) - Number(b));
    return {
      appliedSeqs,
      failedSeq: null,
      topics: topicBuckets.size,
      configs: configEvents.length,
      attachments: attachmentEvents.length,
      skipped: unsupportedEvents.length,
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
      topics: topicBuckets.size,
      configs: configEvents.length,
      attachments: attachmentEvents.length,
      skipped: unsupportedEvents.length,
    };
  }
}

module.exports = { projectEvents, groupEvents, historyPathFor };
