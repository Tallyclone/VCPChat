"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { createRequire } = require("node:module");
(async () => {
  const plugin = path.resolve(__dirname, ".."),
    server = path.resolve(plugin, "../..");
  const loaderPath = path.join(server, "Plugin.js"),
    runtimeRequire = createRequire(loaderPath);
  const module = { exports: {} },
    logs = [];
  const restrictedFs = {
    ...fsp,
    readdir: async (directory, ...rest) => {
      if (path.resolve(directory) === path.join(server, "Plugin"))
        return [{ name: "GoogleAccountManager", isDirectory: () => true }];
      return fsp.readdir(directory, ...rest);
    },
  };
  const context = {
    module,
    exports: module.exports,
    __dirname: server,
    process,
    Buffer,
    setTimeout,
    clearTimeout,
    console: {
      log: (...x) => logs.push(x),
      warn: (...x) => logs.push(x),
      error: (...x) => logs.push(x),
    },
    require: (id) =>
      id === "fs"
        ? { promises: restrictedFs }
        : id === "node-schedule"
        ? {
            scheduleJob: () => {
              throw Error("unexpected scheduling");
            },
          }
        : runtimeRequire(id),
  };
  vm.runInNewContext(fs.readFileSync(loaderPath, "utf8"), context, {
    filename: loaderPath,
  });
  const manager = module.exports;
  await manager.loadPlugins();
  assert.equal(manager.getAllPluginManifests().length, 1);
  const manifest = manager.getPlugin("GoogleAccountManager");
  assert.equal(manifest.communication.protocol, "stdio");
  assert.equal(manifest.capabilities.invocationCommands.length, 17);
  const local = manager._getPluginConfig(manifest);
  assert.equal(local.GAM_SOURCE_CONFIG, "G:/profiles-manage/config.json");
  assert.equal(local.GAM_APPROVAL, "local-policy");
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "gam-runtime-"));
  try {
    const source = path.join(root, "config.json");
    await fsp.writeFile(
      source,
      JSON.stringify({
        paths: { accountsDir: root, chromePath: process.execPath },
        clash: { host: "127.0.0.1", port: 17890 },
      })
    );
    manifest.pluginSpecificEnvConfig = {
      GAM_SOURCE_CONFIG: source,
      GAM_ALLOWED_ROOT: root,
      GAM_ALLOWED_COMMANDS: "list,inspect,proxy_status,find_available_account",
      GAM_APPROVAL: "dialog",
    };
    await manager.initializeServices({}, {}, server, {});
    const result = JSON.parse(
      await manager.processToolCall(
        "GoogleAccountManager",
        { command: "proxy_status" },
        { vcpContext: { permissions: ["*"], authorized: true } }
      )
    );
    assert.equal(result.status, "success");
    assert.deepEqual(result.result.details.bindings, {});
    assert(Array.isArray(result.result.content));
    const denied = JSON.parse(
      await manager.processToolCall(
        "GoogleAccountManager",
        { command: "set_note", profile: 1, note: "no write" },
        { vcpContext: { permissions: ["*"], authorized: true } }
      )
    );
    assert.equal(denied.details.code, "COMMAND_NOT_ALLOWED");
    assert(!fs.existsSync(path.join(root, ".google_account_notes.json")));
    console.log(
      "PASS: actual distributed loader discovery, config.env schema injection, real stdio subprocess, result.content envelope, forged-context denial"
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
