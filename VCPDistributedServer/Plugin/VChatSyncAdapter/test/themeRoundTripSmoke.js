const assert = require("assert");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");

const centerRoot = process.env.VCHAT_SYNC_TEST_CENTER_ROOT || path.resolve(
  __dirname, "../../../../../VCPToolBox/Plugin/VChatSyncCenter"
);
const { ensureDatabase, closeDatabase } = require(path.join(centerRoot, "core/db"));
const { processOperation, registerDevice } = require(path.join(centerRoot, "core/operationProcessor"));
const { getChanges, getLatestSeq } = require(path.join(centerRoot, "core/changeLog"));
const { exportBaseline } = require(path.join(centerRoot, "core/bootstrapService"));
const {
  getTheme, upsertThemeAsset, upsertThemeAssetMetadata, getThemeAsset, readThemeAssetFile,
} = require(path.join(centerRoot, "core/themeService"));
const { createLocalIndex } = require("../core/localIndex");
const { createWriteIntentLock } = require("../sync/writeIntentLock");
const { joinExisting } = require("../sync/bootstrapManager");
const { syncLocalThemes } = require("../diff/themeDiffEngine");
const { scanThemePackages } = require("../sync/themePackageSync");
const { applyThemeEvents } = require("../projector/themeProjector");
const { createThemeWatcher } = require("../watcher/themeWatcher");

const logger = { info() {}, warn() {}, error() {}, debug() {} };
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lrWtyQAAAABJRU5ErkJggg==",
  "base64"
);
const cssFor = (color) => `:root { --review-color: ${color}; --chat-wallpaper-dark: url('../../assets/wallpaper/shared.png'); }`;

