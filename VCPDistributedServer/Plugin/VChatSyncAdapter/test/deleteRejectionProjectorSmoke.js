const assert = require("assert");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const { createLocalIndex } = require("../core/localIndex");
const { createWriteIntentLock } = require("../sync/writeIntentLock");
const { projectEvents } = require("../projector/appDataProjector");
const { createPullLoop } = require("../sync/pullLoop");

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const messageEvent = (seq, action, extra = {}) => ({
  seq, operation_id: `rejected-${seq}`, device_id: "remote-device",
  item_type: "agent", item_id: "agent-a", topic_id: "topic-a",
  entity_type: "message", entity_id: "m1", action,
  payload: {
    message: { id: "m1", role: "user", content: "offline edit" },
    deleted: true, conflict: true, reason: "topic_deleted",
  },
  ...extra,
});

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vchat-delete-rejection-"));
  const config = {
    appDataPath: path.join(root, "AppData"),
    syncDir: path.join(root, "AppData", "sync"),
    indexPath: path.join(root, "AppData", "sync", "local_index.json"),
    lockPath: path.join(root, "AppData", "sync", "write_intents.jsonl"),
    statePath: path.join(root, "AppData", "sync", "state.json"),
    deviceId: "local-device",
  };
  let loop;
  try {
    const localIndex = createLocalIndex(config, logger);
    await localIndex.load();
    const writeIntentLock = createWriteIntentLock(config, logger);
    const context = { config, localIndex, writeIntentLock, logger };
    const ownerConfig = path.join(config.appDataPath, "Agents", "agent-a", "config.json");
    const historyPath = path.join(config.appDataPath, "UserData", "agent-a", "topics", "topic-a", "history.json");

    // A normal Center delete followed by another device's rejected create
    // must not poison the cursor or reconstruct the deleted directories.
    await fs.outputJson(ownerConfig, { name: "Agent", topics: [{ id: "topic-a", name: "Old topic" }] });
    await fs.outputJson(historyPath, [{ id: "m1", role: "user", content: "old" }]);
    await fs.outputJson(config.statePath, { mode: "active", last_applied_seq: 0 });
    const events = [
      messageEvent(1, "delete", { entity_type: "topic", entity_id: "topic-a", payload: {} }),
      messageEvent(2, "create_rejected_deleted"),
      messageEvent(3, "upsert", {
        entity_type: "topic", entity_id: "unrelated", topic_id: "unrelated",
        payload: { topic: { id: "unrelated", name: "Later topic" } },
      }),
    ];
    const requested = [];
    const centerClient = {
      isConfigured: () => true,
      connectLatestSeq: () => ({ close() {} }),
      async getChanges(afterSeq) {
        requested.push(afterSeq);
        return { events: events.filter((event) => event.seq > afterSeq), checkpoint_seq: 3, has_more: false };
      },
    };
    loop = createPullLoop(config, centerClient, localIndex, writeIntentLock, logger);
    await loop.start();
    const pulled = await loop.pullOnce("delete-rejection-test");
    await loop.stop();
    assert.strictEqual(pulled.last_applied_seq, 3);
    assert.strictEqual((await fs.readJson(config.statePath)).last_applied_seq, 3);
    assert.strictEqual(loop.stats().blocked_seq, null);
    assert.strictEqual(await fs.pathExists(path.dirname(historyPath)), false);
    assert.deepStrictEqual((await fs.readJson(ownerConfig)).topics.map((topic) => topic.id), ["unrelated"]);

    // Missing owner config and missing history are a successful no-op for
    // message deletions, including rejected updates and ordinary deletes.
    for (const action of ["create_rejected_deleted", "update_rejected_deleted", "delete"]) {
      const result = await projectEvents([messageEvent(10, action, { item_id: "missing-agent" })], context);
      assert.deepStrictEqual(result.appliedSeqs, [10]);
      assert.strictEqual(result.error, undefined);
      assert.strictEqual(await fs.pathExists(path.join(config.appDataPath, "Agents", "missing-agent")), false);
      assert.strictEqual(await fs.pathExists(path.join(config.appDataPath, "UserData", "missing-agent")), false);
    }

    // If stale message data remains under a missing topic, remove the target
    // without requiring or synthesizing topic metadata.
    await fs.outputJson(historyPath, [{ id: "m1", role: "user", content: "stale" }]);
    const stale = await projectEvents([messageEvent(20, "update_rejected_deleted")], context);
    assert.deepStrictEqual(stale.appliedSeqs, [20]);
    assert.deepStrictEqual(await fs.readJson(historyPath), []);
    assert.deepStrictEqual((await fs.readJson(ownerConfig)).topics.map((topic) => topic.id), ["unrelated"]);

    // Topic/config rejected creates use deletion semantics as well.
    const rejectedTopic = messageEvent(21, "upsert_rejected_deleted", {
      entity_type: "topic", entity_id: "topic-a",
    });
    assert.deepStrictEqual((await projectEvents([rejectedTopic], context)).appliedSeqs, [21]);
    assert.strictEqual(await fs.pathExists(path.dirname(historyPath)), false);
    assert.deepStrictEqual((await projectEvents([rejectedTopic], context)).appliedSeqs, [21]);
    const configRejection = messageEvent(22, "create_rejected_deleted", {
      entity_type: "agent_config", entity_id: "Agents/agent-a/config.json",
      payload: { schema: "agent_config", deleted: true, conflict: true },
    });
    assert.deepStrictEqual((await projectEvents([configRejection], context)).appliedSeqs, [22]);
    assert.strictEqual(await fs.pathExists(ownerConfig), false);

    // Ordinary creates still require the parent; the fix must not silently
    // consume unrelated invalid events as deletion confirmations.
    const invalid = await projectEvents([messageEvent(23, "create", {
      payload: { message: { id: "m1", role: "user", content: "real create" } },
    })], context);
    assert.strictEqual(invalid.failedSeq, 23);
    assert.match(invalid.error.message, /message parent topic missing/);
    assert.strictEqual(await fs.pathExists(path.dirname(historyPath)), false);
    console.log("delete rejection projector smoke test passed");
  } finally {
    if (loop) await loop.stop();
    assert.strictEqual(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith("vchat-delete-rejection-"));
    await fs.remove(root);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
