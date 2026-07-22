"use strict";

const crypto = require("crypto");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const MAX_MESSAGE_LENGTH = 200000;

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sessionIdOf(session) {
  return String(
    session?.id || session?.sessionId || session?.chatSessionId || ""
  );
}

function roleOf(message) {
  const role = String(
    message?.role ||
      message?.Role ||
      message?.author ||
      message?.Author ||
      message?.sender ||
      message?.Sender ||
      ""
  )
    .trim()
    .toLowerCase();
  if (["user", "human", "you"].includes(role)) return "user";
  if (["assistant", "ai", "bot", "model", "e3"].includes(role)) {
    return "assistant";
  }
  if (["tool", "function"].includes(role)) return "tool";
  return role;
}

function normalizedPartType(part) {
  return String(part?.type || part?.Type || "text")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
}

function textFromPart(part) {
  if (typeof part === "string") return part;
  if (!isObject(part)) return "";
  const type = normalizedPartType(part);
  if (type && type !== "text") return "";
  for (const key of ["text", "Text", "value", "Value", "content", "Content"]) {
    if (typeof part[key] === "string") return part[key];
  }
  return "";
}

function textSegmentsOf(message) {
  if (!isObject(message)) return [];
  for (const key of [
    "content",
    "Content",
    "blocks",
    "Blocks",
    "parts",
    "Parts",
  ]) {
    const value = message[key];
    if (typeof value === "string") return [value];
    if (Array.isArray(value)) {
      const segments = value.map(textFromPart).filter((text) => text !== "");
      if (segments.length) return segments;
    }
    if (isObject(value)) {
      const text = textFromPart(value);
      if (text !== "") return [text];
    }
  }
  for (const key of ["text", "Text", "value", "Value"]) {
    if (typeof message[key] === "string") return [message[key]];
  }
  return [];
}

function rawMarkdownOf(message) {
  return textSegmentsOf(message).join("\n");
}

function arrayRepresentationsOf(message) {
  if (!isObject(message)) return [];
  return ["content", "Content", "blocks", "Blocks", "parts", "Parts"]
    .filter((key) => Array.isArray(message[key]))
    .map((key) => ({ key, value: message[key] }));
}

function textEditabilityOf(message) {
  const segments = textSegmentsOf(message);
  if (!segments.length) return { editable: false, textBlockCount: 0 };
  const arrays = arrayRepresentationsOf(message);
  for (const representation of arrays) {
    if (
      representation.value.some((part) => {
        if (typeof part === "string") return false;
        if (!isObject(part)) return true;
        return normalizedPartType(part) !== "text";
      })
    ) {
      return { editable: false, textBlockCount: segments.length };
    }
  }
  return { editable: true, textBlockCount: segments.length };
}

function setPartText(part, text) {
  if (typeof part === "string") return text;
  const next = { ...part };
  if (Object.prototype.hasOwnProperty.call(next, "Text")) next.Text = text;
  else if (Object.prototype.hasOwnProperty.call(next, "content"))
    next.content = text;
  else if (Object.prototype.hasOwnProperty.call(next, "Content"))
    next.Content = text;
  else if (Object.prototype.hasOwnProperty.call(next, "value"))
    next.value = text;
  else if (Object.prototype.hasOwnProperty.call(next, "Value"))
    next.Value = text;
  else next.text = text;
  return next;
}

function replaceTextRepresentation(message, key, text) {
  const value = message[key];
  if (typeof value === "string") {
    message[key] = text;
    return true;
  }
  if (Array.isArray(value)) {
    const firstTextIndex = value.findIndex(
      (part) =>
        typeof part === "string" ||
        (isObject(part) && normalizedPartType(part) === "text")
    );
    if (firstTextIndex < 0) return false;
    message[key] = value
      .map((part, index) => {
        const isText =
          typeof part === "string" ||
          (isObject(part) && normalizedPartType(part) === "text");
        if (!isText) return part;
        return index === firstTextIndex ? setPartText(part, text) : null;
      })
      .filter((part) => part !== null);
    return true;
  }
  if (isObject(value) && normalizedPartType(value) === "text") {
    message[key] = setPartText(value, text);
    return true;
  }
  return false;
}

