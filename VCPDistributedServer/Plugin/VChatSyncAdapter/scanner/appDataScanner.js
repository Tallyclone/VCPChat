const fs = require("fs-extra");
const path = require("path");
const {
  relativeAppDataPath,
  isHistoryPath,
  parseHistoryIdentity,
  isConfigPath,
  isAttachmentLikePath,
} = require("../utils/pathRules");
const { readStableJson } = require("../watcher/stableFileReader");
const {
  diffHistory,
  applyLocalSnapshot,
} = require("../diff/historyDiffEngine");
const { diffConfig } = require("../diff/configDiffEngine");
const { diffAttachment } = require("../diff/attachmentDiffEngine");
const { shouldAdvanceIndexForLocalObservation } = require("../sync/modePolicy");

async function walk(dir, visitor) {
  if (!(await fs.pathExists(dir))) return;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(fullPath, visitor);
    else await visitor(fullPath);
  }
}

async function handleFile(
  appDataPath,
  filePath,
  localIndex,
  offlineQueue,
  writeIntentLock,
  logger,
  context
) {
  const relativePath = relativeAppDataPath(appDataPath, filePath);

  if (isHistoryPath(relativePath)) {
    const identity = parseHistoryIdentity(relativePath, { appDataPath });
    const read = await readStableJson(filePath);
    const lockChecksum = read.ok
      ? require("../core/hash").checksumJson(read.value)
      : null;
    if (await writeIntentLock.isLocked(relativePath, lockChecksum)) {
      logger.debug("skip projector write-intent file", { relativePath });
      return { skipped: true, reason: "write_intent_lock", relativePath };
    }
    if (!read.ok) {
      logger.warn("skip unstable/corrupt history json", {
        relativePath,
        error: read.error,
      });
      return { skipped: true, reason: "corrupt_json", relativePath };
    }
    const diff = await diffHistory(identity, read.value, localIndex, context);
    const mode = context.mode || "uninitialized";
    const enqueued = await offlineQueue.enqueueMany(diff.operations, { mode });
    if (shouldAdvanceIndexForLocalObservation(mode)) {
      await applyLocalSnapshot(localIndex, diff, enqueued);
    } else {
      logger.warn(
        "history diff observed but local index not advanced because mode forbids upload",
        {
          relativePath,
          mode,
          operations: diff.operations.length,
        }
      );
    }
    return {
      relativePath,
      type: "history",
      operations: diff.operations.length,
      skipped: diff.skipped.length,
    };
  }

  if (isConfigPath(relativePath)) {
    const read = await readStableJson(filePath);
    const lockChecksum = read.ok
      ? require("../core/hash").checksumJson(read.value)
      : null;
    if (await writeIntentLock.isLocked(relativePath, lockChecksum)) {
      logger.debug("skip projector write-intent config file", { relativePath });
      return { skipped: true, reason: "write_intent_lock", relativePath };
    }
    if (!read.ok)
      return { skipped: true, reason: "corrupt_json", relativePath };
    const result = await diffConfig(relativePath, read.value, localIndex, {
      ...context,
      profile: context.profile || "runtime",
    });
    const mode = context.mode || "uninitialized";
    const operations = Array.isArray(result.operations)
      ? result.operations
      : result.operation
      ? [result.operation]
      : [];
    const enqueued = operations.length
      ? await offlineQueue.enqueueMany(operations, { mode })
      : [];
    if (
      shouldAdvanceIndexForLocalObservation(mode) &&
      operations.length > 0 &&
      enqueued.length > 0
    ) {
      await localIndex.setFile(relativePath, {
        kind: "config",
        checksum: result.checksum,
        last_known_checksum: result.checksum,
        pending_operation_id: result.operation && result.operation.operation_id,
        snapshot_json: read.value,
        updated_at: new Date().toISOString(),
      });
    }
    return {
      relativePath,
      type: "config",
      changed: result.changed,
      operations: enqueued.length,
      skipped: result.skipped ? 1 : 0,
    };
  }
  if (isAttachmentLikePath(relativePath)) {
    const result = await diffAttachment(
      relativePath,
      filePath,
      localIndex,
      context
    );
    return { relativePath, type: "attachment", changed: result.changed };
  }

  return { skipped: true, reason: "out_of_scope", relativePath };
}

async function scanAppData(
  appDataPath,
  localIndex,
  offlineQueue,
  writeIntentLock,
  logger,
  context = {}
) {
  const summary = {
    files: 0,
    histories: 0,
    configs: 0,
    attachments: 0,
    operations: 0,
    skipped: 0,
  };
  const configFiles = [];
  const historyFiles = [];
  const attachmentFiles = [];

  await walk(appDataPath, async (filePath) => {
    const relativePath = relativeAppDataPath(appDataPath, filePath);
    if (relativePath.startsWith("sync/")) return;
    if (isConfigPath(relativePath)) {
      configFiles.push(filePath);
    } else if (isHistoryPath(relativePath)) {
      historyFiles.push(filePath);
    } else if (isAttachmentLikePath(relativePath)) {
      attachmentFiles.push(filePath);
    }
  });

  const orderedFiles = [...configFiles, ...historyFiles, ...attachmentFiles];
  for (const filePath of orderedFiles) {
    const relativePath = relativeAppDataPath(appDataPath, filePath);
    summary.files += 1;
    try {
      const result = await handleFile(
        appDataPath,
        filePath,
        localIndex,
        offlineQueue,
        writeIntentLock,
        logger,
        context
      );
      if (result.type === "history") summary.histories += 1;
      if (result.type === "config") summary.configs += 1;
      if (result.type === "attachment") summary.attachments += 1;
      if (result.operations) summary.operations += result.operations;
      if (result.skipped) summary.skipped += 1;
    } catch (error) {
      summary.skipped += 1;
      logger.warn("scan file failed", { relativePath, error: error.message });
    }
  }
  logger.info("startup scan completed", {
    ...summary,
    scan_order: "config_history_attachment",
  });
  return { summary };
}

module.exports = { scanAppData, handleFile };
