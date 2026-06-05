const path = require("path");
const fs = require("fs-extra");
const { checksumBuffer } = require("../core/hash");
const {
  assertInsideAppData,
  assertSafePathSegment,
  isAvatarPath,
  normalizeSlashes,
  parseAvatarIdentity,
  safeJoinAppData,
} = require("../utils/pathRules");
const { sanitizeExt } = require("../sync/attachmentSync");

const VALID_OWNER_TYPES = new Set(["agent", "group", "user"]);

function eventPayload(event) {
  return event && event.payload && typeof event.payload === "object"
    ? event.payload
    : {};
}

function avatarIdentity(event) {
  const payload = eventPayload(event);
  const [entityOwnerType, ...entityOwnerIdParts] = String(
    event.entity_id || ""
  ).split(":");
  const ownerType = String(
    payload.owner_type ||
      payload.ownerType ||
      event.owner_type ||
      entityOwnerType ||
      ""
  ).trim();
  const ownerId = String(
    payload.owner_id ||
      payload.ownerId ||
      event.owner_id ||
      entityOwnerIdParts.join(":") ||
      ""
  ).trim();
  if (!VALID_OWNER_TYPES.has(ownerType)) {
    throw new Error("avatar owner_type must be agent, group, or user");
  }
  return {
    owner_type: ownerType,
    owner_id: assertSafePathSegment(ownerId, "avatar owner_id"),
  };
}

function defaultAvatarRelativePath(identity, ext) {
  const normalizedExt = sanitizeExt(ext) || ".png";
  if (identity.owner_type === "agent") {
    return `Agents/${identity.owner_id}/avatar${normalizedExt}`;
  }
  if (identity.owner_type === "group") {
    return `AgentGroups/${identity.owner_id}/avatar${normalizedExt}`;
  }
  return `user_avatar${normalizedExt}`;
}

function avatarPathForEvent(config, event, identity) {
  const payload = eventPayload(event);
  const ext =
    payload.ext || path.extname(payload.relative_path || "") || ".png";
  const relativePath = payload.relative_path
    ? normalizeSlashes(String(payload.relative_path))
    : defaultAvatarRelativePath(identity, ext);
  if (!isAvatarPath(relativePath)) {
    throw new Error(`unsafe avatar relative_path: ${relativePath}`);
  }
  const parsedIdentity = parseAvatarIdentity(relativePath);
  if (
    parsedIdentity &&
    (parsedIdentity.owner_type !== identity.owner_type ||
      parsedIdentity.owner_id !== identity.owner_id)
  ) {
    throw new Error(`avatar relative_path owner mismatch: ${relativePath}`);
  }
  const filePath = safeJoinAppData(config.appDataPath, relativePath);
  const safeRelativePath = assertInsideAppData(config.appDataPath, filePath);
  return { filePath, relativePath: safeRelativePath };
}

async function removeAvatarFile(event, context, identity) {
  const { config, writeIntentLock, localIndex } = context;
  const { filePath, relativePath } = avatarPathForEvent(
    config,
    event,
    identity
  );
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
  return { deleted: true, relativePath };
}

async function writeAvatarFile(event, context, identity) {
  const { config, centerClient, writeIntentLock, localIndex } = context;
  const payload = eventPayload(event);
  const hash = String(payload.hash || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error("avatar hash must be sha256 hex");
  }
  if (!centerClient || !centerClient.downloadAttachment) {
    throw new Error(
      "center client downloadAttachment is required for avatar projection"
    );
  }
  const { filePath, relativePath } = avatarPathForEvent(
    config,
    event,
    identity
  );
  const downloaded = await centerClient.downloadAttachment(hash);
  const buffer = downloaded.buffer;
  const checksum = checksumBuffer(buffer);
  if (checksum !== hash) {
    throw new Error(`downloaded avatar checksum mismatch: ${hash}`);
  }
  await writeIntentLock.record({
    relative_path: relativePath,
    filePath,
    source: "sync_projector",
    expectedChecksum: hash,
    ttl_ms: 60000,
    expireAt: Date.now() + 60000,
  });
  await fs.ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, buffer);
  await localIndex.setFile(relativePath, {
    kind: "avatar",
    owner_type: identity.owner_type,
    owner_id: identity.owner_id,
    hash,
    ext: sanitizeExt(payload.ext || path.extname(filePath)),
    mime_type: payload.mime_type || payload.mime || null,
    last_applied_seq: event.seq,
    downloaded_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  return { written: true, relativePath, hash };
}

async function applyAvatarEvent(event, context) {
  const identity = avatarIdentity(event);
  if (event.action === "delete") {
    return removeAvatarFile(event, context, identity);
  }
  if (!["create", "update", "upsert", "baseline"].includes(event.action)) {
    throw new Error(`unsupported avatar action: ${event.action}`);
  }
  return writeAvatarFile(event, context, identity);
}

async function applyAvatarEvents(events, context) {
  let applied = 0;
  for (const event of events) {
    await applyAvatarEvent(event, context);
    applied += 1;
  }
  return { applied };
}

module.exports = {
  applyAvatarEvents,
  applyAvatarEvent,
  avatarIdentity,
  avatarPathForEvent,
  defaultAvatarRelativePath,
};
