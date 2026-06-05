const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { checksumBuffer } = require("../core/hash");
const { createLocalIndex } = require("../core/localIndex");
const { createWriteIntentLock } = require("../sync/writeIntentLock");
const { projectEvents } = require("../projector/appDataProjector");
const { uploadLocalAttachment } = require("../sync/attachmentSync");

async function main() {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "vchat-avatar-projector-")
  );
  const config = {
    appDataPath: path.join(tempRoot, "AppData"),
    syncDir: path.join(tempRoot, "AppData", "sync"),
    indexPath: path.join(tempRoot, "AppData", "sync", "local_index.json"),
    lockPath: path.join(tempRoot, "AppData", "sync", "write_intents.jsonl"),
    attachmentDir: path.join(tempRoot, "AppData", "UserData", "attachments"),
    deviceId: "device-local",
  };
  await fs.ensureDir(config.syncDir);
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const localIndex = createLocalIndex(config, logger);
  await localIndex.load();
  const writeIntentLock = createWriteIntentLock(config, logger);

  const avatarBufferV1 = Buffer.from("avatar-v1");
  const avatarHashV1 = checksumBuffer(avatarBufferV1);
  const avatarBufferV2 = Buffer.from("avatar-v2");
  const avatarHashV2 = checksumBuffer(avatarBufferV2);
  const downloads = new Map([
    [avatarHashV1, avatarBufferV1],
    [avatarHashV2, avatarBufferV2],
  ]);
  const submitted = [];
  const uploaded = [];
  const centerClient = {
    async downloadAttachment(hash) {
      const buffer = downloads.get(hash);
      if (!buffer) throw new Error(`missing test attachment: ${hash}`);
      return { buffer };
    },
    async uploadAttachment(payload) {
      uploaded.push(payload);
      return { ok: true, hash: payload.hash };
    },
    async submitOperation(operation) {
      submitted.push(operation);
      return { ok: true, seq: submitted.length, version: submitted.length };
    },
  };

  const createResult = await projectEvents(
    [
      {
        seq: 1,
        operation_id: "avatar-create-agent-one",
        entity_type: "avatar",
        entity_id: "agent:agent-one",
        action: "create",
        payload: {
          owner_type: "agent",
          owner_id: "agent-one",
          hash: avatarHashV1,
          ext: ".png",
          mime_type: "image/png",
        },
      },
    ],
    { config, localIndex, writeIntentLock, logger, centerClient }
  );
  assert.deepStrictEqual(createResult.appliedSeqs, [1]);
  const agentAvatarPath = path.join(
    config.appDataPath,
    "Agents",
    "agent-one",
    "avatar.png"
  );
  assert.strictEqual(await fs.readFile(agentAvatarPath, "utf8"), "avatar-v1");
  assert.strictEqual(
    localIndex.getFile("Agents/agent-one/avatar.png").hash,
    avatarHashV1
  );

  const updateResult = await projectEvents(
    [
      {
        seq: 2,
        operation_id: "avatar-update-agent-one",
        entity_type: "avatar",
        entity_id: "agent:agent-one",
        action: "update",
        payload: {
          owner_type: "agent",
          owner_id: "agent-one",
          hash: avatarHashV2,
          ext: ".png",
          relative_path: "Agents/agent-one/avatar.png",
        },
      },
    ],
    { config, localIndex, writeIntentLock, logger, centerClient }
  );
  assert.deepStrictEqual(updateResult.appliedSeqs, [2]);
  assert.strictEqual(await fs.readFile(agentAvatarPath, "utf8"), "avatar-v2");

  const deleteResult = await projectEvents(
    [
      {
        seq: 3,
        operation_id: "avatar-delete-agent-one",
        entity_type: "avatar",
        entity_id: "agent:agent-one",
        action: "delete",
        payload: {
          owner_type: "agent",
          owner_id: "agent-one",
          relative_path: "Agents/agent-one/avatar.png",
        },
      },
    ],
    { config, localIndex, writeIntentLock, logger, centerClient }
  );
  assert.deepStrictEqual(deleteResult.appliedSeqs, [3]);
  assert.strictEqual(await fs.pathExists(agentAvatarPath), false);
  assert.strictEqual(localIndex.getFile("Agents/agent-one/avatar.png"), null);

  const missingDeleteResult = await projectEvents(
    [
      {
        seq: 4,
        operation_id: "avatar-delete-missing",
        entity_type: "avatar",
        entity_id: "group:group-one",
        action: "delete",
        payload: { owner_type: "group", owner_id: "group-one", ext: ".jpg" },
      },
    ],
    { config, localIndex, writeIntentLock, logger, centerClient }
  );
  assert.deepStrictEqual(missingDeleteResult.appliedSeqs, [4]);

  const traversalResult = await projectEvents(
    [
      {
        seq: 5,
        operation_id: "avatar-traversal",
        entity_type: "avatar",
        entity_id: "agent:../outside",
        action: "create",
        payload: {
          owner_type: "agent",
          owner_id: "../outside",
          hash: avatarHashV1,
          ext: ".png",
        },
      },
    ],
    { config, localIndex, writeIntentLock, logger, centerClient }
  );
  assert(traversalResult.error, "avatar owner_id traversal should fail");
  assert.strictEqual(traversalResult.failedSeq, 5);
  assert.deepStrictEqual(traversalResult.appliedSeqs, []);

  const mismatchCreateResult = await projectEvents(
    [
      {
        seq: 6,
        operation_id: "avatar-create-path-owner-mismatch",
        entity_type: "avatar",
        entity_id: "agent:agent-one",
        action: "create",
        payload: {
          owner_type: "agent",
          owner_id: "agent-one",
          hash: avatarHashV1,
          relative_path: "Agents/agent-two/avatar.png",
        },
      },
    ],
    { config, localIndex, writeIntentLock, logger, centerClient }
  );
  assert(
    mismatchCreateResult.error,
    "avatar create path owner mismatch should fail"
  );
  assert.strictEqual(mismatchCreateResult.failedSeq, 6);
  assert.deepStrictEqual(mismatchCreateResult.appliedSeqs, []);

  const mismatchDeleteResult = await projectEvents(
    [
      {
        seq: 7,
        operation_id: "avatar-delete-path-owner-mismatch",
        entity_type: "avatar",
        entity_id: "group:group-one",
        action: "delete",
        payload: {
          owner_type: "group",
          owner_id: "group-one",
          relative_path: "AgentGroups/group-two/avatar.jpg",
        },
      },
    ],
    { config, localIndex, writeIntentLock, logger, centerClient }
  );
  assert(
    mismatchDeleteResult.error,
    "avatar delete path owner mismatch should fail"
  );
  assert.strictEqual(mismatchDeleteResult.failedSeq, 7);
  assert.deepStrictEqual(mismatchDeleteResult.appliedSeqs, []);

  const nonAvatarPathResult = await projectEvents(
    [
      {
        seq: 8,
        operation_id: "avatar-non-avatar-relative-path",
        entity_type: "avatar",
        entity_id: "agent:agent-one",
        action: "create",
        payload: {
          owner_type: "agent",
          owner_id: "agent-one",
          hash: avatarHashV1,
          relative_path: "Agents/agent-one/config.json",
        },
      },
    ],
    { config, localIndex, writeIntentLock, logger, centerClient }
  );
  assert(nonAvatarPathResult.error, "non-avatar relative_path should fail");
  assert.strictEqual(nonAvatarPathResult.failedSeq, 8);
  assert.deepStrictEqual(nonAvatarPathResult.appliedSeqs, []);

  const localAvatarPath = path.join(
    config.appDataPath,
    "AgentGroups",
    "group-local",
    "avatar.jpg"
  );
  await fs.outputFile(localAvatarPath, avatarBufferV1);
  const uploadResult = await uploadLocalAttachment(
    "AgentGroups/group-local/avatar.jpg",
    localAvatarPath,
    localIndex,
    centerClient,
    config,
    { force: true }
  );
  assert.strictEqual(uploadResult.hash, avatarHashV1);
  assert.strictEqual(uploaded.length, 1);
  assert.strictEqual(submitted.length, 1);
  assert.strictEqual(submitted[0].entity_type, "avatar");
  assert.strictEqual(submitted[0].entity_id, "group:group-local");
  assert.strictEqual(
    submitted[0].payload.relative_path,
    "AgentGroups/group-local/avatar.jpg"
  );
  const indexedAvatar = localIndex.getFile(
    "AgentGroups/group-local/avatar.jpg"
  );
  assert.strictEqual(indexedAvatar.avatar_operation_submitted, true);
  assert.strictEqual(indexedAvatar.avatar_operation_hash, avatarHashV1);

  await localIndex.setFile("AgentGroups/group-local/avatar.jpg", {
    ...indexedAvatar,
    avatar_operation_submitted: false,
  });
  const retryResult = await uploadLocalAttachment(
    "AgentGroups/group-local/avatar.jpg",
    localAvatarPath,
    localIndex,
    centerClient,
    config
  );
  assert.strictEqual(retryResult.uploaded, false);
  assert.strictEqual(retryResult.avatarOperationSubmitted, true);
  assert.strictEqual(uploaded.length, 1);
  assert.strictEqual(submitted.length, 2);
  assert.strictEqual(submitted[1].operation_id, submitted[0].operation_id);
  assert.strictEqual(
    localIndex.getFile("AgentGroups/group-local/avatar.jpg")
      .avatar_operation_submitted,
    true
  );

  await fs.remove(tempRoot);
  console.log("avatar projector smoke test passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
