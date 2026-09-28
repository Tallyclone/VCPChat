const assert = require("assert");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const { createLocalIndex } = require("../core/localIndex");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vchat-index-serialization-"));
  const config = { indexPath: path.join(root, "local_index.json") };
  const index = createLocalIndex(config, { warn() {}, error() {} });
  const originalMove = fs.move;
  const originalWriteJson = fs.writeJson;
  try {
    await index.load();
    const firstMove = deferred();
    const releaseMove = deferred();
    let intercept = true;
    fs.move = async (source, target, options) => {
      if (target === config.indexPath && intercept) {
        intercept = false;
        firstMove.resolve();
        await releaseMove.promise;
      }
      return originalMove(source, target, options);
    };
    const older = index.setMessage("m", { value: "older" });
    await firstMove.promise;
    const newer = index.setMessage("m", { value: "newer" });
    // Give a concurrent, unsequenced write time to replace the target first.
    await Promise.race([newer, new Promise((resolve) => setTimeout(resolve, 100))]);
    releaseMove.resolve();
    await Promise.all([older, newer]);
    assert.strictEqual((await fs.readJson(config.indexPath)).local_messages.m.value, "newer");

    // An older save completing during a batch must not clear that batch's
    // dirty state and leave its newer mutations only in memory.
    const batchMove = deferred();
    const releaseBatchMove = deferred();
    intercept = true;
    fs.move = async (source, target, options) => {
      if (target === config.indexPath && intercept) {
        intercept = false;
        batchMove.resolve();
        await releaseBatchMove.promise;
      }
      return originalMove(source, target, options);
    };
    const saving = index.setMessage("before-batch", { value: 1 });
    await batchMove.promise;
    const batchChanged = deferred();
    const finishBatch = deferred();
    const batch = index.batchUpdate(async () => {
      await index.setMessage("batch", { value: 2 });
      batchChanged.resolve();
      await finishBatch.promise;
    });
    await batchChanged.promise;
    releaseBatchMove.resolve();
    await saving;
    finishBatch.resolve();
    await batch;
    assert.strictEqual((await fs.readJson(config.indexPath)).local_messages.batch.value, 2);

    // A failed save must reject its caller while allowing later writes to
    // persist the complete current index.
    fs.move = originalMove;
    let failOnce = true;
    fs.writeJson = async (target, value, options) => {
      if (target.startsWith(`${config.indexPath}.tmp-`) && failOnce) {
        failOnce = false;
        throw new Error("simulated disk write failure");
      }
      return originalWriteJson(target, value, options);
    };
    await assert.rejects(index.setMessage("failed-save", { value: 3 }), /simulated disk write failure/);
    await index.setMessage("after-failure", { value: 4 });
    const saved = await fs.readJson(config.indexPath);
    assert.strictEqual(saved.local_messages["failed-save"].value, 3);
    assert.strictEqual(saved.local_messages["after-failure"].value, 4);
    console.log("local index serialization smoke test passed");
  } finally {
    fs.move = originalMove;
    fs.writeJson = originalWriteJson;
    assert.strictEqual(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith("vchat-index-serialization-"));
    await fs.remove(root);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
