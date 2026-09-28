const assert = require("assert");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const { createRequire } = require("module");
const { createLocalIndex } = require("../core/localIndex");
const { createWriteIntentLock } = require("../sync/writeIntentLock");
const { joinExisting } = require("../sync/bootstrapManager");

const centerRoot = process.env.VCHAT_SYNC_TEST_CENTER_ROOT ||
  path.resolve(__dirname, "../../../../../VCPToolBox/Plugin/VChatSyncCenter");
const centerRequire = createRequire(path.join(centerRoot, "index.js"));
const Database = centerRequire("better-sqlite3");
const { runMigrations } = centerRequire("./core/migrations");
const { processOperation, registerDevice } = centerRequire("./core/operationProcessor");
const { exportBaseline } = centerRequire("./core/bootstrapService");
const { getChanges, getLatestSeq } = centerRequire("./core/changeLog");
const logger = { debug() {}, info() {}, warn() {}, error() {} };

function makeCenter() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db, logger);
  registerDevice(db, { device_id: "source-device" });
  return { dbContext: { db }, config: { maxLimit: 2 }, logger };
}

function topicOperation(operationId, itemId, topicId, extra = {}) {
  return {
    operation_id: operationId, device_id: "source-device", entity_type: "topic",
    action: "upsert", item_type: "agent", item_id: itemId,
    topic_id: topicId, entity_id: topicId,
    payload: { topic: { id: topicId, name: topicId, createdAt: 1, ...extra } },
  };
}

function messageOperation(operationId, itemId, topicId, id, action = "create", content = id) {
  return {
    operation_id: operationId, device_id: "source-device", entity_type: "message",
    action, item_type: "agent", item_id: itemId, topic_id: topicId, entity_id: id,
    base_version: action === "create" ? undefined : 1,
    payload: { id, message: { id, role: "user", content } },
  };
}

function deleteOperation(operationId, itemId, topicId) {
  return {
    operation_id: operationId, device_id: "source-device",
    entity_type: topicId ? "topic" : "item", action: "delete",
    item_type: "agent", item_id: itemId,
    ...(topicId ? { topic_id: topicId } : {}),
    entity_id: topicId || itemId,
    payload: { item_type: "agent", item_id: itemId, ...(topicId ? { topic_id: topicId } : {}) },
  };
}

function apply(db, operation) {
  const result = processOperation(db, operation);
  assert.notStrictEqual(result.ok, false, `${operation.operation_id} was rejected`);
  return result;
}

async function makeAdapter(root, centerClient) {
  const appDataPath = path.join(root, "AppData");
  const syncDir = path.join(appDataPath, "sync");
  const config = {
    appDataPath, syncDir, deviceId: "joining-device",
    indexPath: path.join(syncDir, "local_index.json"),
    lockPath: path.join(syncDir, "write_intents.jsonl"),
    attachmentDir: path.join(appDataPath, "UserData", "attachments"),
  };
  const localIndex = createLocalIndex(config, logger);
  await localIndex.load();
  const savedStates = [];
  return {
    config, localIndex, centerClient, logger, savedStates,
    state: { mode: "uninitialized" },
    writeIntentLock: createWriteIntentLock(config, logger),
    async writeState(state) {
      savedStates.push(JSON.parse(JSON.stringify(state)));
      await fs.writeJson(path.join(syncDir, "state.json"), state);
    },
  };
}

async function adapterContents(adapter) {
  const topics = [];
  const messages = [];
  const agentsRoot = path.join(adapter.config.appDataPath, "Agents");
  if (await fs.pathExists(agentsRoot)) {
    for (const itemId of await fs.readdir(agentsRoot)) {
      const configPath = path.join(agentsRoot, itemId, "config.json");
      if (!(await fs.pathExists(configPath))) continue;
      const config = await fs.readJson(configPath);
      for (const topic of config.topics || []) topics.push(`${itemId}:${topic.id}`);
    }
  }
  const userData = path.join(adapter.config.appDataPath, "UserData");
  if (await fs.pathExists(userData)) {
    for (const itemId of await fs.readdir(userData)) {
      const topicsRoot = path.join(userData, itemId, "topics");
      if (!(await fs.pathExists(topicsRoot))) continue;
      for (const topicId of await fs.readdir(topicsRoot)) {
        const historyPath = path.join(topicsRoot, topicId, "history.json");
        if (!(await fs.pathExists(historyPath))) continue;
        for (const message of await fs.readJson(historyPath)) {
          messages.push({ key: `${itemId}:${topicId}:${message.id}`, content: message.content });
        }
      }
    }
  }
  return {
    topics: topics.sort(),
    messages: messages.sort((left, right) => left.key.localeCompare(right.key)),
  };
}

