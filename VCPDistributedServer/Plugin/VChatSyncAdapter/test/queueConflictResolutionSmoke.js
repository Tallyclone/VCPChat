const assert = require("assert");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const { createRequire } = require("module");
const { checksumJson } = require("../core/hash");
const { messageKey } = require("../core/identity");
const { createLocalIndex } = require("../core/localIndex");
const { diffHistory, applyLocalSnapshot } = require("../diff/historyDiffEngine");
const { createOfflineQueue, readQueueLines, rejectedQueuePathFor } = require("../sync/offlineQueue");

const centerRoot = process.env.VCHAT_SYNC_TEST_CENTER_ROOT ||
  path.resolve(__dirname, "../../../../../VCPToolBox/Plugin/VChatSyncCenter");
const centerRequire = createRequire(path.join(centerRoot, "index.js"));
const Database = centerRequire("better-sqlite3");
const { runMigrations } = centerRequire("./core/migrations");
const { processOperation, registerDevice } = centerRequire("./core/operationProcessor");

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const identity = { item_type: "agent", item_id: "agent-a", topic_id: "topic-a", id: "m1" };
const key = messageKey(identity);
const topicKey = "agent:agent-a:topic-a";
const message = (content) => ({ id: "m1", role: "user", content });

// Real Center over an in-memory database, wrapped in the HTTP error shape
// axios produces so the queue sees exactly what production sees.
function makeCenter() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db, logger);
  registerDevice(db, { device_id: "device-a" });
  registerDevice(db, { device_id: "device-b" });
  const calls = [];
  const centerClient = {
    calls,
    async submitOperation(operation) {
      calls.push(JSON.parse(JSON.stringify(operation)));
      let result;
      try {
        result = processOperation(db, operation);
      } catch (error) {
        const wrapped = new Error("Request failed with status code 400");
        wrapped.response = { status: 400, data: { ok: false, code: error.code, error: error.message } };
        throw wrapped;
      }
      if (result.ok === false) {
        const wrapped = new Error("Request failed with status code 409");
        wrapped.response = { status: 409, data: result };
        throw wrapped;
      }
      return result;
    },
    async checkTopics(topics) {
      return {
        ok: true,
        results: topics.map((topic) => {
          const row = db.prepare(
            "SELECT id, deleted FROM topics WHERE item_type = ? AND item_id = ? AND id = ?"
          ).get(topic.item_type, topic.item_id, topic.topic_id);
          return row
            ? { topic_id: row.id, exists: true, deleted: Number(row.deleted) === 1 }
            : { topic_id: topic.topic_id, exists: false };
        }),
      };
    },
    async registerDevice() { return { ok: true }; },
  };
  return { db, centerClient };
}

async function makeContext(root, center) {
  const config = {
    appDataPath: path.join(root, "AppData"),
    syncDir: path.join(root, "AppData", "sync"),
    indexPath: path.join(root, "AppData", "sync", "local_index.json"),
    queuePath: path.join(root, "AppData", "sync", "offline_queue.jsonl"),
    deviceId: "device-a",
    queueIntervalMs: 1,
  };
  await fs.ensureDir(config.syncDir);
  const index = createLocalIndex(config, logger);
  await index.load();
  const queue = createOfflineQueue(config, center.centerClient, index, logger);
  await queue.start({ modeProvider: () => "active" });
  await queue.stop();
  return { config, index, queue };
}

async function makeReady(context) {
  const rows = await readQueueLines(context.config.queuePath, logger);
  for (const row of rows) row.next_attempt_at = new Date(0).toISOString();
  await fs.writeFile(context.config.queuePath, rows.map(JSON.stringify).join("\n") + (rows.length ? "\n" : ""));
}

function seedTopic(center, itemId = "agent-a", topicId = "topic-a") {
  processOperation(center.db, {
    operation_id: `seed-topic-${itemId}-${topicId}`, device_id: "device-b",
    entity_type: "topic", entity_id: topicId, action: "upsert",
    item_type: "agent", item_id: itemId, topic_id: topicId,
    payload: { topic: { id: topicId, name: "Topic" } },
  });
}