function replaceMessageText(message, text) {
  let replaced = false;
  for (const key of [
    "content",
    "Content",
    "blocks",
    "Blocks",
    "parts",
    "Parts",
  ]) {
    if (Object.prototype.hasOwnProperty.call(message, key)) {
      replaced = replaceTextRepresentation(message, key, text) || replaced;
    }
  }
  if (!replaced) {
    for (const key of ["text", "Text", "value", "Value"]) {
      if (typeof message[key] === "string") {
        message[key] = text;
        replaced = true;
      }
    }
  }
  if (!replaced) throw new Error("该记录没有可安全编辑的文本块");
}

function collectToolLinks(message) {
  const uses = new Set();
  const results = new Set();
  const seen = new Set();

  function addId(target, value) {
    if (value !== undefined && value !== null && String(value)) {
      target.add(String(value));
    }
  }

  function visit(value, keyHint = "") {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, keyHint));
      return;
    }

    const type = normalizedPartType(value);
    const role = roleOf(value);
    const isToolUse = ["tool_use", "tool_call", "tool"].includes(type);
    const isToolResult =
      ["tool_result", "tool_response"].includes(type) || role === "tool";
    if (isToolUse) {
      addId(uses, value.id || value.Id || value.toolId || value.toolCallId);
    }
    if (isToolResult) {
      addId(
        results,
        value.tool_call_id ||
          value.tool_use_id ||
          value.toolUseId ||
          value.toolCallId ||
          value.callId ||
          value.id
      );
    }

    for (const [key, nested] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase().replace(/-/g, "_");
      if (normalizedKey === "tool_calls" && Array.isArray(nested)) {
        nested.forEach((call) => {
          if (isObject(call)) {
            addId(uses, call.id || call.Id || call.toolId || call.toolCallId);
          }
        });
      } else if (
        normalizedKey === "tool_call_id" ||
        normalizedKey === "tool_use_id"
      ) {
        if (isToolResult || role === "tool") addId(results, nested);
      }
      visit(nested, normalizedKey || keyHint);
    }
  }

  visit(message);
  return { uses, results };
}

function fingerprintOf(row) {
  return crypto.createHash("sha256").update(JSON.stringify(row)).digest("hex");
}

function workspaceRootOf(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  return value.trim();
}

function canonicalWorkspaceDirectory(workspaceRoot) {
  const root = workspaceRootOf(workspaceRoot);
  if (!root) return "";
  return crypto.createHash("sha256").update(root).digest("hex").slice(0, 8);
}

function sameWorkspaceRoot(left, right) {
  return workspaceRootOf(left) === workspaceRootOf(right);
}

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function numericToken(message, keys) {
  for (const key of keys) {
    const value = message?.[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0)
      return value;
  }
  const usage = message?.usage || message?.Usage;
  if (isObject(usage)) {
    for (const key of keys) {
      const value = usage[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0)
        return value;
    }
  }
  return 0;
}

function hasOwnTokenField(message, keys) {
  if (!isObject(message)) return false;
  if (keys.some((key) => Object.prototype.hasOwnProperty.call(message, key)))
    return true;
  const usage = message.usage || message.Usage;
  return (
    isObject(usage) &&
    keys.some((key) => Object.prototype.hasOwnProperty.call(usage, key))
  );
}

function metadataForRows(current, rows) {
  // E3 stores the usage snapshot on the last assistant record carrying token
  // fields; it does not store a sum of every historical row. When a mutation
  // removes the only row carrying usage fields, preserve the existing index
  // values rather than inventing zeroes with unproven semantics.
  let tokenRow = null;
  for (const row of rows) {
    if (roleOf(row) !== "assistant") continue;
    if (
      hasOwnTokenField(row, ["input_tokens", "inputTokens", "InputTokens"]) ||
      hasOwnTokenField(row, ["output_tokens", "outputTokens", "OutputTokens"])
    ) {
      tokenRow = row;
    }
  }
  const next = {
    ...current,
    messageCount: rows.length,
    updatedAt: new Date().toISOString(),
  };
  if (tokenRow) {
    next.inputTokens = numericToken(tokenRow, [
      "input_tokens",
      "inputTokens",
      "InputTokens",
    ]);
    next.outputTokens = numericToken(tokenRow, [
      "output_tokens",
      "outputTokens",
      "OutputTokens",
    ]);
  }
  return next;
}