async function runScenario(root, name, seed, mutate, verify) {
  const center = makeCenter();
  const db = center.dbContext.db;
  try {
    seed(db);
    const pages = [];
    const pulls = [];
    let changed = false;
    const client = {
      async exportBootstrap(options = {}) {
        // The initial transaction returns only two rows of each kind. Mutate
        // before a subsequent message page, while independent topic/config
        // cursors still refer to that initial transaction's replay boundary.
        if (options.kind === "messages" && !changed) {
          changed = true;
          mutate(db);
        }
        const page = exportBaseline(center, options);
        pages.push(page);
        return page;
      },
      async getChanges(afterSeq, limit) {
        const events = getChanges(db, afterSeq, Math.min(Number(limit || 2), 2));
        pulls.push({ afterSeq, events });
        const checkpoint = events.length ? events[events.length - 1].seq : afterSeq;
        return {
          events, checkpoint_seq: checkpoint, next_after_seq: checkpoint,
          latest_seq: getLatestSeq(db), has_more: checkpoint < getLatestSeq(db),
        };
      },
    };
    const adapter = await makeAdapter(path.join(root, name), client);
    const result = await joinExisting(adapter);
    assert.strictEqual(changed, true, `${name}: mutation must occur after the first page`);
    const baselineSeq = pages[0].baseline_seq;
    const replayUntil = Math.max(...pages.map((page) => Number(page.latest_seq)));
    assert(replayUntil > baselineSeq, `${name}: test must contain a nonempty replay window`);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(adapter.state.last_applied_seq, replayUntil, `${name}: cursor must cover the full window`);
    assert.strictEqual(adapter.state.mode, "active");
    assert(pulls.length > 0, `${name}: join must replay before becoming active`);
    assert.strictEqual(pulls[0].afterSeq, baselineSeq);
    for (const state of adapter.savedStates.filter((state) => state.mode === "active")) {
      assert.strictEqual(state.last_applied_seq, replayUntil, `${name}: active state was published too early`);
    }
    const persisted = await fs.readJson(path.join(adapter.config.syncDir, "state.json"));
    assert.strictEqual(persisted.last_applied_seq, replayUntil);

    const actual = await adapterContents(adapter);
    const expectedTopics = db.prepare("SELECT item_id, id FROM topics WHERE deleted = 0").all()
      .map((row) => `${row.item_id}:${row.id}`).sort();
    const expectedMessages = db.prepare("SELECT item_id, topic_id, id, raw_json FROM messages WHERE deleted = 0").all()
      .map((row) => ({ key: `${row.item_id}:${row.topic_id}:${row.id}`, content: JSON.parse(row.raw_json).content }))
      .sort((left, right) => left.key.localeCompare(right.key));
    assert.deepStrictEqual(actual.topics, expectedTopics, `${name}: topic projection differs from Center`);
    assert.deepStrictEqual(actual.messages, expectedMessages, `${name}: message projection differs from Center`);
    await verify({ adapter, pages, pulls, actual, baselineSeq, replayUntil });
  } finally {
    db.close();
  }
}

