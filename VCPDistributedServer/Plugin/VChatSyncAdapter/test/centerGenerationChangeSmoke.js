const assert = require("assert");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const { createRequire } = require("module");
const { createLocalIndex } = require("../core/localIndex");
const { createWriteIntentLock } = require("../sync/writeIntentLock");
const { createPullLoop } = require("../sync/pullLoop");
const { readState, writeState } = require("../sync/state");
const { joinExisting } = require("../sync/bootstrapManager");

const centerRoot = process.env.VCHAT_SYNC_TEST_CENTER_ROOT ||
  path.resolve(__dirname, "../../../../../VCPToolBox/Plugin/VChatSyncCenter");
const centerRequire = createRequire(path.join(centerRoot, "index.js"));
const { ensureDatabase, closeDatabase } = centerRequire("./core/db");
const { processOperation, registerDevice } = centerRequire("./core/operationProcessor");
const { exportBaseline } = centerRequire("./core/bootstrapService");
const { getChanges, getLatestSeq } = centerRequire("./core/changeLog");
const { getGeneration } = centerRequire("./core/centerMeta");
const { createDatabaseBackup, restoreDatabaseBackup } = centerRequire("./core/backupService");

const logger = { info() {}, warn() {}, error() {}, debug() {} };

function topicOp(id, topicId) {
  return {
    operation_id: id, device_id: "source", entity_type: "topic", entity_id: topicId,
    action: "upsert", item_type: "agent", item_id: "a", topic_id: topicId,
    payload: { topic: { id: topicId, name: topicId } },
  };
}

function messageOp(id, topicId, messageId, content) {
  return {
    operation_id: id, device_id: "source", entity_type: "message", entity_id: messageId,
    action: "create", item_type: "agent", item_id: "a", topic_id: topicId,
    payload: { message: { id: messageId, role: "user", content } },
  };
}