function parseLoadedPayload(payload) {
  if (typeof payload !== "string") return payload;
  const trimmed = payload.trim();
  if (!trimmed || (!trimmed.startsWith("[") && !trimmed.startsWith("{")))
    return payload;
  try {
    return JSON.parse(trimmed);
  } catch (_) {
    return payload;
  }
}

function loadedMessagesOf(payload) {
  if (Array.isArray(payload)) return payload;
  if (!isObject(payload)) return null;
  const candidates = [
    payload.messages,
    payload.Messages,
    payload.history,
    payload.History,
    payload.items,
    payload.Items,
    payload.session?.messages,
    payload.session?.Messages,
  ];
  return candidates.find(Array.isArray) || null;
}

function textsEquivalent(loaded, persisted) {
  const left = String(loaded || "").replace(/\r\n/g, "\n");
  const segments = textSegmentsOf(persisted).map((text) =>
    text.replace(/\r\n/g, "\n")
  );
  return left === segments.join("\n") || left === segments.join("");
}

class E3HistoryCoordinator {
  constructor(options = {}) {
    this.sessionsRoot = path.resolve(
      options.sessionsRoot ||
        path.join(os.homedir(), ".e3", "chatbot", "sessions")
    );
    this.listSessions = options.listSessions;
    this.locks = new Map();
    this.pendingTransactions = new Map();
  }