async function observe(context, content) {
  const diff = await diffHistory(identity, [message(content)], context.index, { deviceId: "device-a" });
  const enqueued = await context.queue.enqueueMany(diff.operations, { mode: "active" });
  await applyLocalSnapshot(context.index, diff, enqueued);
  return { diff, enqueued };
}

function centerMessage(center) {
  return center.db.prepare(
    "SELECT raw_json, version, deleted FROM messages WHERE item_type = ? AND item_id = ? AND topic_id = ? AND id = ?"
  ).get(identity.item_type, identity.item_id, identity.topic_id, identity.id);
}

// Issue 1: a create whose ID Center already rejected with create_conflict
// must not loop forever. The local intent is submitted as an update.
async function testCreateConflictConvertsToUpdate(root) {
  const center = makeCenter();
  seedTopic(center);
  processOperation(center.db, {
    operation_id: "device-b-create", device_id: "device-b",
    entity_type: "message", entity_id: "m1", action: "create",
    item_type: "agent", item_id: "agent-a", topic_id: "topic-a",
    payload: { message: message("from device b") },
  });
  const context = await makeContext(root, center);
  await context.index.setTopicSnapshot(topicKey, { last_known_server_version: 1 });
  await observe(context, "from device a");
  await context.queue.processOnce();
  const afterFirst = await readQueueLines(context.config.queuePath, logger);
  assert.strictEqual(afterFirst.length, 1);
  assert.strictEqual(afterFirst[0].operation.action, "update");
  assert.strictEqual(afterFirst[0].operation.base_version, 1);
  assert.strictEqual(afterFirst[0].repair_reason, "create_conflict_converted_to_update");
  await makeReady(context);
  await context.queue.processOnce();
  assert.deepStrictEqual(await readQueueLines(context.config.queuePath, logger), []);
  const row = centerMessage(center);
  assert.strictEqual(JSON.parse(row.raw_json).content, "from device a");
  assert.strictEqual(row.version, 2);
  const local = context.index.getMessage(key);
  assert.strictEqual(local.pending_operation_id, null);
  assert.strictEqual(local.last_known_server_version, 2);
  // The create hit 409 exactly once; no infinite retry.
  assert.strictEqual(center.centerClient.calls.filter((c) => c.action === "create").length, 1);
  const stable = await diffHistory(identity, [message("from device a")], context.index, { deviceId: "device-a" });
  assert.strictEqual(stable.operations.length, 0);
  center.db.close();
}

// Issue 1 (replay form): the queue already carries hundreds of attempts of
// a rejected create; a restart must converge instead of retrying again.
async function testStaleRejectedCreateFromOldQueue(root) {
  const center = makeCenter();
  seedTopic(center);
  processOperation(center.db, {
    operation_id: "device-b-create", device_id: "device-b",
    entity_type: "message", entity_id: "m1", action: "create",
    item_type: "agent", item_id: "agent-a", topic_id: "topic-a",
    payload: { message: message("center content") },
  });
  const context = await makeContext(root, center);
  await context.index.setTopicSnapshot(topicKey, { last_known_server_version: 1 });
  const localContent = message("local content");
  const checksum = checksumJson(localContent);
  const legacyRow = {
    operation: {
      operation_id: "device-a:message.create:legacy",
      device_id: "device-a", entity_type: "message", action: "create",
      item_type: "agent", item_id: "agent-a", topic_id: "topic-a", entity_id: "m1",
      payload: { ...identity, message_id: "m1", message: localContent, attachments: [], local_checksum: checksum },
    },
    status: "pending", attempts: 1122, next_attempt_at: new Date(0).toISOString(),
    created_at: new Date().toISOString(), key,
    last_error: "Request failed with status code 409",
  };
  await fs.writeFile(context.config.queuePath, JSON.stringify(legacyRow) + "\n");
  await context.index.setMessage(key, {
    identity, topic_key: topicKey, last_known_checksum: checksum,
    pending_operation_id: legacyRow.operation.operation_id, pending_action: "create",
    pending_status: "pending_create", pending_checksum: checksum,
  });
  // Center already recorded the conflict for this exact ID (the real world).
  await assert.rejects(() => center.centerClient.submitOperation(legacyRow.operation), /409/);
  await context.queue.processOnce();
  await makeReady(context);
  await context.queue.processOnce();
  assert.deepStrictEqual(await readQueueLines(context.config.queuePath, logger), []);
  assert.strictEqual(JSON.parse(centerMessage(center).raw_json).content, "local content");
  center.db.close();
}

