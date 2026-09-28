const assert = require("assert");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const { createRequire } = require("module");
const { createLocalIndex } = require("../core/localIndex");
const { createWriteIntentLock } = require("../sync/writeIntentLock");
const { joinExisting, mergeExisting } = require("../sync/bootstrapManager");
const { createPullLoop } = require("../sync/pullLoop");
const { readState, writeState } = require("../sync/state");

const centerRoot = process.env.VCHAT_SYNC_TEST_CENTER_ROOT ||
  path.resolve(__dirname, "../../../../../VCPToolBox/Plugin/VChatSyncCenter");
const centerRequire = createRequire(path.join(centerRoot, "index.js"));
const Database = centerRequire("better-sqlite3");
const { runMigrations } = centerRequire("./core/migrations");
const { processOperation, registerDevice } = centerRequire("./core/operationProcessor");
const { exportBaseline } = centerRequire("./core/bootstrapService");
const { getChanges, getLatestSeq } = centerRequire("./core/changeLog");
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const owners = ["a", "b", "c"];

function configOperation(operationId, owner, name) {
  return {
    operation_id: operationId, device_id: "source-device",
    entity_type: "agent_config", entity_id: `Agents/${owner}/config.json`, action: "update",
    payload: {
      dto_version: 1, schema: "agent_config", entity_id: `Agents/${owner}/config.json`,
      profile: "bootstrap", projection_fields: ["name", "topics"],
      safe_projection_json: { name, topics: [] },
    },
  };
}

function messageOperation(operationId, owner, action, content) {
  return {
    operation_id: operationId, device_id: "source-device",
    entity_type: "message", entity_id: "m", action,
    item_type: "agent", item_id: owner, topic_id: "t",
    base_version: action === "update" ? 1 : undefined,
    payload: { message: { id: "m", role: "user", content } },
  };
}

function configPath(runtime, owner) {
  return path.join(runtime.config.appDataPath, "Agents", owner, "config.json");
}

function historyPath(runtime, owner) {
  return path.join(runtime.config.appDataPath, "UserData", owner, "topics", "t", "history.json");
}

async function makeFixture(root) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db, logger);
  registerDevice(db, { device_id: "source-device" });
  const center = {
    dbContext: { db }, logger,
    config: { maxLimit: 2, attachmentDir: path.join(root, "center", "attachments") },
  };
  const submit = (operation) => {
    const result = processOperation(db, operation);
    assert.strictEqual(result.ok, true);
    return result;
  };
  for (const owner of owners) {
    submit(configOperation(`config-${owner}`, owner, owner));
    submit({
      operation_id: `topic-${owner}`, device_id: "source-device",
      entity_type: "topic", entity_id: "t", action: "upsert",
      item_type: "agent", item_id: owner, topic_id: "t",
      payload: { topic: { id: "t", name: `Topic ${owner}` } },
    });
    submit(messageOperation(`message-${owner}`, owner, "create", `initial ${owner}`));
  }

  const appDataPath = path.join(root, "AppData");
  const syncDir = path.join(appDataPath, "sync");
  const config = {
    appDataPath, syncDir, deviceId: "joining-device", appRootPath: root,
    themeStylesDir: path.join(root, "styles", "themes"),
    wallpaperDir: path.join(root, "assets", "wallpaper"),
    attachmentDir: path.join(appDataPath, "UserData", "attachments"),
    indexPath: path.join(syncDir, "local_index.json"),
    lockPath: path.join(syncDir, "write_intents.jsonl"),
    statePath: path.join(syncDir, "state.json"),
  };
  await fs.ensureDir(syncDir);
  const localIndex = createLocalIndex(config, logger);
  await localIndex.load();
  const hooks = { beforeExport: null, beforeChanges: null, changesCalls: 0 };
  const centerClient = {
    isConfigured: () => true,
    connectLatestSeq: () => null,
    async exportBootstrap(options = {}) {
      if (hooks.beforeExport) await hooks.beforeExport(options);
      return exportBaseline(center, options);
    },
    async getChanges(afterSeq, limit) {
      hooks.changesCalls += 1;
      if (hooks.beforeChanges) await hooks.beforeChanges(afterSeq, hooks.changesCalls);
      const pageLimit = Math.min(limit, center.config.maxLimit);
      const events = getChanges(db, afterSeq, pageLimit);
      const latestSeq = getLatestSeq(db);
      const checkpointSeq = events.length ? events[events.length - 1].seq : afterSeq;
      return {
        ok: true, events, latest_seq: latestSeq, checkpoint_seq: checkpointSeq,
        has_more: events.length === pageLimit && checkpointSeq < latestSeq,
      };
    },
  };
  const resumes = [];
  const runtime = {
    config, centerClient, localIndex, logger,
    writeIntentLock: createWriteIntentLock(config, logger),
    state: { mode: "uninitialized", last_applied_seq: 0 },
    watcher: { async stop() {} },
    pullLoop: { async stop() {} },
    async writeState(state) { await writeState(config, state, logger); },
    async resumeRuntimeServices() {
      resumes.push({ mode: runtime.state.mode, seq: runtime.state.last_applied_seq });
      runtime.runtimeServicesStarted = runtime.state.mode === "active";
    },
  };
  await joinExisting(runtime);
  // The HTTP bootstrap route starts services after a successful join.
  runtime.runtimeServicesStarted = true;
  resumes.length = 0;
  return { center, db, submit, runtime, hooks, resumes };
}

