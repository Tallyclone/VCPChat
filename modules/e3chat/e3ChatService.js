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
const {
  normalizeHubEvent,
  normalizeInvocationFailure,
} = require("./e3EventNormalizer");

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
  }

  status() {
    return {
      connected: !!this.client?.connected,
      baseUrl: this.baseUrl,
      source: this.source,
      workspace: this.workspace.current(),
    };
  }

  emitEvent(event) {
    this.emit("event", event);
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
      this.emitEvent(event);
    });
    client.on("connection", (state) =>
      this.emitEvent({
        type: "connection",
        state,
        workspace: this.workspace.current(),
        receivedAt: new Date().toISOString(),
      })
    );
    client.on("error", (error) =>
      this.diagnostics.add("error", "SignalR client error", error.message)
    );
  }

  async disconnect(mark = true) {
    if (this.client) await this.client.disconnect();
    this.client = null;
    if (mark)
      this.emitEvent({
        type: "connection",
        state: "disconnected",
        workspace: this.workspace.current(),
        receivedAt: new Date().toISOString(),
      });
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
    return await this.repository.loadSession(sessionId);
  }
  async renameSession(sessionId, title) {
    return await this.repository.renameSession(sessionId, title);
  }

  async sendMessage(content, attachments = null, sessionId = null) {
    const messageContent = buildMessageContent(content, attachments);
    if (!messageContent || messageContent.length > 200000)
      throw new Error("Invalid message content");
    if (!this.client?.connected)
      throw new Error("E3 SignalR client is not connected");
    const requestedSessionId =
      typeof sessionId === "string" && sessionId.trim()
        ? sessionId.trim()
        : null;
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
      };
    } catch (error) {
      const evt = normalizeInvocationFailure(
        "SendChatMessage",
        error,
        this.workspace.current()
      );
      this.emitEvent(evt);
      throw error;
    }
  }

  async cancel() {
    try {
      // CancelChat 是命令型调用：服务端已完成取消后可能因内部
      // OperationCanceledException 返回 invocation error。无需等待 completion，
      // 使用无 invocationId 的 SignalR 发送可避免把“已取消”误报成失败。
      return await this.client.send("CancelChat");
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
