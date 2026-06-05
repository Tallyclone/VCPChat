const fs = require("fs");
const fsp = require("fs-extra");
const path = require("path");
const os = require("os");
const dotenv = require("dotenv");
const { createLogger } = require("./utils/logger");
const { ensureAdapterState, readState, writeState } = require("./sync/state");
const { createLocalIndex } = require("./core/localIndex");
const { scanAppData } = require("./scanner/appDataScanner");
const { createWatcher } = require("./watcher/appDataWatcher");
const { createThemeWatcher } = require("./watcher/themeWatcher");
const { createOfflineQueue } = require("./sync/offlineQueue");
const { createCenterClient } = require("./sync/centerClient");
const { createWriteIntentLock } = require("./sync/writeIntentLock");
const { createPullLoop } = require("./sync/pullLoop");
const { canUploadInMode } = require("./sync/modePolicy");
const { syncLocalThemes } = require("./diff/themeDiffEngine");
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
      (req.headers["x-vchat-sync-key"] || req.headers.authorization)) ||
      ""
  );
  const token = header.replace(/^Bearer\s+/i, "");
  if (!configured || configured === "change-me" || token !== configured) {
    const error = new Error("authorization failed");
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

const CENTER_REST_PATH = "/api/plugins/VChatSyncCenter";
const LATEST_SEQ_WS_PATH = "/vchat-sync/latest-seq";

function normalizeUrlPath(inputUrl, requiredPath, options = {}) {
  const raw = String(inputUrl || "").trim();
  if (!raw) return "";
  const normalizedRequired = `/${String(requiredPath || "").replace(
    /^\/+/,
    ""
  )}`;
  try {
    const url = new URL(raw);
    const currentPath = (url.pathname || "/").replace(/\/+$/, "") || "/";
    const currentLower = currentPath.toLowerCase();
    const requiredLower = normalizedRequired.toLowerCase();
    const replacePathLower = options.replacePath
      ? `/${String(options.replacePath).replace(/^\/+/, "")}`.toLowerCase()
      : "";
    if (currentLower === "/") {
      url.pathname = normalizedRequired;
    } else if (
      currentLower === requiredLower ||
      currentLower.endsWith(requiredLower)
    ) {
      url.pathname = currentPath;
    } else if (replacePathLower && currentLower.endsWith(replacePathLower)) {
      url.pathname = normalizedRequired;
    } else {
      url.pathname = `${currentPath}/${normalizedRequired.replace(/^\/+/, "")}`;
    }
    return url.toString().replace(/\/+$/, "");
  } catch (error) {
    const trimmed = raw.replace(/\/+$/, "");
    return trimmed.endsWith(normalizedRequired)
      ? trimmed
      : `${trimmed}${normalizedRequired}`;
  }
}

function normalizeCenterUrl(inputUrl) {
  return normalizeUrlPath(inputUrl, CENTER_REST_PATH);
}

function deriveLatestSeqWsUrl(centerUrl) {
  const raw = String(centerUrl || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    url.protocol = url.protocol.replace(/^http/i, "ws");
    url.pathname = LATEST_SEQ_WS_PATH;
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch (error) {
    return normalizeUrlPath(raw.replace(/^http/i, "ws"), LATEST_SEQ_WS_PATH, {
      replacePath: CENTER_REST_PATH,
    });
  }
}

function normalizeLatestSeqWsUrl(inputUrl, centerUrl) {
  const explicit = String(inputUrl || "").trim();
  if (explicit) {
    return normalizeUrlPath(
      explicit.replace(/^http/i, "ws"),
      LATEST_SEQ_WS_PATH,
      {
        replacePath: CENTER_REST_PATH,
      }
    );
  }
  return deriveLatestSeqWsUrl(centerUrl);
}

async function loadSyncProfileConfig(adapterDir = __dirname, logger = null) {
  const configPath = path.join(adapterDir, "config", "sync_profile.json");
  const defaultConfig = {
    version: 1,
    runtimeSync: {
      agent_config: { include: [], exclude: [], deleteMissing: false },
      group_config: { include: [], exclude: [], deleteMissing: false },
    },
    bootstrap: { conflictPolicy: "report_only" },
  };
  try {
    if (!(await fsp.pathExists(configPath))) {
      await fsp.ensureDir(path.dirname(configPath));
      await fsp.writeJson(configPath, defaultConfig, { spaces: 2 });
      if (logger && logger.info) {
        logger.info("sync profile config created with defaults", {
          configPath,
        });
      }
      return defaultConfig;
    }
    const loaded = await fsp.readJson(configPath);
    const loadedRuntimeSync =
      loaded && loaded.runtimeSync && typeof loaded.runtimeSync === "object"
        ? loaded.runtimeSync
        : {};
    const merged = {
      ...defaultConfig,
      ...(loaded && typeof loaded === "object" ? loaded : {}),
      runtimeSync: {
        ...defaultConfig.runtimeSync,
        ...loadedRuntimeSync,
        agent_config: {
          ...defaultConfig.runtimeSync.agent_config,
          ...((loadedRuntimeSync && loadedRuntimeSync.agent_config) || {}),
        },
        group_config: {
          ...defaultConfig.runtimeSync.group_config,
          ...((loadedRuntimeSync && loadedRuntimeSync.group_config) || {}),
        },
      },
      bootstrap: {
        ...defaultConfig.bootstrap,
        ...((loaded && loaded.bootstrap) || {}),
      },
    };
    if (logger && logger.info) {
      logger.info("sync profile config loaded", {
        configPath,
        agentInclude: merged.runtimeSync.agent_config.include.length,
        agentExclude: merged.runtimeSync.agent_config.exclude.length,
        agentDeleteMissing:
          merged.runtimeSync.agent_config.deleteMissing === true,
        groupInclude: merged.runtimeSync.group_config.include.length,
        groupExclude: merged.runtimeSync.group_config.exclude.length,
        groupDeleteMissing:
          merged.runtimeSync.group_config.deleteMissing === true,
      });
    }
    return merged;
  } catch (error) {
    if (logger && logger.warn) {
      logger.warn("failed to load sync profile config; using defaults", {
        configPath,
        error: error.message,
      });
    }
    return defaultConfig;
  }
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
  const rawCenterUrl = pickConfigValue(
    pluginConfig.VCHAT_SYNC_CENTER_URL,
    adapterEnv.VCHAT_SYNC_CENTER_URL
  );
  const centerUrl = normalizeCenterUrl(rawCenterUrl);
  const rawWsUrl = pickConfigValue(
    pluginConfig.VCHAT_SYNC_WS_URL,
    adapterEnv.VCHAT_SYNC_WS_URL
  );
  const wsUrl = normalizeLatestSeqWsUrl(rawWsUrl, centerUrl);
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
    centerUrl,
    wsUrl,
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
    topicActivityOrderIntervalMs: intValue(
      pickConfigValue(
        pluginConfig.VCHAT_TOPIC_ACTIVITY_ORDER_INTERVAL_MS,
        adapterEnv.VCHAT_TOPIC_ACTIVITY_ORDER_INTERVAL_MS
      ),
      5 * 60 * 1000
    ),
    topicActivityOrderMaxOwnersPerRun: intValue(
      pickConfigValue(
        pluginConfig.VCHAT_TOPIC_ACTIVITY_ORDER_MAX_OWNERS_PER_RUN,
        adapterEnv.VCHAT_TOPIC_ACTIVITY_ORDER_MAX_OWNERS_PER_RUN
      ),
      3
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
  const syncProfileConfig = await loadSyncProfileConfig(__dirname, logger);
  config.syncProfileConfig = syncProfileConfig;
  logger.info("adapter config resolved", {
    adapterEnvPath: adapterEnvState.envPath,
    adapterEnvLoaded: adapterEnvState.loaded,
    centerUrl: config.centerUrl,
    wsUrl: config.wsUrl,
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
  const themeWatcher = createThemeWatcher(
    {
      ...config,
      themeStylesDir: path.resolve(projectBasePath, "styles", "themes"),
      wallpaperDir: path.resolve(projectBasePath, "assets", "wallpaper"),
      appRootPath: projectBasePath,
    },
    localIndex,
    centerClient,
    logger,
    {
      mode: state.mode || "uninitialized",
      deviceId: config.deviceId,
    }
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
    themeWatcher,
    writeState: async (nextState) => writeState(config, nextState, logger),
    watcher: null,
    runtimeServicesStarted: false,
    startedAt: new Date().toISOString(),
  };

  async function startRuntimeServicesIfActive() {
    const latestState = await readState(config, logger);
    const mode = latestState.mode || runtime.state.mode || "uninitialized";
    runtime.state.mode = mode;
    if (!canUploadInMode(mode)) {
      logger.warn(
        "runtime services not started because adapter mode is not active",
        {
          mode,
        }
      );
      return false;
    }
    if (runtime.runtimeServicesStarted) return true;

    const startedServices = [];
    try {
      await offlineQueue.start({
        modeProvider: () => runtime.state.mode || "uninitialized",
      });
      startedServices.push({ name: "offlineQueue", service: offlineQueue });

      await pullLoop.start();
      startedServices.push({ name: "pullLoop", service: pullLoop });

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
          syncProfileConfig,
        }
      );
      await runtime.watcher.start();
      startedServices.push({ name: "watcher", service: runtime.watcher });

      await runtime.themeWatcher.start();
      startedServices.push({
        name: "themeWatcher",
        service: runtime.themeWatcher,
      });

      runtime.runtimeServicesStarted = true;
      logger.info("adapter runtime services started", { mode });
      return true;
    } catch (error) {
      for (const entry of startedServices.reverse()) {
        try {
          if (entry.service && typeof entry.service.stop === "function") {
            await entry.service.stop();
          }
        } catch (stopError) {
          logger.warn("runtime service rollback stop failed", {
            name: entry.name,
            error: stopError.message,
          });
        }
      }
      runtime.runtimeServicesStarted = false;
      logger.error("adapter runtime services failed to start", {
        mode,
        error: error.message,
      });
      throw error;
    }
  }

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
      if (result && result.ok !== false && result.mode === "active") {
        await startRuntimeServicesIfActive();
      }
      return res.json(result);
    } catch (error) {
      logger.error("bootstrap action failed", { error: error.message });
      return res
        .status(error.statusCode || 400)
        .json({ ok: false, error: error.message });
    }
  });

  app.get("/api/vchat-sync-adapter/bootstrap/manifest", async (req, res) => {
    try {
      requireAdapterAuth(config, req);
      const manifest = await buildLocalManifest(config, {
        logger,
        allowConflicts: true,
        profile: "bootstrap",
        syncProfileConfig,
      });
      return res.json(manifest);
    } catch (error) {
      return res
        .status(error.statusCode || 400)
        .json({ ok: false, error: error.message });
    }
  });

  app.get("/api/vchat-sync-adapter/bootstrap/conflicts", async (req, res) => {
    try {
      requireAdapterAuth(config, req);
      const conflicts = await scanNormalizedIdConflicts(config.appDataPath);
      return res.json({ ok: true, conflicts });
    } catch (error) {
      return res
        .status(error.statusCode || 400)
        .json({ ok: false, error: error.message });
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

  const currentMode = state.mode || "uninitialized";
  let scanResult = {
    summary: { skipped: true, reason: "mode_not_active", mode: currentMode },
  };
  let themeScanResult = {
    summary: { skipped: true, reason: "mode_not_active", mode: currentMode },
  };

  if (canUploadInMode(currentMode)) {
    await centerClient.registerDevice().catch((error) => {
      logger.warn(
        "device registration failed; queue will retry operations later",
        { error: error.message }
      );
    });

    scanResult = await scanAppData(
      config.appDataPath,
      localIndex,
      offlineQueue,
      writeIntentLock,
      logger,
      {
        mode: currentMode,
        profile: "runtime",
        deviceId: config.deviceId,
        centerClient,
        config,
        syncProfileConfig,
      }
    );
    themeScanResult = await syncLocalThemes(
      {
        ...config,
        themeStylesDir: path.resolve(projectBasePath, "styles", "themes"),
        wallpaperDir: path.resolve(projectBasePath, "assets", "wallpaper"),
        appRootPath: projectBasePath,
      },
      localIndex,
      centerClient,
      logger,
      {
        mode: currentMode,
        deviceId: config.deviceId,
      }
    );
  } else {
    logger.warn(
      "runtime startup scan skipped because adapter mode is not active",
      {
        mode: currentMode,
      }
    );
  }

  state.last_scan_at = new Date().toISOString();

  state.last_scan_result = {
    ...scanResult.summary,
    themes: themeScanResult.summary,
  };
  await writeState(config, state, logger);

  await startRuntimeServicesIfActive();

  logger.info("adapter started", {
    appDataPath: config.appDataPath,
    mode: state.mode,
    runtimeServicesStarted: runtime.runtimeServicesStarted,
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
  if (runtime && runtime.themeWatcher) await runtime.themeWatcher.stop();
  if (runtime && runtime.pullLoop) await runtime.pullLoop.stop();
  if (runtime && runtime.offlineQueue) await runtime.offlineQueue.stop();
  runtime = null;
}

module.exports = { registerRoutes, shutdown, buildConfig, requireAdapterAuth };
