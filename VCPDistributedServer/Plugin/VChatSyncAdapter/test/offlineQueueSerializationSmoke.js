const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { createLocalIndex } = require("../core/localIndex");
const { createOfflineQueue, readQueueLines } = require("../sync/offlineQueue");

function operation(id, entityId = id) {
  return {
    operation_id: id,
    device_id: "pc-test",
    entity_type: "agent_config",
    entity_id: `Agents/${entityId}/config.json`,
    action: "update",
    payload: {},
  };
}

async function makeQueue(tempRoot, submitOperation) {
  const config = {
    appDataPath: path.join(tempRoot, "AppData"),
    syncDir: path.join(tempRoot, "AppData", "sync"),
    indexPath: path.join(tempRoot, "AppData", "sync", "local_index.json"),
    queuePath: path.join(tempRoot, "AppData", "sync", "offline_queue.jsonl"),
    queueIntervalMs: 10,
    deviceId: "pc-test",
  };
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const localIndex = createLocalIndex(config, logger);
  await localIndex.load();
  const queue = createOfflineQueue(
    config,
    { submitOperation },
    localIndex,
    logger
  );
  await queue.start({ modeProvider: () => "active" });
  await queue.stop();
  return { config, localIndex, queue, logger };
}

async function main() {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "vchat-queue-serial-")
  );
  try {
    let releaseFirstSubmit;
    let submitCount = 0;
    const ctx = await makeQueue(tempRoot, async (op) => {
      submitCount += 1;
      if (submitCount === 1) {
        await new Promise((resolve) => {
          releaseFirstSubmit = resolve;
        });
      }
      return { ok: true, seq: 1, version: 1, operation_id: op.operation_id };
    });

    await Promise.all([
      ctx.queue.enqueueMany([operation("op-a")], { mode: "active" }),
      ctx.queue.enqueueMany([operation("op-b")], { mode: "active" }),
    ]);
    let rows = await readQueueLines(ctx.config.queuePath, ctx.logger);
    assert.deepStrictEqual(
      rows.map((row) => row.operation.operation_id).sort(),
      ["op-a", "op-b"]
    );

    const processing = ctx.queue.processOnce();
    while (!releaseFirstSubmit) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const enqueueDuringProcessing = ctx.queue.enqueueMany([operation("op-c")], {
      mode: "active",
    });
    releaseFirstSubmit();
    await processing;
    await enqueueDuringProcessing;
    assert.strictEqual(submitCount, 2);
    rows = await readQueueLines(ctx.config.queuePath, ctx.logger);
    assert.deepStrictEqual(
      rows.map((row) => row.operation.operation_id),
      ["op-c"]
    );

    const conflictPath = "Agents/conflict/config.json";
    await ctx.localIndex.setFile(conflictPath, {
      pending_operation_id: "op-conflict",
      pending_status: "pending_update",
    });
    const conflictQueue = createOfflineQueue(
      ctx.config,
      {
        async submitOperation() {
          return {
            ok: true,
            conflict: true,
            deleted: true,
            resolution: "delete_wins",
          };
        },
      },
      ctx.localIndex,
      ctx.logger
    );
    await conflictQueue.start({ modeProvider: () => "active" });
    await conflictQueue.stop();
    await conflictQueue.enqueueMany([operation("op-conflict", "conflict")], {
      mode: "active",
    });
    await conflictQueue.processOnce();
    rows = await readQueueLines(ctx.config.queuePath, ctx.logger);
    assert.deepStrictEqual(rows, []);
    const terminal = ctx.localIndex.getFile(conflictPath);
    assert.strictEqual(terminal.pending_status, "conflict_delete_wins");
    assert.strictEqual(terminal.terminal_conflict.resolution, "delete_wins");

    let failWarning = true;
    const rejectionLogger = {
      debug() {},
      info() {},
      error() {},
      warn() {
        if (failWarning) {
          failWarning = false;
          throw new Error("intentional logger failure");
        }
      },
    };
    await fs.writeFile(ctx.config.queuePath, "not-json\n", "utf8");
    const rejectionQueue = createOfflineQueue(
      ctx.config,
      { submitOperation: async () => ({ ok: true }) },
      ctx.localIndex,
      rejectionLogger
    );
    await rejectionQueue.start({ modeProvider: () => "active" });
    await rejectionQueue.stop();
    await assert.rejects(
      () => rejectionQueue.stats(),
      /intentional logger failure/
    );
    await fs.writeFile(ctx.config.queuePath, "", "utf8");
    await rejectionQueue.enqueueMany([operation("op-after-rejection")], {
      mode: "active",
    });
    rows = await readQueueLines(ctx.config.queuePath, ctx.logger);
    assert.deepStrictEqual(
      rows.map((row) => row.operation.operation_id),
      ["op-after-rejection"]
    );

    console.log(
      "offline queue serialization and terminal conflict smoke test passed"
    );
  } finally {
    await fs.remove(tempRoot);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