// Issue 6 end to end: restore an older backup at Center (sequence goes back),
// new events reuse old sequence numbers, and the client must not skip them.
async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vchat-generation-"));
  const centerConfig = {
    dbPath: path.join(root, "center", "center.db"),
    attachmentDir: path.join(root, "center", "attachments"),
    backupDir: path.join(root, "center", "backups"),
    maxLimit: 5000,
  };
  const center = { config: centerConfig, logger, dbContext: ensureDatabase(centerConfig, logger) };
  const db = () => center.dbContext.db;
  let loop;
  try {
    registerDevice(db(), { device_id: "source" });
    processOperation(db(), { operation_id: "cfg-a", device_id: "source", entity_type: "agent_config",
      entity_id: "Agents/a/config.json", action: "update",
      payload: { dto_version: 1, schema: "agent_config", entity_id: "Agents/a/config.json", profile: "bootstrap",
        projection_fields: ["name", "topics"], safe_projection_json: { name: "a", topics: [] } } });
    processOperation(db(), topicOp("t1", "t"));
    processOperation(db(), messageOp("m1", "t", "m1", "one"));
    processOperation(db(), messageOp("m2", "t", "m2", "two"));
    const backup = await createDatabaseBackup(center, { label: "at-two" });
    const generationBefore = getGeneration(db());

    const appDataPath = path.join(root, "AppData");
    const syncDir = path.join(appDataPath, "sync");
    const config = {
      appDataPath, syncDir, deviceId: "client", appRootPath: root,
      themeStylesDir: path.join(root, "styles", "themes"),
      wallpaperDir: path.join(root, "assets", "wallpaper"),
      attachmentDir: path.join(appDataPath, "UserData", "attachments"),
      indexPath: path.join(syncDir, "local_index.json"),
      lockPath: path.join(syncDir, "write_intents.jsonl"),
      statePath: path.join(syncDir, "state.json"),
      enabled: true,
    };
    await fs.ensureDir(syncDir);
    const localIndex = createLocalIndex(config, logger);
    await localIndex.load();
    const centerClient = {
      isConfigured: () => true,
      connectLatestSeq: () => null,
      async exportBootstrap(options = {}) { return exportBaseline(center, options); },
      async getChanges(afterSeq, limit) {
        const events = getChanges(db(), afterSeq, limit);
        const latestSeq = getLatestSeq(db());
        const checkpointSeq = events.length ? events[events.length - 1].seq : afterSeq;
        return { ok: true, generation: getGeneration(db()), events, latest_seq: latestSeq,
          checkpoint_seq: checkpointSeq, has_more: false };
      },
    };
    const runtime = {
      config, centerClient, localIndex, logger,
      writeIntentLock: createWriteIntentLock(config, logger),
      state: { mode: "uninitialized", last_applied_seq: 0 },
      watcher: { async stop() {} }, pullLoop: { async stop() {} },
      async writeState(state) { await writeState(config, state, logger); },
      async resumeRuntimeServices() {},
    };
    await joinExisting(runtime);
    assert.strictEqual(runtime.state.center_generation, generationBefore, "join must record the generation");

    // Client advances past the backup point.
    processOperation(db(), messageOp("m3", "t", "m3", "three"));
    processOperation(db(), messageOp("m4", "t", "m4", "four"));
    loop = createPullLoop(config, centerClient, localIndex, runtime.writeIntentLock, logger);
    await loop.start();
    const pulled = await loop.pullOnce("before-restore");
    assert.strictEqual(pulled.ok, true);
    const stateBefore = await readState(config, logger);
    assert.strictEqual(stateBefore.last_applied_seq, getLatestSeq(db()));
    const historyPath = path.join(appDataPath, "UserData", "a", "topics", "t", "history.json");
    assert.deepStrictEqual((await fs.readJson(historyPath)).map((m) => m.id), ["m1", "m2", "m3", "m4"]);

    // Restore the older backup: latest_seq drops, then new events reuse numbers.
    await restoreDatabaseBackup(center, { name: backup.backup.name, allow_seq_downgrade: true });
    processOperation(db(), messageOp("m5", "t", "m5", "five"));
    processOperation(db(), messageOp("m6", "t", "m6", "six"));
    assert(getLatestSeq(db()) <= stateBefore.last_applied_seq, "test premise: sequence numbers were reused");

    // The old cursor no longer applies: the client must stop, not skip.
    const afterRestore = await loop.pullOnce("after-restore");
    assert.strictEqual(afterRestore.reason, "center_generation_changed");
    const stateAfter = await readState(config, logger);
    assert.strictEqual(stateAfter.mode, "recovering");
    assert.strictEqual(stateAfter.recovering_reason, "center_generation_changed");
    assert.strictEqual(loop.stats().stopped, true);

    // Re-running join rebuilds the baseline on the new generation and picks
    // up the reused sequence numbers.
    runtime.state = stateAfter;
    runtime.pullLoop = loop;
    await joinExisting(runtime);
    const stateJoined = await readState(config, logger);
    assert.strictEqual(stateJoined.mode, "active");
    assert.strictEqual(stateJoined.center_generation, getGeneration(db()));
    assert.notStrictEqual(stateJoined.center_generation, generationBefore);
    // The events that reused sequence numbers 5 and 6 are now projected. m3
    // and m4 remain local: Center lost them in the restore, and this device
    // still holds the user's copy.
    const rejoined = (await fs.readJson(historyPath)).map((m) => m.id);
    assert(rejoined.includes("m5") && rejoined.includes("m6"), `reused seq events missing: ${rejoined}`);
    processOperation(db(), messageOp("m7", "t", "m7", "seven"));
    loop = createPullLoop(config, centerClient, localIndex, runtime.writeIntentLock, logger);
    await loop.start();
    assert.strictEqual((await loop.pullOnce("post-rejoin")).ok, true);
    assert((await fs.readJson(historyPath)).some((m) => m.id === "m7"));
    console.log("center generation change detection smoke test passed");
  } finally {
    if (loop) await loop.stop();
    closeDatabase(center.dbContext);
    assert.strictEqual(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    await fs.remove(root);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
