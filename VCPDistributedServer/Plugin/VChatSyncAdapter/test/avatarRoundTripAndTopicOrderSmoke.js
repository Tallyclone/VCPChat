const assert = require("assert");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const { createRequire } = require("module");
const { checksumBuffer } = require("../core/hash");
const { createLocalIndex } = require("../core/localIndex");
const { uploadLocalAttachment } = require("../sync/attachmentSync");
const { buildTopicOrderMoveOperations, applyMoveToOrder } = require("../diff/configDiffEngine");

const centerRoot = process.env.VCHAT_SYNC_TEST_CENTER_ROOT ||
  path.resolve(__dirname, "../../../../../VCPToolBox/Plugin/VChatSyncCenter");
const centerRequire = createRequire(path.join(centerRoot, "index.js"));
const Database = centerRequire("better-sqlite3");
const { runMigrations } = centerRequire("./core/migrations");
const { processOperation, registerDevice } = centerRequire("./core/operationProcessor");
const { getAvatar } = centerRequire("./core/avatarService");
const { ensureDatabase } = centerRequire("./core/db");
const { upsertAttachment } = centerRequire("./core/attachmentStore");

const logger = { debug() {}, info() {}, warn() {}, error() {} };

// Issue 8: avatar A -> B -> A. The third change must reach Center.
async function testAvatarRoundTrip(root) {
  const centerConfig = {
    dbPath: path.join(root, "center", "center.db"),
    attachmentDir: path.join(root, "center", "attachments"),
    backupDir: path.join(root, "center", "backups"),
    maxLimit: 5000,
  };
  const dbContext = ensureDatabase(centerConfig, logger);
  const runtime = { config: centerConfig, logger, dbContext };
  registerDevice(dbContext.db, { device_id: "device-a" });
  try {
    const config = {
      appDataPath: path.join(root, "AppData"),
      syncDir: path.join(root, "AppData", "sync"),
      indexPath: path.join(root, "AppData", "sync", "local_index.json"),
      deviceId: "device-a",
    };
    await fs.ensureDir(config.syncDir);
    const localIndex = createLocalIndex(config, logger);
    await localIndex.load();
    const submitted = [];
    const centerClient = {
      async uploadAttachment(payload) {
        return upsertAttachment(runtime, {
          buffer: Buffer.from(payload.content_base64, "base64"),
          hash: payload.hash, ext: payload.ext, device_id: payload.device_id,
          operation_id: payload.operation_id,
        });
      },
      async submitOperation(operation) {
        submitted.push(operation);
        return processOperation(dbContext.db, operation);
      },
    };
    const relativePath = "Agents/agent-one/avatar.png";
    const absolutePath = path.join(config.appDataPath, relativePath);
    const contentA = Buffer.from("avatar-A");
    const contentB = Buffer.from("avatar-B");
    for (const content of [contentA, contentB, contentA]) {
      await fs.outputFile(absolutePath, content);
      await uploadLocalAttachment(relativePath, absolutePath, localIndex, centerClient, config);
    }
    assert.strictEqual(submitted.length, 3);
    assert.notStrictEqual(submitted[0].operation_id, submitted[2].operation_id,
      "restoring the first avatar is a new modification and needs its own ID");
    const centerAvatar = getAvatar(dbContext.db, "agent", "agent-one");
    assert.strictEqual(centerAvatar.hash, checksumBuffer(contentA));
    assert.strictEqual(centerAvatar.version, 3);
    const indexed = localIndex.getFile(relativePath);
    assert.strictEqual(indexed.avatar_operation_hash, checksumBuffer(contentA));
    assert.strictEqual(indexed.avatar_pending_operation_id, undefined);

    // A retry of the same not-yet-confirmed change reuses its ID.
    const failing = {
      ...centerClient,
      async submitOperation() { throw new Error("connection lost"); },
    };
    await fs.outputFile(absolutePath, contentB);
    await assert.rejects(() => uploadLocalAttachment(relativePath, absolutePath, localIndex, failing, config), /connection lost/);
    const pendingId = localIndex.getFile(relativePath).avatar_pending_operation_id;
    assert(pendingId, "pending ID must be persisted before the request");
    await uploadLocalAttachment(relativePath, absolutePath, localIndex, centerClient, config);
    assert.strictEqual(submitted[3].operation_id, pendingId);
    assert.strictEqual(getAvatar(dbContext.db, "agent", "agent-one").hash, checksumBuffer(contentB));
  } finally {
    dbContext.db.close();
  }
}

