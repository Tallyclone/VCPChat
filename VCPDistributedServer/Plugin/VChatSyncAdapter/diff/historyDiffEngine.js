const { checksumJson } = require("../core/hash");
const { messageKey, operationId } = require("../core/identity");
const { collectAttachmentRefs } = require("../sync/attachmentSync");

let observationClock = 0;

function isPlaceholderMessage(message, options = {}) {
  if (!message || typeof message !== "object") return true;
  if (!message.id && options.allowMissingId !== true) return true;
  if (message.isThinking === true) return true;
  if (message.id === "loading_history") return true;
  if (
    message.placeholder === true ||
    message.ui_placeholder === true ||
    message.status === "placeholder"
  )
    return true;
  if (message.status === "streaming" || message.partial === true) return true;
  if (
    message.role === "assistant" &&
    typeof message.content === "string" &&
    message.content.trim().length === 0 &&
    !message.finishReason
  )
    return true;
  return false;
}

function topicKey(identity) {
  return `${identity.item_type}:${identity.item_id}:${identity.topic_id}`;
}

function deletionGuardConfig(context = {}) {
  const guard = context.deleteGuard || {};
  return {
    enabled: guard.enabled !== false,
    minPrevious: Number(guard.minPrevious || 20),
    maxDeleteRatio: Number(guard.maxDeleteRatio || 0.5),
    maxDeleteCount: Number(guard.maxDeleteCount || 50),
  };
}

function shouldBlockBulkDelete(previousCount, deleteCount, context) {
  const guard = deletionGuardConfig(context);
  if (!guard.enabled || deleteCount === 0) return false;
  if (previousCount < guard.minPrevious) return false;
  const ratio = deleteCount / previousCount;
  return deleteCount > guard.maxDeleteCount || ratio > guard.maxDeleteRatio;
}

function hasConfirmedRemoteMessage(previous) {
  return !!(
    previous &&
    previous.last_known_server_version !== undefined &&
    previous.last_known_server_version !== null
  );
}

function buildOperation(
  action,
  identity,
  message,
  previous,
  checksum,
  context
) {
  const attachmentRefs = collectAttachmentRefs(message).map((ref, index) => ({
    hash: ref.hash,
    ext: ref.ext,
    mime_type: ref.mime_type,
    filename: ref.filename,
    position: index,
  }));
  return {
    operation_id: operationId(
      context.deviceId,
      `message.${action}`,
      identity,
      checksum
    ),
    device_id: context.deviceId,
    entity_type: "message",
    action,
    item_type: identity.item_type,
    item_id: identity.item_id,
    topic_id: identity.topic_id,
    entity_id: identity.id,
    _local_observation_id: context.localObservationId,
    base_version:
      action === "create"
        ? undefined
        : hasConfirmedRemoteMessage(previous)
        ? previous.last_known_server_version
        : null,
    payload: {
      item_type: identity.item_type,
      item_id: identity.item_id,
      topic_id: identity.topic_id,
      message_id: identity.id,
      message,
      attachments: attachmentRefs,
      local_checksum: checksum,
    },
  };
}

