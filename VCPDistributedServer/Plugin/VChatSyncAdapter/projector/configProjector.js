const path = require("path");
const fs = require("fs-extra");
const { atomicWriteJson } = require("./atomicWriter");
const { checksumJson } = require("../core/hash");
const {
  assertInsideAppData,
  assertSafePathSegment,
  normalizeSlashes,
  safeJoinAppData,
} = require("../utils/pathRules");
const {
  mergeProjectedConfig,
  validateSafeConfigDto,
} = require("../core/configSchema");

function pathForConfigEvent(config, event) {
  const payload = event.payload || {};
  const schema = payload.schema || event.entity_type;
  const rawRelativePath =
    payload.relative_path || payload.entity_id || event.entity_id;
  if (!rawRelativePath) return null;

  const relativePath = normalizeSlashes(rawRelativePath);
  if (relativePath.includes("/") || /\.json$/i.test(relativePath)) {
    return safeJoinAppData(config.appDataPath, relativePath);
  }

  if (schema === "agent_config") {
    const entityId = assertSafePathSegment(
      relativePath,
      "agent_config entity_id"
    );
    return safeJoinAppData(
      config.appDataPath,
      "Agents",
      entityId,
      "config.json"
    );
  }
  if (schema === "group_config") {
    const entityId = assertSafePathSegment(
      relativePath,
      "group_config entity_id"
    );
    return safeJoinAppData(
      config.appDataPath,
      "AgentGroups",
      entityId,
      "config.json"
    );
  }
  return safeJoinAppData(config.appDataPath, relativePath);
}

async function readLocalConfig(filePath) {
  if (!(await fs.pathExists(filePath))) return {};
  const value = await fs.readJson(filePath);
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

async function applyConfigDeleteEvent(event, context, filePath) {
  const { config, writeIntentLock, localIndex } = context;
  const relativePath = assertInsideAppData(config.appDataPath, filePath);
  await writeIntentLock.record({
    relative_path: relativePath,
    filePath,
    source: "sync_projector",
    expectedChecksum: null,
    ttl_ms: 60000,
    expireAt: Date.now() + 60000,
  });
  await fs.remove(filePath);
  await localIndex.deleteFile(relativePath);
  return { deleted: true, relativePath, seq: event.seq };
}

async function applyConfigEvents(events, context) {
  const { config, writeIntentLock, localIndex, logger } = context;
  let written = 0;
  for (const event of events) {
    const payload = event.payload || {};
    const dto = payload.safe_projection_json;
    const schema = payload.schema || event.entity_type;
    const filePath = pathForConfigEvent(config, event);
    if (!filePath) continue;
    if (event.action === "delete") {
      await applyConfigDeleteEvent(event, context, filePath);
      written += 1;
      continue;
    }
    if (!dto || typeof dto !== "object") continue;

    const profile = payload.profile || event.profile || "bootstrap";
    const projectionFields =
      payload.projection_fields || event.projection_fields;
    const deletedFields = payload.deleted_fields || event.deleted_fields || [];
    if (profile === "runtime" && !Array.isArray(projectionFields)) {
      throw new Error(
        `runtime config event requires projection_fields: ${schema}:${
          payload.entity_id || event.entity_id
        }`
      );
    }
    if (
      profile === "runtime" &&
      (schema === "agent_config" || schema === "group_config") &&
      !(await fs.pathExists(filePath))
    ) {
      if (logger && logger.warn) {
        logger.warn("skip runtime config event for missing local config", {
          schema,
          entityId: payload.entity_id || event.entity_id,
          filePath,
          seq: event.seq,
        });
      }
      continue;
    }
    validateSafeConfigDto(schema, dto, {
      profile,
      projection_fields: projectionFields,
    });
    const localConfig = await readLocalConfig(filePath);
    const next = mergeProjectedConfig(localConfig, dto, {
      schema,
      profile,
      projection_fields: projectionFields,
      deleted_fields: deletedFields,
    });

    const expectedChecksum = checksumJson(next);
    const remoteDtoChecksum = checksumJson({
      dto_version: payload.dto_version,
      schema,
      entity_id: payload.entity_id || event.entity_id,
      safe_projection_json: dto,
      projection_fields: projectionFields,
      deleted_fields: deletedFields,
      profile,
    });

    const relativePath = assertInsideAppData(config.appDataPath, filePath);
    await writeIntentLock.record({
      relative_path: relativePath,
      filePath,
      source: "sync_projector",
      expectedChecksum,
      ttl_ms: 60000,
      expireAt: Date.now() + 60000,
    });
    await atomicWriteJson(filePath, next, { logger });
    await localIndex.setFile(relativePath, {
      kind: "config",
      checksum: remoteDtoChecksum,
      last_known_checksum: remoteDtoChecksum,
      local_projection_checksum: expectedChecksum,
      last_applied_seq: event.seq,
      updated_at: new Date().toISOString(),
    });
    written += 1;
  }
  if (events.length > 0 && logger && logger.debug) {
    logger.debug("config projector merged config DTO events", {
      count: events.length,
      written,
    });
  }
  return { applied: events.length, written };
}

module.exports = {
  applyConfigEvents,
  applyConfigDeleteEvent,
  pathForConfigEvent,
  readLocalConfig,
};
