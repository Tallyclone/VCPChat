const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { buildConfig, requireAdapterAuth } = require("../index");

function makeReq(headers = {}) {
  return { headers };
}

async function main() {
  // Test credentials must not read or depend on this installation's config.env.
  const envPath = path.resolve(__dirname, "../config.env");
  const originalExistsSync = fs.existsSync;
  let config;
  try {
    fs.existsSync = (candidate) => path.resolve(String(candidate)) === envPath
      ? false : originalExistsSync(candidate);
    config = buildConfig(
      {
        VCHAT_ADAPTER_ENABLED: "false",
        VCHAT_SYNC_KEY: "super-secret-key",
      },
      process.cwd()
    );
  } finally {
    fs.existsSync = originalExistsSync;
  }

  assert.doesNotThrow(() =>
    requireAdapterAuth(
      config,
      makeReq({ authorization: "Bearer super-secret-key" })
    )
  );
  assert.doesNotThrow(() =>
    requireAdapterAuth(
      config,
      makeReq({ "x-vchat-sync-key": "super-secret-key" })
    )
  );
  assert.throws(
    () =>
      requireAdapterAuth(
        config,
        makeReq({ "x-vchat-bootstrap-key": "super-secret-key" })
      ),
    /authorization failed/
  );

  assert.throws(
    () => requireAdapterAuth(config, makeReq({})),
    /authorization failed/
  );
  assert.throws(
    () =>
      requireAdapterAuth(config, makeReq({ authorization: "Bearer wrong" })),
    /authorization failed/
  );
  assert.throws(
    () =>
      requireAdapterAuth(
        { ...config, syncKey: "change-me" },
        makeReq({ authorization: "Bearer change-me" })
      ),
    /authorization failed/
  );

  console.log("cycle6 adapter auth smoke test passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
