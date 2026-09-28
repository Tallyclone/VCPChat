const assert = require("assert");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const { createRequire } = require("module");
const { createLocalIndex } = require("../core/localIndex");
const { createWriteIntentLock } = require("../sync/writeIntentLock");
const { joinExisting, exportCompleteBootstrap } = require("../sync/bootstrapManager");

const centerRoot = process.env.VCHAT_SYNC_TEST_CENTER_ROOT ||
  path.resolve(__dirname, "../../../../../VCPToolBox/Plugin/VChatSyncCenter");
const centerRequire = createRequire(path.join(centerRoot, "index.js"));
const Database = centerRequire("better-sqlite3");
const { runMigrations } = centerRequire("./core/migrations");
const { processOperation, registerDevice } = centerRequire("./core/operationProcessor");
const { exportBaseline } = centerRequire("./core/bootstrapService");
const { getChanges } = centerRequire("./core/changeLog");
const { checksumConfigDto } = centerRequire("./core/configService");
const logger = { debug() {}, info() {}, warn() {}, error() {} };

function makeCenter() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db, logger);
  registerDevice(db, { device_id: "source-device" });
  return { dbContext: { db }, config: { maxLimit: 2 }, logger };
}

function configOperation(id, profile, dto, fields, deletedFields = []) {
  return {
    operation_id: id,
    device_id: "source-device",
    entity_type: "agent_config",
    entity_id: "Agents/a/config.json",
    action: "update",
    payload: {
      dto_version: 1,
      schema: "agent_config",
      entity_id: "Agents/a/config.json",
      profile,
      projection_fields: fields,
      deleted_fields: deletedFields,
      safe_projection_json: dto,
    },
  };
}

function topicOperation(id, topicId) {
  return {
    operation_id: id, device_id: "source-device", entity_type: "topic",
    action: "upsert", item_type: "agent", item_id: "a", topic_id: topicId,
    entity_id: topicId, payload: { topic: { id: topicId, name: topicId, createdAt: 1 } },
  };
}

function messageOperation(operationId, id, action, content, order) {
  return {
    operation_id: operationId, device_id: "source-device", entity_type: "message",
    action, item_type: "agent", item_id: "a", topic_id: "t1", entity_id: id,
    base_version: action === "create" ? undefined : 1,
    payload: { id, message: { id, role: "user", content }, local_order: order },
  };
}

async function makeAdapter(tempRoot, centerClient) {
  const appDataPath = path.join(tempRoot, "AppData");
  const syncDir = path.join(appDataPath, "sync");
  const config = {
    appDataPath, syncDir, deviceId: "joining-device",
    indexPath: path.join(syncDir, "local_index.json"),
    lockPath: path.join(syncDir, "write_intents.jsonl"),
    attachmentDir: path.join(appDataPath, "UserData", "attachments"),
  };
  await fs.ensureDir(syncDir);
  const localIndex = createLocalIndex(config, logger);
  await localIndex.load();
  return {
    config, localIndex, centerClient, logger, state: { mode: "uninitialized" },
    writeIntentLock: createWriteIntentLock(config, logger),
    async writeState(state) { await fs.writeJson(path.join(syncDir, "state.json"), state); },
  };
}

async function testConfigSnapshot(tempRoot) {
  const center = makeCenter();
  const db = center.dbContext.db;
  try {
    processOperation(db, configOperation("base", "bootstrap", {
      name: "Old name", systemPrompt: "Old prompt",
      advancedSystemPrompt: { hiddenBlocks: { old: true }, viewMode: "cards" },
    }, ["name", "systemPrompt", "advancedSystemPrompt"]));
    processOperation(db, configOperation("prompt", "runtime", { systemPrompt: "New prompt" }, ["systemPrompt"]));
    processOperation(db, configOperation("name", "runtime", { name: "New name" }, ["name"]));
    processOperation(db, configOperation("delete-field", "runtime", {},
      ["advancedSystemPrompt.hiddenBlocks"], ["advancedSystemPrompt.hiddenBlocks"]));

    const client = { async exportBootstrap(options) { return exportBaseline(center, options); } };
    const adapter = await makeAdapter(path.join(tempRoot, "config-join"), client);
    const joined = await joinExisting(adapter);
    assert.strictEqual(joined.ok, true);
    const config = await fs.readJson(path.join(adapter.config.appDataPath, "Agents/a/config.json"));
    assert.strictEqual(config.name, "New name");
    assert.strictEqual(config.systemPrompt, "New prompt");
    assert.deepStrictEqual(config.advancedSystemPrompt, { viewMode: "cards" });
    const rows = exportBaseline(center, { kind: "configs" }).baseline.configs;
    for (const row of rows) assert.strictEqual(row.checksum, checksumConfigDto(row));
    assert.deepStrictEqual(rows.find((row) => row.profile === "runtime").deleted_fields,
      ["advancedSystemPrompt.hiddenBlocks"]);
  } finally {
    db.close();
  }
}