async function snapshotLocalFiles(runtime) {
  const paths = [
    ...owners.map((owner) => configPath(runtime, owner)),
    ...owners.map((owner) => historyPath(runtime, owner)),
    runtime.config.indexPath,
  ];
  return Promise.all(paths.map(async (filePath) => ({
    filePath, bytes: await fs.readFile(filePath),
  })));
}

async function testNetworkFailure(root, action) {
  const { db, submit, runtime, hooks, resumes } = await makeFixture(root);
  let recoveryPull;
  try {
    const beforeSeq = runtime.state.last_applied_seq;
    const beforeFiles = await snapshotLocalFiles(runtime);
    const beforeIndex = JSON.parse(JSON.stringify(runtime.localIndex.raw()));
    let interleaved = false;
    hooks.beforeExport = (options) => {
      if (options.kind !== "messages" || interleaved) return;
      interleaved = true;
      submit(messageOperation("update-c", "c", "update", "updated c"));
      submit({
        operation_id: "delete-topic-c", device_id: "source-device",
        entity_type: "topic", entity_id: "t", action: "delete",
        item_type: "agent", item_id: "c", topic_id: "t", payload: {},
      });
    };
    hooks.beforeChanges = (_afterSeq, request) => {
      if (request === 2) throw new Error("simulated catch-up network failure");
    };
    // The first catch-up page includes update + topic deletion. Losing the
    // second page must happen before either that page or the baseline is written.
    await assert.rejects(() => action(runtime), /simulated catch-up network failure/);
    assert.strictEqual(hooks.changesCalls, 2);
    for (const snapshot of beforeFiles) {
      assert.deepStrictEqual(await fs.readFile(snapshot.filePath), snapshot.bytes,
        `network failure changed ${snapshot.filePath}`);
    }
    assert.deepStrictEqual(runtime.localIndex.raw(), beforeIndex);
    assert.strictEqual(runtime.state.mode, "active");
    assert.strictEqual(runtime.state.last_applied_seq, beforeSeq);
    assert.strictEqual((await readState(runtime.config, logger)).last_applied_seq, beforeSeq);
    assert.deepStrictEqual(resumes, [{ mode: "active", seq: beforeSeq }]);
    assert.strictEqual(runtime.runtimeServicesStarted, true);

    // The restored ordinary pull must still be able to process the update
    // before the deletion, then reach E without a missing-parent error.
    hooks.beforeChanges = null;
    recoveryPull = createPullLoop(runtime.config, runtime.centerClient,
      runtime.localIndex, runtime.writeIntentLock, logger);
    await recoveryPull.start();
    const recovered = await recoveryPull.pullOnce("network-recovered");
    assert.strictEqual(recovered.ok, true);
    assert.strictEqual((await readState(runtime.config, logger)).last_applied_seq, getLatestSeq(db));
    assert.deepStrictEqual((await fs.readJson(configPath(runtime, "c"))).topics, []);
    assert.strictEqual(await fs.pathExists(historyPath(runtime, "c")), false);
    assert.strictEqual(recoveryPull.stats().blocked_seq, null);
  } finally {
    if (recoveryPull) await recoveryPull.stop();
    db.close();
  }
}

