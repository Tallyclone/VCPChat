const nativeFs = require("fs");
const fs = require("fs-extra");
const path = require("path");
const { checksumJson } = require("../core/hash");
const {
  diffHistory,
  applyLocalSnapshot,
} = require("../diff/historyDiffEngine");
const { parseHistoryIdentity } = require("../utils/pathRules");
const { shouldAdvanceIndexForLocalObservation } = require("./modePolicy");

function normalizeSlashes(value) {
  return String(value || "").replace(/\\/g, "/");
}

function intentFilePath(config) {
  return path.join(config.syncDir, "message_intents.jsonl");
}

function intentFilePaths(config) {
  const paths = [intentFilePath(config)];
  // Compatibility for early desktop writer builds that wrote AppData/UserData/sync.
  if (config && config.appDataPath) {
    paths.push(
      path.join(config.appDataPath, "UserData", "sync", "message_intents.jsonl")
    );
  }
  return [...new Set(paths.map((filePath) => path.resolve(filePath)))];
}

function stateFilePath(config) {
  return path.join(config.syncDir, "message_intents.state.json");
}

async function readConsumerState(config, logger) {
  const filePath = stateFilePath(config);
  try {
    if (!(await fs.pathExists(filePath))) {
      return {
        schema: "vchat.message_intent_consumer_state.v1",
        processed: {},
      };
    }
    const parsed = await fs.readJson(filePath);
    return {
      schema: "vchat.message_intent_consumer_state.v1",
      processed:
        parsed && parsed.processed && typeof parsed.processed === "object"
          ? parsed.processed
          : {},
      updated_at: parsed && parsed.updated_at,
    };
  } catch (error) {
    const corruptPath = `${filePath}.corrupt-${Date.now()}`;
    await fs.move(filePath, corruptPath, { overwrite: true }).catch(() => {});
    logger.warn("message intent consumer state was corrupt; starting fresh", {
      corruptPath,
      error: error.message,
    });
    return { schema: "vchat.message_intent_consumer_state.v1", processed: {} };
  }
}

async function writeConsumerState(config, state) {
  const filePath = stateFilePath(config);
  await fs.ensureDir(path.dirname(filePath));
  await fs.writeJson(
    filePath,
    { ...state, updated_at: new Date().toISOString() },
    { spaces: 2 }
  );
}

async function readIntentRows(config, logger) {
  const rows = [];
  for (const filePath of intentFilePaths(config)) {
    await fs.ensureFile(filePath);
    const raw = await fs.readFile(filePath, "utf8");
    const corrupt = [];
    const lines = raw.split(/\r?\n/);
    const hasTrailingNewline = /\r?\n$/.test(raw);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line) continue;
      const isLastPhysicalLine = index === lines.length - 1;
      try {
        const row = JSON.parse(line);
        if (
          row &&
          row.schema === "vchat.message_intent.v1" &&
          row.intent_type === "message_upsert"
        ) {
          rows.push(row);
        }
      } catch (_) {
        // If the writer is appending concurrently, the only valid partial JSONL
        // case is the final line without a trailing newline. Keep it for the next pass.
        if (isLastPhysicalLine && !hasTrailingNewline) {
          logger.warn(
            "message intent file has trailing partial line; will retry later",
            {
              filePath,
            }
          );
        } else {
          corrupt.push(line);
        }
      }
    }
    if (corrupt.length > 0) {
      const corruptPath = `${filePath}.corrupt-${Date.now()}`;
      await fs.writeFile(corruptPath, corrupt.join("\n"), "utf8");
      logger.warn(
        "message intent file had corrupt lines; isolated copy written",
        {
          corruptPath,
          count: corrupt.length,
        }
      );
    }
  }
  return rows;
}

function isIntentProcessed(state, intent) {
  const id = intent && intent.intent_id;
  if (!id) return false;
  const previous = state.processed[id];
  return !!previous && previous.message_checksum === intent.message_checksum;
}

function markIntentProcessed(state, intent, result = {}) {
  const id = intent && intent.intent_id;
  if (!id) return;
  state.processed[id] = {
    message_checksum: intent.message_checksum || null,
    message_id: intent.message_id || null,
    history_path: intent.history_path || null,
    processed_at: new Date().toISOString(),
    operations: result.operations || 0,
    enqueued: result.enqueued || 0,
  };
}

function pruneProcessed(state, maxEntries) {
  const limit = Number(maxEntries || 50000);
  const entries = Object.entries(state.processed || {});
  if (entries.length <= limit) return;
  entries.sort((left, right) => {
    const leftTime = Date.parse((left[1] && left[1].processed_at) || 0) || 0;
    const rightTime = Date.parse((right[1] && right[1].processed_at) || 0) || 0;
    return rightTime - leftTime;
  });
  state.processed = Object.fromEntries(entries.slice(0, limit));
}

