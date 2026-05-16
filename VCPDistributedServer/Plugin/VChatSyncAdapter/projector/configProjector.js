const path = require("path");
const fs = require("fs-extra");
const { atomicWriteJson } = require("./atomicWriter");
const { checksumJson } = require("../core/hash");
const { normalizeSlashes } = require("../utils/pathRules");
const {
  mergeProjectedConfig,
  validateSafeConfigDto,
} = require("../core/configSchema");

function pathForConfigEvent(config, event) {
  const payload = event.payload || {};
  const relativePath =
    payload.relative_path || payload.entity_id || event.entity_id;
  if (!relativePath) return null;
  return path.join(config.appDataPath, relativePath);
}

async function readLocalConfig(filePath) {
  if (!(await fs.pathExists(filePath))) return {};
  const value = await fs.readJson(filePath);
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

async function applyConfigEvents(events, context) {
  const { config, writeIntentLock, localIndex, logger } = context;
  let written = 0;
  for (const event of events) {
    const payload = event.payload || {};
    const dto = payload.safe_projection_json;
    const schema = payload.schema || event.entity_type;
    const filePath = pathForConfigEvent(config, event);
    if (!filePath || !dto || typeof dto !== "object") continue;

    validateSafeConfigDto(schema, dto);
    const localConfig = await readLocalConfig(filePath);
    const next = mergeProjectedConfig(localConfig, dto, schema);
    const expectedChecksum = checksumJson(next);
    const remoteDtoChecksum = checksumJson({
      dto_version: payload.dto_version,
      schema,
      entity_id: payload.entity_id || event.entity_id,
      safe_projection_json: dto,
    });
    const relativePath = normalizeSlashes(
      path.relative(config.appDataPath, filePath)
    );
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

module.exports = { applyConfigEvents, pathForConfigEvent, readLocalConfig };
