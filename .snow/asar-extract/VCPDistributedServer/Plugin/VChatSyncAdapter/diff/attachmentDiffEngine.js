const { uploadLocalAttachment } = require("../sync/attachmentSync");

async function diffAttachment(
  relativePath,
  absolutePath,
  localIndex,
  context = {}
) {
  const previous = localIndex.getFile(relativePath);
  const shouldUpload = context.mode === "active" && context.centerClient;
  if (!shouldUpload) {
    return {
      changed: false,
      skipped: true,
      reason: "mode_forbids_upload",
      previous,
    };
  }
  return uploadLocalAttachment(
    relativePath,
    absolutePath,
    localIndex,
    context.centerClient,
    context.config || {}
  );
}

module.exports = { diffAttachment };
