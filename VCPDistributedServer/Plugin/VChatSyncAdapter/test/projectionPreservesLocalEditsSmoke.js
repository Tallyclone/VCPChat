const assert = require("assert");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const { checksumJson, checksumBuffer } = require("../core/hash");
const { messageKey } = require("../core/identity");
const { createLocalIndex } = require("../core/localIndex");
const { createWriteIntentLock } = require("../sync/writeIntentLock");
const { projectEvents } = require("../projector/appDataProjector");
const { diffHistory, applyLocalSnapshot } = require("../diff/historyDiffEngine");
const { createOfflineQueue, readQueueLines } = require("../sync/offlineQueue");

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const identity = { item_type: "agent", item_id: "agent-a", topic_id: "topic-a", id: "m1" };
const key = messageKey(identity);
const topicKey = "agent:agent-a:topic-a";
const message = (content, id = "m1") => ({ id, role: "user", content });

async function makeFixture(root) {
  const config = {
    appDataPath: path.join(root, "AppData"),
    syncDir: path.join(root, "AppData", "sync"),
    indexPath: path.join(root, "AppData", "sync", "local_index.json"),
    queuePath: path.join(root, "AppData", "sync", "offline_queue.jsonl"),
    lockPath: path.join(root, "AppData", "sync", "write_intents.jsonl"),
    attachmentDir: path.join(root, "AppData", "UserData", "attachments"),
    deviceId: "device-a",
    queueIntervalMs: 1,
  };
  await fs.ensureDir(config.syncDir);
  await fs.outputJson(path.join(config.appDataPath, "Agents", "agent-a", "config.json"), {
    name: "Agent", topics: [{ id: "topic-a", name: "Topic A", createdAt: 1 }],
  });
  const historyPath = path.join(config.appDataPath, "UserData", "agent-a", "topics", "topic-a", "history.json");
  const localIndex = createLocalIndex(config, logger);
  await localIndex.load();
  await localIndex.setTopicSnapshot(topicKey, { last_known_server_version: 1 });
  const writeIntentLock = createWriteIntentLock(config, logger);
  const context = { config, localIndex, writeIntentLock, logger };
  return { config, historyPath, localIndex, writeIntentLock, context };
}

function remoteEvent(seq, content, extra = {}) {
  return {
    seq, operation_id: `remote-${seq}`, device_id: "device-b",
    item_type: "agent", item_id: "agent-a", topic_id: "topic-a",
    entity_type: "message", entity_id: "m1", action: "update", version: seq,
    payload: { message: message(content) },
    ...extra,
  };
}

