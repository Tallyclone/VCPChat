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

const DEFAULT_INITIAL_DEBOUNCE_MS = 1000;
const DEFAULT_SHORT_TRAILING_DELAYS_MS = [5000, 10000];
const DEFAULT_ACTIVE_TOPIC_WINDOW_MS = 900000;
const DEFAULT_ACTIVE_TOPIC_SCAN_INTERVAL_MS = 60000;
const DEFAULT_ACTIVE_TOPIC_SCHEDULER_TICK_MS = 15000;
const DEFAULT_ACTIVE_TOPIC_MAX_SCAN_PER_TICK = 2;
const DEFAULT_ACTIVE_TOPIC_MAX_ACTIVE = 10;

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function listNumber(value, fallback) {
  if (Array.isArray(value)) return value.map(Number).filter((v) => Number.isFinite(v) && v > 0);
  if (typeof value === "string" && value.trim()) {
    const parsed = value
      .split(",")
      .map((item) => Number(item.trim()))
      .filter((v) => Number.isFinite(v) && v > 0);
    return parsed.length ? parsed : fallback;
  }
  return fallback;
}

function createWatcher(
  config,
  localIndex,
  offlineQueue,
  writeIntentLock,
  logger,
  context = {}
) {
  let watcher = null;
  let activeScanTimer = null;
  const pendingHandlers = new Map();
  const trailingTimers = new Map();
  const activeTopics = new Map();

  const initialDebounceMs = positiveNumber(
    config.initialDebounceMs || config.watchDebounceMs,
    DEFAULT_INITIAL_DEBOUNCE_MS
  );
  const shortTrailingDelaysMs = listNumber(
    config.shortTrailingDelaysMs || config.SHORT_TRAILING_DELAYS_MS,
    DEFAULT_SHORT_TRAILING_DELAYS_MS
  );
  const activeTopicWindowMs = positiveNumber(
    config.activeTopicWindowMs || config.ACTIVE_TOPIC_WINDOW_MS,
    DEFAULT_ACTIVE_TOPIC_WINDOW_MS
  );
  const activeTopicScanIntervalMs = positiveNumber(
    config.activeTopicScanIntervalMs || config.ACTIVE_TOPIC_SCAN_INTERVAL_MS,
    DEFAULT_ACTIVE_TOPIC_SCAN_INTERVAL_MS
  );
  const activeTopicSchedulerTickMs = positiveNumber(
    config.activeTopicSchedulerTickMs || config.ACTIVE_TOPIC_SCHEDULER_TICK_MS,
    DEFAULT_ACTIVE_TOPIC_SCHEDULER_TICK_MS
  );
  const activeTopicMaxScanPerTick = positiveNumber(
    config.activeTopicMaxScanPerTick || config.ACTIVE_TOPIC_MAX_SCAN_PER_TICK,
    DEFAULT_ACTIVE_TOPIC_MAX_SCAN_PER_TICK
  );
  const activeTopicMaxActive = positiveNumber(
    config.activeTopicMaxActive || config.ACTIVE_TOPIC_MAX_ACTIVE,
    DEFAULT_ACTIVE_TOPIC_MAX_ACTIVE
  );

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

  function isRuntimeHistoryFile(filePath) {
    const relativePath = relativeAppDataPath(config.appDataPath, filePath);
    return !relativePath.startsWith("sync/") && isHistoryPath(relativePath);
  }

  function markActiveTopic(filePath) {
    if (!isRuntimeHistoryFile(filePath)) return;
    const now = Date.now();
    if (!activeTopics.has(filePath) && activeTopics.size >= activeTopicMaxActive) {
      const oldest = Array.from(activeTopics.entries()).sort(
        (a, b) => (a[1].activeUntil || 0) - (b[1].activeUntil || 0)
      )[0];
      if (oldest) activeTopics.delete(oldest[0]);
    }
    const previous = activeTopics.get(filePath) || {};
    activeTopics.set(filePath, {
      activeUntil: now + activeTopicWindowMs,
      lastScanAt: previous.lastScanAt || 0,
    });
  }

  async function processFile(filePath, reason = "watch") {
    const relativePath = relativeAppDataPath(config.appDataPath, filePath);
    if (relativePath.startsWith("sync/")) return;
    if (
      !isHistoryPath(relativePath) &&
      !isConfigPath(relativePath) &&
      !isAttachmentLikePath(relativePath)
    )
      return;
    try {
      const result = await handleFile(
        config.appDataPath,
        filePath,
        localIndex,
        offlineQueue,
        writeIntentLock,
        logger,
        buildEventContext()
      );
      if (isHistoryPath(relativePath) && activeTopics.has(filePath)) {
        activeTopics.get(filePath).lastScanAt = Date.now();
      }
      return result;
    } catch (error) {
      logger.warn("watch event handling failed", {
        relativePath,
        reason,
        error: error.message,
      });
    }
  }

  function scheduleDebouncedScan(filePath) {
    if (!pendingHandlers.has(filePath)) {
      pendingHandlers.set(
        filePath,
        debounce((targetPath) => processFile(targetPath, "debounce"), initialDebounceMs)
      );
    }
    pendingHandlers.get(filePath)(filePath);
  }

  function clearTrailingTimers(filePath) {
    const timers = trailingTimers.get(filePath) || [];
    timers.forEach((timer) => clearTimeout(timer));
    trailingTimers.delete(filePath);
  }

  function scheduleShortTrailingScans(filePath) {
    if (!isRuntimeHistoryFile(filePath)) return;
    clearTrailingTimers(filePath);
    const timers = shortTrailingDelaysMs.map((delayMs) =>
      setTimeout(() => {
        processFile(filePath, `short_trailing_${delayMs}ms`).catch((error) => {
          logger.warn("watch trailing scan failed", {
            relativePath: relativeAppDataPath(config.appDataPath, filePath),
            delayMs,
            error: error.message,
          });
        });
      }, delayMs)
    );
    trailingTimers.set(filePath, timers);
  }

  function scheduleHistoryScans(filePath) {
    markActiveTopic(filePath);
    scheduleDebouncedScan(filePath);
    scheduleShortTrailingScans(filePath);
  }

  async function runActiveTopicTick() {
    const now = Date.now();
    let scanned = 0;
    for (const [filePath, state] of activeTopics.entries()) {
      if (state.activeUntil <= now) {
        activeTopics.delete(filePath);
        continue;
      }
      if (now - (state.lastScanAt || 0) < activeTopicScanIntervalMs) continue;
      if (scanned >= activeTopicMaxScanPerTick) break;
      state.lastScanAt = now;
      scanned += 1;
      await processFile(filePath, "active_topic_scan");
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
    clearTrailingTimers(filePath);
    activeTopics.delete(filePath);
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
        if (isRuntimeHistoryFile(filePath)) scheduleHistoryScans(filePath);
        else scheduleDebouncedScan(filePath);
      });
      watcher.on("change", (filePath) => {
        if (isRuntimeHistoryFile(filePath)) scheduleHistoryScans(filePath);
        else scheduleDebouncedScan(filePath);
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
      activeScanTimer = setInterval(() => {
        runActiveTopicTick().catch((error) => {
          logger.warn("active topic scan tick failed", { error: error.message });
        });
      }, activeTopicSchedulerTickMs);
      logger.info("watcher started", {
        appDataPath: config.appDataPath,
        initialDebounceMs,
        shortTrailingDelaysMs,
        activeTopicWindowMs,
        activeTopicScanIntervalMs,
        activeTopicSchedulerTickMs,
        activeTopicMaxScanPerTick,
        activeTopicMaxActive,
      });
    },
    async stop() {
      if (activeScanTimer) {
        clearInterval(activeScanTimer);
        activeScanTimer = null;
      }
      for (const filePath of trailingTimers.keys()) clearTrailingTimers(filePath);
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
      trailingTimers.clear();
      activeTopics.clear();
      deleteBuffer.clear();
    },
  };
}

module.exports = { createWatcher };
