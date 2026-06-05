const path = require("path");
const fs = require("fs-extra");
const { checksumBuffer } = require("../core/hash");
const { isAvatarPath, parseAvatarIdentity } = require("../utils/pathRules");

function sanitizeExt(ext) {
  const raw = String(ext || "")
    .trim()
    .toLowerCase();
  if (!raw) return "";
  const normalized = raw.startsWith(".") ? raw : `.${raw}`;
  return /^\.[a-z0-9]{1,16}$/.test(normalized) ? normalized : "";
}

function localAttachmentPath(config, hash, ext) {
  return path.join(config.attachmentDir, `${hash}${sanitizeExt(ext)}`);
}

function collectAttachmentRefs(message) {
  const refs = [];
  const push = (value) => {
    if (!value || typeof value !== "object") return;
    const hash = value.hash || value.attachment_hash || value.sha256;
    if (!hash || !/^[a-f0-9]{64}$/i.test(String(hash))) return;
    refs.push({
      hash: String(hash).toLowerCase(),
      ext:
        value.ext ||
        path.extname(
          value.name || value.filename || value.internalPath || value.src || ""
        ),
      mime_type: value.mime_type || value.mime || value.type || null,
      filename: value.name || value.filename || null,
      source: value,
    });
  };
  if (Array.isArray(message.attachments)) message.attachments.forEach(push);
  if (Array.isArray(message.files)) message.files.forEach(push);
  if (message._fileManagerData) push(message._fileManagerData);
  if (message.file) push(message.file);
  return refs;
}