  _validateSessionId(sessionId) {
    if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) {
      throw new Error("Invalid E3 sessionId");
    }
    return sessionId;
  }

  async _withSessionLock(sessionId, task) {
    const previous = this.locks.get(sessionId) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => {}).then(() => gate);
    this.locks.set(sessionId, tail);
    await previous.catch(() => {});
    try {
      return await task();
    } finally {
      release();
      if (this.locks.get(sessionId) === tail) this.locks.delete(sessionId);
    }
  }

  async _assertRegularFile(filePath, label) {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`${label} 不是受信任的普通文件`);
    }
  }

  async _resolveStorage(sessionId) {
    this._validateSessionId(sessionId);
    if (typeof this.listSessions !== "function") {
      throw new Error("E3 trusted session provider is unavailable");
    }
    const trustedSessions = await this.listSessions();
    const trustedSession = (
      Array.isArray(trustedSessions) ? trustedSessions : []
    ).find((session) => sessionIdOf(session) === sessionId);
    if (!trustedSession) throw new Error("E3 会话不在当前可信工作区列表中");

    const trustedWorkspaceRoot = workspaceRootOf(trustedSession.workspaceRoot);
    if (!trustedWorkspaceRoot) {
      throw new Error("E3 可信会话缺少 workspaceRoot");
    }
    const workspaceName = canonicalWorkspaceDirectory(trustedWorkspaceRoot);
    if (!/^[a-f0-9]{8}$/.test(workspaceName)) {
      throw new Error("E3 工作区目录标识无效");
    }

    const rootStat = await fs.lstat(this.sessionsRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error("E3 会话根目录不可用或不受信任");
    }
    const realRoot = await fs.realpath(this.sessionsRoot);
    const workspaceDir = path.resolve(realRoot, workspaceName);
    if (!isPathInside(realRoot, workspaceDir)) {
      throw new Error("Resolved path escapes the E3 storage root.");
    }
    const workspaceStat = await fs.lstat(workspaceDir);
    if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink()) {
      throw new Error("E3 工作区目录不可用或不受信任");
    }
    const realWorkspaceDir = await fs.realpath(workspaceDir);
    if (!isPathInside(realRoot, realWorkspaceDir)) {
      throw new Error("Resolved path escapes the E3 storage root.");
    }

    const indexPath = path.resolve(realWorkspaceDir, "index.json");
    const jsonlPath = path.resolve(realWorkspaceDir, `${sessionId}.jsonl`);
    if (
      !isPathInside(realRoot, indexPath) ||
      !isPathInside(realWorkspaceDir, indexPath) ||
      !isPathInside(realRoot, jsonlPath) ||
      !isPathInside(realWorkspaceDir, jsonlPath)
    ) {
      throw new Error("Resolved path escapes the E3 storage root.");
    }
    await Promise.all([
      this._assertRegularFile(indexPath, "index.json"),
      this._assertRegularFile(jsonlPath, "会话 JSONL"),
    ]);

    let index;
    try {
      index = JSON.parse(await fs.readFile(indexPath, "utf8"));
    } catch (error) {
      throw new Error(`E3 index.json 解析失败: ${error.message}`);
    }
    if (
      !isObject(index) ||
      !Object.prototype.hasOwnProperty.call(index, sessionId)
    ) {
      throw new Error("E3 index.json 缺少当前会话元数据");
    }
    const entryMetadata = index[sessionId];
    if (
      !isObject(entryMetadata) ||
      String(entryMetadata.id || sessionId) !== sessionId
    ) {
      throw new Error("E3 index.json 会话标识不一致");
    }
    const indexedWorkspaceRoot = workspaceRootOf(entryMetadata.workspaceRoot);
    if (
      !indexedWorkspaceRoot ||
      !sameWorkspaceRoot(trustedWorkspaceRoot, indexedWorkspaceRoot)
    ) {
      throw new Error("E3 会话工作区元数据不一致");
    }

    return {
      sessionId,
      trustedSession,
      workspaceDir: realWorkspaceDir,
      indexPath,
      jsonlPath,
      index,
      entryMetadata,
    };
  }

  async _readSnapshot(sessionId) {
    const storage = await this._resolveStorage(sessionId);
    const [jsonlBuffer, indexBuffer] = await Promise.all([
      fs.readFile(storage.jsonlPath),
      fs.readFile(storage.indexPath),
    ]);
    const rows = [];
    const lines = jsonlBuffer.toString("utf8").split(/\r?\n/);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (!isObject(row)) throw new Error("record is not an object");
        rows.push(row);
      } catch (error) {
        throw new Error(
          `E3 JSONL 第 ${lineIndex + 1} 行解析失败: ${error.message}`
        );
      }
    }
    let index;
    try {
      index = JSON.parse(indexBuffer.toString("utf8"));
    } catch (error) {
      throw new Error(`E3 index.json 解析失败: ${error.message}`);
    }
    if (!isObject(index) || !isObject(index[sessionId])) {
      throw new Error("E3 index.json 缺少当前会话元数据");
    }
    return { ...storage, rows, index, jsonlBuffer, indexBuffer };
  }

  _assertReference(rows, reference) {
    const rowIndex = Number(reference?.rowIndex);
    const fingerprint = String(reference?.fingerprint || "");
    if (
      !Number.isInteger(rowIndex) ||
      rowIndex < 0 ||
      rowIndex >= rows.length
    ) {
      throw new Error("消息位置已失效，请重新加载会话后再试");
    }
    if (!FINGERPRINT_PATTERN.test(fingerprint)) {
      throw new Error("消息指纹无效");
    }
    if (fingerprintOf(rows[rowIndex]) !== fingerprint) {
      throw new Error("消息内容已被其他操作更新，请重新加载会话后再试");
    }
    return rowIndex;
  }

  _assertNoPendingTransaction(sessionId) {
    for (const transaction of this.pendingTransactions.values()) {
      if (transaction.sessionId === sessionId) {
        throw new Error("该会话已有待完成的历史操作");
      }
    }
  }

  _findPreviousHumanPrompt(rows, beforeIndex) {
    for (let index = beforeIndex - 1; index >= 0; index -= 1) {
      const row = rows[index];
      const links = collectToolLinks(row);
      const prompt = rawMarkdownOf(row);
      if (
        roleOf(row) === "user" &&
        prompt.trim() &&
        links.results.size === 0 &&
        links.uses.size === 0
      ) {
        return { index, prompt };
      }
    }
    return null;
  }

  _describeRow(rows, rowIndex, sessionId) {
    const row = rows[rowIndex];
    const role = roleOf(row);
    const links = collectToolLinks(row);
    const editability = textEditabilityOf(row);
    const containsToolData = links.uses.size > 0 || links.results.size > 0;
    const previousPrompt =
      role === "assistant"
        ? this._findPreviousHumanPrompt(rows, rowIndex)
        : null;
    const originalText = rawMarkdownOf(row);
    return {
      sessionId,
      reference: { rowIndex, fingerprint: fingerprintOf(row) },
      role: role || "assistant",
      rawMarkdown: originalText,
      originalText,
      text: originalText,
      textBlockCount: editability.textBlockCount,
      containsToolData,
      canEdit:
        (role === "user" || role === "assistant") &&
        editability.editable &&
        !containsToolData,
      canDelete: true,
      canRegenerate: role === "assistant" && !!previousPrompt,
    };
  }

  async decorateLoadedSession(sessionId, payload) {
    const snapshot = await this._readSnapshot(sessionId);
    const parsedPayload = parseLoadedPayload(payload);
    const messages = loadedMessagesOf(parsedPayload);
    if (!messages) return parsedPayload;

    let persistedCursor = 0;
    for (const message of messages) {
      if (!isObject(message)) continue;
      const loadedRole = roleOf(message);
      const loadedText = rawMarkdownOf(message);
      let matchedIndex = -1;
      for (
        let index = persistedCursor;
        index < snapshot.rows.length;
        index += 1
      ) {
        const row = snapshot.rows[index];
        if (roleOf(row) !== loadedRole) continue;
        if (textsEquivalent(loadedText, row)) {
          matchedIndex = index;
          break;
        }
      }
      if (matchedIndex < 0) continue;
      const description = this._describeRow(
        snapshot.rows,
        matchedIndex,
        sessionId
      );
      // Electron's structured clone only transports enumerable object fields.
      // Keep this renderer-safe descriptor enumerable; it contains no paths.
      Object.defineProperty(message, "__e3History", {
        configurable: true,
        enumerable: true,
        writable: true,
        value: description,
      });
      persistedCursor = matchedIndex + 1;
    }
    return parsedPayload;
  }

  _expandedDeletionIndexes(rows, selectedIndex) {
    const selected = new Set([selectedIndex]);
    const linkedIds = new Set();
    let changed = true;
    while (changed) {
      changed = false;
      for (const index of selected) {
        const links = collectToolLinks(rows[index]);
        for (const id of [...links.uses, ...links.results]) {
          if (!linkedIds.has(id)) {
            linkedIds.add(id);
            changed = true;
          }
        }
      }
      if (!linkedIds.size) break;
      rows.forEach((row, index) => {
        if (selected.has(index)) return;
        const links = collectToolLinks(row);
        const connected = [...links.uses, ...links.results].some((id) =>
          linkedIds.has(id)
        );
        if (connected) {
          selected.add(index);
          changed = true;
        }
      });
    }

    const remainingUses = new Set();
    const remainingResults = new Set();
    rows.forEach((row, index) => {
      if (selected.has(index)) return;
      const links = collectToolLinks(row);
      links.uses.forEach((id) => remainingUses.add(id));
      links.results.forEach((id) => remainingResults.add(id));
    });
    const danglingResult = [...remainingResults].find(
      (id) => !remainingUses.has(id)
    );
    const danglingUse = [...remainingUses].find(
      (id) => !remainingResults.has(id)
    );
    if (danglingResult || danglingUse) {
      throw new Error("删除会破坏工具调用依赖，已拒绝修改");
    }

    return [...selected].sort((a, b) => a - b);
  }

  async _writeDurable(filePath, content) {
    const handle = await fs.open(filePath, "wx");
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async _replaceFile(tempPath, targetPath, transactionId) {
    try {
      await fs.rename(tempPath, targetPath);
      return;
    } catch (error) {
      if (!["EEXIST", "EPERM", "EACCES"].includes(error?.code)) throw error;
    }
    const displacedPath = `${targetPath}.vcpchat-${transactionId}.old`;
    await fs.rename(targetPath, displacedPath);
    try {
      await fs.rename(tempPath, targetPath);
      await fs.rm(displacedPath, { force: true });
    } catch (error) {
      await fs.rm(targetPath, { force: true }).catch(() => {});
      await fs.rename(displacedPath, targetPath).catch(() => {});
      throw error;
    }
  }

  async _writeAndReplace(targetPath, content, transactionId, suffix) {
    const tempPath = `${targetPath}.vcpchat-${transactionId}-${suffix}.tmp`;
    await fs.rm(tempPath, { force: true });
    await this._writeDurable(tempPath, content);
    try {
      await this._replaceFile(
        tempPath,
        targetPath,
        `${transactionId}-${suffix}`
      );
    } finally {
      await fs.rm(tempPath, { force: true }).catch(() => {});
    }
  }

  async _restorePair(transaction) {
    const errors = [];
    try {
      await this._writeAndReplace(
        transaction.jsonlPath,
        transaction.originalJsonl,
        transaction.id,
        "restore-jsonl"
      );
    } catch (error) {
      errors.push(`JSONL: ${error.message}`);
    }
    try {
      await this._writeAndReplace(
        transaction.indexPath,
        transaction.originalIndex,
        transaction.id,
        "restore-index"
      );
    } catch (error) {
      errors.push(`index.json: ${error.message}`);
    }
    if (errors.length)
      throw new Error(`E3 历史回滚不完整：${errors.join("；")}`);
  }

  async _persistRows(snapshot, nextRows, action, details = {}) {
    this._assertNoPendingTransaction(snapshot.sessionId);
    const transactionId = crypto.randomUUID();
    const nextIndex = { ...snapshot.index };
    nextIndex[snapshot.sessionId] = metadataForRows(
      snapshot.index[snapshot.sessionId],
      nextRows
    );
    const nextJsonl = Buffer.from(
      nextRows.length
        ? `${nextRows.map((row) => JSON.stringify(row)).join("\r\n")}\r\n`
        : "",
      "utf8"
    );
    const nextIndexBuffer = Buffer.from(JSON.stringify(nextIndex), "utf8");
    const jsonlTemp = `${snapshot.jsonlPath}.vcpchat-${transactionId}.tmp`;
    const indexTemp = `${snapshot.indexPath}.vcpchat-${transactionId}.tmp`;
    const jsonlBackup = `${snapshot.jsonlPath}.vcpchat-${transactionId}.bak`;
    const indexBackup = `${snapshot.indexPath}.vcpchat-${transactionId}.bak`;
    const transaction = {
      id: transactionId,
      action,
      sessionId: snapshot.sessionId,
      jsonlPath: snapshot.jsonlPath,
      indexPath: snapshot.indexPath,
      jsonlBackup,
      indexBackup,
      originalJsonl: snapshot.jsonlBuffer,
      originalIndex: snapshot.indexBuffer,
      persistedMessageCount: nextRows.length,
      details,
      createdAt: Date.now(),
    };

    await Promise.all([
      this._writeDurable(jsonlTemp, nextJsonl),
      this._writeDurable(indexTemp, nextIndexBuffer),
      this._writeDurable(jsonlBackup, snapshot.jsonlBuffer),
      this._writeDurable(indexBackup, snapshot.indexBuffer),
    ]);
    try {
      await this._replaceFile(
        jsonlTemp,
        snapshot.jsonlPath,
        `${transactionId}-jsonl`
      );
      await this._replaceFile(
        indexTemp,
        snapshot.indexPath,
        `${transactionId}-index`
      );
    } catch (error) {
      await this._restorePair(transaction).catch((restoreError) => {
        error.message += `；${restoreError.message}`;
      });
      await Promise.all([
        fs.rm(jsonlBackup, { force: true }).catch(() => {}),
        fs.rm(indexBackup, { force: true }).catch(() => {}),
      ]);
      throw error;
    } finally {
      await Promise.all([
        fs.rm(jsonlTemp, { force: true }).catch(() => {}),
        fs.rm(indexTemp, { force: true }).catch(() => {}),
      ]);
    }

    this.pendingTransactions.set(transactionId, transaction);
    return {
      transactionId,
      action,
      sessionId: snapshot.sessionId,
      messageCount: nextRows.length,
      ...details,
    };
  }

  async editMessage(sessionId, reference, newText, options = {}) {
    this._validateSessionId(sessionId);
    if (typeof newText !== "string" || newText.length > MAX_MESSAGE_LENGTH) {
      throw new Error("编辑后的消息必须是 200000 字符以内的文本");
    }
    return await this._withSessionLock(sessionId, async () => {
      const snapshot = await this._readSnapshot(sessionId);
      const rowIndex = this._assertReference(snapshot.rows, reference);
      const row = snapshot.rows[rowIndex];
      const role = roleOf(row);
      const links = collectToolLinks(row);
      const editability = textEditabilityOf(row);
      if (
        (role !== "user" && role !== "assistant") ||
        !editability.editable ||
        links.uses.size > 0 ||
        links.results.size > 0
      ) {
        throw new Error("该消息包含工具或非文本块，无法安全编辑");
      }
      const nextRows = snapshot.rows.map((row) =>
        JSON.parse(JSON.stringify(row))
      );
      replaceMessageText(nextRows[rowIndex], newText);
      const result = await this._persistRows(snapshot, nextRows, "edit", {
        rowIndex,
      });
      if (options.deferCommit === true) {
        return { ...result, committed: false };
      }
      const commitResult = await this._commitUnlocked(
        result.transactionId,
        sessionId
      );
      return { ...result, ...commitResult };
    });
  }

  async deleteMessage(sessionId, reference, options = {}) {
    this._validateSessionId(sessionId);
    return await this._withSessionLock(sessionId, async () => {
      const snapshot = await this._readSnapshot(sessionId);
      const rowIndex = this._assertReference(snapshot.rows, reference);
      const removedIndexes = this._expandedDeletionIndexes(
        snapshot.rows,
        rowIndex
      );
      const removedSet = new Set(removedIndexes);
      const nextRows = snapshot.rows.filter(
        (_row, index) => !removedSet.has(index)
      );
      const result = await this._persistRows(snapshot, nextRows, "delete", {
        rowIndex,
        removedIndexes,
        removedCount: removedIndexes.length,
      });
      if (options.deferCommit === true) {
        return { ...result, committed: false };
      }
      const commitResult = await this._commitUnlocked(
        result.transactionId,
        sessionId
      );
      return { ...result, ...commitResult };
    });
  }

  async prepareRegeneration(sessionId, reference) {
    this._validateSessionId(sessionId);
    return await this._withSessionLock(sessionId, async () => {
      const snapshot = await this._readSnapshot(sessionId);
      const rowIndex = this._assertReference(snapshot.rows, reference);
      if (roleOf(snapshot.rows[rowIndex]) !== "assistant") {
        throw new Error("只能重新生成助手回复");
      }
      const previousPrompt = this._findPreviousHumanPrompt(
        snapshot.rows,
        rowIndex
      );
      if (!previousPrompt) throw new Error("找不到可安全重发的上一条用户消息");
      const nextRows = snapshot.rows.slice(0, previousPrompt.index);
      return await this._persistRows(snapshot, nextRows, "regenerate", {
        rowIndex,
        promptRowIndex: previousPrompt.index,
        prompt: previousPrompt.prompt,
        removedCount: snapshot.rows.length - previousPrompt.index,
      });
    });
  }

  async verifyRegeneration(transactionId, sessionId) {
    this._validateSessionId(sessionId);
    return await this._withSessionLock(sessionId, async () => {
      const transaction = this._pendingTransaction(transactionId, sessionId);
      if (transaction.action !== "regenerate") {
        throw new Error("当前事务不是重新生成操作");
      }
      const snapshot = await this._readSnapshot(sessionId);
      const baseline = transaction.persistedMessageCount;
      const indexedCount = Number(snapshot.index[sessionId]?.messageCount);
      if (
        !Number.isInteger(indexedCount) ||
        indexedCount !== snapshot.rows.length
      ) {
        return {
          ready: false,
          reason: "E3 会话索引尚未与历史记录同步",
          messageCount: snapshot.rows.length,
        };
      }

      let promptIndex = -1;
      for (let index = baseline; index < snapshot.rows.length; index += 1) {
        const row = snapshot.rows[index];
        if (
          roleOf(row) === "user" &&
          textsEquivalent(transaction.details.prompt, row)
        ) {
          promptIndex = index;
          break;
        }
      }
      if (promptIndex < 0) {
        return {
          ready: false,
          reason: "重新发送的用户消息尚未持久化",
          messageCount: snapshot.rows.length,
        };
      }

      let responseIndex = -1;
      for (
        let index = promptIndex + 1;
        index < snapshot.rows.length;
        index += 1
      ) {
        const row = snapshot.rows[index];
        if (roleOf(row) !== "assistant") continue;
        const links = collectToolLinks(row);
        if (
          rawMarkdownOf(row).trim() ||
          links.uses.size > 0 ||
          links.results.size > 0
        ) {
          responseIndex = index;
          break;
        }
      }
      if (responseIndex < 0) {
        return {
          ready: false,
          reason: "重新生成的助手回复尚未持久化",
          messageCount: snapshot.rows.length,
          promptIndex,
        };
      }

      return {
        ready: true,
        messageCount: snapshot.rows.length,
        promptIndex,
        responseIndex,
      };
    });
  }

  hasPendingTransaction(transactionId, sessionId) {
    const transaction = this.pendingTransactions.get(
      String(transactionId || "")
    );
    return !!transaction && transaction.sessionId === sessionId;
  }

  _pendingTransaction(transactionId, sessionId) {
    const transaction = this.pendingTransactions.get(
      String(transactionId || "")
    );
    if (!transaction || transaction.sessionId !== sessionId) {
      throw new Error("历史操作事务不存在或已结束");
    }
    return transaction;
  }

  async _commitUnlocked(transactionId, sessionId) {
    const transaction = this._pendingTransaction(transactionId, sessionId);
    const cleanup = await Promise.allSettled([
      fs.rm(transaction.jsonlBackup, { force: true }),
      fs.rm(transaction.indexBackup, { force: true }),
    ]);
    const cleanupWarnings = cleanup
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason?.message || String(result.reason));
    this.pendingTransactions.delete(transaction.id);
    return {
      transactionId: transaction.id,
      committed: true,
      cleanupWarnings,
    };
  }

  async commit(transactionId, sessionId) {
    this._pendingTransaction(transactionId, sessionId);
    return await this._withSessionLock(sessionId, async () =>
      this._commitUnlocked(transactionId, sessionId)
    );
  }

  async _rollbackUnlocked(transactionId, sessionId) {
    const transaction = this._pendingTransaction(transactionId, sessionId);
    await this._restorePair(transaction);
    const cleanup = await Promise.allSettled([
      fs.rm(transaction.jsonlBackup, { force: true }),
      fs.rm(transaction.indexBackup, { force: true }),
    ]);
    const cleanupWarnings = cleanup
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason?.message || String(result.reason));
    this.pendingTransactions.delete(transaction.id);
    return {
      transactionId: transaction.id,
      rolledBack: true,
      cleanupWarnings,
    };
  }

  async rollback(transactionId, sessionId) {
    this._pendingTransaction(transactionId, sessionId);
    return await this._withSessionLock(sessionId, async () =>
      this._rollbackUnlocked(transactionId, sessionId)
    );
  }

  async rollbackAll() {
    const transactions = [...this.pendingTransactions.values()];
    const results = [];
    for (const transaction of transactions) {
      try {
        results.push(
          await this.rollback(transaction.id, transaction.sessionId)
        );
      } catch (error) {
        results.push({
          transactionId: transaction.id,
          rolledBack: false,
          error: error.message,
        });
      }
    }
    return results;
  }
}

module.exports = E3HistoryCoordinator;
