const path = require("path");
const fs = require("fs-extra");
const { checksumJson } = require("../core/hash");
const { operationId } = require("../core/identity");
const { safeConfigDto } = require("../core/safeConfigDto");
const { uploadLocalAttachment } = require("../sync/attachmentSync");
const {
  isSafeUserAvatarUrlPath,
  safeJoinAppData,
  parseConfigIdentity,
} = require("../utils/pathRules");

function normalizeUserAvatarRelativePath(value) {
  const relativePath = String(value || "")
    .trim()
    .replace(/\\/g, "/");
  if (!relativePath || !isSafeUserAvatarUrlPath(relativePath)) return null;
  return relativePath;
}

async function uploadSettingsUserAvatar(parsedJson, localIndex, context = {}) {
  if (!parsedJson || typeof parsedJson !== "object") return null;
  const relativePath = normalizeUserAvatarRelativePath(
    parsedJson.userAvatarUrl
  );
  if (!relativePath || !context.config || !context.config.appDataPath)
    return null;
  if (context.mode !== "active" || !context.centerClient) return null;

  const absolutePath = safeJoinAppData(
    context.config.appDataPath,
    relativePath
  );
  if (!(await fs.pathExists(absolutePath))) return null;

  return uploadLocalAttachment(
    relativePath,
    absolutePath,
    localIndex,
    context.centerClient,
    context.config,
    {
      avatarIdentity: { owner_type: "user", owner_id: "user_avatar" },
      avatarOperationRelativePath: relativePath,
      avatarOperationMetadata: { source: "settings.userAvatarUrl" },
    }
  );
}

function buildGroupMemberDeleteOperations(
  relativePath,
  parsedJson,
  previousConfig,
  context,
  checksum
) {
  if (
    !previousConfig ||
    !/AgentGroups\/[^/]+\/config\.json$/i.test(relativePath)
  ) {
    return [];
  }
  const currentMembers = new Set(
    Array.isArray(parsedJson && parsedJson.members)
      ? parsedJson.members.map(String)
      : []
  );
  const previousMembers = Array.isArray(previousConfig.members)
    ? previousConfig.members.map(String)
    : [];
  const match = /^AgentGroups\/([^/]+)\/config\.json$/i.exec(relativePath);
  const groupId = match
    ? decodeURIComponent(match[1])
    : String(parsedJson.id || "");
  if (!groupId) return [];
  return previousMembers
    .filter((memberId) => memberId && !currentMembers.has(memberId))
    .map((memberId) => ({
      operation_id: operationId(
        context.deviceId || "unknown_device",
        "group_member.delete",
        {
          item_type: "group",
          item_id: groupId,
          topic_id: "members",
          id: memberId,
        },
        checksum
      ),
      device_id: context.deviceId,
      entity_type: "group_member",
      action: "delete",
      item_type: "group",
      item_id: groupId,
      entity_id: memberId,
      member_id: memberId,
      payload: {
        group_id: groupId,
        member_id: memberId,
        deleted_at: new Date().toISOString(),
        reason: "local_group_config_members_diff",
      },
    }));
}

function topicIdOf(topic) {
  return topic && (topic.id || topic.topic_id || topic.topicId);
}

function normalizeTopicForTopicOperation(topic) {
  const source =
    topic && typeof topic === "object" && !Array.isArray(topic) ? topic : {};
  const id = topicIdOf(source);
  if (!id) return null;
  const normalized = { ...source, id: String(id) };
  if (
    !normalized.name &&
    (source.title || source.topic_title || source.topicTitle)
  ) {
    normalized.name = source.title || source.topic_title || source.topicTitle;
  }
  if (!normalized.createdAt && (source.created_at || source.timestamp)) {
    normalized.createdAt = source.created_at || source.timestamp;
  }
  return normalized;
}

function topicOrderOf(topics) {
  return (Array.isArray(topics) ? topics : [])
    .map((topic) => topicIdOf(topic))
    .filter(Boolean)
    .map(String);
}