async function ensureLocalAttachment(ref, context) {
  const { config, centerClient, localIndex, logger } = context;
  const target = localAttachmentPath(config, ref.hash, ref.ext);
  await fs.ensureDir(path.dirname(target));
  if (await fs.pathExists(target)) {
    const buffer = await fs.readFile(target);
    if (checksumBuffer(buffer) === ref.hash) {
      await localIndex.setFile(
        `UserData/attachments/${path.basename(target)}`,
        {
          kind: "attachment",
          hash: ref.hash,
          ext: sanitizeExt(ref.ext),
          local_path: target,
          checksum_status: "verified",
          updated_at: new Date().toISOString(),
        }
      );
      return { ok: true, localPath: target, downloaded: false };
    }
  }
  if (!centerClient || !centerClient.downloadAttachment) {
    return {
      ok: false,
      pending: true,
      reason: "center_client_download_unavailable",
    };
  }
  const downloaded = await centerClient.downloadAttachment(ref.hash);
  const buffer = downloaded.buffer;
  const checksum = checksumBuffer(buffer);
  if (checksum !== ref.hash)
    throw new Error(`downloaded attachment checksum mismatch: ${ref.hash}`);
  await fs.writeFile(target, buffer);
  await localIndex.setFile(`UserData/attachments/${path.basename(target)}`, {
    kind: "attachment",
    hash: ref.hash,
    ext: sanitizeExt(ref.ext),
    local_path: target,
    checksum_status: "verified",
    downloaded_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  if (logger && logger.info)
    logger.info("downloaded synced attachment", { hash: ref.hash, target });
  return { ok: true, localPath: target, downloaded: true };
}

async function rewriteMessageAttachments(message, context) {
  if (!message || typeof message !== "object") return message;
  const refs = collectAttachmentRefs(message);
  const localByHash = new Map();
  for (const ref of refs) {
    const result = await ensureLocalAttachment(ref, context).catch((error) => ({
      ok: false,
      error: error.message,
    }));
    if (result.ok) localByHash.set(ref.hash, result.localPath);
  }

  const rewriteObject = (value) => {
    if (!value || typeof value !== "object") return value;
    const hash = String(
      value.hash || value.attachment_hash || value.sha256 || ""
    ).toLowerCase();
    const localPath = localByHash.get(hash);
    if (!localPath) return value;
    if (Object.prototype.hasOwnProperty.call(value, "internalPath")) {
      value.internalPath = localPath;
    }
    if (Object.prototype.hasOwnProperty.call(value, "src")) {
      value.src = localPath;
    }
    if (
      value._fileManagerData &&
      typeof value._fileManagerData === "object" &&
      Object.prototype.hasOwnProperty.call(
        value._fileManagerData,
        "internalPath"
      )
    ) {
      value._fileManagerData.internalPath = localPath;
    }
    if (String(value.url || "").startsWith("file://")) value.url = localPath;
    return value;
  };

  if (Array.isArray(message.attachments))
    message.attachments = message.attachments.map(rewriteObject);
  if (Array.isArray(message.files))
    message.files = message.files.map(rewriteObject);
  if (message._fileManagerData) rewriteObject(message._fileManagerData);
  if (message.file) rewriteObject(message.file);
  return message;
}

async function uploadLocalAttachment(
  relativePath,
  absolutePath,
  localIndex,
  centerClient,
  config,
  options = {}
) {
  const buffer = await fs.readFile(absolutePath);
  const hash = checksumBuffer(buffer);
  const ext = sanitizeExt(path.extname(absolutePath));
  const previous = localIndex.getFile(relativePath);
  const isAvatar = isAvatarPath(relativePath);
  const avatarIdentity = isAvatar ? parseAvatarIdentity(relativePath) : null;
  const changed =
    options.force === true ||
    !previous ||
    previous.hash !== hash ||
    previous.uploaded !== true;
  const uploadedToCenter = Boolean(
    changed && centerClient && centerClient.uploadAttachment
  );
  if (uploadedToCenter) {
    const basePayload = {
      hash,
      ext,
      filename: path.basename(absolutePath),
      device_id: config.deviceId,
      operation_id: `attachment.${config.deviceId}.${hash}`,
    };
    const multipartThreshold = Number(
      config.multipartAttachmentThresholdBytes || 8 * 1024 * 1024
    );
    if (buffer.length > multipartThreshold) {
      await centerClient.uploadAttachment({
        ...basePayload,
        buffer,
      });
    } else {
      await centerClient.uploadAttachment({
        ...basePayload,
        content_base64: buffer.toString("base64"),
      });
    }
  }

  const uploaded =
    previous && previous.uploaded === true ? true : uploadedToCenter;
  const avatarOperationId = avatarIdentity
    ? `avatar.${config.deviceId}.${avatarIdentity.owner_type}.${avatarIdentity.owner_id}.${hash}`
    : null;
  const shouldSubmitAvatarOperation = Boolean(
    isAvatar &&
      avatarIdentity &&
      centerClient &&
      centerClient.submitOperation &&
      uploaded &&
      (options.force === true ||
        !previous ||
        previous.kind !== "avatar" ||
        previous.hash !== hash ||
        previous.avatar_operation_submitted !== true ||
        previous.avatar_operation_hash !== hash ||
        previous.avatar_operation_id !== avatarOperationId)
  );
  let avatarOperationSubmitted = false;
  if (shouldSubmitAvatarOperation) {
    await centerClient.submitOperation({
      operation_id: avatarOperationId,
      device_id: config.deviceId,
      entity_type: "avatar",
      entity_id: `${avatarIdentity.owner_type}:${avatarIdentity.owner_id}`,
      action: previous && previous.kind === "avatar" ? "update" : "create",
      payload: {
        owner_type: avatarIdentity.owner_type,
        owner_id: avatarIdentity.owner_id,
        hash,
        ext,
        relative_path: relativePath,
        metadata: { source: "appDataScanner" },
      },
    });
    avatarOperationSubmitted = true;
  }

  await localIndex.setFile(relativePath, {
    kind: isAvatar ? "avatar" : "attachment",
    owner_type: avatarIdentity ? avatarIdentity.owner_type : undefined,
    owner_id: avatarIdentity ? avatarIdentity.owner_id : undefined,
    hash,
    ext,
    size: buffer.length,
    local_path: absolutePath,
    uploaded,
    avatar_operation_submitted: isAvatar
      ? previous &&
        previous.hash === hash &&
        previous.avatar_operation_submitted === true
        ? true
        : avatarOperationSubmitted
      : undefined,
    avatar_operation_hash: isAvatar
      ? avatarOperationSubmitted
        ? hash
        : previous && previous.hash === hash
        ? previous.avatar_operation_hash
        : undefined
      : undefined,
    avatar_operation_id: isAvatar
      ? avatarOperationSubmitted
        ? avatarOperationId
        : previous && previous.hash === hash
        ? previous.avatar_operation_id
        : undefined
      : undefined,
    checksum_status: "verified",
    updated_at: new Date().toISOString(),
  });
  return {
    changed,
    hash,
    size: buffer.length,
    uploaded: uploadedToCenter,
    avatarOperationSubmitted,
  };
}

module.exports = {
  collectAttachmentRefs,
  rewriteMessageAttachments,
  uploadLocalAttachment,
  localAttachmentPath,
  sanitizeExt,
};
