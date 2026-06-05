const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { checksumBuffer } = require("../core/hash");
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
          safe_projection_json: {
            userName: "synced-user",
            userAvatarUrl: "assets/synced-avatar.png",
          },
          projection_fields: ["userName", "userAvatarUrl"],
          profile: "runtime",
        },
      },
    ],
    { config, localIndex, writeIntentLock, logger }
  );
  assert.deepStrictEqual(settingsResult.appliedSeqs, [4]);
  const settings = await fs.readJson(
    path.join(config.appDataPath, "settings.json")
  );
  assert.deepStrictEqual(settings, {
    userName: "synced-user",
    userAvatarUrl: "assets/synced-avatar.png",
  });

  const createAgainResult = await projectEvents(
    [
      {
        ...baseEvent,
        seq: 5,
        operation_id: "op-create-again",
        entity_id: "m2",
        action: "create",
        version: 1,
        payload: { message: { id: "m2", role: "user", content: "to reject" } },
      },
    ],
    { config, localIndex, writeIntentLock, logger }
  );
  assert.deepStrictEqual(createAgainResult.appliedSeqs, [5]);
  const rejectDeletedResult = await projectEvents(
    [
      {
        ...baseEvent,
        seq: 6,
        operation_id: "op-create-rejected-deleted",
        entity_id: "m2",
        action: "create_rejected_deleted",
        version: 1,
        payload: { id: "m2", deleted_at: new Date().toISOString() },
      },
    ],
    { config, localIndex, writeIntentLock, logger }
  );
  assert.deepStrictEqual(rejectDeletedResult.appliedSeqs, [6]);
  history = await fs.readJson(historyPath);
  assert.strictEqual(
    history.some((message) => message.id === "m2"),
    false
  );

  const topicDeleteResult = await projectEvents(
    [
      {
        seq: 7,
        operation_id: "op-topic-delete",
        entity_type: "topic",
        entity_id: "topic-one",
        action: "delete",
        item_type: "user",
        item_id: "agent-one",
        topic_id: "topic-one",
        payload: { deleted_at: new Date().toISOString() },
      },
    ],
    { config, localIndex, writeIntentLock, logger }
  );
  assert.deepStrictEqual(topicDeleteResult.appliedSeqs, [7]);
  assert.strictEqual(await fs.pathExists(path.dirname(historyPath)), false);
  assert.strictEqual(
    localIndex.getTopicSnapshot("user:agent-one:topic-one"),
    null
  );

  const agentConfigPath = path.join(
    config.appDataPath,
    "Agents",
    "agent-one",
    "config.json"
  );
  await fs.outputJson(agentConfigPath, { name: "agent-one" });
  await localIndex.setFile("Agents/agent-one/config.json", { kind: "config" });
  const agentConfigDeleteResult = await projectEvents(
    [
      {
        seq: 8,
        operation_id: "op-agent-config-delete",
        entity_type: "agent_config",
        entity_id: "agent-one",
        action: "delete",
        payload: { schema: "agent_config", entity_id: "agent-one" },
      },
    ],
    { config, localIndex, writeIntentLock, logger }
  );
  assert.deepStrictEqual(agentConfigDeleteResult.appliedSeqs, [8]);
  assert.strictEqual(await fs.pathExists(agentConfigPath), false);
  assert.strictEqual(localIndex.getFile("Agents/agent-one/config.json"), null);

  const groupConfigPath = path.join(
    config.appDataPath,
    "AgentGroups",
    "group-one",
    "config.json"
  );
  await fs.outputJson(groupConfigPath, { name: "group-one" });
  await localIndex.setFile("AgentGroups/group-one/config.json", {
    kind: "config",
  });
  const groupConfigDeleteResult = await projectEvents(
    [
      {
        seq: 9,
        operation_id: "op-group-config-delete",
        entity_type: "group_config",
        entity_id: "group-one",
        action: "delete",
        payload: { schema: "group_config", entity_id: "group-one" },
      },
    ],
    { config, localIndex, writeIntentLock, logger }
  );
  assert.deepStrictEqual(groupConfigDeleteResult.appliedSeqs, [9]);
  assert.strictEqual(await fs.pathExists(groupConfigPath), false);
  assert.strictEqual(
    localIndex.getFile("AgentGroups/group-one/config.json"),
    null
  );

  const itemHistoryPath = path.join(
    config.appDataPath,
    "UserData",
    "agent-delete-me",
    "topics",
    "topic-z",
    "history.json"
  );
  const itemConfigPath = path.join(
    config.appDataPath,
    "Agents",
    "agent-delete-me",
    "config.json"
  );
  await fs.outputJson(itemHistoryPath, [{ id: "z1", content: "remove" }]);
  await fs.outputJson(itemConfigPath, { name: "remove agent" });
  await localIndex.setMessage("agent:agent-delete-me:topic-z:z1", {
    identity: {
      item_type: "agent",
      item_id: "agent-delete-me",
      topic_id: "topic-z",
      id: "z1",
    },
    topic_key: "agent:agent-delete-me:topic-z",
  });
  await localIndex.setTopicSnapshot("agent:agent-delete-me:topic-z", {
    topic_key: "agent:agent-delete-me:topic-z",
  });
  await localIndex.setFile("Agents/agent-delete-me/config.json", {
    kind: "config",
  });
  const itemDeleteResult = await projectEvents(
    [
      {
        seq: 10,
        operation_id: "op-item-delete",
        entity_type: "item",
        entity_id: "agent-delete-me",
        action: "delete",
        item_type: "agent",
        item_id: "agent-delete-me",
        payload: { deleted_at: new Date().toISOString() },
      },
    ],
    { config, localIndex, writeIntentLock, logger }
  );
  assert.deepStrictEqual(itemDeleteResult.appliedSeqs, [10]);
  assert.strictEqual(await fs.pathExists(itemHistoryPath), false);
  assert.strictEqual(await fs.pathExists(itemConfigPath), false);
  assert.strictEqual(
    localIndex.getMessage("agent:agent-delete-me:topic-z:z1"),
    null
  );
  assert.strictEqual(
    localIndex.getTopicSnapshot("agent:agent-delete-me:topic-z"),
    null
  );

  const missingDeleteResult = await projectEvents(
    [
      {
        seq: 11,
        operation_id: "op-missing-topic-delete",
        entity_type: "topic",
        entity_id: "missing-topic",
        action: "delete",
        item_type: "agent",
        item_id: "missing-agent",
        topic_id: "missing-topic",
        payload: { deleted_at: new Date().toISOString() },
      },
    ],
    { config, localIndex, writeIntentLock, logger }
  );
  assert.deepStrictEqual(missingDeleteResult.appliedSeqs, [11]);

  const configTraversalResult = await projectEvents(
    [
      {
        seq: 12,
        operation_id: "op-config-delete-traversal",
        entity_type: "settings",
        entity_id: "../outside.json",
        action: "delete",
        payload: { relative_path: "../outside.json" },
      },
    ],
    { config, localIndex, writeIntentLock, logger }
  );
  assert(configTraversalResult.error, "config path traversal should fail");
  assert.strictEqual(configTraversalResult.failedSeq, 12);
  assert.deepStrictEqual(configTraversalResult.appliedSeqs, []);

  const itemTraversalResult = await projectEvents(
    [
      {
        seq: 13,
        operation_id: "op-item-delete-traversal",
        entity_type: "item",
        entity_id: "../outside-agent",
        action: "delete",
        item_type: "agent",
        item_id: "../outside-agent",
        payload: { deleted_at: new Date().toISOString() },
      },
    ],
    { config, localIndex, writeIntentLock, logger }
  );
  assert(itemTraversalResult.error, "item config path traversal should fail");
  assert.strictEqual(itemTraversalResult.failedSeq, 13);
  assert.deepStrictEqual(itemTraversalResult.appliedSeqs, []);

  const attachmentBuffer = Buffer.from("remote attachment payload", "utf8");
  const attachmentHash = checksumBuffer(attachmentBuffer);
  const attachmentMessageResult = await projectEvents(
    [
      {
        ...baseEvent,
        seq: 14,
        operation_id: "op-attachment-header-ext",
        entity_id: "m-attachment",
        action: "create",
        payload: {
          message: {
            id: "m-attachment",
            role: "assistant",
            content: "file",
            attachments: [
              {
                hash: attachmentHash,
                internalPath: "C:/source/no-extension",
              },
            ],
          },
        },
      },
    ],
    {
      config,
      localIndex,
      writeIntentLock,
      logger,
      centerClient: {
        async downloadAttachment(hash) {
          assert.strictEqual(hash, attachmentHash);
          return {
            buffer: attachmentBuffer,
            headers: { "x-vchat-attachment-ext": ".PNG" },
          };
        },
      },
    }
  );
  assert.deepStrictEqual(attachmentMessageResult.appliedSeqs, [14]);
  const attachmentTarget = path.join(
    config.attachmentDir,
    `${attachmentHash}.png`
  );
  assert.strictEqual(await fs.pathExists(attachmentTarget), true);
  const attachmentHistory = await fs.readJson(historyPath);
  const projectedAttachment = attachmentHistory.find(
    (message) => message.id === "m-attachment"
  ).attachments[0];
  assert.strictEqual(projectedAttachment.internalPath, attachmentTarget);
  assert.strictEqual(
    localIndex.getFile(`UserData/attachments/${attachmentHash}.png`).ext,
    ".png"
  );

  const legacyBuffer = Buffer.from("legacy attachment payload", "utf8");
  const legacyHash = checksumBuffer(legacyBuffer);
  await localIndex.setFile(`remote_attachment:${legacyHash}`, {
    kind: "attachment_remote",
    hash: legacyHash,
    ext: ".jpg",
  });
  const legacyBarePath = path.join(config.attachmentDir, legacyHash);
  await fs.outputFile(legacyBarePath, legacyBuffer);
  const legacyMessageResult = await projectEvents(
    [
      {
        ...baseEvent,
        seq: 15,
        operation_id: "op-attachment-indexed-ext-migrate",
        entity_id: "m-legacy-attachment",
        action: "create",
        payload: {
          message: {
            id: "m-legacy-attachment",
            role: "assistant",
            content: "legacy file",
            files: [
              {
                hash: legacyHash,
                src: "C:/source/legacy-no-extension",
              },
            ],
          },
        },
      },
    ],
    {
      config,
      localIndex,
      writeIntentLock,
      logger,
      centerClient: {
        async downloadAttachment() {
          throw new Error(
            "existing indexed attachment should not be downloaded"
          );
        },
      },
    }
  );
  assert.deepStrictEqual(legacyMessageResult.appliedSeqs, [15]);
  const legacyTarget = path.join(config.attachmentDir, `${legacyHash}.jpg`);
  assert.strictEqual(await fs.pathExists(legacyTarget), true);
  const legacyHistory = await fs.readJson(historyPath);
  const projectedLegacy = legacyHistory.find(
    (message) => message.id === "m-legacy-attachment"
  ).files[0];
  assert.strictEqual(projectedLegacy.src, legacyTarget);
  assert.strictEqual(
    localIndex.getFile(`UserData/attachments/${legacyHash}.jpg`).ext,
    ".jpg"
  );

  const topicConfigPath = path.join(
    config.appDataPath,
    "Agents",
    "topic-agent",
    "config.json"
  );
  await fs.outputJson(topicConfigPath, {
    name: "topic-agent",
    topics: [
      { id: "topic-a", name: "A", createdAt: 1000, deepMemoFlag: "keep-a" },
      { id: "topic-b", name: "B", createdAt: 900, deepMemoFlag: "keep-b" },
      { id: "topic-c", name: "C", createdAt: 800, deepMemoFlag: "keep-c" },
    ],
  });

  const topicUpsertResult = await projectEvents(
    [
      {
        seq: 16,
        operation_id: "op-topic-upsert-preserve-fields",
        entity_type: "topic",
        entity_id: "topic-b",
        action: "upsert",
        item_type: "agent",
        item_id: "topic-agent",
        topic_id: "topic-b",
        payload: {
          topic: { id: "topic-b", name: "B2", customNewField: "new" },
        },
      },
    ],
    { config, localIndex, writeIntentLock, logger }
  );
  assert.deepStrictEqual(topicUpsertResult.appliedSeqs, [16]);
  let topicConfig = await fs.readJson(topicConfigPath);
  assert.deepStrictEqual(
    topicConfig.topics.map((topic) => topic.id),
    ["topic-a", "topic-b", "topic-c"]
  );
  const updatedTopicB = topicConfig.topics.find(
    (topic) => topic.id === "topic-b"
  );
  assert.strictEqual(updatedTopicB.name, "B2");
  assert.strictEqual(updatedTopicB.deepMemoFlag, "keep-b");
  assert.strictEqual(updatedTopicB.customNewField, "new");

  const topicMoveResult = await projectEvents(
    [
      {
        seq: 17,
        operation_id: "op-topic-order-move-after",
        entity_type: "topic_order",
        entity_id: "topic-agent",
        action: "move",
        item_type: "agent",
        item_id: "topic-agent",
        topic_id: "topic-a",
        payload: { mode: "move_after", after_topic_id: "topic-c" },
      },
    ],
    { config, localIndex, writeIntentLock, logger }
  );
  assert.deepStrictEqual(topicMoveResult.appliedSeqs, [17]);
  topicConfig = await fs.readJson(topicConfigPath);
  assert.deepStrictEqual(
    topicConfig.topics.map((topic) => topic.id),
    ["topic-b", "topic-c", "topic-a"]
  );

  const topicReplaceResult = await projectEvents(
    [
      {
        seq: 18,
        operation_id: "op-topic-order-replace",
        entity_type: "topic_order",
        entity_id: "topic-agent",
        action: "replace",
        item_type: "agent",
        item_id: "topic-agent",
        payload: { topics_order: ["topic-a", "topic-b"] },
      },
    ],
    { config, localIndex, writeIntentLock, logger }
  );
  assert.deepStrictEqual(topicReplaceResult.appliedSeqs, [18]);
  topicConfig = await fs.readJson(topicConfigPath);
  assert.deepStrictEqual(
    topicConfig.topics.map((topic) => topic.id),
    ["topic-a", "topic-b", "topic-c"]
  );
  assert.strictEqual(
    topicConfig.topics.find((topic) => topic.id === "topic-c").deepMemoFlag,
    "keep-c"
  );

  const unsupportedResult = await projectEvents(
    [
      {
        ...baseEvent,
        seq: 19,
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
  assert.strictEqual(unsupportedResult.failedSeq, 19);
  assert.deepStrictEqual(unsupportedResult.appliedSeqs, []);

  await fs.remove(tempRoot);
  console.log("cycle3/cycle4 projector smoke test passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
