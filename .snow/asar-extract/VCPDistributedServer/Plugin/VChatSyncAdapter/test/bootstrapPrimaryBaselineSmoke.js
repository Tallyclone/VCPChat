const assert = require("assert");
const { recordBootstrapPrimaryBaseline } = require("../sync/bootstrapManager");
const { createLocalIndex } = require("../core/localIndex");

async function main() {
  const savedRows = { messages: {}, files: {} };
  const localIndex = {
    batchUpdate: async (mutator) => mutator(),
    setMessage: async (key, row) => {
      savedRows.messages[key] = row;
    },
    setFile: async (key, row) => {
      savedRows.files[key] = row;
    },
  };

  assert.strictEqual(typeof createLocalIndex, "function");

  const manifest = {
    messages: [
      {
        item_type: "agent",
        item_id: "agent-1",
        topic_id: "topic-1",
        id: "msg-1",
        checksum: "message-checksum",
      },
    ],
    configs: [
      {
        schema: "agent_config",
        entity_id: "Agents/agent-1/config.json",
        relative_path: "Agents/agent-1/config.json",
        checksum: "config-checksum",
      },
    ],
  };

  const result = await recordBootstrapPrimaryBaseline(
    localIndex,
    manifest,
    { latest_seq: 42 },
    { info: () => {} }
  );

  assert.deepStrictEqual(result, { messages: 1, configs: 1, latest_seq: 42 });
  assert.strictEqual(
    savedRows.messages["agent:agent-1:topic-1:msg-1"].last_known_checksum,
    "message-checksum"
  );
  assert.strictEqual(
    savedRows.messages["agent:agent-1:topic-1:msg-1"].pending_operation_id,
    null
  );
  assert.strictEqual(
    savedRows.files["Agents/agent-1/config.json"].checksum,
    "config-checksum"
  );
  assert.strictEqual(
    savedRows.files["Agents/agent-1/config.json"].bootstrap_baseline,
    true
  );
  assert.strictEqual(
    savedRows.files["Agents/agent-1/config.json"].last_applied_seq,
    42
  );

  console.log("bootstrap primary baseline smoke test passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
