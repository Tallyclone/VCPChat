const assert = require("assert");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const { atomicWriteJson } = require("../projector/atomicWriter");

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vchat-sync-atomic-"));
  const filePath = path.join(tempRoot, "history.json");
  const logger = { warn() {}, error() {} };

  await atomicWriteJson(filePath, [{ id: "m1", content: "ok" }], { logger });
  assert.deepStrictEqual(await fs.readJson(filePath), [{ id: "m1", content: "ok" }]);

  const originalMove = fs.move;
  let injected = true;
  fs.move = async (source, target, options) => {
    if (injected && String(source).includes(".tmp-")) {
      injected = false;
      throw new Error("injected rename failure");
    }
    return originalMove(source, target, options);
  };

  try {
    await atomicWriteJson(filePath, [{ id: "m1", content: "recovered" }], {
      logger,
    });
  } finally {
    fs.move = originalMove;
  }

  assert.deepStrictEqual(await fs.readJson(filePath), [
    { id: "m1", content: "recovered" },
  ]);
  const leftovers = (await fs.readdir(tempRoot)).filter((name) =>
    /\.tmp-|\.backup-/.test(name)
  );
  assert.strictEqual(leftovers.length, 0);

  await fs.remove(tempRoot);
  console.log("cycle6 atomic writer recovery smoke test passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
