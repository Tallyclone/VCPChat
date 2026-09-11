const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const assert = require("assert");
const {
  buildLocalManifest,
  exportCompleteBootstrap,
  bootstrapPrimary,
} = require("../sync/bootstrapManager");

function emptyPage(kind = "all") {
  const names = [
    "messages",
    "topics",
    "configs",
    "attachments",
    "message_attachments",
    "avatars",
    "themes",
  ];
  return Object.fromEntries(
    names.map((name) => [
      name,
      { kind: name, cursor: 0, limit: 2, has_more: false, next_cursor: null },
    ])
  );
}

async function testManifestFiltering(tempRoot) {
  const appDataPath = path.join(tempRoot, "AppData");
  const historyPath = path.join(
    appDataPath,
    "UserData",
    "agent-1",
    "topics",
    "topic-1",
    "history.json"
  );
  await fs.ensureDir(path.dirname(historyPath));
  await fs.writeJson(historyPath, [
    {
      id: "stream",
      role: "assistant",
      content: "partial",
      status: "streaming",
    },
    { role: "user", content: "valid", timestamp: 1 },
    { role: "assistant", content: "", timestamp: 2 },
  ]);
  const manifest = await buildLocalManifest({
    appDataPath,
    deviceId: "pc-test",
  });
  assert.strictEqual(manifest.ok, true);
  assert.strictEqual(manifest.messages.length, 1);
  assert.ok(/^sync_[a-f0-9]{24}$/.test(manifest.messages[0].id));
  assert.deepStrictEqual(manifest.rewritten, [
    "UserData/agent-1/topics/topic-1/history.json",
  ]);
  const rewritten = await fs.readJson(historyPath);
  assert.strictEqual(rewritten[0].id, "stream");
  assert.strictEqual(rewritten[2].id, undefined);
  assert.strictEqual(rewritten[1].id, manifest.messages[0].id);
}

async function testPagination() {
  const categories = [
    "messages",
    "topics",
    "configs",
    "attachments",
    "message_attachments",
    "avatars",
    "themes",
  ];
  const calls = [];
  const client = {
    async exportBootstrap(options = {}) {
      calls.push(options);
      if (!options.kind) {
        const page = emptyPage();
        const baseline = {};
        for (const kind of categories) {
          baseline[kind] = [`${kind}-1`];
          page[kind] = {
            kind,
            cursor: 0,
            limit: 1,
            has_more: true,
            next_cursor: 1,
          };
        }
        return { ok: true, latest_seq: 9, baseline, page };
      }
      assert.ok(categories.includes(options.kind));
      assert.strictEqual(options.cursor, 1);
      assert.strictEqual(options.limit, 1);
      const page = emptyPage();
      page[options.kind] = {
        kind: options.kind,
        cursor: 1,
        limit: 1,
        has_more: false,
        next_cursor: null,
      };
      return {
        ok: true,
        baseline: { [options.kind]: [`${options.kind}-2`] },
        page,
      };
    },
  };
  const exported = await exportCompleteBootstrap(client);
  for (const kind of categories) {
    assert.deepStrictEqual(exported.baseline[kind], [`${kind}-1`, `${kind}-2`]);
  }
  assert.strictEqual(exported.latest_seq, 9);
  assert.strictEqual(exported.page.messages.has_more, true);
  assert.strictEqual(calls.length, categories.length + 1);

  const stuck = {
    async exportBootstrap(options = {}) {
      const page = emptyPage();
      page.messages = {
        kind: "messages",
        cursor: options.cursor || 0,
        limit: 2,
        has_more: true,
        next_cursor: 2,
      };
      return { ok: true, baseline: { messages: [] }, page };
    },
  };
  await assert.rejects(
    () => exportCompleteBootstrap(stuck),
    /cursor did not advance for messages/
  );

  let missingMetadataCall = 0;
  const missingMetadata = {
    async exportBootstrap() {
      missingMetadataCall += 1;
      if (missingMetadataCall === 1) {
        const page = emptyPage();
        page.configs = {
          kind: "configs",
          cursor: 0,
          limit: 1,
          has_more: true,
          next_cursor: 1,
        };
        return { baseline: { configs: ["configs-1"] }, page };
      }
      return { baseline: { configs: ["configs-2"] }, page: {} };
    },
  };
  await assert.rejects(
    () => exportCompleteBootstrap(missingMetadata),
    /pagination metadata missing for configs/
  );
}

async function testBootstrapRecovery(tempRoot) {
  const appDataPath = path.join(tempRoot, "RecoveryAppData");
  const agentDir = path.join(appDataPath, "Agents", "agent-conflict");
  await fs.ensureDir(agentDir);
  await fs.writeJson(path.join(agentDir, "config.json"), {
    name: "conflict",
    topics: [{ id: "Topic-A" }, { id: "topic-a" }],
  });
  let resumed = 0;
  const runtime = {
    config: { appDataPath, deviceId: "pc-test" },
    centerClient: { importBootstrap: async () => ({ ok: true }) },
    localIndex: {},
    offlineQueue: {},
    writeIntentLock: {},
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    watcher: { stop: async () => {} },
    themeWatcher: { stop: async () => {} },
    pullLoop: { stop: async () => {} },
    state: {},
    runtimeServicesStarted: true,
    async resumeRuntimeServices() {
      resumed += 1;
      this.runtimeServicesStarted = true;
    },
  };
  await assert.rejects(
    () => bootstrapPrimary(runtime),
    /manifest validation failed/
  );
  assert.strictEqual(resumed, 1);

  const importFailureAppData = path.join(tempRoot, "ImportFailureAppData");
  await fs.ensureDir(importFailureAppData);
  let importFailureResumed = 0;
  const importFailureRuntime = {
    config: { appDataPath: importFailureAppData, deviceId: "pc-test" },
    centerClient: {
      async importBootstrap() {
        throw new Error("intentional import failure");
      },
    },
    localIndex: {},
    offlineQueue: { stop: async () => {} },
    writeIntentLock: {},
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    watcher: { stop: async () => {} },
    themeWatcher: { stop: async () => {} },
    pullLoop: { stop: async () => {} },
    state: {},
    runtimeServicesStarted: true,
    async resumeRuntimeServices() {
      importFailureResumed += 1;
      this.runtimeServicesStarted = true;
    },
  };
  await assert.rejects(
    () => bootstrapPrimary(importFailureRuntime),
    /intentional import failure/
  );
  assert.strictEqual(importFailureResumed, 1);
}

async function main() {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "vchat-bootstrap-robustness-")
  );
  try {
    await testManifestFiltering(tempRoot);
    await testPagination();
    await testBootstrapRecovery(tempRoot);
    console.log("bootstrap robustness smoke test passed");
  } finally {
    await fs.remove(tempRoot);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