// Scenario 1 from the review: device A has an unsent edit; device B's version
// arrives first. A's edit must survive on disk and be submitted as an update
// against B's version, so Center converges on A's content.
async function testLocalEditSurvivesRemoteVersion(root) {
  const f = await makeFixture(root);
  await fs.outputJson(f.historyPath, [message("base")]);
  await f.localIndex.setMessage(key, {
    identity, topic_key: topicKey, last_known_server_version: 1, last_applied_seq: 1,
    last_known_checksum: checksumJson(message("base")),
  });
  const server = { message: message("B edit"), version: 2 };
  const submitted = [];
  const centerClient = {
    async submitOperation(operation) {
      submitted.push(JSON.parse(JSON.stringify(operation)));
      server.message = operation.payload.message;
      server.version += 1;
      return { ok: true, seq: 10 + submitted.length, version: server.version };
    },
  };
  const queue = createOfflineQueue(f.config, centerClient, f.localIndex, logger);
  await queue.start({ modeProvider: () => "active" });
  await queue.stop();

  // A edits locally (queued, offline).
  await fs.outputJson(f.historyPath, [message("A edit")]);
  const diff = await diffHistory(identity, [message("A edit")], f.localIndex, { deviceId: "device-a" });
  const enqueued = await queue.enqueueMany(diff.operations, { mode: "active" });
  await applyLocalSnapshot(f.localIndex, diff, enqueued);

  // B's version is pulled and projected before A's queue drains.
  const projection = await projectEvents([remoteEvent(2, "B edit")], f.context);
  assert.deepStrictEqual(projection.appliedSeqs, [2]);
  assert.deepStrictEqual(await fs.readJson(f.historyPath), [message("A edit")], "local edit overwritten");
  const local = f.localIndex.getMessage(key);
  assert.strictEqual(local.pending_action, "update");
  assert.strictEqual(local.last_known_server_version, 2);
  assert.strictEqual(local.remote_version_preserved_local_edit.kind, "pending_edit");

  // A's queue drains against B's version.
  await queue.processOnce();
  assert.strictEqual(submitted.length, 1);
  assert.strictEqual(submitted[0].base_version, 2);
  assert.strictEqual(server.message.content, "A edit");
  assert.strictEqual(server.version, 3);
  assert.deepStrictEqual(await readQueueLines(f.config.queuePath, logger), []);

  // The next scan finds nothing to re-upload: B was never written to disk,
  // so it cannot be mistaken for a new local modification.
  const stable = await diffHistory(identity, [message("A edit")], f.localIndex, { deviceId: "device-a" });
  assert.strictEqual(stable.operations.length, 0);
  assert.strictEqual(f.localIndex.getMessage(key).last_known_server_version, 3);

  // Once nothing is pending, a later remote version is applied normally.
  const later = await projectEvents([remoteEvent(4, "B again")], f.context);
  assert.deepStrictEqual(later.appliedSeqs, [4]);
  assert.deepStrictEqual(await fs.readJson(f.historyPath), [message("B again")]);
}

// An edit the watcher has not observed yet (on disk differs from the last
// known checksum, nothing queued) is also preserved.
async function testUnobservedEditSurvives(root) {
  const f = await makeFixture(root);
  await fs.outputJson(f.historyPath, [message("typed but not yet scanned")]);
  await f.localIndex.setMessage(key, {
    identity, topic_key: topicKey, last_known_server_version: 1, last_applied_seq: 1,
    last_known_checksum: checksumJson(message("base")),
  });
  const projection = await projectEvents([remoteEvent(2, "remote")], f.context);
  assert.deepStrictEqual(projection.appliedSeqs, [2]);
  assert.deepStrictEqual(await fs.readJson(f.historyPath), [message("typed but not yet scanned")]);
  const local = f.localIndex.getMessage(key);
  assert.strictEqual(local.last_known_server_version, 2);
  assert.strictEqual(local.last_known_checksum, checksumJson(message("base")));
  // The following scan uploads the local edit against version 2.
  const diff = await diffHistory(identity, [message("typed but not yet scanned")], f.localIndex, { deviceId: "device-a" });
  assert.strictEqual(diff.operations.length, 1);
  assert.strictEqual(diff.operations[0].action, "update");
  assert.strictEqual(diff.operations[0].base_version, 2);
}

// Scenario 2 from the review: the host saves a new message while the
// projector is downloading an attachment. The new message must survive.
async function testHostSaveDuringAttachmentDownload(root) {
  const f = await makeFixture(root);
  await fs.outputJson(f.historyPath, [message("first")]);
  await f.localIndex.setMessage(key, {
    identity, topic_key: topicKey, last_known_server_version: 1, last_applied_seq: 1,
    last_known_checksum: checksumJson(message("first")),
  });
  const attachmentBuffer = Buffer.from("remote attachment payload");
  const attachmentHash = checksumBuffer(attachmentBuffer);
  let downloads = 0;
  const centerClient = {
    async downloadAttachment() {
      downloads += 1;
      // The host appends a brand-new local message while we wait.
      const current = await fs.readJson(f.historyPath);
      current.push(message("typed during download", "m-local-new"));
      await fs.writeJson(f.historyPath, current);
      return { buffer: attachmentBuffer, headers: {} };
    },
  };
  const projection = await projectEvents([{
    seq: 5, operation_id: "remote-5", device_id: "device-b",
    item_type: "agent", item_id: "agent-a", topic_id: "topic-a",
    entity_type: "message", entity_id: "m2", action: "create", version: 1,
    payload: { message: { id: "m2", role: "assistant", content: "with file",
      attachments: [{ hash: attachmentHash, internalPath: "C:/x/file.bin" }] } },
  }], { ...f.context, centerClient });
  assert.strictEqual(projection.error, undefined);
  assert.deepStrictEqual(projection.appliedSeqs, [5]);
  assert.strictEqual(downloads, 1);
  const history = await fs.readJson(f.historyPath);
  assert.deepStrictEqual(history.map((m) => m.id), ["m1", "m-local-new", "m2"]);
  assert.strictEqual(history[2].attachments[0].internalPath,
    path.join(f.config.attachmentDir, `${attachmentHash}.bin`));
}

