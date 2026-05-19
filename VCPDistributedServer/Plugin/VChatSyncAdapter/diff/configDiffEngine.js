const { checksumJson } = require("../core/hash");
const { operationId } = require("../core/identity");
const { safeConfigDto } = require("../core/safeConfigDto");

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
      safe_projection_json: dto.safe_projection_json,
      checksum,
    },
  };
  return {
    changed,
    checksum,
    dto,
    operation,
  };
}

module.exports = { diffConfig };
