const assert = require("assert");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const { atomicWriteJson, moveWithRetry } = require("../projector/atomicWriter");
const { readState, writeState, ensureAdapterState } = require("../sync/state");
const { createLocalIndex } = require("../core/localIndex");
const { createOfflineQueue, readQueueLines, writeQueueRows } = require("../sync/offlineQueue");
const { createPullLoop } = require("../sync/pullLoop");

const logger = { debug() {}, info() {}, warn() {}, error() {} };

function makeConfig(root) {
  const syncDir = path.join(root, "AppData", "sync");
  return {
    appDataPath: path.join(root, "AppData"),
    syncDir,
    statePath: path.join(syncDir, "state.json"),
    indexPath: path.join(syncDir, "local_index.json"),
    queuePath: path.join(syncDir, "offline_queue.jsonl"),
    lockPath: path.join(syncDir, "write_intents.jsonl"),
    deviceId: "device-a",
    queueIntervalMs: 1,
    enabled: true,
    mode: "active",
  };
}

// The destination must never be observed missing while a replace is in
// progress, and a failed replace must leave the previous content intact.
async function testRenameNeverRemovesTarget(root) {
  await fs.ensureDir(root);
  const filePath = path.join(root, "target.json");
  await fs.writeJson(filePath, { v: 1 });
  const originalRename = fs.rename;
  fs.rename = async () => {
    const error = new Error("EPERM: injected");
    error.code = "EPERM";
    throw error;
  };
  try {
    await assert.rejects(
      () => atomicWriteJson(filePath, { v: 2 }, { logger }),
      /EPERM/
    );
  } finally {
    fs.rename = originalRename;
  }
  assert.deepStrictEqual(await fs.readJson(filePath), { v: 1 });
  const leftovers = (await fs.readdir(root)).filter((name) => /\.tmp-|\.backup-/.test(name));
  assert.deepStrictEqual(leftovers, []);

  // Concurrent readers during a burst of writes must always see valid JSON.
  let readErrors = 0;
  let reads = 0;
  const writes = (async () => {
    for (let i = 0; i < 40; i += 1) {
      await atomicWriteJson(filePath, { v: i }, { logger });
    }
  })();
  const readers = (async () => {
    while (reads < 200) {
      reads += 1;
      try {
        const value = await fs.readJson(filePath);
        assert.strictEqual(typeof value.v, "number");
      } catch (error) {
        readErrors += 1;
      }
    }
  })();
  await Promise.all([writes, readers]);
  assert.strictEqual(readErrors, 0, "reader observed a missing or partial file");
}

// Reading state concurrently with writes must never trigger corruption
// recovery; a truly corrupt file still does.
async function testStateReadWriteRace(root) {
  const config = makeConfig(root);
  await ensureAdapterState(config, logger);
  await writeState(config, { mode: "active", enabled: true, last_applied_seq: 100 }, logger);
  const writes = (async () => {
    for (let seq = 101; seq <= 160; seq += 1) {
      await writeState(config, { mode: "active", enabled: true, last_applied_seq: seq }, logger);
    }
  })();
  const readsDone = (async () => {
    for (let i = 0; i < 120; i += 1) {
      const state = await readState(config, logger);
      assert.strictEqual(state.mode, "active", "state read entered recovery during a normal write");
      assert(Number(state.last_applied_seq) >= 100);
    }
  })();
  await Promise.all([writes, readsDone]);
  assert.strictEqual((await readState(config, logger)).last_applied_seq, 160);

  // A missing file is recreated, never treated as corruption.
  await fs.remove(config.statePath);
  const recreated = await readState(config, logger);
  assert.notStrictEqual(recreated.mode, "recovering");

  // A newer temp snapshot left by an older adapter is adopted.
  await writeState(config, { mode: "active", enabled: true, last_applied_seq: 5 }, logger);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await fs.writeJson(`${config.statePath}.tmp-1-2-3`, {
    mode: "active", enabled: true, last_applied_seq: 999,
  });
  const adopted = await readState(config, logger);
  assert.strictEqual(adopted.last_applied_seq, 999);
  assert.strictEqual(await fs.pathExists(`${config.statePath}.tmp-1-2-3`), false);

  // Real corruption still enters recovering and keeps the corrupt bytes.
  await fs.writeFile(config.statePath, "{ not json", "utf8");
  const recovering = await readState(config, logger);
  assert.strictEqual(recovering.mode, "recovering");
  const corruptFiles = (await fs.readdir(config.syncDir)).filter((n) => n.startsWith("state.json.corrupt-"));
  assert.strictEqual(corruptFiles.length, 1);

  // The pull loop stops on a non-active mode without touching the cursor.
  const loop = createPullLoop(config, {
    isConfigured: () => true,
    connectLatestSeq: () => null,
    async getChanges() { throw new Error("must not be called"); },
  }, null, null, logger);
  const pulled = await loop.pullOnce("test");
  assert.strictEqual(pulled.reason, "mode_not_active");
}

