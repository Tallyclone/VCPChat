const assert = require("assert");
const {
  buildSafeConfigDto,
  mergeProjectedConfig,
  validateSafeConfigDto,
} = require("../core/configSchema");

function main() {
  const localConfig = {
    name: "old name",
    systemPrompt: "local prompt must stay",
    originalSystemPrompt: "local original prompt must stay",
    model: "local-model",
    syncPrompt: true,
    customCss: ".local {}",
    advancedSystemPrompt: {
      blocks: [{ id: "block-1", content: "must stay" }],
      hiddenBlocks: { old: { content: "old" } },
      warehouseOrder: ["old"],
      viewMode: true,
    },
    topics: [
      { id: "topic-1", name: "old topic", extra: "must be stripped in DTO" },
    ],
  };

  const remoteConfig = {
    name: "new name",
    systemPrompt: "remote prompt must not sync",
    model: "remote-model",
    syncPrompt: false,
    advancedSystemPrompt: {
      blocks: [{ id: "remote-block", content: "must not sync" }],
      hiddenBlocks: { remote: { content: "new" } },
      warehouseOrder: ["remote"],
      viewMode: false,
    },
    topics: [
      { id: "topic-2", name: "new topic", extra: "must be stripped in DTO" },
    ],
    presetSystemPrompt: "preset body",
    selectedPreset: "preset-id",
  };

  const dto = buildSafeConfigDto("Agents/agent-a/config.json", remoteConfig, {
    profile: "runtime",
  });

  assert.strictEqual(dto.schema, "agent_config");
  assert.strictEqual(dto.profile, "runtime");
  assert.deepStrictEqual(dto.projection_fields, [
    "name",
    "topics",
    "advancedSystemPrompt.hiddenBlocks",
    "advancedSystemPrompt.warehouseOrder",
    "advancedSystemPrompt.viewMode",
    "presetSystemPrompt",
    "selectedPreset",
  ]);
  assert.strictEqual(dto.safe_projection_json.systemPrompt, undefined);
  assert.strictEqual(dto.safe_projection_json.model, undefined);
  assert.strictEqual(dto.safe_projection_json.syncPrompt, undefined);
  assert.strictEqual(
    dto.safe_projection_json.advancedSystemPrompt.blocks,
    undefined
  );
  assert.deepStrictEqual(dto.safe_projection_json.topics, [
    { id: "topic-2", name: "new topic" },
  ]);

  const merged = mergeProjectedConfig(localConfig, dto.safe_projection_json, {
    schema: dto.schema,
    profile: dto.profile,
    projection_fields: dto.projection_fields,
  });

  assert.strictEqual(merged.name, "new name");
  assert.strictEqual(merged.systemPrompt, "local prompt must stay");
  assert.strictEqual(
    merged.originalSystemPrompt,
    "local original prompt must stay"
  );
  assert.strictEqual(merged.model, "local-model");
  assert.strictEqual(merged.syncPrompt, true);
  assert.strictEqual(merged.customCss, ".local {}");
  assert.deepStrictEqual(merged.advancedSystemPrompt.blocks, [
    { id: "block-1", content: "must stay" },
  ]);
  assert.deepStrictEqual(merged.advancedSystemPrompt.hiddenBlocks, {
    remote: { content: "new" },
  });

  const expandableDto = buildSafeConfigDto(
    "Agents/agent-a/config.json",
    remoteConfig,
    {
      profile: "runtime",
      syncProfileConfig: {
        runtimeSync: {
          agent_config: {
            include: ["systemPrompt", "model"],
            exclude: [],
          },
        },
      },
    }
  );
  assert(expandableDto.projection_fields.includes("systemPrompt"));
  assert(expandableDto.projection_fields.includes("model"));
  assert.strictEqual(
    expandableDto.safe_projection_json.systemPrompt,
    "remote prompt must not sync"
  );
  assert.strictEqual(expandableDto.safe_projection_json.model, "remote-model");

  const missingFieldDto = buildSafeConfigDto(
    "Agents/agent-a/config.json",
    { name: "legacy" },
    {
      profile: "runtime",
      syncProfileConfig: {
        runtimeSync: {
          agent_config: {
            include: ["systemPrompt"],
            exclude: [],
          },
        },
      },
    }
  );
  assert(!missingFieldDto.projection_fields.includes("systemPrompt"));

  const denylistDto = buildSafeConfigDto(
    "Agents/agent-a/config.json",
    remoteConfig,
    {
      profile: "runtime",
      syncProfileConfig: {
        runtimeSync: {
          agent_config: {
            include: ["advancedSystemPrompt.blocks", "syncPrompt"],
            exclude: [],
          },
        },
      },
    }
  );
  assert(
    !denylistDto.projection_fields.includes("advancedSystemPrompt.blocks")
  );
  assert(!denylistDto.projection_fields.includes("syncPrompt"));

  const deleteHiddenBlocks = mergeProjectedConfig(
    localConfig,
    {},
    {
      schema: "agent_config",
      profile: "runtime",
      projection_fields: ["advancedSystemPrompt.hiddenBlocks"],
    }
  );
  assert.strictEqual(
    deleteHiddenBlocks.advancedSystemPrompt.hiddenBlocks,
    undefined
  );
  assert.deepStrictEqual(deleteHiddenBlocks.advancedSystemPrompt.blocks, [
    { id: "block-1", content: "must stay" },
  ]);

  assert.throws(
    () =>
      mergeProjectedConfig(localConfig, dto.safe_projection_json, {
        schema: "agent_config",
        profile: "runtime",
      }),
    /requires projection_fields/
  );

  assert.throws(
    () =>
      validateSafeConfigDto(
        "agent_config",
        {
          advancedSystemPrompt: {
            hiddenBlocks: {},
            blocks: [{ id: "bad" }],
          },
        },
        {
          profile: "runtime",
          projection_fields: ["advancedSystemPrompt.hiddenBlocks"],
        }
      ),
    /advancedSystemPrompt\.blocks/
  );

  const bootstrapDto = buildSafeConfigDto(
    "Agents/agent-a/config.json",
    remoteConfig,
    {
      profile: "bootstrap",
    }
  );
  assert(bootstrapDto.projection_fields.includes("advancedSystemPrompt"));
  assert(
    !bootstrapDto.projection_fields.includes("advancedSystemPrompt.blocks")
  );
  assert(
    !bootstrapDto.projection_fields.includes(
      "advancedSystemPrompt.hiddenBlocks"
    )
  );

  console.log("runtime projection fields smoke test passed");
}

main();