// Issue 9: every permutation of 3..5 topics must replay to the target order
// through the real Center move semantics.
function replayThroughCenter(db, owner, previousOrder, operations) {
  const itemId = owner.item_id;
  previousOrder.forEach((topicId, index) => {
    processOperation(db, {
      operation_id: `seed-${itemId}-${topicId}`, device_id: "device-a",
      entity_type: "topic", entity_id: topicId, action: "upsert",
      item_type: owner.item_type, item_id: itemId, topic_id: topicId,
      payload: { topic: { id: topicId, name: topicId } },
    });
    // applyTopicUpsert assigns front ranks; force the seed order explicitly.
    db.prepare("UPDATE topics SET order_rank = ? WHERE item_type = ? AND item_id = ? AND id = ?")
      .run(index * 1000000000, owner.item_type, itemId, topicId);
  });
  for (const operation of operations) {
    const result = processOperation(db, operation);
    assert.strictEqual(result.ok, true);
  }
  return db.prepare(
    "SELECT id FROM topics WHERE item_type = ? AND item_id = ? AND deleted = 0 ORDER BY order_rank ASC, created_at ASC, id ASC"
  ).all(owner.item_type, itemId).map((row) => row.id);
}

function permutations(items) {
  if (items.length <= 1) return [items];
  const out = [];
  items.forEach((item, index) => {
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    for (const perm of permutations(rest)) out.push([item, ...perm]);
  });
  return out;
}

function testTopicOrderPermutations() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db, logger);
  registerDevice(db, { device_id: "device-a" });
  let owners = 0;
  let checked = 0;
  try {
    for (const size of [3, 4, 5]) {
      const base = ["a", "b", "c", "d", "e"].slice(0, size);
      for (const target of permutations(base)) {
        owners += 1;
        const owner = { item_type: "agent", item_id: `owner-${owners}` };
        const operations = buildTopicOrderMoveOperations(owner, base, target, { deviceId: "device-a" });
        // Simulated replay agrees with the target.
        let simulated = [...base];
        for (const operation of operations) {
          simulated = applyMoveToOrder(simulated, operation.topic_id, operation.payload);
        }
        assert.deepStrictEqual(simulated, target, `simulation ${base} -> ${target}`);
        // Real Center replay agrees with the target.
        const replayed = replayThroughCenter(db, owner, base, operations);
        assert.deepStrictEqual(replayed, target, `center ${base} -> ${target}`);
        checked += 1;
      }
    }
    // The review's example.
    const owner = { item_type: "agent", item_id: "example" };
    const example = buildTopicOrderMoveOperations(owner, ["a", "b", "c", "d", "e"], ["d", "e", "c", "b", "a"], { deviceId: "device-a" });
    assert.deepStrictEqual(
      replayThroughCenter(db, owner, ["a", "b", "c", "d", "e"], example),
      ["d", "e", "c", "b", "a"]
    );
  } finally {
    db.close();
  }
  assert.strictEqual(checked, 6 + 24 + 120);
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vchat-avatar-order-"));
  try {
    await testAvatarRoundTrip(root);
    testTopicOrderPermutations();
    console.log("avatar round trip and topic order permutation smoke test passed");
  } finally {
    assert.strictEqual(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    await fs.remove(root);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
