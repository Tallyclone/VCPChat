const path = require("path");
const { readStableJson } = require("../watcher/stableFileReader");
const { checksumJson } = require("../core/hash");
const { operationId } = require("../core/identity");
const { safeConfigDto } = require("../core/safeConfigDto");
const {
  normalizeSlashes,
  safeJoinAppData,
  assertSafePathSegment,
} = require("../utils/pathRules");

function agentConfigRelativePath(agentId) {
  return normalizeSlashes(path.join("Agents", String(agentId), "config.json"));
}

async function buildAgentBootstrapOperation(
  identity,
  localIndex,
  context = {},
  options = {}
) {
  try {
    if (!identity || identity.item_type !== "agent" || !identity.item_id) {
      return { changed: false, skipped: true, reason: "not_agent" };
    }
    if (!context.config || !context.config.appDataPath) {
      return { changed: false, skipped: true, reason: "app_data_path_missing" };
    }

    const agentId = assertSafePathSegment(identity.item_id, "agent_id");
    const relativePath = agentConfigRelativePath(agentId);
    const previous = localIndex.getFile(relativePath);
    const force = options.force === true;
    if (!force && previous && previous.bootstrap_pending !== true) {
      return {
        changed: false,
        skipped: true,
        reason: previous.bootstrap_checksum
          ? "bootstrap_already_set"
          : "bootstrap_not_pending",
        relativePath,
      };
    }

    const filePath = safeJoinAppData(
      context.config.appDataPath,
      "Agents",
      agentId,
      "config.json"
    );
    const fileExists = await require("fs-extra").pathExists(filePath);
    if (!fileExists) {
      return {
        changed: false,
        skipped: true,
        reason: "agent_not_found",
        relativePath,
      };
    }
    const read = await readStableJson(filePath);
    if (!read.ok) {
      return {
        changed: false,
        skipped: true,
        reason: "agent_config_unreadable",
        error: read.error,
        relativePath,
      };
    }

    const dto = safeConfigDto(relativePath, read.value, {
      profile: "bootstrap",
      syncProfileConfig: context.syncProfileConfig,
    });
    if (
      dto.schema !== "agent_config" ||
      dto.syncable === false ||
      dto.schema === "skip" ||
      dto.schema === "unsupported_config"
    ) {
      return {
        changed: false,
        skipped: true,
        reason: "agent_config_not_syncable",
        relativePath,
      };
    }

    const checksum = checksumJson(dto.checksum_source);
    if (previous && previous.bootstrap_checksum === checksum) {
      return {
        changed: false,
        skipped: true,
        reason: "bootstrap_unchanged",
        checksum,
        relativePath,
      };
    }

    const action =
      previous && previous.bootstrap_checksum ? "update" : "create";
    const operation = {
      operation_id: operationId(
        context.deviceId || "unknown_device",
        `config.agent_config.${action}`,
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
      action,
      entity_id: dto.entity_id,
      payload: {
        dto_version: dto.dto_version,
        schema: dto.schema,
        entity_id: dto.entity_id,
        relative_path: relativePath,
        profile: "bootstrap",
        projection_fields: dto.projection_fields,
        deleted_fields: dto.deleted_fields,
        safe_projection_json: dto.safe_projection_json,
        checksum,
        bootstrap_reason: options.reason || "first_valid_conversation",
      },
    };

    return {
      changed: true,
      checksum,
      dto,
      operation,
      relativePath,
      reason: options.reason || "first_valid_conversation",
    };
  } catch (error) {
    return {
      changed: false,
      skipped: true,
      reason:
        error && error.code === "ENOENT"
          ? "agent_not_found"
          : "agent_bootstrap_build_failed",
      error: error.message,
    };
  }
}

async function markAgentBootstrapEnqueued(
  localIndex,
  result,
  enqueueResult = []
) {
  if (!result || !result.operation || !result.relativePath) return false;
  const accepted = enqueueResult.some(
    (entry) => entry && entry.operation_id === result.operation.operation_id
  );
  if (!accepted) return false;

  const previous = localIndex.getFile(result.relativePath) || {};
  await localIndex.setFile(result.relativePath, {
    ...previous,
    kind: "config",
    bootstrap_pending: false,
    bootstrap_checksum: result.checksum,
    bootstrap_operation_id: result.operation.operation_id,
    bootstrap_reason: result.reason,
    bootstrap_updated_at: new Date().toISOString(),
  });
  return true;
}

module.exports = {
  agentConfigRelativePath,
  buildAgentBootstrapOperation,
  markAgentBootstrapEnqueued,
};
