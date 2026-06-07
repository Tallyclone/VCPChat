const fs = require("fs-extra");
const path = require("path");
const crypto = require("crypto");

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

function checksumJson(value) {
  return crypto
    .createHash("sha256")
    .update(stableStringify(value))
    .digest("hex");
}

function isDurableMessageCandidate(message) {
  if (!message || typeof message !== "object") return false;
  if (!message.id) return false;
  if (message.isThinking === true) return false;
  if (message.id === "loading_history") return false;
  if (
    message.placeholder === true ||
    message.ui_placeholder === true ||
    message.status === "placeholder"
  )
    return false;
  if (message.status === "streaming" || message.partial === true) return false;
  if (
    message.role === "assistant" &&
    typeof message.content === "string" &&
    message.content.trim().length === 0 &&
    !message.finishReason
  ) {
    return false;
  }
  return true;
}
function resolveSyncDir(userDataDir) {
  if (!userDataDir) return null;
  // USER_DATA_DIR points at AppData/UserData/<owner>. Keep adapter and desktop writer aligned
  // on the shared AppData/sync directory instead of AppData/UserData/sync.
  const userDataRoot = path.dirname(userDataDir);
  return path.join(path.dirname(userDataRoot), "sync");
}

async function appendMessageIntents(options = {}) {
  const userDataDir = options.userDataDir;
  const syncDir = resolveSyncDir(userDataDir);
  if (!syncDir)
    return { written: 0, skipped: true, reason: "missing_user_data_dir" };

  const messages = Array.isArray(options.messages)
    ? options.messages
    : Array.isArray(options.history)
    ? options.history
    : [];

  const rows = [];
  const now = Date.now();
  for (const message of messages) {
    if (!isDurableMessageCandidate(message)) continue;
    rows.push({
      schema: "vchat.message_intent.v1",
      intent_id: `${options.itemType || "unknown"}:${options.itemId || ""}:${
        options.topicId || ""
      }:${message.id}:${checksumJson(message)}`,
      intent_type: "message_upsert",
      item_type: options.itemType,
      item_id: options.itemId,
      topic_id: options.topicId,
      message_id: String(message.id),
      history_path: options.historyPath || null,
      message_checksum: checksumJson(message),
      source: options.source || "history_write",
      created_at: new Date(now).toISOString(),
    });
  }

  if (rows.length === 0) return { written: 0 };

  await fs.ensureDir(syncDir);
  const intentPath = path.join(syncDir, "message_intents.jsonl");
  await fs.appendFile(
    intentPath,
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "utf8"
  );
  return { written: rows.length, intentPath };
}

module.exports = {
  appendMessageIntents,
  isDurableMessageCandidate,
};
