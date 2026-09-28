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

function isMessageDeletionEvent(event) {
  return event.action === "delete" ||
    event.action === "update_rejected_deleted" ||
    event.action === "create_rejected_deleted";
}

function isMessageContentEvent(event) {
  return (
    event.entity_type === "message" &&
    ["create", "update"].includes(event.action)
  );
}

function isAuthoritativeReplay(event, options = {}) {
  return options.bootstrapReplay === true || event.baseline_seq === true;
}

// Detect a local change that Center has not confirmed yet. Such an edit is
// the user's newest intent on this device: the remote version must not
// overwrite it. The queued/upcoming update carries the remote version as its
// base, so Center converges on the local content afterwards.
function detectLocalEdit(localIndex, identity, onDiskMessage) {
  if (!localIndex || typeof localIndex.getMessage !== "function") return null;
  const local = localIndex.getMessage(messageKey(identity));
  if (!local) return null;
  const pendingAction = local.pending_operation_id ? local.pending_action : null;
  if (pendingAction === "delete") {
    return { kind: "pending_delete", local };
  }
  if (pendingAction === "create" || pendingAction === "update") {
    return { kind: "pending_edit", local };
  }
  if (
    onDiskMessage &&
    local.last_known_checksum &&
    checksumJson(onDiskMessage) !== local.last_known_checksum
  ) {
    return { kind: "unobserved_edit", local };
  }
  return null;
}

function applyEventToHistory(history, event, options = {}) {
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

  if (isMessageDeletionEvent(event)) {
    if (targetIndex >= 0) history.splice(targetIndex, 1);
    return { identity, deleted: true };
  }

  if (event.action === "create_conflict") {
    return { identity, skipped: true, reason: "create_conflict" };
  }

  if (!isMessageContentEvent(event)) {
    return { identity, skipped: true, reason: "unsupported_action" };
  }

  const incoming = payload.message;
  if (!incoming || typeof incoming !== "object") {
    throw new Error(`message event has no payload.message at seq ${event.seq}`);
  }

  const nextMessage = options.preparedMessage
    ? options.preparedMessage
    : toNativeHistoryMessage(incoming, identity);

  if (!isAuthoritativeReplay(event, options)) {
    const onDisk = targetIndex >= 0 ? history[targetIndex] : null;
    const localEdit = detectLocalEdit(options.localIndex, identity, onDisk);
    if (localEdit && (localEdit.kind !== "pending_delete" || !onDisk)) {
      return {
        identity,
        kept_local: true,
        local_edit_kind: localEdit.kind,
        remote_message: nextMessage,
      };
    }
  }

  if (targetIndex >= 0) {
    history[targetIndex] = nextMessage;
  } else if (event.action === "create" || options.bootstrapReplay === true) {
    // A paginated baseline can omit a message deleted during export. Updates
    // contain full messages, so the bounded bootstrap replay can reconstruct it
    // until its later deletion arrives. Normal incremental pulls stay strict.
    history.push(nextMessage);
  } else {
    const error = new Error(
      `message update target missing at seq ${event.seq}`
    );
    error.failedSeq = event.seq;
    throw error;
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
  const appliedSeq = event.baseline_seq === true
    ? Number(event.server_seq || 0)
    : event.seq;
  if (result.kept_local) {
    // Remember the Center version so the pending/upcoming local update is
    // submitted against it, but keep the local pending intent untouched.
    const previous = localIndex.getMessage(key) || {};
    await localIndex.setMessage(key, {
      ...previous,
      identity: result.identity,
      topic_key: topicKey(result.identity),
      last_known_server_version: event.version,
      last_applied_seq: appliedSeq,
      remote_checksum: checksumJson(result.remote_message),
      remote_version_preserved_local_edit: {
        kind: result.local_edit_kind,
        seq: event.seq,
        version: event.version,
        device_id: event.device_id || null,
        at: new Date().toISOString(),
      },
      updated_at: new Date().toISOString(),
    });
    return;
  }
  if (!result.message) return;
  const checksum = checksumJson(result.message);
  const previous = localIndex.getMessage(key) || {};
  await localIndex.setMessage(key, {
    ...previous,
    identity: result.identity,
    topic_key: topicKey(result.identity),
    last_known_server_version: event.version,
    last_known_checksum: checksum,
    // Bootstrap events use synthetic counters to order local projection, not
    // real Center sequences. They must not make a later real ACK look stale.
    last_applied_seq: appliedSeq,
    local_projection_checksum: checksum,
    pending_operation_id: null,
    pending_action: null,
    pending_checksum: null,
    pending_status: null,
    terminal_conflict: null,
    remote_version_preserved_local_edit: null,
    updated_at: new Date().toISOString(),
  });
}

module.exports = {
  applyEventToHistory,
  updateIndexForMessageEvent,
  eventIdentity,
  topicKey,
  isMessageDeletionEvent,
  isMessageContentEvent,
  toNativeHistoryMessage,
  detectLocalEdit,
};
