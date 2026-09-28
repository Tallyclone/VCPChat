const assert = require("assert");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const { checksumJson } = require("../core/hash");
const { messageKey } = require("../core/identity");
const { createLocalIndex } = require("../core/localIndex");
const { diffHistory, applyLocalSnapshot } = require("../diff/historyDiffEngine");
const { createOfflineQueue, readQueueLines } = require("../sync/offlineQueue");

const identity = { item_type: "agent", item_id: "agent-a", topic_id: "topic-a", id: "m1" };
const key = messageKey(identity);
const topicKey = "agent:agent-a:topic-a";
const message = (content) => ({ id: "m1", role: "user", content });
const logger = { debug() {}, info() {}, warn() {}, error() {} };

async function makeContext(root, initial = "A") {
  const config = {
    appDataPath: path.join(root, "AppData"),
    syncDir: path.join(root, "AppData", "sync"),
    indexPath: path.join(root, "AppData", "sync", "local_index.json"),
    queuePath: path.join(root, "AppData", "sync", "offline_queue.jsonl"),
    deviceId: "device-a",
    queueIntervalMs: 1,
  };
  const context = {
    config,
    calls: [],
    applied: new Map(),
    server: initial === null ? null : { message: message(initial), version: 1 },
    seq: initial === null ? 0 : 1,
    beforeSubmit: null,
    afterCommit: null,
  };
  context.centerClient = {
    async submitOperation(operation) {
      context.calls.push(JSON.parse(JSON.stringify(operation)));
      if (context.beforeSubmit) await context.beforeSubmit(operation);
      if (context.applied.has(operation.operation_id)) {
        return context.applied.get(operation.operation_id);
      }
      if (operation.action === "update" && !context.server) {
        const error = new Error("message update target does not exist");
        error.code = "MESSAGE_UPDATE_TARGET_MISSING";
        throw error;
      }
      if (operation.action === "create" && context.server) {
        assert.deepStrictEqual(operation.payload.message, context.server.message,
          "a changed create must wait for its ACK, then become an update");
      }
      const version = context.server ? context.server.version + 1 : 1;
      context.server = operation.action === "delete" ? null : {
        message: JSON.parse(JSON.stringify(operation.payload.message)), version,
      };
      const response = { ok: true, seq: ++context.seq, version };
      context.applied.set(operation.operation_id, response);
      if (context.afterCommit) await context.afterCommit(operation);
      return response;
    },
  };
  context.reopen = async () => {
    if (context.queue) await context.queue.stop();
    context.index = createLocalIndex(config, logger);
    await context.index.load();
    context.queue = createOfflineQueue(config, context.centerClient, context.index, logger);
    await context.queue.start({ modeProvider: () => "active" });
    await context.queue.stop();
  };
  await context.reopen();
  await context.index.setTopicSnapshot(topicKey, { last_known_server_version: 1 });
  if (initial !== null) {
    await context.index.setMessage(key, {
      identity, topic_key: topicKey,
      last_known_server_version: 1,
      last_applied_seq: 1,
      last_known_checksum: checksumJson(message(initial)),
    });
  }
  return context;
}

async function observe(context, content, options = {}) {
  const diff = await diffHistory(identity, [message(content)], context.index, {
    deviceId: context.config.deviceId,
  });
  if (options.operationId) diff.operations[0].operation_id = options.operationId;
  const enqueued = await context.queue.enqueueMany(diff.operations, { mode: "active" });
  if (!options.delaySnapshot) await applyLocalSnapshot(context.index, diff, enqueued);
  return { diff, enqueued };
}

async function makeReady(context) {
  const rows = await readQueueLines(context.config.queuePath, logger);
  for (const row of rows) row.next_attempt_at = new Date(0).toISOString();
  await fs.writeFile(context.config.queuePath, rows.map(JSON.stringify).join("\n") + "\n");
}

