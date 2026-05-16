const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { createLocalIndex } = require("../core/localIndex");
const { createWriteIntentLock } = require("../sync/writeIntentLock");
const { projectEvents } = require("../projector/appDataProjector");

async function main() {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "vchat-sync-cycle3-")
  );
  const config = {
    appDataPath: path.join(tempRoot, "AppData"),
    syncDir: path.join(tempRoot, "AppData", "sync"),
    indexPath: path.join(tempRoot, "AppData", "sync", "local_index.json"),
    lockPath: path.join(tempRoot, "AppData", "sync", "write_intents.jsonl"),
    attachmentDir: path.join(tempRoot, "AppData", "UserData", "attachments"),
  };
  await fs.ensureDir(config.syncDir);
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const localIndex = createLocalIndex(config, logger);
  await localIndex.load();
  const writeIntentLock = createWriteIntentLock(config, logger);

  const baseEvent = {
    seq: 1,
    operation_id: "op-create",
    device_id: "pc-a",
    item_type: "user",
    item_id: "agent-one",
    topic_id: "topic-one",
    entity_type: "message",
    entity_id: "m1",
    action: "create",
    version: 1,
    payload: {
      message: { id: "m1", role: "user", content: "hello from pc-a" },
    },
  };
  const createResult = await projectEvents([baseEvent], {
    config,
    localIndex,
    writeIntentLock,
    logger,
  });
  assert.deepStrictEqual(createResult.appliedSeqs, [1]);
  const historyPath = path.join(
    config.appDataPath,
    "UserData",
    "agent-one",
    "topics",
    "topic-one",
    "history.json"
  );
  let history = await fs.readJson(historyPath);
  assert.strictEqual(history.length, 1);
  assert.strictEqual(history[0].content, "hello from pc-a");

  const updateResult = await projectEvents(
    [
      {
        ...baseEvent,
        seq: 2,
        operation_id: "op-update",
        action: "update",
        version: 2,
        payload: { message: { id: "m1", role: "user", content: "edited" } },
      },
    ],
    { config, localIndex, writeIntentLock, logger }
  );
  assert.deepStrictEqual(updateResult.appliedSeqs, [2]);
  history = await fs.readJson(historyPath);
  assert.strictEqual(history.length, 1);
  assert.strictEqual(history[0].content, "edited");

  const deleteResult = await projectEvents(
    [
      {
        ...baseEvent,
        seq: 3,
        operation_id: "op-delete",
        action: "delete",
        version: 2,
        payload: { id: "m1", deleted_at: new Date().toISOString() },
      },
    ],
    { config, localIndex, writeIntentLock, logger }
  );
  assert.deepStrictEqual(deleteResult.appliedSeqs, [3]);
  history = await fs.readJson(historyPath);
  assert.strictEqual(history.length, 0);

  const settingsResult = await projectEvents(
    [
      {
        seq: 4,
        operation_id: "op-settings",
        entity_type: "settings",
        entity_id: "settings.json",
        action: "update",
        version: 1,
        payload: {
          entity_id: "settings.json",
          relative_path: "settings.json",
          safe_projection_json: { displayName: "synced-user" },
        },
      },
    ],
    { config, localIndex, writeIntentLock, logger }
  );
  assert.deepStrictEqual(settingsResult.appliedSeqs, [4]);
  const settings = await fs.readJson(path.join(config.appDataPath, "settings.json"));
  assert.deepStrictEqual(settings, { displayName: "synced-user" });

  const unsupportedResult = await projectEvents(
    [
      {
        ...baseEvent,
        seq: 5,
        entity_type: "unknown_entity",
        action: "update",
        payload: { value: true },
      },
    ],
    { config, localIndex, writeIntentLock, logger }
  );
  assert(
    unsupportedResult.error,
    "unknown event should block cursor advancement"
  );
  assert.strictEqual(unsupportedResult.failedSeq, 5);
  assert.deepStrictEqual(unsupportedResult.appliedSeqs, []);

  await fs.remove(tempRoot);
  console.log("cycle3/cycle4 projector smoke test passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