function seedMessages(db, itemId, topicId, ids) {
  for (const id of ids) apply(db, messageOperation(`seed-${itemId}-${topicId}-${id}`, itemId, topicId, id));
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vchat-bootstrap-replay-window-"));
  try {
    await runScenario(root, "message-update-delete", (db) => {
      apply(db, topicOperation("topic-t1", "a", "t1"));
      seedMessages(db, "a", "t1", ["m1", "m2", "m3", "m4"]);
    }, (db) => {
      apply(db, messageOperation("update-unexported", "a", "t1", "m3", "update", "edited during export"));
      apply(db, messageOperation("delete-unexported", "a", "t1", "m3", "delete"));
    }, async ({ pages, actual, pulls }) => {
      assert(!pages.some((page) => page.baseline.messages.some((message) => message.id === "m3")));
      assert(pulls.flatMap((pull) => pull.events).some((event) => event.action === "update" && event.entity_id === "m3"));
      assert.deepStrictEqual(actual.messages.map((message) => message.key), ["a:t1:m1", "a:t1:m2", "a:t1:m4"]);
    });

    await runScenario(root, "topic-update-delete", (db) => {
      for (const topicId of ["t1", "t2", "t3", "t4"]) apply(db, topicOperation(`topic-${topicId}`, "a", topicId));
      seedMessages(db, "a", "t1", ["m1", "m2"]);
      seedMessages(db, "a", "t3", ["m3"]);
      seedMessages(db, "a", "t4", ["m4"]);
    }, (db) => {
      apply(db, messageOperation("update-before-topic-delete", "a", "t3", "m3", "update", "late edit"));
      apply(db, deleteOperation("delete-unexported-topic", "a", "t3"));
    }, async ({ adapter, pages, actual }) => {
      assert(!pages.some((page) => page.baseline.topics.some((topic) => topic.id === "t3")));
      assert(!pages.some((page) => page.baseline.messages.some((message) => message.id === "m3")));
      assert.deepStrictEqual(actual.topics, ["a:t1", "a:t2", "a:t4"]);
      assert.strictEqual(await fs.pathExists(path.join(adapter.config.appDataPath, "UserData/a/topics/t3")), false);
    });

    await runScenario(root, "item-update-delete", (db) => {
      for (const itemId of ["a", "b", "c", "d"]) apply(db, topicOperation(`topic-${itemId}`, itemId, "t"));
      seedMessages(db, "a", "t", ["m1", "m2"]);
      seedMessages(db, "c", "t", ["m3"]);
      seedMessages(db, "d", "t", ["m4"]);
    }, (db) => {
      apply(db, messageOperation("update-before-item-delete", "c", "t", "m3", "update", "late edit"));
      apply(db, deleteOperation("delete-unexported-item", "c"));
    }, async ({ adapter, pages, actual }) => {
      assert(!pages.some((page) => page.baseline.topics.some((topic) => topic.item_id === "c")));
      assert(!pages.some((page) => page.baseline.messages.some((message) => message.item_id === "c")));
      assert.deepStrictEqual(actual.topics, ["a:t", "b:t", "d:t"]);
      assert.strictEqual(await fs.pathExists(path.join(adapter.config.appDataPath, "Agents/c")), false);
      assert.strictEqual(await fs.pathExists(path.join(adapter.config.appDataPath, "UserData/c")), false);
    });

    await runScenario(root, "topic-inserted-before-cursor", (db) => {
      for (const topicId of ["t0", "t2", "t3", "t4"]) apply(db, topicOperation(`topic-${topicId}`, "a", topicId));
      seedMessages(db, "a", "t0", ["m1", "m2"]);
      seedMessages(db, "a", "t4", ["m4"]);
    }, (db) => {
      apply(db, topicOperation("topic-behind-topic-cursor", "a", "t1", {
        name: "Late topic with full metadata", createdAt: 777,
        locked: false, unread: true, creatorSource: "bootstrap-test",
      }));
      apply(db, messageOperation("message-after-message-cursor", "a", "t1", "m3", "create", "late topic message"));
    }, async ({ adapter, pages, actual }) => {
      assert(!pages.some((page) => page.baseline.topics.some((topic) => topic.id === "t1")));
      assert(pages.some((page) => page.baseline.messages.some((message) => message.topic_id === "t1")));
      assert.deepStrictEqual(actual.topics, ["a:t0", "a:t1", "a:t2", "a:t3", "a:t4"]);
      const config = await fs.readJson(path.join(adapter.config.appDataPath, "Agents/a/config.json"));
      const topic = config.topics.find((topic) => topic.id === "t1");
      assert.strictEqual(topic.name, "Late topic with full metadata");
      assert.strictEqual(topic.createdAt, 777);
      assert.strictEqual(topic.locked, false);
      assert.strictEqual(topic.unread, true);
      assert.strictEqual(topic.creatorSource, "bootstrap-test");
      const history = await fs.readJson(path.join(adapter.config.appDataPath, "UserData/a/topics/t1/history.json"));
      assert.deepStrictEqual(history.map((message) => message.content), ["late topic message"]);
    });
    console.log("bootstrap replay window smoke test passed (4 concurrent pagination scenarios)");
  } finally {
    const resolved = path.resolve(root);
    assert.strictEqual(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert(path.basename(resolved).startsWith("vchat-bootstrap-replay-window-"));
    await fs.remove(resolved);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
