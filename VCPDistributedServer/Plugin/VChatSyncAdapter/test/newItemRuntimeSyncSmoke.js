const assert = require("assert");
const { diffConfig } = require("../diff/configDiffEngine");
const { itemDeleteOperation } = require("../scanner/deleteEventHandler");

async function main() {
  const newEntityIndex = { getFile() { return null; } };
  const agentPath = "Agents/new-agent/config.json";
  const agentConfig = {
    name: "new agent",
    systemPrompt: "full prompt",
    syncPrompt: true,
    advancedSystemPrompt: {
      blocks: [{ id: "block-1", content: "full block" }],
      hiddenBlocks: {},
      warehouseOrder: [],
      viewMode: false,
    },
    topics: [{ id: "topic-1", name: "first topic" }],
  };
  const agentResult = await diffConfig(agentPath, agentConfig, newEntityIndex, {
    profile: "runtime",
    deviceId: "device-test",
  });

  assert.strictEqual(agentResult.dto.profile, "bootstrap");
  assert.strictEqual(
    agentResult.operation.payload.safe_projection_json.systemPrompt,
    "full prompt"
  );
  assert.deepStrictEqual(
    agentResult.operation.payload.safe_projection_json.advancedSystemPrompt.blocks,
    [{ id: "block-1", content: "full block" }]
  );
  assert.ok(
    agentResult.operations.some(
      (operation) =>
        operation.entity_type === "topic" &&
        operation.action === "upsert" &&
        operation.topic_id === "topic-1"
    )
  );

  const groupPath = "AgentGroups/new-group/config.json";
  const groupResult = await diffConfig(
    groupPath,
    {
      id: "new-group",
      name: "new group",
      groupPrompt: "full group prompt",
      members: ["new-agent"],
      topics: [{ id: "group-topic-1", name: "group topic" }],
    },
    newEntityIndex,
    { profile: "runtime", deviceId: "device-test" }
  );
  assert.strictEqual(groupResult.dto.profile, "bootstrap");
  assert.strictEqual(
    groupResult.operation.payload.safe_projection_json.groupPrompt,
    "full group prompt"
  );
  assert.ok(
    groupResult.operations.some(
      (operation) =>
        operation.entity_type === "topic" &&
        operation.topic_id === "group-topic-1"
    )
  );

  const existingIndex = {
    getFile() {
      return { checksum: "old", snapshot_json: { name: "existing" } };
    },
  };
  const existingResult = await diffConfig(
    agentPath,
    agentConfig,
    existingIndex,
    { profile: "runtime", deviceId: "device-test" }
  );
  assert.strictEqual(existingResult.dto.profile, "runtime");
  assert.strictEqual(
    existingResult.operation.payload.safe_projection_json.systemPrompt,
    undefined
  );

  const agentDelete = itemDeleteOperation(
    { item_type: "agent", item_id: "名字 with space" },
    { deviceId: "device-test" }
  );
  assert.strictEqual(
    agentDelete.payload.config_entity_id,
    "Agents/%E5%90%8D%E5%AD%97%20with%20space/config.json"
  );
  const groupDelete = itemDeleteOperation(
    { item_type: "group", item_id: "group-a" },
    { deviceId: "device-test" }
  );
  assert.strictEqual(
    groupDelete.payload.config_entity_id,
    "AgentGroups/group-a/config.json"
  );

  console.log("new item runtime sync smoke test passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
