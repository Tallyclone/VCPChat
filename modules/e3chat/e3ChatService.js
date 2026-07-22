"use strict";

const EventEmitter = require("events");
const path = require("path");
const E3BackendDiscovery = require("./e3BackendDiscovery");
const E3SignalRClient = require("./e3SignalRClient");
const E3ProtocolDiagnostics = require("./e3ProtocolDiagnostics");
const E3LocalStateStore = require("./e3LocalStateStore");
const E3SessionRepository = require("./e3SessionRepository");
const E3SessionSyncService = require("./e3SessionSyncService");
const E3WorkspaceCoordinator = require("./e3WorkspaceCoordinator");
const E3ViewportBridge = require("./e3ViewportBridge");
const E3HistoryCoordinator = require("./e3HistoryCoordinator");
const {
  normalizeHubEvent,
  normalizeInvocationFailure,
} = require("./e3EventNormalizer");

const REGENERATION_COMPLETION_TIMEOUT_MS = 10 * 60 * 1000;
const REGENERATION_PERSIST_TIMEOUT_MS = 15 * 1000;
const REGENERATION_POLL_INTERVAL_MS = 250;
const GENERATION_CANCEL_SETTLE_TIMEOUT_MS = 3000;

const CHAT_EVENTS = new Set([
  "chat-message",
  "chat-thinking",
  "chat-tool-call",
  "chat-tool-result",
  "chat-done",
  "chat-error",
  "chat-ask-question",
]);

function sessionIdOf(session) {
  return session?.id || session?.sessionId || session?.chatSessionId || null;
}

function timestampOf(session) {
  const value =
    session?.updatedAt ||
    session?.lastMessageAt ||
    session?.createdAt ||
    session?.time ||
    session?.timestamp;
  const time = value ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : 0;
}

function newestSessionId(sessions) {
  if (!Array.isArray(sessions) || !sessions.length) return null;
  const sorted = [...sessions].sort((a, b) => timestampOf(b) - timestampOf(a));
  return sessionIdOf(sorted[0]);
}

function newSessionId(beforeSessions, afterSessions) {
  const beforeIds = new Set(
    (Array.isArray(beforeSessions) ? beforeSessions : [])
      .map(sessionIdOf)
      .filter(Boolean)
  );
  const created = (Array.isArray(afterSessions) ? afterSessions : []).filter(
    (session) => {
      const id = sessionIdOf(session);
      return id && !beforeIds.has(id);
    }
  );
  return newestSessionId(created);
}