function resolveHistoryPath(config, intent) {
  const declared = intent && intent.history_path;
  if (!declared) return null;
  const resolved = path.resolve(declared);
  const appDataRoot = path.resolve(config.appDataPath);
  const relative = path.relative(appDataRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return resolved;
}

function buildHistoryGroups(config, intents) {
  const groups = new Map();
  for (const intent of intents) {
    const historyPath = resolveHistoryPath(config, intent);
    if (!historyPath) continue;
    const key = normalizeSlashes(historyPath);
    const existing = groups.get(key) || { historyPath, intents: [] };
    existing.intents.push(intent);
    groups.set(key, existing);
  }
  return Array.from(groups.values());
}

async function processHistoryGroup(
  config,
  group,
  localIndex,
  offlineQueue,
  logger,
  context
) {
  if (!(await fs.pathExists(group.historyPath))) {
    logger.warn("message intent history file is missing", {
      historyPath: group.historyPath,
      intents: group.intents.length,
    });
    return { operations: 0, enqueued: 0, skipped: group.intents.length };
  }

  const history = await fs.readJson(group.historyPath);
  const relativePath = normalizeSlashes(
    path.relative(config.appDataPath, group.historyPath)
  );
  const identity = parseHistoryIdentity(relativePath, {
    appDataPath: config.appDataPath,
  });
  if (!identity) {
    logger.warn("message intent history path is not a VChat history path", {
      historyPath: group.historyPath,
      relativePath,
    });
    return { operations: 0, enqueued: 0, skipped: group.intents.length };
  }

  const diff = await diffHistory(identity, history, localIndex, context);
  const mode = context.mode || "uninitialized";
  const enqueued = await offlineQueue.enqueueMany(diff.operations, { mode });
  if (shouldAdvanceIndexForLocalObservation(mode)) {
    await applyLocalSnapshot(localIndex, diff, enqueued);
  }

  logger.info("message intents consumed for history", {
    relativePath,
    intents: group.intents.length,
    operations: diff.operations.length,
    enqueued: enqueued.length,
    skipped: diff.skipped.length,
    history_checksum: checksumJson(history),
  });

  return {
    operations: diff.operations.length,
    enqueued: enqueued.length,
    skipped: diff.skipped.length,
  };
}

function createMessageIntentConsumer(
  config,
  localIndex,
  offlineQueue,
  logger,
  options = {}
) {
  let timer = null;
  let debounceTimer = null;
  let stopped = true;
  let running = false;
  let watchers = [];
  let modeProvider = options.modeProvider || (() => "uninitialized");
  const intervalMs = Number(config.messageIntentConsumerIntervalMs || 30000);
  const watchDebounceMs = Number(
    config.messageIntentConsumerWatchDebounceMs ||
      options.messageIntentConsumerWatchDebounceMs ||
      1500
  );

  async function processOnce(processOptions = {}) {
    if (running) return { skipped: true, reason: "already_running" };
    running = true;
    try {
      const mode = processOptions.mode || modeProvider();
      const rows = await readIntentRows(config, logger);
      const state = await readConsumerState(config, logger);
      const pending = rows.filter((row) => !isIntentProcessed(state, row));
      if (pending.length === 0) {
        return {
          intents: rows.length,
          pending: 0,
          histories: 0,
          operations: 0,
          enqueued: 0,
        };
      }

      const groups = buildHistoryGroups(config, pending);
      const summary = {
        intents: rows.length,
        pending: pending.length,
        histories: groups.length,
        operations: 0,
        enqueued: 0,
        skipped: 0,
      };
      const context = {
        ...options,
        ...processOptions,
        mode,
        profile: processOptions.profile || options.profile || "runtime",
        deviceId: config.deviceId,
        config,
      };

      const resultsByHistory = new Map();
      for (const group of groups) {
        const result = await processHistoryGroup(
          config,
          group,
          localIndex,
          offlineQueue,
          logger,
          context
        );
        resultsByHistory.set(normalizeSlashes(group.historyPath), result);
        summary.operations += result.operations || 0;
        summary.enqueued += result.enqueued || 0;
        summary.skipped += result.skipped || 0;
      }

      for (const intent of pending) {
        const historyPath = resolveHistoryPath(config, intent);
        const result = historyPath
          ? resultsByHistory.get(normalizeSlashes(historyPath))
          : { operations: 0, enqueued: 0 };
        markIntentProcessed(state, intent, result || {});
      }
      pruneProcessed(state, options.maxProcessedIntents || 50000);
      await writeConsumerState(config, state);
      return summary;
    } finally {
      running = false;
    }
  }

  function scheduleProcessOnce(reason) {
    if (stopped) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      processOnce({ reason }).catch((error) => {
        logger.warn("message intent consumer watcher trigger failed", {
          reason,
          error: error.message,
        });
      });
    }, watchDebounceMs);
  }

  async function startWatchers() {
    stopWatchers();
    const paths = intentFilePaths(config);
    for (const filePath of paths) {
      await fs.ensureDir(path.dirname(filePath));
      await fs.ensureFile(filePath);
      try {
        const watcher = nativeFs.watch(filePath, { persistent: false }, () => {
          scheduleProcessOnce("intent_file_changed");
        });
        watcher.on("error", (error) => {
          logger.warn("message intent file watcher failed", {
            filePath,
            error: error.message,
          });
        });
        watchers.push(watcher);
      } catch (error) {
        logger.warn("message intent file watcher could not start", {
          filePath,
          error: error.message,
        });
      }
    }
  }

  function stopWatchers() {
    for (const watcher of watchers) {
      try {
        watcher.close();
      } catch (_) {}
    }
    watchers = [];
  }

  async function loop() {
    if (stopped) return;
    await processOnce({ reason: "interval" }).catch((error) => {
      logger.warn("message intent consumer failed", { error: error.message });
    });
    if (!stopped) timer = setTimeout(loop, intervalMs);
  }

  return {
    processOnce,
    async start(startOptions = {}) {
      if (startOptions.modeProvider) modeProvider = startOptions.modeProvider;
      if (!stopped) return;
      stopped = false;
      await startWatchers();
      timer = setTimeout(loop, Math.min(intervalMs, 2000));
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = null;
      stopWatchers();
    },
    stats() {
      return {
        interval_ms: intervalMs,
        watch_debounce_ms: watchDebounceMs,
        watcher_count: watchers.length,
        running,
        stopped,
      };
    },
  };
}

module.exports = {
  createMessageIntentConsumer,
  readIntentRows,
  intentFilePath,
};
