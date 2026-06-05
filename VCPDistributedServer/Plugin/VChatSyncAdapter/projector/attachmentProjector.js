const { atomicWriteJson } = require("./atomicWriter");
const { checksumJson } = require("../core/hash");
const { messageKey } = require("../core/identity");
const {
  collectAttachmentRefs,
  rewriteMessageAttachments,
} = require("../sync/attachmentSync");
const { safeJoinAppData, assertInsideAppData } = require("../utils/pathRules");

function historyPathForIdentity(appDataPath, identity) {
  return safeJoinAppData(
    appDataPath,
    "UserData",
    encodeURIComponent(identity.item_id),
    "topics",
    encodeURIComponent(identity.topic_id),
    "history.json"
  );
}

function messageHasAttachmentHash(message, hash) {
  return collectAttachmentRefs(message).some(
    (ref) => String(ref.hash || "").toLowerCase() === hash
  );
}

async function repairMessagesForAttachment(hash, context, seq) {
  const { config, localIndex, writeIntentLock, logger } = context;
  if (!hash || !config || !localIndex || !localIndex.raw) return 0;
  const index = localIndex.raw();
  const rows = Object.values(index.local_messages || {});
  const topicKeys = new Map();
  for (const row of rows) {
    const identity = row && row.identity;
    if (!identity || !identity.item_id || !identity.topic_id) continue;
    topicKeys.set(
      `${identity.item_type}:${identity.item_id}:${identity.topic_id}`,
      identity
    );
  }

  let repaired = 0;
  for (const identity of topicKeys.values()) {
    const filePath = historyPathForIdentity(config.appDataPath, identity);
    let history = null;
    try {
      history = await require("fs-extra").readJson(filePath);
    } catch (error) {
      continue;
    }
    if (!Array.isArray(history)) continue;

    let changed = false;
    for (let index = 0; index < history.length; index += 1) {
      const message = history[index];
      if (!messageHasAttachmentHash(message, hash)) continue;
      const before = JSON.stringify(message);
      const nextMessage = await rewriteMessageAttachments(message, context);
      if (JSON.stringify(nextMessage) !== before) {
        history[index] = nextMessage;
        changed = true;
        const key = messageKey({
          ...identity,
          id: String(nextMessage.id || ""),
        });
        const previous = localIndex.getMessage(key) || {};
        await localIndex.setMessage(key, {
          ...previous,
          identity: { ...identity, id: String(nextMessage.id || "") },
          topic_key: `${identity.item_type}:${identity.item_id}:${identity.topic_id}`,
          last_known_checksum: checksumJson(nextMessage),
          local_projection_checksum: checksumJson(nextMessage),
          last_attachment_repair_seq: seq,
          updated_at: new Date().toISOString(),
        });
        repaired += 1;
      }
    }

    if (changed) {
      const expectedChecksum = checksumJson(history);
      const relativePath = assertInsideAppData(config.appDataPath, filePath);
      await writeIntentLock.record({
        relative_path: relativePath,
        filePath,
        source: "sync_attachment_repair",
        expectedChecksum,
        ttl_ms: 60000,
        expireAt: Date.now() + 60000,
      });
      await atomicWriteJson(filePath, history, { logger });
    }
  }
  return repaired;
}

async function applyAttachmentEvents(events, context) {
  const logger = context.logger;
  let repaired = 0;
  for (const event of events) {
    const payload = event.payload || {};
    const hash = String(payload.hash || "").toLowerCase();
    if (hash && context.localIndex) {
      await context.localIndex.setFile(`remote_attachment:${hash}`, {
        kind: "attachment_remote",
        hash,
        ext: payload.ext || "",
        size: payload.size_bytes || 0,
        mime_type: payload.mime_type || null,
        last_applied_seq: event.seq,
        updated_at: new Date().toISOString(),
      });
      repaired += await repairMessagesForAttachment(hash, context, event.seq);
    }
  }
  if (events.length > 0 && logger && logger.debug) {
    logger.debug("attachment projector recorded attachment metadata events", {
      count: events.length,
      repaired,
    });
  }
  return { applied: events.length, repaired };
}

module.exports = { applyAttachmentEvents, repairMessagesForAttachment };
