const path = require("path");
const fs = require("fs-extra");
const { checksumBuffer } = require("../core/hash");

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
  config
) {
  const buffer = await fs.readFile(absolutePath);
  const hash = checksumBuffer(buffer);
  const ext = sanitizeExt(path.extname(absolutePath));
  const previous = localIndex.getFile(relativePath);
  const changed =
    !previous || previous.hash !== hash || previous.uploaded !== true;
  if (changed && centerClient && centerClient.uploadAttachment) {
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
  await localIndex.setFile(relativePath, {
    kind: "attachment",
    hash,
    ext,
    size: buffer.length,
    local_path: absolutePath,
    uploaded: true,
    checksum_status: "verified",
    updated_at: new Date().toISOString(),
  });
  return { changed, hash, size: buffer.length };
}

module.exports = {
  collectAttachmentRefs,
  rewriteMessageAttachments,
  uploadLocalAttachment,
  localAttachmentPath,
  sanitizeExt,
};
