const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { diffHistory } = require("../diff/historyDiffEngine");
const { createLocalIndex } = require("../core/localIndex");
const { createOfflineQueue, readQueueLines } = require("../sync/offlineQueue");

async function main() {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "vchat-sync-missing-message-")
  );
  const config = {
    appDataPath: path.join(tempRoot, "AppData"),
    syncDir: path.join(tempRoot, "AppData", "sync"),
    indexPath: path.join(tempRoot, "AppData", "sync", "local_index.json"),
    queuePath: path.join(tempRoot, "AppData", "sync", "offline_queue.jsonl"),
    lockPath: path.join(tempRoot, "AppData", "sync", "write_intents.jsonl"),
    queueIntervalMs: 25,
  };
  await fs.ensureDir(config.syncDir);
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const localIndex = createLocalIndex(config, logger);
  await localIndex.load();

  const identityBase = {
    item_type: "user",
    item_id: "agent-one",
    topic_id: "topic-one",
  };
  const history = [{ id: "m1", role: "assistant", content: "hello" }];

  await localIndex.setMessage("user:agent-one:topic-one:m1", {
    identity: { ...identityBase, id: "m1" },
    topic_key: "user:agent-one:topic-one",
    last_known_checksum: "old-checksum",
    local_projection_checksum: "old-checksum",
    pending_operation_id: null,
    pending_action: null,
    pending_status: null,
    updated_at: new Date().toISOString(),
  });

  const diff = await diffHistory(identityBase, history, localIndex, {
    deviceId: "pc-a",
  });
  assert.strictEqual(diff.operations.length, 1);
  assert.strictEqual(diff.operations[0].action, "create");
  assert.strictEqual(diff.operations[0].base_version, undefined);

  const centerClient = {
    async submitOperation(operation) {
      if (operation.action === "update") {
        throw new Error("message update target does not exist");
      }
      return { ok: true, seq: 11, version: 1 };
    },
  };
  const offlineQueue = createOfflineQueue(
    config,
    centerClient,
    localIndex,
    logger
  );
  await offlineQueue.start({ modeProvider: () => "active" });
  await localIndex.setMessage("user:agent-one:topic-one:m1", {
    topic_key: "user:agent-one:topic-one",
    last_known_checksum: "next-checksum",
    local_projection_checksum: "next-checksum",
    last_known_server_version: 2,
    pending_operation_id: null,
    pending_action: null,
    pending_status: null,
    updated_at: new Date().toISOString(),
  });
  await offlineQueue.enqueueMany(
    [
      {
        operation_id: "op-update-missing",
        device_id: "pc-a",
        entity_type: "message",
        action: "update",
        item_type: "user",
        item_id: "agent-one",
        topic_id: "topic-one",
        entity_id: "m1",
        base_version: 2,
        payload: {
          item_type: "user",
          item_id: "agent-one",
          topic_id: "topic-one",
          message_id: "m1",
          message: history[0],
          attachments: [],
          local_checksum: "next-checksum",
        },
      },
    ],
    { mode: "active" }
  );

  await new Promise((resolve) => setTimeout(resolve, 30));

  await offlineQueue.processOnce();
  await offlineQueue.stop();
  const rows = await readQueueLines(config.queuePath, logger);

  assert.deepStrictEqual(rows, []);
  const repaired = localIndex.getMessage("user:agent-one:topic-one:m1");
  assert.strictEqual(repaired.last_known_server_version, null);
  assert.strictEqual(repaired.pending_operation_id, null);
  assert.strictEqual(repaired.pending_action, null);
  assert.strictEqual(repaired.pending_status, "needs_create");
  assert.strictEqual(
    repaired.remote_existence_assumption_rollback_reason,
    "message update target does not exist"
  );

  await fs.remove(tempRoot);
  console.log("missing message repair smoke test passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