async function waitFor(check, label) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out: ${label}`);
}

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vchat-theme-roundtrip-"));
  let runtime;
  const watchers = [];
  try {
    const config = {
      dbPath: path.join(tempRoot, "center", "center.db"),
      attachmentDir: path.join(tempRoot, "center", "attachments"),
      backupDir: path.join(tempRoot, "center", "backups"),
      maxLimit: 5000,
      maxAttachmentMb: 16,
    };
    runtime = { config, logger, dbContext: ensureDatabase(config, logger) };
    const db = runtime.dbContext.db;

    async function makeDevice(deviceId) {
      const root = path.join(tempRoot, deviceId);
      const syncDir = path.join(root, "AppData", "sync");
      const deviceConfig = {
        deviceId,
        syncDir,
        appDataPath: path.join(root, "AppData"),
        appRootPath: root,
        themeStylesDir: path.join(root, "styles", "themes"),
        wallpaperDir: path.join(root, "assets", "wallpaper"),
        indexPath: path.join(root, "sync-index.json"),
        lockPath: path.join(syncDir, "write_intents.jsonl"),
        watchDebounceMs: 25,
      };
      await fs.ensureDir(syncDir);
      await fs.ensureDir(deviceConfig.themeStylesDir);
      await fs.ensureDir(deviceConfig.wallpaperDir);
      const localIndex = createLocalIndex(deviceConfig, logger);
      await localIndex.load();
      registerDevice(db, { device_id: deviceId, name: deviceId });
      const device = {
        config: deviceConfig, localIndex, logger,
        cursor: 0, uploads: [], assetUploads: [], assetDownloads: [], mode: "active",
        state: { mode: "uninitialized" },
        writeIntentLock: createWriteIntentLock(deviceConfig, logger),
        async writeState(state) { await fs.writeJson(path.join(syncDir, "state.json"), state); },
      };
      device.centerClient = {
        isConfigured: () => true,
        async exportBootstrap(options) { return exportBaseline(runtime, options); },
        async getChanges(afterSeq, limit) { return { events: getChanges(db, afterSeq, limit) }; },
        async upsertThemePackage(body) {
          device.uploads.push(body.operation_id);
          const result = processOperation(db, {
            operation_id: body.operation_id,
            device_id: deviceId,
            entity_type: "theme_package",
            entity_id: body.theme_id,
            action: "upsert",
            payload: body,
          });
          assert.strictEqual(result.ok, true);
          if (device.loseNextResponse) {
            device.loseNextResponse = false;
            throw new Error("simulated response loss after center commit");
          }
          return result;
        },
        async uploadThemeAsset(body) {
          device.assetUploads.push(body.asset_hash);
          return upsertThemeAsset(runtime, body);
        },
        async downloadThemeAsset(hash) {
          device.assetDownloads.push(hash);
          if (device.beforeDownload) await device.beforeDownload(hash);
          return { buffer: await readThemeAssetFile(getThemeAsset(db, config, hash)) };
        },
      };
      return device;
    }

    const a = await makeDevice("theme-device-a");
    const b = await makeDevice("theme-device-b");
    const cssPath = (device) => path.join(device.config.themeStylesDir, "themesOcean.css");
    const wallpaperPath = (device) => path.join(device.config.wallpaperDir, "shared.png");
    const sync = (device) => syncLocalThemes(
      device.config, device.localIndex, device.centerClient, logger,
      { modeProvider: () => device.mode }
    );
    const project = async (device, events) => {
      await applyThemeEvents(events.filter((event) => event.device_id !== device.config.deviceId), device);
      if (events.length) device.cursor = events[events.length - 1].seq;
    };
    const pull = (device) => project(device, getChanges(db, device.cursor, 1000));
    const themeCount = () => db.prepare("SELECT COUNT(*) AS count FROM theme_packages").get().count;

    await fs.writeFile(cssPath(a), cssFor("blue"));
    await fs.writeFile(wallpaperPath(a), png);
    // Duplicate local file events must serialize into one package and one blob.
    await Promise.all([sync(a), sync(a)]);
    assert.strictEqual(a.uploads.length, 1);
    assert.strictEqual(a.assetUploads.length, 1);
    const themeId = (await scanThemePackages(a.config, a.localIndex))[0].theme_id;

    // A fresh device starts after the original blob event. Bootstrap itself
    // must advertise and download that blob while preserving its CSS path.
    const joining = await makeDevice("theme-device-joining");
    const beforeJoinSeq = getLatestSeq(db);
    const joined = await joinExisting(joining);
    assert.strictEqual(joined.ok, true);
    assert.strictEqual(joined.baseline_projection, true);
    assert.strictEqual(joining.state.last_applied_seq, beforeJoinSeq);
    assert.strictEqual(await fs.readFile(cssPath(joining), "utf8"), cssFor("blue"));
    assert.deepStrictEqual(await fs.readdir(joining.config.themeStylesDir), ["themesOcean.css"]);
    assert.deepStrictEqual(await fs.readFile(wallpaperPath(joining)), png);
    assert.strictEqual(joining.assetDownloads.length, 1);
    await sync(joining);
    assert.strictEqual(joining.uploads.length, 0);
    assert.strictEqual(joining.assetUploads.length, 0);
    assert.strictEqual(getLatestSeq(db), beforeJoinSeq, "bootstrap projection must not echo");

    // Packages and blobs can arrive in separate pulls. The missing/old local
    // wallpaper must not turn the just-received CSS into a local edit.
    const initial = getChanges(db, 0, 1000);
    await project(b, initial.filter((event) => event.entity_type === "theme_package"));
    await sync(b);
    assert.strictEqual(b.uploads.length, 0);
    assert.strictEqual(b.assetUploads.length, 0);
    await pull(b);
    assert.strictEqual(await fs.readFile(cssPath(b), "utf8"), cssFor("blue"));
    assert.deepStrictEqual(await fs.readdir(b.config.themeStylesDir), ["themesOcean.css"]);
    assert.deepStrictEqual(await fs.readFile(wallpaperPath(b)), png);

    const initialSeq = getLatestSeq(db);
    for (let round = 0; round < 4; round += 1) {
      await Promise.all([sync(a), sync(b)]);
      await Promise.all([pull(a), pull(b)]);
    }
    assert.strictEqual(themeCount(), 1);
    assert.strictEqual(getLatestSeq(db), initialSeq, "unchanged projections must not echo");

    // Real edits in either direction, including reverting to old content,
    // remain new operations for the original theme id.
    await fs.writeFile(cssPath(b), cssFor("green"));
    await sync(b);
    await pull(a);
    assert.strictEqual(await fs.readFile(cssPath(a), "utf8"), cssFor("green"));
    await fs.writeFile(cssPath(a), cssFor("blue"));
    await sync(a);
    assert.notStrictEqual(a.uploads[0], a.uploads[a.uploads.length - 1]);
    await pull(b);
    assert.strictEqual(getTheme(db, themeId).extra_css, cssFor("blue"));
    assert.strictEqual(await fs.readFile(cssPath(b), "utf8"), cssFor("blue"));

    await fs.writeFile(wallpaperPath(b), Buffer.concat([png, Buffer.from("second image")]));
    await sync(b);
    await pull(a);
    assert.deepStrictEqual(await fs.readFile(wallpaperPath(a)), await fs.readFile(wallpaperPath(b)));
    const imageSeq = getLatestSeq(db);
    await Promise.all([sync(a), sync(a), sync(b)]);
    assert.strictEqual(getLatestSeq(db), imageSeq, "wallpaper and CSS change events must not echo");

    // A watcher scan that starts during a slow download waits for projection
    // and its index update, instead of observing half of a remote change.
    await fs.writeFile(wallpaperPath(b), Buffer.concat([png, Buffer.from("third image")]));
    await sync(b);
    let entered;
    let release;
    const downloadStarted = new Promise((resolve) => { entered = resolve; });
    const downloadGate = new Promise((resolve) => { release = resolve; });
    a.beforeDownload = async () => { entered(); await downloadGate; };
    const projection = pull(a);
    await downloadStarted;
    const duringProjection = sync(a);
    release();
    await Promise.all([projection, duringProjection]);
    a.beforeDownload = null;
    const afterProjectionSeq = getLatestSeq(db);
    await sync(a);
    assert.strictEqual(getLatestSeq(db), afterProjectionSeq);

    // The image projection may acknowledge its own new bytes, but must not
    // acknowledge a user's CSS edit made while that download was pending.
    await fs.writeFile(wallpaperPath(b), Buffer.concat([png, Buffer.from("fourth image")]));
    await sync(b);
    const editDownloadStarted = new Promise((resolve) => { entered = resolve; });
    const editDownloadGate = new Promise((resolve) => { release = resolve; });
    a.beforeDownload = async () => { entered(); await editDownloadGate; };
    const editProjection = pull(a);
    await editDownloadStarted;
    await fs.writeFile(cssPath(a), cssFor("cyan"));
    release();
    await editProjection;
    a.beforeDownload = null;
    const beforeLocalEdit = getLatestSeq(db);
    await sync(a);
    assert.strictEqual(getLatestSeq(db), beforeLocalEdit + 1);
    assert.strictEqual(getTheme(db, themeId).extra_css, cssFor("cyan"));
    await pull(b);

    // Retry after an ambiguous response, including reloading the durable local
    // index, uses the previous operation id and does not create another event.
    await fs.writeFile(cssPath(b), cssFor("orange"));
    b.loseNextResponse = true;
    const failed = await sync(b);
    assert.strictEqual(failed.summary.skipped, 1);
    const committedSeq = getLatestSeq(db);
    b.localIndex = createLocalIndex(b.config, logger);
    await b.localIndex.load();
    await sync(b);
    assert.strictEqual(b.uploads[b.uploads.length - 1], b.uploads[b.uploads.length - 2]);
    assert.strictEqual(getLatestSeq(db), committedSeq);
    await pull(a);

    // An imported/mobile theme can have an id that is not derived from its
    // filename. Editing the projected CSS must keep that identity as well.
    processOperation(db, {
      operation_id: "mobile-theme-import", device_id: a.config.deviceId,
      entity_type: "theme_package", entity_id: "mobile-custom-id", action: "upsert",
      payload: {
        theme_id: "mobile-custom-id", display_name: "Mobile", extra_css: ":root { --mobile: 1; }",
        manifest: { css: { relative_path: "styles/themes/themesMobile.css" } },
      },
    });
    await pull(b);
    const mobileCss = path.join(b.config.themeStylesDir, "themesMobile.css");
    await fs.writeFile(mobileCss, ":root { --mobile: 2; }");
    await sync(b);
    assert.strictEqual(themeCount(), 2);
    assert.strictEqual(getTheme(db, "mobile-custom-id").extra_css, ":root { --mobile: 2; }");
    await pull(a);
    await fs.writeFile(mobileCss, "");
    await sync(b);
    await pull(a);
    assert.strictEqual(await fs.readFile(path.join(a.config.themeStylesDir, "themesMobile.css"), "utf8"), "");

    // Exercise actual chokidar events and a mode transition after startup.
    b.mode = "uninitialized";
    const watcher = createThemeWatcher(b.config, b.localIndex, b.centerClient, logger, {
      modeProvider: () => b.mode,
    });
    watchers.push(watcher);
    await watcher.start();
    b.mode = "active";
    await fs.writeFile(cssPath(b), cssFor("purple"));
    await waitFor(() => getTheme(db, themeId).extra_css === cssFor("purple"), "watcher uploads after activation");
    await watcher.stop();
    await pull(a);
    const finalSeq = getLatestSeq(db);
    await Promise.all([sync(a), sync(b)]);
    assert.strictEqual(getLatestSeq(db), finalSeq);
    assert.strictEqual(themeCount(), 2);

    // Metadata-only imports and a real blob lost from storage must remain
    // pending on another new device, without attempts to download either.
    const metadataHash = "f".repeat(64);
    upsertThemeAssetMetadata(db, {
      theme_id: themeId, asset_hash: metadataHash,
      filename: "metadata-only.png", mime_type: "image/png",
      relative_path: "assets/wallpaper/metadata-only.png",
    });
    const missingHash = b.assetUploads[b.assetUploads.length - 1];
    const missingAsset = getThemeAsset(db, config, missingHash);
    const missingPath = path.resolve(missingAsset.absolute_path);
    assert(missingPath.startsWith(path.resolve(tempRoot) + path.sep));
    const originalBytes = await fs.readFile(missingPath);
    await fs.unlink(missingPath);
    try {
      const exportedTheme = exportBaseline(runtime, { kind: "themes" })
        .baseline.themes.find((theme) => theme.theme_id === themeId);
      assert.strictEqual(exportedTheme.assets.find((asset) => asset.asset_hash === metadataHash).binary_available, false);
      assert.strictEqual(exportedTheme.assets.find((asset) => asset.asset_hash === missingHash).binary_available, false);
      assert(exportedTheme.assets.every((asset) => !asset.absolute_path && !asset.storage_path));
      const pendingDevice = await makeDevice("theme-device-pending");
      assert.strictEqual((await joinExisting(pendingDevice)).ok, true);
      assert.strictEqual(await fs.readFile(cssPath(pendingDevice), "utf8"), cssFor("purple"));
      assert.strictEqual(pendingDevice.localIndex.getFile(`theme_asset:${metadataHash}`).pending_binary, true);
      assert.strictEqual(pendingDevice.localIndex.getFile(`theme_asset:${missingHash}`).pending_binary, true);
      assert(!pendingDevice.assetDownloads.includes(metadataHash));
      assert(!pendingDevice.assetDownloads.includes(missingHash));
    } finally {
      await fs.writeFile(missingPath, originalBytes);
    }
    console.log("theme round-trip smoke test passed");
  } finally {
    await Promise.all(watchers.map((watcher) => watcher.stop()));
    if (runtime) closeDatabase(runtime.dbContext);
    const resolved = path.resolve(tempRoot);
    assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert(path.basename(resolved).startsWith("vchat-theme-roundtrip-"));
    await fs.remove(resolved);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