// A host save between the projector's read and its write is detected and
// merged (retry), never overwritten.
async function testHostSaveBetweenReadAndWrite(root) {
  const f = await makeFixture(root);
  await fs.outputJson(f.historyPath, [message("first")]);
  await f.localIndex.setMessage(key, {
    identity, topic_key: topicKey, last_known_server_version: 1, last_applied_seq: 1,
    last_known_checksum: checksumJson(message("first")),
  });
  const originalRecord = f.writeIntentLock.record;
  let injected = false;
  f.writeIntentLock.record = async (intent) => {
    if (!injected && /history\.json$/.test(intent.filePath)) {
      injected = true;
      const current = await fs.readJson(f.historyPath);
      current.push(message("host wrote this", "m-host"));
      await fs.writeJson(f.historyPath, current);
    }
    return originalRecord(intent);
  };
  const projection = await projectEvents([{
    seq: 6, operation_id: "remote-6", device_id: "device-b",
    item_type: "agent", item_id: "agent-a", topic_id: "topic-a",
    entity_type: "message", entity_id: "m3", action: "create", version: 1,
    payload: { message: message("remote new", "m3") },
  }], f.context);
  assert.strictEqual(projection.error, undefined);
  assert.deepStrictEqual(projection.appliedSeqs, [6]);
  assert.deepStrictEqual((await fs.readJson(f.historyPath)).map((m) => m.id), ["m1", "m-host", "m3"]);
}

// A remote topic upsert confirms the local topic snapshot so queued messages
// stop waiting for a parent that Center evidently has.
async function testRemoteTopicEventConfirmsSnapshot(root) {
  const f = await makeFixture(root);
  await f.localIndex.setTopicSnapshot(topicKey, {
    topic_key: topicKey, local_checksum: "x",
    pending_operation_id: "lost", pending_action: "upsert", pending_status: "pending_upsert",
  });
  const projection = await projectEvents([{
    seq: 7, operation_id: "remote-topic", device_id: "device-b",
    entity_type: "topic", entity_id: "topic-a", action: "upsert", version: 3,
    item_type: "agent", item_id: "agent-a", topic_id: "topic-a",
    payload: { topic: { id: "topic-a", name: "Renamed" } },
  }], f.context);
  assert.deepStrictEqual(projection.appliedSeqs, [7]);
  const snapshot = f.localIndex.getTopicSnapshot(topicKey);
  assert.strictEqual(snapshot.pending_operation_id, null);
  assert(snapshot.confirmed_at);
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vchat-projection-merge-"));
  try {
    await testLocalEditSurvivesRemoteVersion(path.join(root, "local-edit"));
    await testUnobservedEditSurvives(path.join(root, "unobserved"));
    await testHostSaveDuringAttachmentDownload(path.join(root, "download"));
    await testHostSaveBetweenReadAndWrite(path.join(root, "race"));
    await testRemoteTopicEventConfirmsSnapshot(path.join(root, "topic"));
    console.log("projection preserves local edits and host writes smoke test passed");
  } finally {
    assert.strictEqual(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    await fs.remove(root);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
