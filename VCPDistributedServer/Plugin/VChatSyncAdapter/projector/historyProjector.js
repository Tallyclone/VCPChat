const { checksumJson } = require("../core/hash");
const { messageKey } = require("../core/identity");

function topicKey(identity) {
  return `${identity.item_type}:${identity.item_id}:${identity.topic_id}`;
}

function eventIdentity(event) {
  const payload = event.payload || {};
  const message = payload.message || {};
  const id = event.entity_id || payload.message_id || payload.id || message.id;
  return {
    item_type: String(
      event.item_type || payload.item_type || message.item_type || ""
    ),
    item_id: String(event.item_id || payload.item_id || message.item_id || ""),
    topic_id: String(
      event.topic_id || payload.topic_id || message.topic_id || ""
    ),
    id: String(id || ""),
  };
}

const SYNC_INTERNAL_MESSAGE_KEYS = new Set([
  "item_type",
  "item_id",
  "topic_id",
  "local_order",
  "server_seq",
  "server_version",
  "_syncDerivatives",
  "sync_status",
]);

function toNativeHistoryMessage(message, identity) {
  const native = JSON.parse(JSON.stringify(message || {}));
  for (const key of SYNC_INTERNAL_MESSAGE_KEYS) delete native[key];
  native.id = identity.id;
  return native;
}

function applyEventToHistory(history, event) {
  const identity = eventIdentity(event);
  if (
    !identity.item_type ||
    !identity.item_id ||
    !identity.topic_id ||
    !identity.id
  ) {
    throw new Error(`invalid message event identity at seq ${event.seq}`);
  }

  const payload = event.payload || {};
  const targetIndex = history.findIndex(
    (message) => String(message && message.id) === identity.id
  );

  if (event.action === "delete" || event.action === "update_rejected_deleted") {
    if (targetIndex >= 0) history.splice(targetIndex, 1);
    return { identity, deleted: true };
  }

  if (event.action === "create_conflict") {
    return { identity, skipped: true, reason: "create_conflict" };
  }

  if (
    event.entity_type !== "message" ||
    !["create", "update"].includes(event.action)
  ) {
    return { identity, skipped: true, reason: "unsupported_action" };
  }

  const incoming = payload.message;
  if (!incoming || typeof incoming !== "object") {
    throw new Error(`message event has no payload.message at seq ${event.seq}`);
  }

  const nextMessage = toNativeHistoryMessage(incoming, identity);

  if (targetIndex >= 0) {
    history[targetIndex] = nextMessage;
  } else {
    history.push(nextMessage);
  }
  return { identity, message: nextMessage };
}

async function updateIndexForMessageEvent(localIndex, event, result) {
  if (!result || !result.identity) return;
  const key = messageKey(result.identity);
  if (result.deleted) {
    await localIndex.deleteMessage(key);
    return;
  }
  if (!result.message) return;
  const checksum = checksumJson(result.message);
  await localIndex.setMessage(key, {
    identity: result.identity,
    topic_key: topicKey(result.identity),
    last_known_server_version: event.version,
    last_known_checksum: checksum,
    last_applied_seq: event.seq,
    local_projection_checksum: checksum,
    pending_operation_id: null,
    pending_status: null,
    updated_at: new Date().toISOString(),
  });
}

module.exports = {
  applyEventToHistory,
  updateIndexForMessageEvent,
  eventIdentity,
  topicKey,
};