async function assertSettled(context, content) {
  assert.strictEqual(context.server.message.content, content);
  assert.deepStrictEqual(await readQueueLines(context.config.queuePath, logger), []);
  await context.reopen();
  const saved = context.index.getMessage(key);
  assert.strictEqual(saved.pending_operation_id, null);
  assert.strictEqual(saved.last_known_checksum, checksumJson(message(content)));
  const stable = await diffHistory(identity, [message(content)], context.index, {
    deviceId: context.config.deviceId,
  });
  assert.strictEqual(stable.operations.length, 0);
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vchat-message-lifecycle-"));
  try {
    // Unchanged trailing scans must preserve pending metadata; another edit
    // must replace the unattempted payload, not merely advance its checksum.
    const offline = await makeContext(path.join(root, "offline-edits"));
    const first = await observe(offline, "B");
    await observe(offline, "B");
    assert.strictEqual(offline.index.getMessage(key).pending_operation_id,
      first.enqueued[0].operation_id);
    await observe(offline, "C");
    const pending = await readQueueLines(offline.config.queuePath, logger);
    assert.strictEqual(pending.length, 1);
    assert.strictEqual(pending[0].operation.payload.message.content, "C");
    await offline.queue.processOnce();
    await assertSettled(offline, "C");

    // A caller resuming applyLocalSnapshot after a worker ACK cannot revive
    // the acknowledged pending operation, including after a process restart.
    const delayed = await makeContext(path.join(root, "delayed-snapshot"));
    const delayedScan = await observe(delayed, "B", { delaySnapshot: true });
    await delayed.queue.processOnce();
    await applyLocalSnapshot(delayed.index, delayedScan.diff, delayedScan.enqueued);
    await assertSettled(delayed, "B");

    // Two watchers can complete their asynchronous scans out of order.
    const reordered = await makeContext(path.join(root, "reordered-scans"));
    const oldDiff = await diffHistory(identity, [message("B")], reordered.index, { deviceId: "device-a" });
    const newDiff = await diffHistory(identity, [message("C")], reordered.index, { deviceId: "device-a" });
    await reordered.queue.enqueueMany(newDiff.operations, { mode: "active" });
    const stale = await reordered.queue.enqueueMany(oldDiff.operations, { mode: "active" });
    assert.strictEqual(stale[0].stale_observation, true);
    await reordered.queue.processOnce();
    await assertSettled(reordered, "C");

    // The same value reached through a later edit is not an old retry.
    const recurring = await makeContext(path.join(root, "recurring-value"));
    for (const content of ["B", "C", "B"]) {
      await observe(recurring, content);
      await recurring.queue.processOnce();
    }
    assert.notStrictEqual(recurring.calls[0].operation_id, recurring.calls[2].operation_id);
    assert.strictEqual(recurring.server.version, 4);
    await assertSettled(recurring, "B");

    // An ACK lost after a committed create must not allow merging away the
    // old request. A restart replays its exact ID and then uploads the edit.
    const lostCreate = await makeContext(path.join(root, "lost-create-ack"), null);
    let loseAck = true;
    lostCreate.afterCommit = async () => {
      if (loseAck) { loseAck = false; throw new Error("connection lost after commit"); }
    };
    const created = await observe(lostCreate, "B", { operationId: "legacy-fixed-create-id" });
    await lostCreate.queue.processOnce();
    const transmitted = await readQueueLines(lostCreate.config.queuePath, logger);
    assert.strictEqual(transmitted[0].attempts, 1);
    await observe(lostCreate, "C");
    const successors = await readQueueLines(lostCreate.config.queuePath, logger);
    assert.strictEqual(successors.length, 2);
    assert.strictEqual(successors[0].operation.operation_id, created.enqueued[0].operation_id);
    assert.strictEqual(successors[0].operation.payload.message.content, "B");
    assert.strictEqual(successors[1].operation.action, "update");
    assert.strictEqual(successors[1].after_operation_id, successors[0].operation.operation_id);
    await lostCreate.reopen();
    await makeReady(lostCreate);
    await lostCreate.queue.processOnce();
    assert.strictEqual(lostCreate.calls[0].operation_id, lostCreate.calls[1].operation_id);
    assert.strictEqual(lostCreate.calls[2].base_version, 1);
    await assertSettled(lostCreate, "C");

    // A failed earlier update blocks later edits for that message; its ACK
    // must preserve the pending ID/checksum belonging to the newer edit.
    const lostUpdate = await makeContext(path.join(root, "lost-update-ack"));
    let disconnected = true;
    lostUpdate.beforeSubmit = async (operation) => {
      if (disconnected) throw new Error("offline");
      if (operation.payload.message.content === "C") {
        assert.strictEqual(lostUpdate.index.getMessage(key).pending_operation_id, operation.operation_id);
        assert.strictEqual(lostUpdate.index.getMessage(key).last_known_checksum, checksumJson(message("C")));
      }
    };
    await observe(lostUpdate, "B", { operationId: "legacy-fixed-update-id" });
    await lostUpdate.queue.processOnce();
    await observe(lostUpdate, "C");
    await makeReady(lostUpdate);
    await lostUpdate.queue.processOnce();
    assert(lostUpdate.calls.every((operation) => operation.payload.message.content === "B"));
    disconnected = false;
    await makeReady(lostUpdate);
    await lostUpdate.queue.processOnce();
    assert.strictEqual(lostUpdate.calls[2].operation_id, "legacy-fixed-update-id");
    await assertSettled(lostUpdate, "C");

    // Recovery must use the durable queue when its index write failed.
    const partialEnqueue = await makeContext(path.join(root, "partial-enqueue"));
    const originalSet = partialEnqueue.index.setMessage;
    partialEnqueue.index.setMessage = async () => { throw new Error("simulated index write failure"); };
    await assert.rejects(observe(partialEnqueue, "B"), /simulated index write failure/);
    partialEnqueue.index.setMessage = originalSet;
    assert.strictEqual((await readQueueLines(partialEnqueue.config.queuePath, logger)).length, 1);
    await partialEnqueue.reopen();
    await partialEnqueue.queue.processOnce();
    await assertSettled(partialEnqueue, "B");

    // Old needs_create state is still repairable without a new user edit.
    const legacyRepair = await makeContext(path.join(root, "legacy-needs-create"), null);
    await legacyRepair.index.setMessage(key, {
      identity, topic_key: topicKey,
      last_known_checksum: checksumJson(message("B")),
      last_known_server_version: null, pending_status: "needs_create",
    });
    const repair = await observe(legacyRepair, "B");
    assert.strictEqual(repair.diff.operations[0].action, "create");
    await legacyRepair.queue.processOnce();
    await assertSettled(legacyRepair, "B");

    // A missing update target becomes a persistent create in the same queue,
    // so it survives restart without depending on another filesystem event.
    const missing = await makeContext(path.join(root, "missing-target"));
    missing.server = null;
    const update = await observe(missing, "B");
    await missing.queue.processOnce();
    const recreate = await readQueueLines(missing.config.queuePath, logger);
    assert.strictEqual(recreate.length, 1);
    assert.strictEqual(recreate[0].operation.action, "create");
    assert.strictEqual(recreate[0].repair_of_operation_id, update.enqueued[0].operation_id);
    assert.notStrictEqual(recreate[0].operation.operation_id, update.enqueued[0].operation_id);
    assert.strictEqual(missing.index.getMessage(key).pending_action, "create");
    await missing.reopen();
    await missing.queue.processOnce();
    await assertSettled(missing, "B");

    // A local delete is retained behind an outstanding edit and does not
    // depend on a later scan after that edit happens to finish uploading.
    const deleted = await makeContext(path.join(root, "delete-after-edit"));
    await observe(deleted, "B");
    const deletion = await diffHistory(identity, [], deleted.index, { deviceId: "device-a" });
    assert.strictEqual(deletion.operations[0].action, "delete");
    const deleteReceipt = await deleted.queue.enqueueMany(deletion.operations, { mode: "active" });
    await applyLocalSnapshot(deleted.index, deletion, deleteReceipt);
    await deleted.queue.processOnce();
    assert.strictEqual(deleted.server, null);
    assert.strictEqual(deleted.index.getMessage(key), null);
    assert.deepStrictEqual(await readQueueLines(deleted.config.queuePath, logger), []);

    // Temporarily incomplete content is still physically present and cannot
    // be inferred to be a user deletion.
    const streaming = await makeContext(path.join(root, "streaming-presence"));
    const transient = await diffHistory(identity, [{ ...message(""), partial: true }], streaming.index,
      { deviceId: "device-a" });
    assert.strictEqual(transient.operations.length, 0);

    // If the old create is rejected because its parent was deleted, its
    // queued successor must terminate rather than retrying a forbidden update.
    const terminal = await makeContext(path.join(root, "terminal-predecessor"), null);
    terminal.beforeSubmit = async () => { throw new Error("offline"); };
    await observe(terminal, "B");
    await terminal.queue.processOnce();
    await observe(terminal, "C");
    const terminalCalls = [];
    terminal.centerClient.submitOperation = async (operation) => {
      terminalCalls.push(operation);
      return { ok: true, conflict: true, deleted: true, resolution: "delete_wins", seq: 2 };
    };
    await makeReady(terminal);
    await terminal.queue.processOnce();
    assert.strictEqual(terminalCalls.length, 1);
    assert.deepStrictEqual(await readQueueLines(terminal.config.queuePath, logger), []);
    assert.strictEqual(terminal.index.getMessage(key).pending_status, "conflict_delete_wins");
    console.log("message queue lifecycle smoke test passed");
  } finally {
    assert.strictEqual(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith("vchat-message-lifecycle-"));
    await fs.remove(root);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
