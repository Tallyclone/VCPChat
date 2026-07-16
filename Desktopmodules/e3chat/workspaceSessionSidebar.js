"use strict";
(function (global) {
  const state = {
    activeSessionId: null,
    sessions: [],
  };

  function sessionIdOf(session) {
    return String(
      session?.id || session?.sessionId || session?.chatSessionId || ""
    );
  }

  function titleOf(session) {
    return (
      session?.title ||
      session?.name ||
      session?.summary ||
      sessionIdOf(session) ||
      "未命名会话"
    );
  }

  function countOf(session) {
    return (
      session?.messageCount ??
      session?.messagesCount ??
      session?.messages?.length ??
      0
    );
  }

  function getActiveSessionId() {
    return state.activeSessionId;
  }

  function setActiveSessionId(sessionId) {
    state.activeSessionId = sessionId ? String(sessionId) : null;
    document.querySelectorAll(".session-item").forEach((item) => {
      item.classList.toggle(
        "active",
        item.dataset.sessionId === state.activeSessionId
      );
    });
  }

  function startNewSession() {
    setActiveSessionId(null);
    global.E3MessageStreamRenderer.clearConversation();
  }

  function parseJsonContainer(value) {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    if (!trimmed || (!trimmed.startsWith("[") && !trimmed.startsWith("{")))
      return value;
    try {
      return JSON.parse(trimmed);
    } catch (_) {
      return value;
    }
  }

  function normalizeMessages(payload) {
    const normalized = parseJsonContainer(payload);
    if (Array.isArray(normalized)) return normalized;
    const candidates = [
      normalized?.messages,
      normalized?.Messages,
      normalized?.history,
      normalized?.History,
      normalized?.items,
      normalized?.Items,
      normalized?.session?.messages,
      normalized?.session?.Messages,
    ];
    for (const candidate of candidates) {
      const parsed = parseJsonContainer(candidate);
      if (Array.isArray(parsed)) return parsed;
    }
    return [];
  }

  function roleOf(message) {
    const role = String(
      message?.role ||
        message?.Role ||
        message?.author ||
        message?.Author ||
        message?.sender ||
        message?.Sender ||
        message?.type ||
        message?.Type ||
        "assistant"
    ).toLowerCase();
    if (role.includes("user") || role.includes("human")) return "user";
    return "assistant";
  }

  function textOf(value, seen = new Set()) {
    if (typeof value === "string") {
      const parsed = parseJsonContainer(value);
      return parsed === value ? value : textOf(parsed, seen);
    }
    if (value === null || value === undefined || typeof value !== "object")
      return "";
    if (seen.has(value)) return "";
    seen.add(value);
    if (Array.isArray(value))
      return value
        .map((item) => textOf(item, seen))
        .filter(Boolean)
        .join("");

    const directKeys = ["text", "Text", "value", "Value", "html", "Html"];
    for (const key of directKeys) {
      if (typeof value[key] === "string") return value[key];
    }

    const nestedKeys = [
      "content",
      "Content",
      "parts",
      "Parts",
      "blocks",
      "Blocks",
      "message",
      "Message",
      "data",
      "Data",
    ];
    for (const key of nestedKeys) {
      if (value[key] !== undefined) {
        const nested = textOf(value[key], seen);
        if (nested) return nested;
      }
    }
    return "";
  }

  function renderHistoryMessage(message, messageIndex) {
    const renderer = global.E3MessageStreamRenderer;
    const generation = renderer.state.generation;
    const role = roleOf(message);
    const messageId = String(
      message?.id ||
        message?.Id ||
        message?.messageId ||
        message?.MessageId ||
        `history-${messageIndex}`
    );
    const blocks = Array.isArray(message?.blocks)
      ? message.blocks
      : Array.isArray(message?.Blocks)
      ? message.Blocks
      : Array.isArray(message?.content)
      ? message.content
      : Array.isArray(message?.Content)
      ? message.Content
      : [message];

    blocks.forEach((block, blockIndex) => {
      const type = String(block?.type || block?.Type || "text").toLowerCase();
      const blockId = `${messageId}:block:${blockIndex}`;
      if (type === "thinking" || type === "reasoning") {
        const content = textOf(block);
        if (content) renderer.appendThinking(content, generation, blockId);
        return;
      }
      if (type === "tool" || type === "tool-call" || type === "tool_use") {
        const toolId = String(block?.id || block?.toolId || blockId);
        const status = String(block?.status || "success");
        const normalizedStatus = status.toLowerCase();
        const isError =
          block?.isError === true ||
          block?.isError === "true" ||
          normalizedStatus.includes("error") ||
          normalizedStatus === "failed";
        renderer.renderTool(
          {
            id: toolId,
            name: block?.name || block?.toolName || "unknown",
            input: block?.input ?? block?.arguments ?? null,
            status: normalizedStatus === "running" ? "running" : status,
          },
          generation
        );
        if (
          normalizedStatus !== "running" ||
          block?.result !== undefined ||
          block?.content !== undefined
        ) {
          renderer.finalizeToolResult(
            toolId,
            block?.result ?? block?.content ?? "",
            status,
            isError,
            generation
          );
        }
        return;
      }

      const content = textOf(block);
      if (!content) return;
      renderer.appendMessage(role, content, blockId, generation);
    });
  }

  async function loadSessionIntoView(sessionId) {
    const messages = await window.e3chat.loadSession(sessionId);
    setActiveSessionId(sessionId);
    // 切换会话不会建立新的 SignalR 连接，不能递增 connectionGeneration。
    // 否则当前连接后续的 message/thinking/tool 事件都会被误判为旧事件。
    global.E3MessageStreamRenderer.clearConversation();
    normalizeMessages(messages).forEach(renderHistoryMessage);
  }

  async function renderSessions(options = {}) {
    const host = document.getElementById("session-list");
    if (!host || !window.e3chat) return;
    const previousActiveId = state.activeSessionId;
    host.textContent = "加载中…";
    try {
      const sessions = Array.isArray(options.sessions)
        ? options.sessions
        : await window.e3chat.listSessions();
      state.sessions = Array.isArray(sessions) ? sessions : [];
      host.innerHTML = "";
      if (!state.sessions.length) {
        const empty = document.createElement("div");
        empty.className = "session-empty";
        empty.textContent = "暂无会话，发送消息或点击“新建会话”开始。";
        host.appendChild(empty);
      }
      state.sessions.forEach((session) => {
        const sessionId = sessionIdOf(session);
        if (!sessionId) return;
        const item = document.createElement("button");
        item.type = "button";
        item.className = "session-item";
        item.dataset.sessionId = sessionId;
        item.textContent = `${titleOf(session)} (${countOf(session)})`;
        item.addEventListener("click", async () =>
          loadSessionIntoView(sessionId)
        );
        host.appendChild(item);
      });
      const hasExplicitSelection = Object.prototype.hasOwnProperty.call(
        options,
        "selectSessionId"
      );
      const firstSessionId = state.sessions.length
        ? sessionIdOf(state.sessions[0])
        : null;
      const nextActiveId = hasExplicitSelection
        ? options.selectSessionId
        : options.preserveSelection && previousActiveId
        ? previousActiveId
        : options.allowNoSelection
        ? null
        : firstSessionId;
      setActiveSessionId(nextActiveId);
      if (options.loadSelection && nextActiveId) {
        await loadSessionIntoView(nextActiveId);
      }
    } catch (error) {
      host.textContent = error.message;
    }
  }

  global.E3WorkspaceSidebar = {
    renderSessions,
    loadSessionIntoView,
    getActiveSessionId,
    setActiveSessionId,
    startNewSession,
    state,
  };
})(window);
