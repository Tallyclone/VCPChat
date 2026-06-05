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

function attachmentIndexKey(target) {
  return `UserData/attachments/${path.basename(target)}`;
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== "object") return "";
  const lowerName = String(name || "").toLowerCase();
  return headers[lowerName] || headers[name] || "";
}

function uniqueExts(...exts) {
  const out = [];
  for (const ext of exts) {
    const normalized = sanitizeExt(ext);
    if (!out.includes(normalized)) out.push(normalized);
  }
  return out;
}

function remoteAttachmentExt(localIndex, hash) {
  if (!localIndex || !localIndex.getFile) return "";
  const row = localIndex.getFile(`remote_attachment:${hash}`);
  return sanitizeExt(row && row.ext);
}

async function recordLocalAttachment(localIndex, target, ref, ext, extra = {}) {
  await localIndex.setFile(attachmentIndexKey(target), {
    kind: "attachment",
    hash: ref.hash,
    ext: sanitizeExt(ext),
    local_path: target,
    checksum_status: "verified",
    ...extra,
    updated_at: new Date().toISOString(),
  });
}

async function findVerifiedLocalAttachment(
  config,
  ref,
  preferredExt,
  candidateExts
) {
  const preferredTarget = localAttachmentPath(config, ref.hash, preferredExt);
  await fs.ensureDir(path.dirname(preferredTarget));

  for (const ext of candidateExts) {
    const candidateTarget = localAttachmentPath(config, ref.hash, ext);
    if (!(await fs.pathExists(candidateTarget))) continue;
    const buffer = await fs.readFile(candidateTarget);
    if (checksumBuffer(buffer) !== ref.hash) continue;

    if (candidateTarget !== preferredTarget) {
      await fs.writeFile(preferredTarget, buffer);
      return {
        target: preferredTarget,
        ext: sanitizeExt(preferredExt),
        migrated: true,
      };
    }
    return { target: candidateTarget, ext: sanitizeExt(ext), migrated: false };
  }
  return null;
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
  const refExt = sanitizeExt(ref.ext);
  const indexedExt = remoteAttachmentExt(localIndex, ref.hash);
  const preferredKnownExt = indexedExt || refExt;
  const knownCandidateExts = uniqueExts(
    preferredKnownExt,
    refExt,
    indexedExt,
    ""
  );
  const existing = await findVerifiedLocalAttachment(
    config,
    ref,
    preferredKnownExt,
    knownCandidateExts
  );
  if (existing) {
    await recordLocalAttachment(localIndex, existing.target, ref, existing.ext);
    return {
      ok: true,
      localPath: existing.target,
      downloaded: false,
      migrated: existing.migrated,
    };
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

  const headerExt = sanitizeExt(
    headerValue(downloaded.headers, "x-vchat-attachment-ext")
  );
  const finalExt = headerExt || indexedExt || refExt;
  const target = localAttachmentPath(config, ref.hash, finalExt);
  await fs.ensureDir(path.dirname(target));
  await fs.writeFile(target, buffer);
  await recordLocalAttachment(localIndex, target, ref, finalExt, {
    downloaded_at: new Date().toISOString(),
  });
  if (logger && logger.info) {
    logger.info("downloaded synced attachment", {
      hash: ref.hash,
      target,
      ext: finalExt,
      headerExt,
      indexedExt,
      refExt,
    });
  }
  return { ok: true, localPath: target, downloaded: true, ext: finalExt };
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
  const optionAvatarIdentity =
    options.avatarIdentity &&
    options.avatarIdentity.owner_type &&
    options.avatarIdentity.owner_id
      ? {
          owner_type: String(options.avatarIdentity.owner_type),
          owner_id: String(options.avatarIdentity.owner_id),
        }
      : null;
  const isAvatar = Boolean(isAvatarPath(relativePath) || optionAvatarIdentity);
  const avatarIdentity =
    optionAvatarIdentity ||
    (isAvatar ? parseAvatarIdentity(relativePath) : null);
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
        relative_path: options.avatarOperationRelativePath || relativePath,
        metadata: options.avatarOperationMetadata || {
          source: "appDataScanner",
        },
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
