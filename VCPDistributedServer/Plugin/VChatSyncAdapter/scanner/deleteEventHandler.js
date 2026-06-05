const path = require("path");
const fs = require("fs-extra");
const { checksumJson } = require("../core/hash");
const { operationId } = require("../core/identity");
const {
  relativeAppDataPath,
  normalizeSlashes,
  parseConfigIdentity,
  parseHistoryIdentity,
  parseTopicDirIdentity,
  parseItemDirIdentity,
} = require("../utils/pathRules");
const { shouldAdvanceIndexForLocalObservation } = require("../sync/modePolicy");

function nowIso() {
  return new Date().toISOString();
}

function deleteOperationId(context, action, identity, checksum) {
  return operationId(
    context.deviceId || "unknown_device",
    action,
    identity,
    checksum || nowIso()
  );
}

function configDeleteOperation(relativePath, identity, context) {
  const checksum = checksumJson({ relativePath, deleted_at: nowIso() });
  return {
    operation_id: deleteOperationId(
      context,
      `config.${identity.schema}.delete`,
      {
        item_type: identity.item_type || "config",
        item_id: identity.item_id || identity.entity_id,
        topic_id: identity.schema,
        id: relativePath,
      },
      checksum
    ),
    device_id: context.deviceId,
    entity_type: identity.schema,
    action: "delete",
    entity_id: identity.entity_id || relativePath,
    payload: {
      schema: identity.schema,
      entity_id: identity.entity_id || relativePath,
      relative_path: relativePath,
      delete_all_profiles: true,
      deleted_at: nowIso(),
      reason: "local_unlink",
    },
  };
}

function itemDeleteOperation(identity, context) {
  const checksum = checksumJson({ identity, deleted_at: nowIso() });
  return {
    operation_id: deleteOperationId(
      context,
      "item.delete",
      {
        item_type: identity.item_type,
        item_id: identity.item_id,
        topic_id: "item",
        id: identity.item_id,
      },
      checksum
    ),
    device_id: context.deviceId,
    entity_type: "item",
    action: "delete",
    item_type: identity.item_type,
    item_id: identity.item_id,
    entity_id: identity.item_id,
    payload: {
      item_type: identity.item_type,
      item_id: identity.item_id,
      deleted_at: nowIso(),
      reason: "local_unlinkDir",
      delete_config: true,
    },
  };
}

function topicDeleteOperation(identity, context, reason = "local_unlinkDir") {
  const checksum = checksumJson({ identity, deleted_at: nowIso(), reason });
  return {
    operation_id: deleteOperationId(
      context,
      "topic.delete",
      {
        item_type: identity.item_type,
        item_id: identity.item_id,
        topic_id: identity.topic_id,
        id: identity.topic_id,
      },
      checksum
    ),
    device_id: context.deviceId,
    entity_type: "topic",
    action: "delete",
    item_type: identity.item_type,
    item_id: identity.item_id,
    topic_id: identity.topic_id,
    entity_id: identity.topic_id,
    payload: {
      item_type: identity.item_type,
      item_id: identity.item_id,
      topic_id: identity.topic_id,
      deleted_at: nowIso(),
      reason,
    },
  };
}

function topicHistoryDeleteOperation(
  identity,
  context,
  reason = "local_history_unlink"
) {
  const checksum = checksumJson({ identity, deleted_at: nowIso(), reason });
  return {
    operation_id: deleteOperationId(
      context,
      "topic_history.delete",
      {
        item_type: identity.item_type,
        item_id: identity.item_id,
        topic_id: identity.topic_id,
        id: identity.topic_id,
      },
      checksum
    ),
    device_id: context.deviceId,
    entity_type: "topic_history",
    action: "delete",
    item_type: identity.item_type,
    item_id: identity.item_id,
    topic_id: identity.topic_id,
    entity_id: identity.topic_id,
    payload: {
      item_type: identity.item_type,
      item_id: identity.item_id,
      topic_id: identity.topic_id,
      deleted_at: nowIso(),
      reason,
    },
  };
}

function messageDeleteOperationsForTopic(identity, localIndex, context) {
  const topicKey = `${identity.item_type}:${identity.item_id}:${identity.topic_id}`;
  const rows = localIndex.listMessagesByTopic(topicKey);
  return Object.entries(rows).map(([, previous]) => {
    const messageIdentity = previous.identity || {};
    return {
      operation_id: deleteOperationId(
        context,
        "message.delete",
        messageIdentity,
        previous.last_known_checksum || nowIso()
      ),
      device_id: context.deviceId,
      entity_type: "message",
      action: "delete",
      item_type: messageIdentity.item_type,
      item_id: messageIdentity.item_id,
      topic_id: messageIdentity.topic_id,
      entity_id: messageIdentity.id,
      base_version:
        previous.last_known_server_version === undefined
          ? null
          : previous.last_known_server_version,
      payload: {
        item_type: messageIdentity.item_type,
        item_id: messageIdentity.item_id,
        topic_id: messageIdentity.topic_id,
        id: messageIdentity.id,
        deleted_at: nowIso(),
        reason: "local_history_unlink",
      },
    };
  });
}

