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
      avatarIdentity: { owner_type: "user", owner_id: "local_user" },
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
  for (const topic of currentTopics) {
    const normalized = normalizeTopicForTopicOperation(topic);
    if (!normalized) continue;
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

  const currentOrder = topicOrderOf(currentTopics);
  const previousOrder = topicOrderOf(previousTopics);
  if (
    currentOrder.length > 0 &&
    !sameStringArray(currentOrder, previousOrder)
  ) {
    operations.push({
      operation_id: operationId(
        context.deviceId || "unknown_device",
        "topic_order.replace",
        {
          item_type: owner.item_type,
          item_id: owner.item_id,
          topic_id: "topics",
          id: currentOrder.join("."),
        },
        checksumJson({ owner, order: currentOrder })
      ),
      device_id: context.deviceId,
      entity_type: "topic_order",
      action: "replace",
      item_type: owner.item_type,
      item_id: owner.item_id,
      entity_id: owner.item_id,
      payload: {
        item_type: owner.item_type,
        item_id: owner.item_id,
        topics_order: currentOrder,
        source: "local_config_topics_diff",
      },
    });
  }

  return operations;
}

async function diffConfig(relativePath, parsedJson, localIndex, context = {}) {
  const profile = context.profile || "bootstrap";
  const dto = safeConfigDto(relativePath, parsedJson, {
    profile,
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
  const previous = localIndex.getFile(relativePath);
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
    ...(profile === "runtime" && previousSnapshot
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
  const operation = {
    operation_id: operationId(
      context.deviceId || "unknown_device",
      `config.${dto.schema}.update`,
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
    action: "update",
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