// Permanent validation rejections are dead-lettered after a few attempts,
// releasing the entity for later edits.
async function testPermanentRejectionDeadLetters(root) {
  const center = makeCenter();
  const context = await makeContext(root, center);
  const rejectedPath = rejectedQueuePathFor(context.config.queuePath);
  await context.queue.enqueueMany([{
    operation_id: "bad-config", device_id: "device-a", entity_type: "agent_config",
    entity_id: "Agents/x/config.json", action: "update",
    payload: { schema: "agent_config", entity_id: "Agents/x/config.json", safe_projection_json: { apiKey: "secret" } },
  }], { mode: "active" });
  for (let i = 0; i < 4; i += 1) {
    await makeReady(context);
    await context.queue.processOnce();
  }
  assert.deepStrictEqual(await readQueueLines(context.config.queuePath, logger), []);
  const rejected = (await fs.readFile(rejectedPath, "utf8")).trim().split("\n").map(JSON.parse);
  assert.strictEqual(rejected.length, 1);
  assert.strictEqual(rejected[0].operation.operation_id, "bad-config");
  assert.strictEqual(rejected[0].rejection.status, 400);
  assert.strictEqual(center.centerClient.calls.length, 3);
  center.db.close();
}

// Issue 2: a topic snapshot whose pending operation is neither queued nor
// confirmed must not hold messages forever. Center is asked; if the topic
// exists the snapshot is confirmed and the message goes out.
async function testOrphanTopicPendingMarker(root) {
  const center = makeCenter();
  seedTopic(center);
  const context = await makeContext(root, center);
  await context.index.setTopicSnapshot(topicKey, {
    topic_key: topicKey, item_type: "agent", item_id: "agent-a", topic_id: "topic-a",
    local_checksum: "abc",
    pending_operation_id: "device-a:topic.upsert:lost-forever",
    pending_action: "upsert", pending_status: "pending_upsert",
  });
  await observe(context, "hello");
  await context.queue.processOnce();
  assert.deepStrictEqual(await readQueueLines(context.config.queuePath, logger), []);
  assert.strictEqual(JSON.parse(centerMessage(center).raw_json).content, "hello");
  const snapshot = context.index.getTopicSnapshot(topicKey);
  assert.strictEqual(snapshot.pending_operation_id, null);
  assert(snapshot.confirmed_at);
  assert.strictEqual(snapshot.stale_pending_operation_id, "device-a:topic.upsert:lost-forever");
  center.db.close();
}

// Issue 2 (topic truly missing): the parent is re-submitted from
// config.topics[] and the message follows it.
async function testOrphanMarkerWithMissingCenterTopic(root) {
  const center = makeCenter();
  const context = await makeContext(root, center);
  await fs.outputJson(path.join(context.config.appDataPath, "Agents", "agent-a", "config.json"), {
    name: "Agent", topics: [{ id: "topic-a", name: "Topic A", createdAt: 1 }],
  });
  await context.index.setTopicSnapshot(topicKey, {
    topic_key: topicKey, local_checksum: "abc",
    pending_operation_id: "lost", pending_action: "upsert", pending_status: "pending_upsert",
  });
  await observe(context, "hello");
  for (let i = 0; i < 3; i += 1) {
    await makeReady(context);
    await context.queue.processOnce();
  }
  assert.deepStrictEqual(await readQueueLines(context.config.queuePath, logger), []);
  assert.strictEqual(JSON.parse(centerMessage(center).raw_json).content, "hello");
  assert.strictEqual(center.centerClient.calls[0].entity_type, "topic");
  center.db.close();
}