// Queue rows left in a temp file by a failed replace are recovered on the
// next read, and a rejected write keeps the previous queue file.
async function testQueueOrphanRecovery(root) {
  const config = makeConfig(root);
  await fs.ensureDir(config.syncDir);
  const localIndex = createLocalIndex(config, logger);
  await localIndex.load();
  const row = (id) => ({
    operation: {
      operation_id: id, device_id: "device-a", entity_type: "agent_config",
      entity_id: `Agents/${id}/config.json`, action: "update", payload: {},
    },
    status: "pending", attempts: 3, next_attempt_at: new Date(0).toISOString(),
    created_at: new Date().toISOString(), key: `agent_config:Agents/${id}/config.json`,
  });
  await writeQueueRows(config.queuePath, [row("kept")], logger);
  // Simulate the old failure: the newest queue only exists in a temp file and
  // the main file was emptied.
  await fs.writeFile(config.queuePath, "", "utf8");
  await fs.writeFile(
    `${config.queuePath}.tmp-10516-1789786170553-deadbeef`,
    [row("kept"), row("orphan")].map(JSON.stringify).join("\n") + "\n",
    "utf8"
  );
  const rows = await readQueueLines(config.queuePath, logger);
  assert.deepStrictEqual(
    rows.map((entry) => entry.operation.operation_id).sort(),
    ["kept", "orphan"]
  );
  const leftovers = (await fs.readdir(config.syncDir)).filter((n) => n.startsWith("offline_queue.jsonl.tmp-"));
  assert.deepStrictEqual(leftovers, []);
  assert.strictEqual((await readQueueLines(config.queuePath, logger)).length, 2);

  // A failed rename keeps the previous queue intact.
  const originalRename = fs.rename;
  fs.rename = async () => { const e = new Error("EBUSY: injected"); e.code = "EBUSY"; throw e; };
  try {
    await assert.rejects(() => writeQueueRows(config.queuePath, [row("new")], logger), /EBUSY/);
  } finally {
    fs.rename = originalRename;
  }
  assert.strictEqual((await readQueueLines(config.queuePath, logger)).length, 2);

  // The worker submits the recovered rows.
  const submitted = [];
  const queue = createOfflineQueue(config, {
    async submitOperation(operation) {
      submitted.push(operation.operation_id);
      return { ok: true, seq: submitted.length, version: 1 };
    },
  }, localIndex, logger);
  await queue.start({ modeProvider: () => "active" });
  await queue.stop();
  await queue.processOnce();
  assert.deepStrictEqual(submitted.sort(), ["kept", "orphan"]);
  assert.deepStrictEqual(await readQueueLines(config.queuePath, logger), []);
}

// A newer local_index temp snapshot is adopted and temp files are removed.
async function testIndexOrphanAdoption(root) {
  const config = makeConfig(root);
  await fs.ensureDir(config.syncDir);
  const first = createLocalIndex(config, logger);
  await first.load();
  await first.setMessage("k1", { identity: { id: "1" }, topic_key: "t" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const raw = await fs.readJson(config.indexPath);
  raw.local_messages.k2 = { identity: { id: "2" }, topic_key: "t" };
  await fs.writeJson(`${config.indexPath}.tmp-1-2-3`, raw);
  await fs.writeJson(`${config.indexPath}.tmp-0-0-0`, { garbage: true });
  const second = createLocalIndex(config, logger);
  await second.load();
  assert(second.getMessage("k2"), "newer temp snapshot must be adopted");
  assert.strictEqual(second.isCorrupted(), false);
  const leftovers = (await fs.readdir(config.syncDir)).filter((n) => n.startsWith("local_index.json.tmp-"));
  assert.deepStrictEqual(leftovers, []);
  assert.strictEqual(typeof moveWithRetry, "function");
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vchat-atomic-replace-"));
  try {
    await testRenameNeverRemovesTarget(path.join(root, "rename"));
    await testStateReadWriteRace(path.join(root, "state"));
    await testQueueOrphanRecovery(path.join(root, "queue"));
    await testIndexOrphanAdoption(path.join(root, "index"));
    console.log("atomic replace, state race and queue recovery smoke test passed");
  } finally {
    assert.strictEqual(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    await fs.remove(root);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