function resultSessionId(result) {
  if (!result || typeof result !== "object") return null;
  return (
    result.activeSessionId ||
    result.sessionId ||
    result.id ||
    result.chatSessionId ||
    null
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildMessageContent(content, attachments) {
  let message = typeof content === "string" ? content.trim() : "";
  const files = Array.isArray(attachments) ? attachments.slice(0, 10) : [];
  for (const attachment of files) {
    const name = String(attachment?.name || "未命名文件");
    const filePath = String(attachment?.internalPath || "");
    const extractedText =
      typeof attachment?.extractedText === "string"
        ? attachment.extractedText.slice(0, 50000)
        : "";
    message += `\n\n[附加文件: ${filePath || name}]`;
    if (extractedText) message += `\n${extractedText}`;
    message += `\n[/附加文件结束: ${name}]`;
  }
  return message.trim();
}

class E3ChatService extends EventEmitter {
  constructor(options = {}) {
    super();
    this.projectRoot = options.projectRoot || process.cwd();
    this.stateStore = new E3LocalStateStore({
      baseDir: path.join(this.projectRoot, "AppData", "E3Chat"),
    });
    this.diagnostics = new E3ProtocolDiagnostics();
    this.discovery = new E3BackendDiscovery({
      stateStore: this.stateStore,
      diagnostics: this.diagnostics,
    });
    this.workspace = new E3WorkspaceCoordinator();
    this.client = null;
    this.baseUrl = null;
    this.source = null;
    this.pendingQuestions = new Set();
    this.viewport = new E3ViewportBridge({ diagnostics: this.diagnostics });
    this.repository = new E3SessionRepository(() => this.client);
    this.syncService = new E3SessionSyncService({
      repository: this.repository,
      diagnostics: this.diagnostics,
    });
    this.history = new E3HistoryCoordinator({
      sessionsRoot: options.sessionsRoot,
      listSessions: () => this.repository.listSessions(),
    });
    this.activeGeneration = null;
    this.pendingRegeneration = null;
  }

  status() {
    const active = this.activeGeneration;
    return {
      connected: !!this.client?.connected,
      baseUrl: this.baseUrl,
      source: this.source,
      workspace: this.workspace.current(),
      generation: active
        ? {
            active: true,
            kind: active.kind,
            sessionId: active.sessionId,
            cancelRequested: active.cancelRequested === true,
          }
        : { active: false },
      pendingRegeneration: this.pendingRegeneration
        ? {
            sessionId: this.pendingRegeneration.sessionId,
            startedAt: this.pendingRegeneration.startedAt,
          }
        : null,
    };
  }

  emitEvent(event) {
    this.emit("event", event);
  }

  _assertMutationIdle(sessionId) {
    if (this.activeGeneration) {
      throw new Error("E3 正在生成回复，当前不能修改历史消息");
    }
    if (
      this.pendingRegeneration &&
      this.pendingRegeneration.sessionId === sessionId
    ) {
      throw new Error("该会话正在重新生成回复");
    }
  }

  _clearActiveGeneration(token) {
    if (!this.activeGeneration || this.activeGeneration.token !== token) return;
    clearTimeout(this.activeGeneration.timeout);
    this.activeGeneration = null;
  }

  _beginGeneration(sessionId, kind = "send") {
    if (this.activeGeneration) {
      throw new Error("E3 已有正在进行的生成任务");
    }
    const token = `${kind}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}`;
    let resolveCompletion;
    const completion = new Promise((resolve) => {
      resolveCompletion = resolve;
    });
    const timeout = setTimeout(() => {
      this._settleGeneration(
        { type: "timeout", message: "等待 E3 生成完成超时" },
        token
      );
    }, REGENERATION_COMPLETION_TIMEOUT_MS);
    this.activeGeneration = {
      token,
      kind,
      sessionId: sessionId || null,
      completion,
      resolveCompletion,
      timeout,
      settled: false,
      cancelRequested: false,
      result: null,
    };
    return this.activeGeneration;
  }

  _settleGeneration(event, token = null) {
    const active = this.activeGeneration;
    if (!active || (token && active.token !== token) || active.settled) return;
    const settledEvent =
      active.cancelRequested && event?.type === "done"
        ? {
            ...event,
            type: "cancelled",
            cancelled: true,
            message: "E3 生成已取消",
          }
        : event;
    active.settled = true;
    active.result = settledEvent;
    clearTimeout(active.timeout);
    active.resolveCompletion(settledEvent);
    if (active.kind !== "regenerate") this.activeGeneration = null;
  }

  async _waitForGenerationCompletion(active) {
    const event = await active.completion;
    if (event?.type !== "done") {
      throw new Error(event?.message || "E3 生成未成功完成");
    }
    return event;
  }

  async _cancelActiveGeneration(active) {
    if (!active || active.settled) return active?.result || null;
    if (!this.client?.connected) {
      this._settleGeneration(
        { type: "connection-lost", message: "E3 SignalR 连接已断开" },
        active.token
      );
      return active.result;
    }
    active.cancelRequested = true;
    try {
      await this.client.send("CancelChat");
    } catch (error) {
      const event = normalizeInvocationFailure(
        "CancelChat",
        error,
        this.workspace.current()
      );
      this._settleGeneration(event, active.token);
      throw error;
    }
    await Promise.race([
      active.completion,
      delay(GENERATION_CANCEL_SETTLE_TIMEOUT_MS),
    ]);
    if (!active.settled) {
      this._settleGeneration(
        { type: "cancelled", cancelled: true, message: "E3 生成已取消" },
        active.token
      );
    }
    return active.result;
  }

  async _reloadDecoratedSession(sessionId) {
    const loaded = await this.repository.loadSession(sessionId);
    return await this.history.decorateLoadedSession(sessionId, loaded);
  }

  async _rollbackRegeneration(transactionId, sessionId) {
    const pending = this.pendingRegeneration;
    if (
      !pending ||
      pending.transactionId !== transactionId ||
      pending.sessionId !== sessionId
    ) {
      if (this.history.hasPendingTransaction(transactionId, sessionId)) {
        throw new Error("重新生成事务与当前恢复状态不匹配");
      }
      return {
        transactionId,
        rolledBack: false,
        session: await this._reloadDecoratedSession(sessionId),
      };
    }
    if (pending.rollbackPromise) return await pending.rollbackPromise;

    pending.rollbackPromise = (async () => {
      let rollback = { transactionId, rolledBack: false };
      if (this.history.hasPendingTransaction(transactionId, sessionId)) {
        rollback = await this.history.rollback(transactionId, sessionId);
      }
      let session = null;
      let reloadWarning = null;
      try {
        session = await this._reloadDecoratedSession(sessionId);
      } catch (error) {
        reloadWarning = error.message;
      }
      if (this.pendingRegeneration === pending) {
        this.pendingRegeneration = null;
      }
      return { ...rollback, session, reloadWarning };
    })();

    try {
      return await pending.rollbackPromise;
    } catch (error) {
      pending.rollbackPromise = null;
      pending.rollbackError = error.message;
      throw error;
    }
  }

  async _mutateAndReload(sessionId, mutate) {
    this._assertMutationIdle(sessionId);
    const result = await mutate();
    try {
      const session = await this._reloadDecoratedSession(sessionId);
      const commit = await this.history.commit(result.transactionId, sessionId);
      return { ...result, ...commit, session };
    } catch (error) {
      if (this.history.hasPendingTransaction(result.transactionId, sessionId)) {
        try {
          await this.history.rollback(result.transactionId, sessionId);
          await this.repository.loadSession(sessionId).catch(() => {});
        } catch (rollbackError) {
          error.message += `；历史回滚失败：${rollbackError.message}`;
        }
      }
      throw error;
    }
  }

  async connect(options = {}) {
    await this.disconnect(false);
    this.emitEvent({
      type: "connection",
      state: "connecting",
      receivedAt: new Date().toISOString(),
    });
    const discovered = await this.discovery.discover(options.baseUrl);
    this.baseUrl = discovered.baseUrl;
    this.source = discovered.source;
    this.client = new E3SignalRClient({
      baseUrl: this.baseUrl,
      hubKey: "dev",
      diagnostics: this.diagnostics,
    });
    this.bindClient(this.client);
    this.client.registerRemote("draw_objects", (body) =>
      this.viewport.remoteCall("draw_objects", body, this.baseUrl)
    );
    this.client.registerRemote("draw_objects_agent", (body) =>
      this.viewport.remoteCall("draw_objects_agent", body, this.baseUrl)
    );
    this.client.registerRemote("clear", (body) =>
      this.viewport.remoteCall("clear", body, this.baseUrl)
    );
    this.client.registerRemote("view_capture", (body) =>
      this.viewport.remoteCall("view_capture", body, this.baseUrl)
    );
    await this.client.connect();
    let sync = { sessions: [], workspaceIdentity: "unknown", roots: [] };
    try {
      sync = await this.syncService.refresh();
    } catch (error) {
      this.diagnostics.add(
        "warn",
        "Initial ListChatSessions failed",
        error.message
      );
    }
    const root =
      sync.workspaceIdentity && sync.workspaceIdentity !== "unknown"
        ? sync.workspaceIdentity
        : null;
    const context = this.workspace.nextGeneration(root);
    this.emitEvent({
      type: "connection",
      state: "connected",
      baseUrl: this.baseUrl,
      workspace: context,
      sessions: sync.sessions,
      receivedAt: new Date().toISOString(),
    });
    return this.status();
  }

  bindClient(client) {
    client.on("hub-event", (name, ...args) => {
      const context = this.workspace.current();
      this.diagnostics.add("info", `SignalR ${name}`, args);
      const event = normalizeHubEvent(name, args, context);
      if (event.type === "ask-question" && event.requestId)
        this.pendingQuestions.add(event.requestId);
      if (event.type === "done" || event.type === "error") {
        this._settleGeneration(event);
      }
      this.emitEvent(event);
    });
    client.on("connection", (state) => {
      if (state === "disconnected") {
        this._settleGeneration({
          type: "connection-lost",
          message: "E3 SignalR 连接已断开",
        });
      }
      this.emitEvent({
        type: "connection",
        state,
        workspace: this.workspace.current(),
        receivedAt: new Date().toISOString(),
      });
    });
    client.on("error", (error) => {
      this.diagnostics.add("error", "SignalR client error", error.message);
      this._settleGeneration({
        type: "client-error",
        message: error?.message || "E3 SignalR 客户端错误",
      });
    });
  }

  async disconnect(mark = true) {
    const rollbackResults = await this.rollbackPendingHistory();
    const active = this.activeGeneration;
    if (active) this._clearActiveGeneration(active.token);
    if (this.client) await this.client.disconnect();
    this.client = null;
    if (mark)
      this.emitEvent({
        type: "connection",
        state: "disconnected",
        workspace: this.workspace.current(),
        receivedAt: new Date().toISOString(),
      });
    return { disconnected: true, rollbackResults };
  }

  async refreshWorkspace() {
    if (!this.client?.connected) await this.connect();
    const sync = await this.syncService.refresh();
    const current = this.workspace.current();
    const root =
      sync.workspaceIdentity && sync.workspaceIdentity !== "unknown"
        ? sync.workspaceIdentity
        : null;
    if (root && root !== current.root) {
      await this.connect({ baseUrl: this.baseUrl });
      return { switched: true, ...this.status() };
    }
    return { switched: false, sessions: sync.sessions, workspace: current };
  }

  async listSessions() {
    return await this.repository.listSessions();
  }
  async loadSession(sessionId) {
    const loaded = await this.repository.loadSession(sessionId);
    return await this.history.decorateLoadedSession(sessionId, loaded);
  }

  async renameSession(sessionId, title) {
    return await this.repository.renameSession(sessionId, title);
  }

  async editMessage(sessionId, reference, newText) {
    return await this._mutateAndReload(sessionId, () =>
      this.history.editMessage(sessionId, reference, newText, {
        deferCommit: true,
      })
    );
  }

  async deleteMessage(sessionId, reference) {
    return await this._mutateAndReload(sessionId, () =>
      this.history.deleteMessage(sessionId, reference, {
        deferCommit: true,
      })
    );
  }

  async prepareRegeneration(sessionId, reference) {
    this._assertMutationIdle(sessionId);
    if (this.pendingRegeneration) {
      throw new Error("E3 已有正在进行的重新生成任务");
    }
    const startedAt = Date.now();
    const transaction = await this.history.prepareRegeneration(
      sessionId,
      reference
    );
    this.pendingRegeneration = {
      sessionId,
      transactionId: transaction.transactionId,
      startedAt,
      reference,
      rollbackPromise: null,
      rollbackError: null,
    };
    try {
      const session = await this._reloadDecoratedSession(sessionId);
      return { ...transaction, session };
    } catch (error) {
      try {
        await this._rollbackRegeneration(transaction.transactionId, sessionId);
      } catch (rollbackError) {
        error.message += `；历史回滚失败：${rollbackError.message}`;
      }
      throw error;
    }
  }

  async regenerateMessage(sessionId, reference) {
    const prepared = await this.prepareRegeneration(sessionId, reference);
    let active = null;
    try {
      active = this._beginGeneration(sessionId, "regenerate");
      const sendResult = await this.sendMessage(
        prepared.prompt,
        null,
        sessionId,
        active
      );
      const completion = await this._waitForGenerationCompletion(active);
      const deadline = Date.now() + REGENERATION_PERSIST_TIMEOUT_MS;
      let verification = { ready: false };
      while (Date.now() < deadline) {
        verification = await this.history.verifyRegeneration(
          prepared.transactionId,
          sessionId
        );
        if (verification.ready) break;
        await delay(REGENERATION_POLL_INTERVAL_MS);
      }
      if (!verification.ready) {
        throw new Error(verification.reason || "重新生成结果尚未持久化");
      }
      const session = await this._reloadDecoratedSession(sessionId);
      const commit = await this.history.commit(
        prepared.transactionId,
        sessionId
      );
      this.pendingRegeneration = null;
      this._clearActiveGeneration(active.token);
      return {
        ...prepared,
        ...sendResult,
        ...verification,
        ...commit,
        completion,
        session,
      };
    } catch (error) {
      if (active && !active.settled && this.client?.connected) {
        await this._cancelActiveGeneration(active).catch(() => {});
      }
      if (active) this._clearActiveGeneration(active.token);
      try {
        const rollback = await this._rollbackRegeneration(
          prepared.transactionId,
          sessionId
        );
        error.session = rollback.session;
      } catch (rollbackError) {
        error.message += `；历史回滚失败：${rollbackError.message}`;
      }
      throw error;
    }
  }

  async rollbackPendingHistory() {
    const active = this.activeGeneration;
    let cancellationError = null;
    if (active && !active.settled) {
      try {
        await this._cancelActiveGeneration(active);
      } catch (error) {
        cancellationError = error.message;
      }
    }

    const pending = this.pendingRegeneration;
    if (!pending) {
      if (active) this._clearActiveGeneration(active.token);
      return cancellationError
        ? [{ cancelled: false, error: cancellationError }]
        : [];
    }
    try {
      const result = await this._rollbackRegeneration(
        pending.transactionId,
        pending.sessionId
      );
      if (active) this._clearActiveGeneration(active.token);
      return [{ ...result, cancellationError }];
    } catch (error) {
      if (active) this._clearActiveGeneration(active.token);
      return [
        {
          transactionId: pending.transactionId,
          rolledBack: false,
          cancellationError,
          error: error.message,
        },
      ];
    }
  }

  async sendMessage(
    content,
    attachments = null,
    sessionId = null,
    existingGeneration = null
  ) {
    const messageContent = buildMessageContent(content, attachments);
    if (!messageContent || messageContent.length > 200000)
      throw new Error("Invalid message content");
    if (!this.client?.connected)
      throw new Error("E3 SignalR client is not connected");
    const requestedSessionId =
      typeof sessionId === "string" && sessionId.trim()
        ? sessionId.trim()
        : null;
    let active = existingGeneration;
    if (active) {
      if (
        this.activeGeneration !== active ||
        active.settled ||
        (active.sessionId && active.sessionId !== requestedSessionId)
      ) {
        throw new Error("E3 生成状态与发送请求不一致");
      }
    } else {
      active = this._beginGeneration(requestedSessionId, "send");
    }

    try {
      let beforeSessions = [];
      if (!requestedSessionId) {
        try {
          beforeSessions = await this.repository.listSessions();
        } catch (listBeforeError) {
          this.diagnostics.add(
            "warn",
            "ListChatSessions before SendChatMessage failed",
            listBeforeError.message
          );
        }
      }
      if (requestedSessionId) {
        await this.repository.loadSession(requestedSessionId);
      }
      // E3 原生协议的第二参数是 currentSessionId，不是 attachments。
      // 传 null 会明确要求 E3 创建新会话。
      const result = await this.client.invoke(
        "SendChatMessage",
        messageContent,
        requestedSessionId
      );
      let sessions = [];
      let activeSessionId = requestedSessionId || resultSessionId(result);
      const attempts = requestedSessionId || activeSessionId ? 1 : 5;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (attempt > 0) await delay(150 * attempt);
        try {
          const sync = await this.syncService.refresh();
          sessions = sync.sessions;
          activeSessionId =
            activeSessionId || newSessionId(beforeSessions, sessions);
          if (activeSessionId) break;
        } catch (refreshError) {
          this.diagnostics.add(
            "warn",
            "ListChatSessions after SendChatMessage failed",
            refreshError.message
          );
          break;
        }
      }
      if (activeSessionId && !active.sessionId) {
        active.sessionId = activeSessionId;
      }
      if (!activeSessionId && !requestedSessionId) {
        this.diagnostics.add(
          "warn",
          "New E3 chat session was not visible after SendChatMessage",
          { beforeCount: beforeSessions.length, afterCount: sessions.length }
        );
      }
      return {
        result,
        activeSessionId,
        sessionId: activeSessionId,
        requestedSessionId,
        sessions,
        generationToken: active.token,
      };
    } catch (error) {
      const evt = normalizeInvocationFailure(
        "SendChatMessage",
        error,
        this.workspace.current()
      );
      this._settleGeneration(evt, active.token);
      this.emitEvent(evt);
      throw error;
    }
  }

  async cancel() {
    const active = this.activeGeneration;
    const pending = this.pendingRegeneration;
    if (!this.client?.connected && !pending) return { accepted: false };
    try {
      let completion = null;
      if (active) {
        completion = await this._cancelActiveGeneration(active);
      } else if (this.client?.connected && !pending) {
        // CancelChat 是命令型调用；无 invocationId 可避免把服务端内部的
        // OperationCanceledException 误报为取消失败。
        await this.client.send("CancelChat");
      }

      let rollback = null;
      const currentPending = this.pendingRegeneration;
      if (currentPending) {
        rollback = await this._rollbackRegeneration(
          currentPending.transactionId,
          currentPending.sessionId
        );
      }
      if (active) this._clearActiveGeneration(active.token);
      return {
        accepted: true,
        completion,
        ...(rollback || { rolledBack: false, session: null }),
      };
    } catch (error) {
      const evt = normalizeInvocationFailure(
        "CancelChat",
        error,
        this.workspace.current()
      );
      this.emitEvent(evt);
      throw error;
    }
  }

  async shutdown() {
    let disconnectResult = null;
    let disconnectError = null;
    try {
      disconnectResult = await this.disconnect(false);
    } catch (error) {
      disconnectError = error.message;
    }
    const remainingRollbacks = await this.history.rollbackAll();
    const pending = this.pendingRegeneration;
    if (
      pending &&
      !this.history.hasPendingTransaction(
        pending.transactionId,
        pending.sessionId
      )
    ) {
      this.pendingRegeneration = null;
    }
    if (
      disconnectError &&
      remainingRollbacks.some((item) => !item.rolledBack)
    ) {
      throw new Error(
        `E3 断开连接失败：${disconnectError}；仍有历史事务未恢复`
      );
    }
    return { disconnectResult, disconnectError, remainingRollbacks };
  }

  async answerQuestion(requestId, answerPayload) {
    if (!this.pendingQuestions.has(requestId))
      throw new Error("Question requestId is not pending or already answered");
    const payload =
      typeof answerPayload === "string"
        ? answerPayload
        : JSON.stringify(answerPayload);
    try {
      const result = await this.client.invoke(
        "AnswerChatQuestion",
        requestId,
        payload
      );
      this.pendingQuestions.delete(requestId);
      return result;
    } catch (error) {
      const evt = normalizeInvocationFailure(
        "AnswerChatQuestion",
        error,
        this.workspace.current()
      );
      this.emitEvent(evt);
      throw error;
    }
  }

  async getLocalState(scope) {
    return await this.stateStore.get(
      scope || this.workspace.current().identity
    );
  }
  async saveLocalState(scope, patch) {
    return await this.stateStore.patch(
      scope || this.workspace.current().identity,
      patch
    );
  }
  getDiagnostics() {
    return this.diagnostics.list();
  }
}

module.exports = E3ChatService;
