const fs = require("fs");
const path = require("path");
const os = require("os");
const dotenv = require("dotenv");
const { createLogger } = require("./utils/logger");
const { ensureAdapterState, readState, writeState } = require("./sync/state");
const { createLocalIndex } = require("./core/localIndex");
const { scanAppData } = require("./scanner/appDataScanner");
const { createWatcher } = require("./watcher/appDataWatcher");
const { createOfflineQueue } = require("./sync/offlineQueue");
const { createCenterClient } = require("./sync/centerClient");
const { createWriteIntentLock } = require("./sync/writeIntentLock");
const { createPullLoop } = require("./sync/pullLoop");
const { canUploadInMode } = require("./sync/modePolicy");
const {
  bootstrapPrimary,
  joinExisting,
  mergeExisting,
  buildLocalManifest,
  scanNormalizedIdConflicts,
} = require("./sync/bootstrapManager");

let runtime = null;

function boolValue(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["true", "1", "yes", "on"].includes(
    String(value).trim().toLowerCase()
  );
}

function intValue(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function requireAdapterAuth(config, req) {
  const configured = config.syncKey || "";
  const header = String(
    (req.headers &&
      (req.headers["x-vchat-sync-key"] ||
        req.headers["x-vchat-bootstrap-key"] ||
        req.headers.authorization)) ||
      ""
  );
  const token = header.replace(/^Bearer\s+/i, "");
  if (!configured || configured === "change-me" || token !== configured) {
    const error = new Error("adapter bootstrap authorization failed");
    error.statusCode = 401;
    throw error;
  }
}

function loadAdapterEnv(projectBasePath = process.cwd()) {
  const adapterDir = __dirname;
  const envPath = path.join(adapterDir, "config.env");
  if (!fs.existsSync(envPath)) {
    return {
      envPath,
      envConfig: {},
      loaded: false,
    };
  }
  return {
    envPath,
    envConfig: dotenv.parse(fs.readFileSync(envPath, "utf8")),
    loaded: true,
  };
}

function pickConfigValue(hostValue, envValue, fallback = "") {
  if (envValue !== undefined && envValue !== null && envValue !== "")
    return envValue;
  if (hostValue !== undefined && hostValue !== null && hostValue !== "")
    return hostValue;
  return fallback;
}

function resolveAppDataPath(pluginConfig, projectBasePath) {
  const configured = pickConfigValue(
    pluginConfig.VCHAT_APPDATA_PATH,
    pluginConfig.__adapterEnv?.VCHAT_APPDATA_PATH,
    "../AppData"
  );
  if (path.isAbsolute(configured)) return path.resolve(configured);
  return path.resolve(projectBasePath, configured);
}

function buildConfig(pluginConfig = {}, projectBasePath = process.cwd()) {
  const adapterEnv = pluginConfig.__adapterEnv || {};
  const appDataPath = resolveAppDataPath(pluginConfig, projectBasePath);
  const syncDir = path.join(appDataPath, "sync");
  const deviceId = pickConfigValue(
    pluginConfig.VCHAT_DEVICE_ID,
    adapterEnv.VCHAT_DEVICE_ID,
    `${os.hostname()}-${os.userInfo().username}`.replace(
      /[^a-zA-Z0-9_.-]/g,
      "_"
    )
  );
  return {
    enabled: boolValue(
      pickConfigValue(
        pluginConfig.VCHAT_ADAPTER_ENABLED,
        adapterEnv.VCHAT_ADAPTER_ENABLED
      ),
      false
    ),
    debug: boolValue(
      pickConfigValue(pluginConfig.DebugMode, adapterEnv.DebugMode),
      false
    ),
    mode: pickConfigValue(
      pluginConfig.VCHAT_ADAPTER_MODE,
      adapterEnv.VCHAT_ADAPTER_MODE,
      "uninitialized"
    ),
    appDataPath,
    syncDir,
    statePath: path.join(syncDir, "state.json"),
    indexPath: path.join(syncDir, "local_index.json"),
    queuePath: path.join(syncDir, "offline_queue.jsonl"),
    lockPath: path.join(syncDir, "write_intents.jsonl"),
    attachmentDir: path.join(appDataPath, "UserData", "attachments"),
    centerUrl: String(
      pickConfigValue(
        pluginConfig.VCHAT_SYNC_CENTER_URL,
        adapterEnv.VCHAT_SYNC_CENTER_URL
      )
    ).replace(/\/+$/, ""),
    syncKey: pickConfigValue(
      pluginConfig.VCHAT_SYNC_KEY,
      adapterEnv.VCHAT_SYNC_KEY
    ),
    deviceId,
    deviceName: pickConfigValue(
      pluginConfig.VCHAT_DEVICE_NAME,
      adapterEnv.VCHAT_DEVICE_NAME,
      os.hostname()
    ),
    watchDebounceMs: intValue(
      pickConfigValue(
        pluginConfig.VCHAT_WATCH_DEBOUNCE_MS,
        adapterEnv.VCHAT_WATCH_DEBOUNCE_MS
      ),
      700
    ),
    queueIntervalMs: intValue(
      pickConfigValue(
        pluginConfig.VCHAT_QUEUE_INTERVAL_MS,
        adapterEnv.VCHAT_QUEUE_INTERVAL_MS
      ),
      5000
    ),
    pullIntervalMs: intValue(
      pickConfigValue(
        pluginConfig.VCHAT_PULL_INTERVAL_MS,
        adapterEnv.VCHAT_PULL_INTERVAL_MS
      ),
      15000
    ),
    multipartAttachmentThresholdBytes: intValue(
      pickConfigValue(
        pluginConfig.VCHAT_ATTACHMENT_MULTIPART_THRESHOLD_BYTES,
        adapterEnv.VCHAT_ATTACHMENT_MULTIPART_THRESHOLD_BYTES
      ),
      8 * 1024 * 1024
    ),
    enableWebSocket: boolValue(
      pickConfigValue(
        pluginConfig.VCHAT_SYNC_ENABLE_WS,
        adapterEnv.VCHAT_SYNC_ENABLE_WS
      ),
      false
    ),
    autoBootstrapMode: pickConfigValue(
      pluginConfig.VCHAT_BOOTSTRAP_MODE,
      adapterEnv.VCHAT_BOOTSTRAP_MODE,
      "manual"
    ),
    releaseMode: pickConfigValue(
      pluginConfig.VCHAT_RELEASE_MODE,
      adapterEnv.VCHAT_RELEASE_MODE,
      "mvp-local-only"
    ),
  };
}

async function startAdapter(app, pluginConfig, projectBasePath) {
  const adapterEnvState = pluginConfig.__adapterEnvState || {
    envPath: path.join(__dirname, "config.env"),
    loaded: false,
  };
  const logger = createLogger(
    "VChatSyncAdapter",
    boolValue(
      pickConfigValue(
        pluginConfig.DebugMode,
        pluginConfig.__adapterEnv?.DebugMode
      ),
      false
    )
  );
  const config = buildConfig(pluginConfig, projectBasePath);
  logger.info("adapter config resolved", {
    adapterEnvPath: adapterEnvState.envPath,
    adapterEnvLoaded: adapterEnvState.loaded,
    centerUrl: config.centerUrl,
    deviceId: config.deviceId,
    appDataPath: config.appDataPath,
  });
  await ensureAdapterState(config, logger);
  const state = await readState(config, logger);

  state.mode = state.mode || config.mode || "uninitialized";
  state.enabled = config.enabled;
  state.device_id = config.deviceId;

  await writeState(config, state, logger);

  const localIndex = createLocalIndex(config, logger);
  await localIndex.load();
  if (localIndex.isCorrupted()) {
    state.mode = "recovering";
    state.enabled = false;
    state.recovering_reason = "local_index_corrupt";
    await writeState(config, state, logger);
  }

  const centerClient = createCenterClient(config, logger);
  const offlineQueue = createOfflineQueue(
    config,
    centerClient,
    localIndex,
    logger
  );
  const writeIntentLock = createWriteIntentLock(config, logger);
  const pullLoop = createPullLoop(
    config,
    centerClient,
    localIndex,
    writeIntentLock,
    logger
  );

  runtime = {
    config,
    logger,
    state,
    localIndex,
    centerClient,
    offlineQueue,
    writeIntentLock,
    pullLoop,
    writeState: async (nextState) => writeState(config, nextState, logger),
    watcher: null,
    startedAt: new Date().toISOString(),
  };

  app.get("/api/vchat-sync-adapter/status", async (req, res) => {
    try {
      requireAdapterAuth(config, req);
      const latestState = await readState(config, logger);
      const queueStats = await offlineQueue.stats();
      const pullStats = pullLoop.stats ? pullLoop.stats() : {};
      res.json({
        ok: true,
        enabled: config.enabled,
        mode: latestState.mode || "uninitialized",
        app_data_path: config.appDataPath,
        sync_dir: config.syncDir,
        device_id: config.deviceId,
        started_at: runtime.startedAt,
        queue: queueStats,
        pull: pullStats,
        index: localIndex.stats(),
      });
    } catch (error) {
      return res
        .status(error.statusCode || 401)
        .json({ ok: false, error: error.message });
    }
  });

  app.post("/api/vchat-sync-adapter/bootstrap/:mode", async (req, res) => {
    try {
      requireAdapterAuth(config, req);
      const mode = String(req.params.mode || "").trim();
      const actions = {
        bootstrap_primary: bootstrapPrimary,
        join_existing: joinExisting,
        merge_existing: mergeExisting,
      };
      if (!actions[mode])
        return res
          .status(400)
          .json({ ok: false, error: "unsupported bootstrap mode" });
      const result = await actions[mode](runtime, req.body || {});
      return res.json(result);
    } catch (error) {
      logger.error("bootstrap action failed", { error: error.message });
      return res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/vchat-sync-adapter/bootstrap/manifest", async (req, res) => {
    try {
      requireAdapterAuth(config, req);
      const manifest = await buildLocalManifest(config, {
        logger,
        allowConflicts: true,
      });
      return res.json(manifest);
    } catch (error) {
      return res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/vchat-sync-adapter/bootstrap/conflicts", async (req, res) => {
    try {
      requireAdapterAuth(config, req);
      const conflicts = await scanNormalizedIdConflicts(config.appDataPath);
      return res.json({ ok: true, conflicts });
    } catch (error) {
      return res.status(400).json({ ok: false, error: error.message });
    }
  });

  if (!config.enabled) {
    logger.warn(
      "adapter disabled; routes registered but scanner/watcher not started"
    );
    return runtime;
  }

  if (config.autoBootstrapMode !== "manual" && state.mode === "uninitialized") {
    const actions = {
      bootstrap_primary: bootstrapPrimary,
      join_existing: joinExisting,
      merge_existing: mergeExisting,
    };
    const action = actions[config.autoBootstrapMode];
    if (action) {
      await action(runtime).catch((error) => {
        logger.error("auto bootstrap failed; remaining uninitialized", {
          error: error.message,
        });
      });
    }
  }

  if (canUploadInMode(state.mode || "uninitialized")) {
    await centerClient.registerDevice().catch((error) => {
      logger.warn(
        "device registration failed; queue will retry operations later",
        { error: error.message }
      );
    });
  }

  const scanResult = await scanAppData(
    config.appDataPath,
    localIndex,
    offlineQueue,
    writeIntentLock,
    logger,
    {
      mode: state.mode || "uninitialized",
      deviceId: config.deviceId,
      centerClient,
      config,
    }
  );
  state.last_scan_at = new Date().toISOString();
  state.last_scan_result = scanResult.summary;
  await writeState(config, state, logger);

  await offlineQueue.start({
    modeProvider: () => runtime.state.mode || "uninitialized",
  });
  await pullLoop.start();

  runtime.watcher = createWatcher(
    config,
    localIndex,
    offlineQueue,
    writeIntentLock,
    logger,
    {
      modeProvider: () => runtime.state.mode || "uninitialized",
      deviceId: config.deviceId,
      centerClient,
      config,
    }
  );
  await runtime.watcher.start();
  logger.info("adapter started", {
    appDataPath: config.appDataPath,
    mode: state.mode,
  });
  return runtime;
}

function registerRoutes(app, pluginConfig = {}, projectBasePath) {
  const adapterEnvState = loadAdapterEnv(projectBasePath);
  const mergedPluginConfig = {
    ...pluginConfig,
    __adapterEnv: adapterEnvState.envConfig,
    __adapterEnvState: adapterEnvState,
  };
  startAdapter(app, mergedPluginConfig, projectBasePath).catch((error) => {
    console.error("[VChatSyncAdapter] failed to start:", error);
  });
}

async function shutdown() {
  if (runtime && runtime.watcher) await runtime.watcher.stop();
  if (runtime && runtime.pullLoop) await runtime.pullLoop.stop();
  if (runtime && runtime.offlineQueue) await runtime.offlineQueue.stop();
  runtime = null;
}

module.exports = { registerRoutes, shutdown, buildConfig, requireAdapterAuth };