// Issue 10: delete then restore-and-edit the same message before the delete
// was ever sent. The delete is withdrawn and the edit is submitted.
async function testDeleteThenRestoreSameMessage(root) {
  const center = makeCenter();
  seedTopic(center);
  processOperation(center.db, {
    operation_id: "seed-message", device_id: "device-b",
    entity_type: "message", entity_id: "m1", action: "create",
    item_type: "agent", item_id: "agent-a", topic_id: "topic-a",
    payload: { message: message("A") },
  });
  const context = await makeContext(root, center);
  await context.index.setTopicSnapshot(topicKey, { last_known_server_version: 1 });
  await context.index.setMessage(key, {
    identity, topic_key: topicKey, last_known_server_version: 1, last_applied_seq: 2,
    last_known_checksum: checksumJson(message("A")),
  });
  const deletion = await diffHistory(identity, [], context.index, { deviceId: "device-a" });
  assert.strictEqual(deletion.operations[0].action, "delete");
  const deleteReceipt = await context.queue.enqueueMany(deletion.operations, { mode: "active" });
  await applyLocalSnapshot(context.index, deletion, deleteReceipt);
  await observe(context, "B");
  const rows = await readQueueLines(context.config.queuePath, logger);
  assert.strictEqual(rows.length, 1, "withdrawn delete must leave the queue");
  assert.strictEqual(rows[0].operation.action, "update");
  assert.strictEqual(rows[0].after_operation_id, undefined);
  await context.queue.processOnce();
  assert.deepStrictEqual(await readQueueLines(context.config.queuePath, logger), []);
  const row = centerMessage(center);
  assert.strictEqual(row.deleted, 0);
  assert.strictEqual(JSON.parse(row.raw_json).content, "B");
  assert.strictEqual(context.index.getMessage(key).pending_operation_id, null);

  // A delete that was already transmitted keeps its order: delete first,
  // then the re-create of the restored message.
  const context2 = await makeContext(path.join(root, "sent-delete"), center);
  await context2.index.setTopicSnapshot(topicKey, { last_known_server_version: 1 });
  await context2.index.setMessage(key, {
    identity, topic_key: topicKey, last_known_server_version: 2, last_applied_seq: 3,
    last_known_checksum: checksumJson(message("B")),
  });
  const deletion2 = await diffHistory(identity, [], context2.index, { deviceId: "device-a" });
  const receipt2 = await context2.queue.enqueueMany(deletion2.operations, { mode: "active" });
  await applyLocalSnapshot(context2.index, deletion2, receipt2);
  const sentRows = await readQueueLines(context2.config.queuePath, logger);
  sentRows[0].attempts = 1;
  sentRows[0].last_error = "offline";
  await fs.writeFile(context2.config.queuePath, sentRows.map(JSON.stringify).join("\n") + "\n");
  await observe(context2, "C");
  const ordered = await readQueueLines(context2.config.queuePath, logger);
  assert.strictEqual(ordered.length, 2);
  assert.strictEqual(ordered[0].operation.action, "delete");
  assert(["create", "update"].includes(ordered[1].operation.action));
  assert.strictEqual(ordered[1].after_operation_id, ordered[0].operation.operation_id);
  await makeReady(context2);
  await context2.queue.processOnce();
  await makeReady(context2);
  await context2.queue.processOnce();
  assert.deepStrictEqual(await readQueueLines(context2.config.queuePath, logger), []);
  const lastTwo = center.centerClient.calls.slice(-2).map((c) => c.action);
  assert.strictEqual(lastTwo[0], "delete", "the transmitted delete keeps its place ahead of the edit");
  assert(["create", "update"].includes(lastTwo[1]));
  assert.strictEqual(centerMessage(center).deleted, 1, "tombstone wins over the later edit");
  assert.strictEqual(context2.index.getMessage(key).pending_status, "conflict_delete_wins");
  center.db.close();
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vchat-queue-conflict-"));
  try {
    await testCreateConflictConvertsToUpdate(path.join(root, "conflict"));
    await testStaleRejectedCreateFromOldQueue(path.join(root, "legacy"));
    await testPermanentRejectionDeadLetters(path.join(root, "dead-letter"));
    await testOrphanTopicPendingMarker(path.join(root, "orphan"));
    await testOrphanMarkerWithMissingCenterTopic(path.join(root, "orphan-missing"));
    await testDeleteThenRestoreSameMessage(path.join(root, "delete-restore"));
    console.log("queue conflict, orphan topic and delete-restore smoke test passed");
  } finally {
    assert.strictEqual(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    await fs.remove(root);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
