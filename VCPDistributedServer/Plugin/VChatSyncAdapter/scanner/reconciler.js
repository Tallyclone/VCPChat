const fs = require("fs-extra");
const path = require("path");
const { handleFile } = require("./appDataScanner");
const { relativeAppDataPath, isHistoryPath } = require("../utils/pathRules");

const DEFAULT_RECONCILE_ENABLED = true;
const DEFAULT_RECONCILE_INTERVAL_MS = 300000;
const DEFAULT_RECONCILE_MAX_FILES_PER_RUN = 5;
const DEFAULT_RECONCILE_MAX_OPS_PER_RUN = 50;
const DEFAULT_RECONCILE_MAX_RUNTIME_MS = 3000;
const DEFAULT_RECONCILE_IDLE_DELAY_MS = 200;
const DEFAULT_RECONCILE_DISCOVERY_INTERVAL_MS = 1800000;
const DEFAULT_RECONCILE_DISCOVERY_MAX_FILES_PER_RUN = 100;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function numberValue(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function walkHistoryFiles(root, visitor, limitState) {
  if (!(await fs.pathExists(root))) return;
  if (limitState.count >= limitState.limit) return;
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (limitState.count >= limitState.limit) return;
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "sync") continue;
      await walkHistoryFiles(fullPath, visitor, limitState);
    } else {
      const relativePath = relativeAppDataPath(limitState.appDataPath, fullPath);
      if (!relativePath.startsWith("sync/") && isHistoryPath(relativePath)) {
        limitState.count += 1;
        await visitor(fullPath, relativePath);
      }
    }
  }
}

function createReconciler(runtime) {
  const { config, logger } = runtime;
  const enabled = config.reconcileEnabled !== false && DEFAULT_RECONCILE_ENABLED;
  const intervalMs = numberValue(config.reconcileIntervalMs, DEFAULT_RECONCILE_INTERVAL_MS);
  const maxFilesPerRun = numberValue(config.reconcileMaxFilesPerRun, DEFAULT_RECONCILE_MAX_FILES_PER_RUN);
  const maxOpsPerRun = numberValue(config.reconcileMaxOpsPerRun, DEFAULT_RECONCILE_MAX_OPS_PER_RUN);
  const maxRuntimeMs = numberValue(config.reconcileMaxRuntimeMs, DEFAULT_RECONCILE_MAX_RUNTIME_MS);
  const idleDelayMs = numberValue(config.reconcileIdleDelayMs, DEFAULT_RECONCILE_IDLE_DELAY_MS);
  const discoveryIntervalMs = numberValue(config.reconcileDiscoveryIntervalMs, DEFAULT_RECONCILE_DISCOVERY_INTERVAL_MS);
  const discoveryMaxFilesPerRun = numberValue(config.reconcileDiscoveryMaxFilesPerRun, DEFAULT_RECONCILE_DISCOVERY_MAX_FILES_PER_RUN);
  const statePath = path.join(config.syncDir, "reconcile_state.json");
  let timer = null;
  let running = false;
  let stopped = false;
  let state = { files: {}, candidates: [], last_discovery_at: 0 };

  async function loadState() {
    try {
      if (await fs.pathExists(statePath)) {
        state = { ...state, ...(await fs.readJson(statePath)) };
        state.files = state.files || {};
        state.candidates = Array.isArray(state.candidates) ? state.candidates : [];
      }
    } catch (error) {
      logger.warn("reconcile state load failed; rebuilding", { error: error.message });
    }
  }

  async function saveState() {
    await fs.ensureDir(path.dirname(statePath));
    await fs.writeJson(statePath, state, { spaces: 2 });
  }

  async function discover(force = false) {
    const now = Date.now();
    if (!force && now - (state.last_discovery_at || 0) < discoveryIntervalMs) return;
    const known = new Set(state.candidates || []);
    const limitState = { appDataPath: config.appDataPath, count: 0, limit: discoveryMaxFilesPerRun };
    await walkHistoryFiles(config.appDataPath, async (filePath, relativePath) => {
      const stat = await fs.stat(filePath).catch(() => null);
      if (!stat) return;
      const previous = state.files[relativePath];
      const signature = `${stat.size}:${Math.floor(stat.mtimeMs)}`;
      if (!previous || previous.signature !== signature) known.add(relativePath);
      state.files[relativePath] = { ...(previous || {}), signature };
    }, limitState);
    state.candidates = Array.from(known);
    state.last_discovery_at = now;
    await saveState();
  }

  async function runOnce(reason = "timer") {
    if (!enabled || running || stopped) return { skipped: true, reason: running ? "running" : "disabled" };
    running = true;
    const startedAt = Date.now();
    const summary = { reason, scanned: 0, operations: 0, skipped: 0, remaining: 0 };
    try {
      await discover(false);
      while (
        state.candidates.length > 0 &&
        summary.scanned < maxFilesPerRun &&
        summary.operations < maxOpsPerRun
      ) {
        if (Date.now() - startedAt > maxRuntimeMs) break;
        const relativePath = state.candidates.shift();
        const filePath = path.join(config.appDataPath, relativePath);
        if (!(await fs.pathExists(filePath))) continue;
        try {
          const result = await handleFile(
            config.appDataPath,
            filePath,
            runtime.localIndex,
            runtime.offlineQueue,
            runtime.writeIntentLock,
            logger,
            {
              mode: runtime.state.mode || "active",
              profile: "runtime",
              deviceId: config.deviceId,
              centerClient: runtime.centerClient,
              config,
              syncProfileConfig: config.syncProfileConfig,
              reconcile: true,
            }
          );
          summary.scanned += 1;
          summary.operations += Number(result.operations || 0);
          if (result.skipped) summary.skipped += 1;
          const stat = await fs.stat(filePath).catch(() => null);
          if (stat) {
            state.files[relativePath] = {
              signature: `${stat.size}:${Math.floor(stat.mtimeMs)}`,
              last_scanned_at: new Date().toISOString(),
            };
          }
          if (idleDelayMs > 0 && state.candidates.length > 0) {
            await wait(idleDelayMs);
          }
        } catch (error) {
          summary.skipped += 1;
          logger.warn("reconcile file scan failed", { relativePath, error: error.message });
        }
      }
      summary.remaining = state.candidates.length;
      await saveState();
      if (summary.scanned > 0 || summary.operations > 0) logger.info("reconcile run completed", summary);
      return summary;
    } finally {
      running = false;
    }
  }

  function schedule() {
    if (stopped || !enabled) return;
    timer = setTimeout(async () => {
      await runOnce("timer").catch((error) => logger.warn("reconcile run failed", { error: error.message }));
      schedule();
    }, intervalMs);
  }

  return {
    async start() {
      if (!enabled) return;
      stopped = false;
      await loadState();
      await discover(true).catch((error) => logger.warn("initial reconcile discovery failed", { error: error.message }));
      schedule();
      logger.info("reconciler started", { intervalMs, maxFilesPerRun, maxOpsPerRun, maxRuntimeMs, idleDelayMs });
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      await saveState().catch(() => {});
    },
    runOnce,
  };
}

module.exports = { createReconciler };
