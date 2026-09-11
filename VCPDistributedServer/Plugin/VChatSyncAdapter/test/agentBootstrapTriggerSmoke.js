const assert = require("assert");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const { handleFile } = require("../scanner/appDataScanner");

function createMemoryIndex() {
  const files = {};
  const messages = {};
  const topics = {};
  return {
    getFile: (key) => files[key] || null,
    setFile: async (key, value) => {
      files[key] = value;
    },
    getMessage: (key) => messages[key] || null,
    setMessage: async (key, value) => {
      messages[key] = value;
    },
    listMessagesByTopic: (topicKey) =>
      Object.fromEntries(
        Object.entries(messages).filter(
          ([, value]) => value.topic_key === topicKey
        )
      ),
    getTopicSnapshot: (key) => topics[key] || null,
    setTopicSnapshot: async (key, value) => {
      topics[key] = value;
    },
  };
}

async function main() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "vchat-bootstrap-trigger-")
  );
  try {
    const agentId = "agent-trigger-test";
    const topicId = "topic-trigger-test";
    const configPath = path.join(root, "Agents", agentId, "config.json");
    const historyPath = path.join(
      root,
      "UserData",
      agentId,
      "topics",
      topicId,
      "history.json"
    );
    await fs.outputJson(configPath, {
      name: "configured agent",
      systemPrompt: "full prompt after configuration",
      advancedSystemPrompt: {
        blocks: [{ id: "block-1", content: "full block" }],
        hiddenBlocks: {},
        warehouseOrder: [],
        viewMode: false,
      },
      topics: [{ id: topicId, name: "first topic" }],
    });
    await fs.outputJson(historyPath, []);

    const localIndex = createMemoryIndex();
    const batches = [];
    const offlineQueue = {
      enqueueMany: async (operations) => {
        batches.push(operations);
        return operations.map((operation) => ({
          operation_id: operation.operation_id,
          key:
            operation.entity_type === "message"
              ? `${operation.item_type}:${operation.item_id}:${operation.topic_id}:${operation.entity_id}`
              : `${operation.entity_type}:${operation.entity_id}`,
          action: operation.action,
          entity_type: operation.entity_type,
        }));
      },
    };
    const writeIntentLock = { isLocked: async () => false };
    const logger = { debug() {}, warn() {}, info() {} };
    const context = {
      config: { appDataPath: root },
      deviceId: "device-test",
      mode: "active",
      profile: "runtime",
    };

    await handleFile(
      root,
      configPath,
      localIndex,
      offlineQueue,
      writeIntentLock,
      logger,
      context
    );
    const configRow = localIndex.getFile(`Agents/${agentId}/config.json`);
    assert.strictEqual(configRow.bootstrap_pending, true);
    assert.strictEqual(batches[0][0].payload.profile, "runtime");
    assert.strictEqual(
      batches[0].some((operation) => operation.payload.profile === "bootstrap"),
      false
    );

    await handleFile(
      root,
      historyPath,
      localIndex,
      offlineQueue,
      writeIntentLock,
      logger,
      context
    );
    assert.strictEqual(batches[1].length, 0);
    assert.strictEqual(
      localIndex.getFile(`Agents/${agentId}/config.json`).bootstrap_pending,
      true
    );

    await fs.outputJson(historyPath, [
      { id: "loading_history", role: "assistant", content: "loading" },
      {
        id: "streaming-1",
        role: "assistant",
        content: "partial",
        status: "streaming",
      },
    ]);
    await handleFile(
      root,
      historyPath,
      localIndex,
      offlineQueue,
      writeIntentLock,
      logger,
      context
    );
    assert.strictEqual(batches[2].length, 0);
    assert.strictEqual(
      localIndex.getFile(`Agents/${agentId}/config.json`).bootstrap_pending,
      true
    );

    await fs.outputJson(historyPath, [
      { id: "message-1", role: "user", content: "hello" },
    ]);
    await handleFile(
      root,
      historyPath,
      localIndex,
      offlineQueue,
      writeIntentLock,
      logger,
      context
    );
    const firstConversationBatch = batches[3];
    assert.strictEqual(firstConversationBatch[0].entity_type, "agent_config");
    assert.strictEqual(firstConversationBatch[0].payload.profile, "bootstrap");
    assert.strictEqual(
      firstConversationBatch[0].payload.safe_projection_json.systemPrompt,
      "full prompt after configuration"
    );
    assert.strictEqual(firstConversationBatch[1].entity_type, "message");
    const bootstrappedConfigRow = localIndex.getFile(
      `Agents/${agentId}/config.json`
    );
    assert.strictEqual(bootstrappedConfigRow.bootstrap_pending, false);
    assert.ok(bootstrappedConfigRow.bootstrap_checksum);

    await fs.outputJson(historyPath, [
      { id: "message-1", role: "user", content: "hello" },
      {
        id: "message-2",
        role: "assistant",
        content: "hi",
        finishReason: "stop",
      },
    ]);
    await handleFile(
      root,
      historyPath,
      localIndex,
      offlineQueue,
      writeIntentLock,
      logger,
      context
    );
    assert.strictEqual(
      batches[4].filter(
        (operation) =>
          operation.entity_type === "agent_config" &&
          operation.payload.profile === "bootstrap"
      ).length,
      0
    );
    assert.strictEqual(batches[4][0].entity_type, "message");

    console.log("agent bootstrap trigger smoke test passed");
  } finally {
    await fs.remove(root);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