async function testProjectionFailure(root, action) {
  const { db, submit, runtime, hooks, resumes } = await makeFixture(root);
  let strictPull;
  try {
    const beforeSeq = runtime.state.last_applied_seq;
    submit(messageOperation("updated-a", "a", "update", "new center content"));
    const originalRecord = runtime.writeIntentLock.record;
    let persistedAtFault = null;
    let failedOnce = false;
    runtime.writeIntentLock.record = async (intent) => {
      if (!failedOnce && path.resolve(intent.filePath) === historyPath(runtime, "b")) {
        failedOnce = true;
        persistedAtFault = await fs.readJson(runtime.config.statePath);
        throw new Error("simulated projection disk failure");
      }
      return originalRecord(intent);
    };
    await assert.rejects(() => action(runtime), /projection failed|simulated projection disk failure/);
    assert.strictEqual(failedOnce, true);
    assert.notStrictEqual(persistedAtFault.mode, "active", "pause must be durable before file projection");
    assert(persistedAtFault.bootstrap_pending);
    assert.strictEqual((await fs.readJson(historyPath(runtime, "a")))[0].content, "new center content");
    assert.notStrictEqual(runtime.state.mode, "active");
    assert.strictEqual(runtime.state.last_applied_seq, beforeSeq);
    assert.deepStrictEqual(resumes, [], "a partially projected baseline must not resume ordinary sync");
    assert.strictEqual(runtime.runtimeServicesStarted, false);
    const persistedFailure = await readState(runtime.config, logger);
    assert.notStrictEqual(persistedFailure.mode, "active");
    assert(persistedFailure.bootstrap_pending);

    // A fresh pull loop reads the persisted mode just as it would after a
    // process restart; it must not fetch events while bootstrap is incomplete.
    const beforeStrictPullCalls = hooks.changesCalls;
    strictPull = createPullLoop(runtime.config, runtime.centerClient,
      runtime.localIndex, runtime.writeIntentLock, logger);
    const blocked = await strictPull.pullOnce("restart-during-bootstrap");
    assert.strictEqual(blocked.reason, "mode_not_active");
    assert.strictEqual(hooks.changesCalls, beforeStrictPullCalls);

    runtime.writeIntentLock.record = originalRecord;
    const retried = await action(runtime);
    assert.strictEqual(retried.ok, true);
    assert.strictEqual(runtime.state.mode, "active");
    assert.strictEqual(runtime.state.last_applied_seq, getLatestSeq(db));
    assert.strictEqual(runtime.state.bootstrap_pending, undefined);
    const persistedSuccess = await readState(runtime.config, logger);
    assert.strictEqual(persistedSuccess.mode, "active");
    assert.strictEqual(persistedSuccess.bootstrap_pending, undefined);
    assert.strictEqual((await fs.readJson(historyPath(runtime, "a")))[0].content, "new center content");
  } finally {
    if (strictPull) await strictPull.stop();
    db.close();
  }
}

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vchat-bootstrap-failure-"));
  try {
    for (const [label, action] of [["join", joinExisting], ["merge", mergeExisting]]) {
      await testNetworkFailure(path.join(tempRoot, `${label}-network`), action);
      await testProjectionFailure(path.join(tempRoot, `${label}-projection`), action);
    }
    console.log("bootstrap network and projection failure recovery passed");
  } finally {
    const resolved = path.resolve(tempRoot);
    assert.strictEqual(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert(path.basename(resolved).startsWith("vchat-bootstrap-failure-"));
    await fs.remove(resolved);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