function classifyDeletedPath(appDataPath, deletedPath, isDirectory = false) {
  const relativePath = normalizeSlashes(
    relativeAppDataPath(appDataPath, deletedPath)
  );
  if (!relativePath || relativePath.startsWith("sync/")) return null;

  if (isDirectory) {
    const itemIdentity = parseItemDirIdentity(relativePath);
    if (itemIdentity)
      return { type: "item", relativePath, identity: itemIdentity };

    const topicIdentity = parseTopicDirIdentity(relativePath, { appDataPath });
    if (topicIdentity)
      return { type: "topic", relativePath, identity: topicIdentity };
    return null;
  }

  const configIdentity = parseConfigIdentity(relativePath);
  if (configIdentity)
    return { type: "config", relativePath, identity: configIdentity };

  const historyIdentity = parseHistoryIdentity(relativePath, { appDataPath });
  if (historyIdentity)
    return { type: "history", relativePath, identity: historyIdentity };

  return null;
}

function pathKey(classified) {
  if (!classified || !classified.identity) return null;
  const identity = classified.identity;
  if (classified.type === "topic" || classified.type === "history") {
    return `${identity.item_type}:${identity.item_id}:${identity.topic_id}`;
  }
  return `${identity.item_type}:${identity.item_id}`;
}

function groupDeletedEntries(classifiedEntries) {
  const itemDeletes = new Set();
  const topicDeletes = new Set();
  for (const entry of classifiedEntries) {
    if (!entry) continue;
    if (entry.type === "item") {
      itemDeletes.add(pathKey(entry));
    } else if (entry.type === "topic") {
      topicDeletes.add(pathKey(entry));
    }
  }
  return { itemDeletes, topicDeletes };
}

function itemParentDirForConfig(appDataPath, entry) {
  const identity = entry && entry.identity;
  if (!identity || !identity.item_type || !identity.item_id) return null;
  const base = identity.item_type === "group" ? "AgentGroups" : "Agents";
  return path.join(appDataPath, base, encodeURIComponent(identity.item_id));
}

async function promoteConfigDeletes(classifiedEntries, appDataPath) {
  const result = [];
  const itemKeys = new Set(
    classifiedEntries
      .filter((entry) => entry && entry.type === "item")
      .map((entry) => pathKey(entry))
  );

  for (const entry of classifiedEntries) {
    if (!entry || entry.type !== "config") {
      result.push(entry);
      continue;
    }
    const itemEntry = {
      type: "item",
      relativePath: entry.relativePath,
      identity: entry.identity,
    };
    const itemKey = pathKey(itemEntry);
    if (itemKeys.has(itemKey)) {
      result.push(entry);
      continue;
    }
    const parentDir = itemParentDirForConfig(appDataPath, entry);
    if (parentDir && !(await fs.pathExists(parentDir))) {
      result.push({
        type: "item",
        relativePath: normalizeSlashes(path.dirname(entry.relativePath)),
        identity: {
          item_type: entry.identity.item_type,
          item_id: entry.identity.item_id,
        },
        promotedFrom: entry,
      });
      itemKeys.add(itemKey);
      continue;
    }
    result.push(entry);
  }
  return result;
}