function sameStringArray(left, right) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function uniqueStringOrder(ids) {
  const seen = new Set();
  const result = [];
  for (const id of ids) {
    const value = String(id || "");
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function movedArrayValueAt(previousOrder, fromIndex, toIndex, index) {
  if (index === toIndex) return previousOrder[fromIndex];
  if (fromIndex < toIndex) {
    if (index >= fromIndex && index < toIndex) return previousOrder[index + 1];
  } else if (index > toIndex && index <= fromIndex) {
    return previousOrder[index - 1];
  }
  return previousOrder[index];
}

function isArrayAfterSingleMove(
  previousOrder,
  currentOrder,
  fromIndex,
  toIndex
) {
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return false;
  if (previousOrder.length !== currentOrder.length) return false;
  for (let index = 0; index < currentOrder.length; index += 1) {
    if (
      movedArrayValueAt(previousOrder, fromIndex, toIndex, index) !==
      currentOrder[index]
    ) {
      return false;
    }
  }
  return true;
}

function topicOrderMovePayload(
  owner,
  topicId,
  targetOrder,
  targetIndex,
  source,
  extra = {}
) {
  const payload = {
    item_type: owner.item_type,
    item_id: owner.item_id,
    topic_id: topicId,
    source,
    ...extra,
  };
  if (targetIndex <= 0) {
    payload.mode = "move_to_front";
  } else {
    payload.mode = "move_after";
    payload.after_topic_id = targetOrder[targetIndex - 1];
  }
  return payload;
}

function buildTopicOrderMoveOperation(
  owner,
  topicId,
  targetOrder,
  targetIndex,
  context,
  seed,
  extra = {}
) {
  const payload = topicOrderMovePayload(
    owner,
    topicId,
    targetOrder,
    targetIndex,
    "manual_drag",
    extra
  );
  const opChecksum = checksumJson({
    owner,
    topic_id: topicId,
    targetIndex,
    payload,
    seed,
  });
  return {
    operation_id: operationId(
      context.deviceId || "unknown_device",
      "topic_order.move",
      {
        item_type: owner.item_type,
        item_id: owner.item_id,
        topic_id: topicId,
        id: `${topicId}:${targetIndex}`,
      },
      opChecksum
    ),
    device_id: context.deviceId,
    entity_type: "topic_order",
    action: "move",
    item_type: owner.item_type,
    item_id: owner.item_id,
    topic_id: topicId,
    entity_id: owner.item_id,
    payload,
  };
}

function detectSingleTopicMove(previousOrder, currentOrder) {
  if (
    previousOrder.length !== currentOrder.length ||
    sameStringArray(previousOrder, currentOrder)
  ) {
    return null;
  }
  const previousPositions = new Map();
  const currentPositions = new Map();
  for (let index = 0; index < previousOrder.length; index += 1) {
    previousPositions.set(previousOrder[index], index);
    currentPositions.set(currentOrder[index], index);
  }
  if (previousPositions.size !== currentPositions.size) return null;
  for (const id of previousPositions.keys()) {
    if (!currentPositions.has(id)) return null;
  }

  let firstMismatch = -1;
  for (let index = 0; index < currentOrder.length; index += 1) {
    if (previousOrder[index] !== currentOrder[index]) {
      firstMismatch = index;
      break;
    }
  }
  if (firstMismatch < 0) return null;

  const movedForwardId = currentOrder[firstMismatch];
  const movedForwardFrom = previousPositions.get(movedForwardId);
  if (
    isArrayAfterSingleMove(
      previousOrder,
      currentOrder,
      movedForwardFrom,
      firstMismatch
    )
  ) {
    return { topic_id: movedForwardId, targetIndex: firstMismatch };
  }

  const movedBackwardId = previousOrder[firstMismatch];
  const movedBackwardTo = currentPositions.get(movedBackwardId);
  if (
    isArrayAfterSingleMove(
      previousOrder,
      currentOrder,
      firstMismatch,
      movedBackwardTo
    )
  ) {
    return { topic_id: movedBackwardId, targetIndex: movedBackwardTo };
  }
  return null;
}

function longestIncreasingSubsequencePositions(values) {
  const tails = [];
  const tailsIndices = [];
  const previous = new Array(values.length).fill(-1);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    let left = 0;
    let right = tails.length;
    while (left < right) {
      const mid = Math.floor((left + right) / 2);
      if (tails[mid] < value) left = mid + 1;
      else right = mid;
    }
    if (left > 0) previous[index] = tailsIndices[left - 1];
    tails[left] = value;
    tailsIndices[left] = index;
  }
  const keep = new Set();
  let cursor = tailsIndices[tailsIndices.length - 1];
  while (cursor !== undefined && cursor >= 0) {
    keep.add(cursor);
    cursor = previous[cursor];
  }
  return keep;
}

function buildTopicOrderMoveOperations(
  owner,
  previousOrderInput,
  currentOrderInput,
  context
) {
  const previousOrder = uniqueStringOrder(previousOrderInput);
  const currentOrder = uniqueStringOrder(currentOrderInput);
  if (currentOrder.length === 0 || sameStringArray(previousOrder, currentOrder))
    return [];

  const seed = {
    previous_order_checksum: checksumJson(previousOrder),
    current_order_checksum: checksumJson(currentOrder),
  };
  const singleMove = detectSingleTopicMove(previousOrder, currentOrder);
  if (singleMove) {
    return [
      buildTopicOrderMoveOperation(
        owner,
        singleMove.topic_id,
        currentOrder,
        singleMove.targetIndex,
        context,
        seed,
        { reason: "single_item_move", move_index: 0, ...seed }
      ),
    ];
  }

  const previousPositions = new Map();
  previousOrder.forEach((id, index) => previousPositions.set(id, index));
  const currentWithPreviousPosition = [];
  currentOrder.forEach((id, index) => {
    if (previousPositions.has(id)) {
      currentWithPreviousPosition.push({
        id,
        currentIndex: index,
        previousIndex: previousPositions.get(id),
      });
    }
  });
  const lisPositions = longestIncreasingSubsequencePositions(
    currentWithPreviousPosition.map((entry) => entry.previousIndex)
  );
  const keepIds = new Set();
  currentWithPreviousPosition.forEach((entry, index) => {
    if (lisPositions.has(index)) keepIds.add(entry.id);
  });

  const currentSet = new Set(currentOrder);
  const mutableSet = new Set(previousOrder.filter((id) => currentSet.has(id)));
  const mutable = previousOrder.filter((id) => currentSet.has(id));
  for (const id of currentOrder) {
    if (!mutableSet.has(id)) {
      mutable.push(id);
      mutableSet.add(id);
    }
  }

  const moves = [];
  for (
    let targetIndex = 0;
    targetIndex < currentOrder.length;
    targetIndex += 1
  ) {
    const topicId = currentOrder[targetIndex];
    if (mutable[targetIndex] === topicId) continue;
    if (keepIds.has(topicId)) continue;
    const fromIndex = mutable.indexOf(topicId);
    if (fromIndex < 0) continue;
    mutable.splice(fromIndex, 1);
    mutable.splice(targetIndex, 0, topicId);
    moves.push(
      buildTopicOrderMoveOperation(
        owner,
        topicId,
        currentOrder,
        targetIndex,
        context,
        seed,
        {
          reason: "lis_reorder",
          move_index: moves.length,
          ...seed,
        }
      )
    );
  }
  return moves;
}

function buildTopicRuntimeOperations(
  relativePath,
  parsedJson,
  previousConfig,
  context,
  checksum
) {
  const owner = parseConfigIdentity(relativePath);
  if (
    !owner ||
    (owner.schema !== "agent_config" && owner.schema !== "group_config")
  ) {
    return [];
  }
  const currentTopics = Array.isArray(parsedJson && parsedJson.topics)
    ? parsedJson.topics
    : [];
  const previousTopics = Array.isArray(previousConfig && previousConfig.topics)
    ? previousConfig.topics
    : [];
  const previousById = new Map();
  for (const topic of previousTopics) {
    const id = topicIdOf(topic);
    if (id) previousById.set(String(id), topic);
  }

  const operations = [];
  const currentIds = new Set();

  for (const topic of currentTopics) {
    const normalized = normalizeTopicForTopicOperation(topic);
    if (!normalized) continue;
    currentIds.add(normalized.id);
    const topicChecksum = checksumJson(normalized);
    const previous = previousById.get(normalized.id);
    if (
      previous &&
      checksumJson(normalizeTopicForTopicOperation(previous) || {}) ===
        topicChecksum
    ) {
      continue;
    }
    operations.push({
      operation_id: operationId(
        context.deviceId || "unknown_device",
        "topic.upsert",
        {
          item_type: owner.item_type,
          item_id: owner.item_id,
          topic_id: normalized.id,
          id: normalized.id,
        },
        topicChecksum
      ),
      device_id: context.deviceId,
      entity_type: "topic",
      action: "upsert",
      item_type: owner.item_type,
      item_id: owner.item_id,
      topic_id: normalized.id,
      entity_id: normalized.id,
      payload: {
        item_type: owner.item_type,
        item_id: owner.item_id,
        topic_id: normalized.id,
        topic: normalized,
        source: "local_config_topics_diff",
      },
    });
  }

  const deletedAt = new Date().toISOString();
  for (const topic of previousTopics) {
    const topicId = topicIdOf(topic);
    if (!topicId) continue;
    const normalizedTopicId = String(topicId);
    if (currentIds.has(normalizedTopicId)) continue;
    const deleteChecksum = checksumJson({
      owner,
      topic_id: normalizedTopicId,
      deleted_at: deletedAt,
      source: "local_config_topics_diff",
    });
    operations.push({
      operation_id: operationId(
        context.deviceId || "unknown_device",
        "topic.delete",
        {
          item_type: owner.item_type,
          item_id: owner.item_id,
          topic_id: normalizedTopicId,
          id: normalizedTopicId,
        },
        deleteChecksum
      ),
      device_id: context.deviceId,
      entity_type: "topic",
      action: "delete",
      item_type: owner.item_type,
      item_id: owner.item_id,
      topic_id: normalizedTopicId,
      entity_id: normalizedTopicId,
      payload: {
        item_type: owner.item_type,
        item_id: owner.item_id,
        topic_id: normalizedTopicId,
        deleted_at: deletedAt,
        source: "local_config_topics_diff",
      },
    });
  }

  const currentOrder = topicOrderOf(currentTopics);
  const previousOrder = topicOrderOf(previousTopics);
  operations.push(
    ...buildTopicOrderMoveOperations(
      owner,
      previousOrder,
      currentOrder,
      context
    )
  );

  return operations;
}

async function diffConfig(relativePath, parsedJson, localIndex, context = {}) {
  const profile = context.profile || "bootstrap";
  const previous = localIndex.getFile(relativePath);
  const isNewEntity = !previous;
  const runtimeSchema =
    profile === "runtime" ? parseConfigIdentity(relativePath) : null;
  const isNewRuntimeItemConfig = Boolean(
    isNewEntity &&
      runtimeSchema &&
      (runtimeSchema.schema === "agent_config" ||
        runtimeSchema.schema === "group_config")
  );
  const effectiveProfile = isNewRuntimeItemConfig ? "bootstrap" : profile;
  const dto = safeConfigDto(relativePath, parsedJson, {
    profile: effectiveProfile,
    syncProfileConfig: context.syncProfileConfig,
  });
  if (
    dto.schema === "skip" ||
    dto.schema === "unsupported_config" ||
    dto.syncable === false
  ) {
    return {
      changed: false,
      skipped: true,
      reason:
        profile === "runtime"
          ? "runtime_profile_excluded"
          : "unsupported_config",
      dto,
    };
  }

  const checksum = checksumJson(dto.checksum_source);
  const changed = !previous || previous.checksum !== checksum;
  const previousSnapshot =
    previous && previous.snapshot_json ? previous.snapshot_json : null;
  const additionalOperations = [
    ...buildGroupMemberDeleteOperations(
      relativePath,
      parsedJson,
      previousSnapshot,
      context,
      checksum
    ),
    ...(profile === "runtime" && (previousSnapshot || isNewRuntimeItemConfig)
      ? buildTopicRuntimeOperations(
          relativePath,
          parsedJson,
          previousSnapshot,
          context,
          checksum
        )
      : []),
  ];
  let settingsAvatarUpload = null;
  if (
    /^settings\.json$/i.test(relativePath) &&
    dto.safe_projection_json.userAvatarUrl
  ) {
    settingsAvatarUpload = await uploadSettingsUserAvatar(
      parsedJson,
      localIndex,
      context
    );
  }
  const operationAction = isNewRuntimeItemConfig ? "create" : "update";
  const operation = {
    operation_id: operationId(
      context.deviceId || "unknown_device",
      `config.${dto.schema}.${operationAction}`,
      {
        item_type: "config",
        item_id: dto.entity_id,
        topic_id: dto.schema,
        id: checksum,
      },
      checksum
    ),
    device_id: context.deviceId,
    entity_type: dto.schema,
    action: operationAction,
    entity_id: dto.entity_id,
    payload: {
      dto_version: dto.dto_version,
      schema: dto.schema,
      entity_id: dto.entity_id,
      relative_path: relativePath,
      profile: dto.profile,
      projection_fields: dto.projection_fields,
      deleted_fields: dto.deleted_fields,
      safe_projection_json: dto.safe_projection_json,
      checksum,
    },
  };

  return {
    changed: changed || additionalOperations.length > 0,
    checksum,
    dto,
    operation,
    operations: changed
      ? [operation, ...additionalOperations]
      : additionalOperations,
    additionalOperations,
    settingsAvatarUpload,
  };
}

module.exports = {
  diffConfig,
  buildGroupMemberDeleteOperations,
  normalizeUserAvatarRelativePath,
  uploadSettingsUserAvatar,
};