async function diffHistory(
  identityBase,
  historyArray,
  localIndex,
  context = {}
) {
  if (!Array.isArray(historyArray))
    throw new Error("history.json root must be an array");
  const current = new Map();
  const operations = [];
  const skipped = [];
  const tKey = topicKey(identityBase);
  const previousRows = localIndex.listMessagesByTopic(tKey);
  observationClock = Math.max(Date.now(), observationClock + 1);
  for (const row of Object.values(previousRows)) {
    const previousObservation = Number(row.last_local_observation_id || 0);
    if (Number.isFinite(previousObservation)) {
      observationClock = Math.max(observationClock, previousObservation + 1);
    }
  }
  context = { ...context, localObservationId: observationClock };
  const presentKeys = new Set();

  for (const message of historyArray) {
    if (message && message.id) {
      presentKeys.add(messageKey({ ...identityBase, id: String(message.id) }));
    }
    if (isPlaceholderMessage(message)) {
      skipped.push({
        id: message && message.id,
        reason: "placeholder_or_streaming",
      });
      continue;
    }
    const identity = { ...identityBase, id: String(message.id) };
    const key = messageKey(identity);
    const checksum = checksumJson(message);
    current.set(key, { identity, message, checksum });
    const previous = localIndex.getMessage(key);
    if (previous && previous.terminal_conflict && previous.terminal_conflict.deleted) {
      skipped.push({ id: message.id, reason: "conflict_delete_wins" });
    } else if (!previous || previous.pending_status === "needs_create") {
      operations.push(
        buildOperation("create", identity, message, previous, checksum, context)
      );
    } else if (previous.last_known_checksum !== checksum) {
      operations.push(
        buildOperation(
          hasConfirmedRemoteMessage(previous) ? "update" : "create",
          identity,
          message,
          previous,
          checksum,
          context
        )
      );
    }
  }

  const previousEntries = Object.entries(previousRows);

  const candidateDeletes = previousEntries.filter(
    ([key, previous]) =>
      !presentKeys.has(key) &&
      previous.pending_action !== "delete" &&
      !(previous.terminal_conflict && previous.terminal_conflict.deleted)
  );
  const deletedKeys = [];
  let bulkDeleteBlocked = null;

  if (
    shouldBlockBulkDelete(
      previousEntries.length,
      candidateDeletes.length,
      context
    )
  ) {
    bulkDeleteBlocked = {
      reason: "bulk_delete_guard",
      topic_key: tKey,
      previous_count: previousEntries.length,
      current_count: current.size,
      delete_count: candidateDeletes.length,
      delete_ratio: candidateDeletes.length / previousEntries.length,
    };
    skipped.push(bulkDeleteBlocked);
  } else {
    for (const [key, previous] of candidateDeletes) {
      const identity = previous.identity;
      deletedKeys.push(key);
      operations.push({
        operation_id: operationId(
          context.deviceId,
          "message.delete",
          identity,
          previous.last_known_checksum || Date.now()
        ),
        device_id: context.deviceId,
        entity_type: "message",
        action: "delete",
        item_type: identity.item_type,
        item_id: identity.item_id,
        topic_id: identity.topic_id,
        entity_id: identity.id,
        _local_observation_id: context.localObservationId,
        base_version: hasConfirmedRemoteMessage(previous)
          ? previous.last_known_server_version
          : null,
        payload: {
          item_type: identity.item_type,
          item_id: identity.item_id,
          topic_id: identity.topic_id,
          id: identity.id,
          deleted_at: new Date().toISOString(),
        },
      });
    }
  }

  const previousTopicSnapshot = localIndex.getTopicSnapshot(tKey) || {};
  await localIndex.setTopicSnapshot(tKey, {
    ...previousTopicSnapshot,
    topic_key: tKey,
    message_count: current.size,
    scanned_at: new Date().toISOString(),
  });

  return { operations, skipped, current, deletedKeys };
}

async function applyLocalSnapshot(localIndex, diffResult, enqueueResult = []) {
  const enqueuedByKey = new Map();
  for (const item of enqueueResult) {
    if (item && item.key) {
      enqueuedByKey.set(item.key, item);
    }
  }
  for (const [key, row] of diffResult.current.entries()) {
    const enqueued = enqueuedByKey.get(key);
    // The durable queue updates the index in its serialization scope. A scan
    // finishing after an ACK must not restore the earlier pending operation.
    if (!enqueued || enqueued.index_managed) continue;
    const previous = localIndex.getMessage(key) || {};
    if (previous.last_submitted_operation_id === enqueued.operation_id) continue;
    const pendingAction = enqueued.action;
    await localIndex.setMessage(key, {
      ...previous,
      identity: row.identity,
      topic_key: topicKey(row.identity),
      last_known_checksum: row.checksum,
      local_projection_checksum: row.checksum,
      pending_operation_id: enqueued.operation_id,
      pending_action: pendingAction,
      pending_status: pendingAction ? `pending_${pendingAction}` : null,
      pending_checksum: row.checksum,
      updated_at: new Date().toISOString(),
    });
  }

  const enqueuedDeletes = new Set(
    enqueueResult
      .filter((item) => item && item.action === "delete" && item.key)
      .map((item) => item.key)
  );
  for (const key of diffResult.deletedKeys || []) {
    if (!enqueuedDeletes.has(key)) continue;
    const enqueued = enqueuedByKey.get(key);
    if (enqueued.index_managed) continue;
    const previous = localIndex.getMessage(key);
    if (!previous) continue;
    if (previous.last_submitted_operation_id === enqueued.operation_id) continue;
    await localIndex.setMessage(key, {
      ...previous,
      pending_operation_id:
        enqueued.operation_id || previous.pending_operation_id,
      pending_action: "delete",
      pending_status: "pending_delete",
      deleted_locally: true,
      updated_at: new Date().toISOString(),
    });
  }
}

module.exports = { diffHistory, applyLocalSnapshot, isPlaceholderMessage };