function dedupeOperations(operations) {
  const seen = new Set();
  const deduped = [];
  for (const operation of operations) {
    const key = [
      operation.entity_type,
      operation.action,
      operation.item_type || "",
      operation.item_id || "",
      operation.topic_id || "",
      operation.entity_id || "",
      operation.payload && operation.payload.relative_path
        ? operation.payload.relative_path
        : "",
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(operation);
  }
  return deduped;
}

function buildOperations(classifiedEntries, localIndex, context) {
  const { itemDeletes, topicDeletes } = groupDeletedEntries(classifiedEntries);
  const operations = [];

  for (const entry of classifiedEntries) {
    if (!entry) continue;
    const itemKey = pathKey({ type: "item", identity: entry.identity });
    const topicKey = pathKey({ type: "topic", identity: entry.identity });

    if (entry.type === "config") {
      if (itemDeletes.has(itemKey)) continue;
      if (!localIndex.getFile(entry.relativePath)) {
        return { operations: [], reason: "unknown_config" };
      }
      operations.push(
        configDeleteOperation(entry.relativePath, entry.identity, context)
      );
      continue;
    }

    if (entry.type === "item") {
      operations.push(itemDeleteOperation(entry.identity, context));
      continue;
    }

    if (entry.type === "topic") {
      if (itemDeletes.has(itemKey)) continue;
      operations.push(topicDeleteOperation(entry.identity, context));
      continue;
    }

    if (entry.type === "history") {
      if (itemDeletes.has(itemKey) || topicDeletes.has(topicKey)) continue;
      operations.push(topicHistoryDeleteOperation(entry.identity, context));
    }
  }

  return { operations: dedupeOperations(operations) };
}

function applyLocalDeletionIndexUpdates(localIndex, operations) {
  const configPaths = new Set();
  const itemKeys = new Set();
  const topicKeys = new Set();
  const topicHistoryKeys = new Set();

  for (const operation of operations) {
    if (operation.entity_type === "item") {
      itemKeys.add(`${operation.item_type}:${operation.item_id}`);
      configPaths.add(
        path.posix.join(
          operation.item_type === "group" ? "AgentGroups" : "Agents",
          encodeURIComponent(operation.item_id),
          "config.json"
        )
      );
    } else if (operation.entity_type === "topic") {
      topicKeys.add(
        `${operation.item_type}:${operation.item_id}:${operation.topic_id}`
      );
    } else if (operation.entity_type === "topic_history") {
      topicHistoryKeys.add(
        `${operation.item_type}:${operation.item_id}:${operation.topic_id}`
      );
    } else if (
      operation.entity_type === "config" ||
      operation.entity_type === "agent_config" ||
      operation.entity_type === "group_config"
    ) {
      configPaths.add(
        operation.payload && operation.payload.relative_path
          ? operation.payload.relative_path
          : null
      );
    }
  }

  return localIndex.batchUpdate(async () => {
    for (const key of itemKeys) {
      const [itemType, itemId] = key.split(":");
      await localIndex.deleteMessagesByItem(itemType, itemId);
      await localIndex.deleteTopicSnapshotsByItem(itemType, itemId);
      const configRelativePath = path.posix.join(
        itemType === "group" ? "AgentGroups" : "Agents",
        encodeURIComponent(itemId),
        "config.json"
      );
      await localIndex.deleteFile(configRelativePath);
    }
    for (const key of topicKeys) {
      await localIndex.deleteMessagesByTopic(key);
      await localIndex.deleteTopicSnapshot(key);
    }
    for (const key of topicHistoryKeys) {
      await localIndex.deleteMessagesByTopic(key);
    }
    for (const configPath of configPaths) {
      if (configPath) await localIndex.deleteFile(configPath);
    }
  });
}

async function handleDeletedPaths(
  appDataPath,
  deletedPaths,
  localIndex,
  offlineQueue,
  logger,
  context = {}
) {
  const list = Array.isArray(deletedPaths) ? deletedPaths : [deletedPaths];
  const rawClassifiedEntries = list
    .map((entry) => {
      if (!entry || !entry.deletedPath) return null;
      return classifyDeletedPath(
        appDataPath,
        entry.deletedPath,
        !!entry.isDirectory
      );
    })
    .filter(Boolean);
  const classifiedEntries = await promoteConfigDeletes(
    rawClassifiedEntries,
    appDataPath
  );

  if (classifiedEntries.length === 0) {
    return { skipped: true, reason: "out_of_scope" };
  }

  const mode = context.mode || "uninitialized";
  if (!shouldAdvanceIndexForLocalObservation(mode)) {
    const relativePath = classifiedEntries[0].relativePath;
    logger.warn(
      "delete observed but local index not advanced because mode forbids upload",
      {
        relativePath,
        mode,
      }
    );
    return { skipped: true, reason: "mode_forbids_upload", relativePath };
  }

  const { operations, reason } = buildOperations(
    classifiedEntries,
    localIndex,
    context
  );
  if (reason === "unknown_config") {
    return {
      skipped: true,
      reason,
      relativePath: classifiedEntries[0].relativePath,
    };
  }
  if (operations.length === 0) {
    return {
      skipped: true,
      reason: "suppressed_by_batch",
      relativePath: classifiedEntries[0].relativePath,
    };
  }

  const enqueued = await offlineQueue.enqueueMany(operations, { mode });
  await applyLocalDeletionIndexUpdates(localIndex, operations);

  logger.info("local delete captured", {
    relativePath: classifiedEntries[0].relativePath,
    types: classifiedEntries.map((entry) => entry.type),
    operations: enqueued.length,
  });
  return {
    relativePath: classifiedEntries[0].relativePath,
    types: classifiedEntries.map((entry) => entry.type),
    operations: enqueued.length,
  };
}

async function handleDeletedPath(
  appDataPath,
  deletedPath,
  isDirectory,
  localIndex,
  offlineQueue,
  logger,
  context = {}
) {
  return handleDeletedPaths(
    appDataPath,
    [{ deletedPath, isDirectory }],
    localIndex,
    offlineQueue,
    logger,
    context
  );
}

module.exports = {
  classifyDeletedPath,
  handleDeletedPath,
  handleDeletedPaths,
  configDeleteOperation,
  itemDeleteOperation,
  topicDeleteOperation,
  topicHistoryDeleteOperation,
  messageDeleteOperationsForTopic,
};
