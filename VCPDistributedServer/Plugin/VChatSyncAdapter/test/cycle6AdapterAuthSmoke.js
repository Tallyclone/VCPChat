const assert = require("assert");
const { buildConfig, requireAdapterAuth } = require("../index");

function makeReq(headers = {}) {
  return { headers };
}

async function main() {
  const config = buildConfig(
    {
      VCHAT_ADAPTER_ENABLED: "false",
      VCHAT_SYNC_KEY: "super-secret-key",
    },
    process.cwd()
  );

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