async function testConcurrentPagination(tempRoot) {
  const center = makeCenter();
  const db = center.dbContext.db;
  try {
    processOperation(db, configOperation("base", "bootstrap", { name: "Agent", topics: [] }, ["name", "topics"]));
    for (const id of ["t1", "t2", "t3"]) processOperation(db, topicOperation(`topic-${id}`, id));
    for (let i = 1; i <= 4; i += 1) {
      processOperation(db, messageOperation(`create-${i}`, `m${i}`, "create", `message-${i}`, 50 - i * 10));
    }
    let initialSeq;
    let changed = false;
    const client = {
      async exportBootstrap(options = {}) {
        if (options.kind === "messages" && !changed) {
          changed = true;
          processOperation(db, messageOperation("delete-first", "m1", "delete", "", 40));
          processOperation(db, messageOperation("insert-before-cursor", "m0", "create", "late message", 50));
          processOperation(db, messageOperation("update-later-page", "m4", "update", "edited during export", 10));
          processOperation(db, {
            operation_id: "reorder-topic", device_id: "source-device", entity_type: "topic_order",
            action: "move", item_type: "agent", item_id: "a", topic_id: "t3", entity_id: "a",
            payload: { mode: "move_to_front" },
          });
        }
        const result = exportBaseline(center, options);
        if (!options.kind) initialSeq = result.latest_seq;
        return result;
      },
      async getChanges(afterSeq, limit) {
        return { events: getChanges(db, afterSeq, limit) };
      },
    };
    const adapter = await makeAdapter(path.join(tempRoot, "concurrent-join"), client);
    const joined = await joinExisting(adapter);
    assert(adapter.state.last_applied_seq > initialSeq);
    assert.strictEqual(joined.catchup.applied, getChanges(db, initialSeq, 1000).length);
    const historyPath = path.join(adapter.config.appDataPath, "UserData/a/topics/t1/history.json");
    const history = await fs.readJson(historyPath);
    assert.deepStrictEqual(history.map((row) => row.id), ["m4", "m3", "m2", "m0"]);
    assert.strictEqual(history[0].content, "edited during export");
    assert.strictEqual(adapter.localIndex.getMessage("agent:a:t1:m3").last_applied_seq,
      db.prepare("SELECT server_seq FROM messages WHERE id = 'm3'").get().server_seq);
    const config = await fs.readJson(path.join(adapter.config.appDataPath, "Agents/a/config.json"));
    assert.deepStrictEqual(config.topics.map((row) => row.id).sort(), ["t1", "t2", "t3"]);
    assert.strictEqual(config.topics[0].id, "t3");

    const first = exportBaseline(center, { kind: "messages", limit: 1 });
    assert.strictEqual(typeof first.page.messages.next_cursor, "string");
    assert.throws(() => exportBaseline(center, { kind: "topics", cursor: first.page.messages.next_cursor }), /invalid bootstrap cursor/);
    assert.throws(() => exportBaseline(center, { kind: "messages", cursor: 1 }), /restart the baseline export/);
    await assert.rejects(() => exportCompleteBootstrap({
      async exportBootstrap(options = {}) {
        if (!options.kind) return first;
        return { ...exportBaseline(center, options), baseline_seq: initialSeq + 1000 };
      },
    }), /replay boundary changed/);
  } finally {
    db.close();
  }
}

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vchat-bootstrap-roundtrip-"));
  try {
    await testConfigSnapshot(tempRoot);
    await testConcurrentPagination(tempRoot);
    console.log("bootstrap snapshot and concurrent pagination round trip passed");
  } finally {
    const resolved = path.resolve(tempRoot);
    assert.strictEqual(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert(path.basename(resolved).startsWith("vchat-bootstrap-roundtrip-"));
    await fs.remove(resolved);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
