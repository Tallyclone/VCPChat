const chokidar = require("chokidar");
const path = require("path");
const { debounce } = require("../utils/debounce");
const {
  relativeAppDataPath,
  isHistoryPath,
  isConfigPath,
  isAttachmentLikePath,
} = require("../utils/pathRules");
const { handleFile } = require("../scanner/appDataScanner");
const { handleDeletedPaths } = require("../scanner/deleteEventHandler");

function createWatcher(
  config,
  localIndex,
  offlineQueue,
  writeIntentLock,
  logger,
  context = {}
) {
  let watcher = null;
  const pendingHandlers = new Map();

  function buildEventContext() {
    return {
      mode: context.modeProvider ? context.modeProvider() : context.mode,
      profile: "runtime",
      deviceId: context.deviceId,
      centerClient: context.centerClient,
      config,
      syncProfileConfig: context.syncProfileConfig,
    };
  }

  async function processFile(filePath) {
    const relativePath = relativeAppDataPath(config.appDataPath, filePath);
    if (relativePath.startsWith("sync/")) return;
    if (
      !isHistoryPath(relativePath) &&
      !isConfigPath(relativePath) &&
      !isAttachmentLikePath(relativePath)
    )
      return;
    try {
      await handleFile(
        config.appDataPath,
        filePath,
        localIndex,
        offlineQueue,
        writeIntentLock,
        logger,
        buildEventContext()
      );
    } catch (error) {
      logger.warn("watch event handling failed", {
        relativePath,
        error: error.message,
      });
    }
  }

  const deleteBuffer = new Map();
  let deleteFlushTimer = null;

  function flushDeleteBuffer() {
    if (deleteFlushTimer) {
      clearTimeout(deleteFlushTimer);
      deleteFlushTimer = null;
    }
    const entries = Array.from(deleteBuffer.values());
    deleteBuffer.clear();
    return handleDeletedPaths(
      config.appDataPath,
      entries,
      localIndex,
      offlineQueue,
      logger,
      buildEventContext()
    );
  }

  function scheduleDeleteFlush() {
    if (deleteFlushTimer) return;
    deleteFlushTimer = setTimeout(() => {
      flushDeleteBuffer().catch((error) => {
        logger.warn("watch delete batch handling failed", {
          error: error.message,
        });
      });
    }, config.watchDebounceMs || 250);
  }

  async function processDelete(filePath, isDirectory) {
    const relativePath = relativeAppDataPath(config.appDataPath, filePath);
    if (relativePath.startsWith("sync/")) return;
    deleteBuffer.set(filePath, {
      deletedPath: filePath,
      isDirectory,
      relativePath,
      timestamp: Date.now(),
    });
    scheduleDeleteFlush();
  }

  return {
    async start() {
      watcher = chokidar.watch(config.appDataPath, {
        ignored: [path.join(config.syncDir, "**")],
        ignoreInitial: true,
        awaitWriteFinish: false,
        persistent: true,
      });
      watcher.on("add", (filePath) => {
        if (!pendingHandlers.has(filePath))
          pendingHandlers.set(
            filePath,
            debounce(processFile, config.watchDebounceMs)
          );
        pendingHandlers.get(filePath)(filePath);
      });
      watcher.on("change", (filePath) => {
        if (!pendingHandlers.has(filePath))
          pendingHandlers.set(
            filePath,
            debounce(processFile, config.watchDebounceMs)
          );
        pendingHandlers.get(filePath)(filePath);
      });
      watcher.on("unlink", (filePath) => {
        processDelete(filePath, false);
      });
      watcher.on("unlinkDir", (dirPath) => {
        processDelete(dirPath, true);
      });
      watcher.on("error", (error) =>
        logger.error("watcher error", { error: error.message })
      );
      logger.info("watcher started", { appDataPath: config.appDataPath });
    },
    async stop() {
      if (deleteFlushTimer) {
        await flushDeleteBuffer().catch((error) =>
          logger.warn("watch delete final flush failed", {
            error: error.message,
          })
        );
      }
      if (watcher) await watcher.close();
      watcher = null;
      pendingHandlers.clear();
      deleteBuffer.clear();
    },
  };
}

module.exports = { createWatcher };
