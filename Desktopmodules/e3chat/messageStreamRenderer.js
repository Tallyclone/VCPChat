"use strict";

(function (global) {
  const state = {
    nodes: new Map(),
    questionRequestId: null,
    currentAssistantId: null,
    assistantTexts: new Map(),
    currentThinkingId: null,
    thinkingTexts: new Map(),
    lastRunningToolId: null,
    generation: 0,
  };

  function list() {
    return document.getElementById("message-list");
  }

  function scrollToBottom() {
    const container = list();
    if (container) container.scrollTop = container.scrollHeight;
  }

  function safeId(prefix) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function ensureMessage(id, role) {
    const container = list();
    if (!container) return null;
    let node = state.nodes.get(id);
    if (!node) {
      node = global.E3MessageBlock.create(role, id);
      state.nodes.set(id, node);
      container.appendChild(node);
    }
    return node;
  }

  function appendUserMessage(
    text,
    id = safeId("user"),
    generation = state.generation
  ) {
    if (generation !== state.generation) return null;
    state.currentAssistantId = null;
    state.assistantTexts.clear();
    state.currentThinkingId = null;
    state.thinkingTexts.clear();
    const node = ensureMessage(id, "user", text);
    if (node) global.E3MessageBlock.update(node, text);
    scrollToBottom();
    return id;
  }

  function mergeStreamText(current, incoming) {
    const previous = String(current ?? "");
    const chunk = String(incoming ?? "");
    if (!chunk) return previous;
    if (!previous) return chunk;
    if (chunk === previous) return previous;

    // E3 versions may emit either deltas or the full accumulated snapshot.
    if (chunk.length > previous.length && chunk.startsWith(previous))
      return chunk;
    if (previous.length > chunk.length && previous.startsWith(chunk))
      return previous;
    return `${previous}${chunk}`;
  }

  function appendAssistantMessageText(
    text,
    generation = state.generation,
    id = null,
    options = {}
  ) {
    if (generation !== state.generation) return null;
    const messageId = id || state.currentAssistantId || safeId("assistant");
    state.currentAssistantId = messageId;
    const nextText = mergeStreamText(state.assistantTexts.get(messageId), text);
    state.assistantTexts.set(messageId, nextText);
    const node = ensureMessage(messageId, "assistant", nextText);
    if (node)
      global.E3MessageBlock.update(node, nextText, {
        streaming: options.streaming !== false,
      });
    scrollToBottom();
    return messageId;
  }

  function finalizeCurrentAssistant(generation = state.generation) {
    if (generation !== state.generation) return null;
    const messageId = state.currentAssistantId;
    if (!messageId) return null;
    const node = state.nodes.get(messageId);
    const text = state.assistantTexts.get(messageId) || "";
    if (node) global.E3MessageBlock.update(node, text, { streaming: false });
    scrollToBottom();
    return messageId;
  }

  function appendMessage(role, text, id = null, generation = state.generation) {
    return role === "user"
      ? appendUserMessage(text, id || safeId("user"), generation)
      : appendAssistantMessageText(text, generation, id, { streaming: false });
  }

  function appendMessageText(text, generation) {
    return appendAssistantMessageText(text, generation);
  }

  function appendThinking(
    text,
    generation = state.generation,
    messageId = null
  ) {
    if (generation !== state.generation) return;
    const id = messageId
      ? `thinking:${messageId}`
      : state.currentThinkingId || safeId("thinking");
    let node = state.nodes.get(id);
    if (!node) {
      node = global.E3ThinkingBlock.create("");
      node.dataset.blockId = id;
      state.nodes.set(id, node);
      list()?.appendChild(node);
      state.thinkingTexts.set(id, "");
    }
    state.currentThinkingId = id;
    const nextText = mergeStreamText(state.thinkingTexts.get(id), text);
    state.thinkingTexts.set(id, nextText);
    global.E3ThinkingBlock.update(node, nextText);
    scrollToBottom();
    return id;
  }

  function renderTool(tool, generation = state.generation) {
    if (generation !== state.generation) return null;
    const id = String(tool?.id || safeId("tool"));
    const existing = state.nodes.get(id);
    if (existing) return existing;
    const node = global.E3ToolCard.create({ ...tool, id });
    node.dataset.blockId = id;
    state.nodes.set(id, node);
    state.lastRunningToolId = id;
    list()?.appendChild(node);
    scrollToBottom();
    return node;
  }

  function finalizeToolResult(
    toolId,
    result,
    status,
    isError,
    generation = state.generation
  ) {
    if (generation !== state.generation) return;
    const requestedId = String(toolId || "");
    const id = requestedId || state.lastRunningToolId || safeId("tool-result");
    let node =
      state.nodes.get(id) ||
      Array.from(document.querySelectorAll("[data-tool-id]")).find(
        (el) => el.dataset.toolId === id
      );
    if (!node)
      node = renderTool({ id, name: "E3 工具调用", input: null }, generation);
    if (node) global.E3ToolCard.update(node, result, status, isError);
    if (state.lastRunningToolId === id) state.lastRunningToolId = null;
    scrollToBottom();
  }

  function renderQuestion(event, submit, generation) {
    if (generation !== state.generation) return;
    const host = document.getElementById("pending-question");
    if (!host) return;
    host.replaceChildren();
    host.hidden = false;
    host.appendChild(global.E3QuestionCard.create(event, submit));
    state.questionRequestId = event.requestId;
    scrollToBottom();
  }

  function clearQuestion() {
    const host = document.getElementById("pending-question");
    if (host) {
      host.replaceChildren();
      host.hidden = true;
    }
    state.questionRequestId = null;
  }

  function showError(message, source, generation) {
    if (generation !== state.generation) return;
    list()?.appendChild(global.E3ErrorBlock.create(message, source));
    scrollToBottom();
  }

  function clearConversation() {
    state.currentAssistantId = null;
    state.assistantTexts.clear();
    state.currentThinkingId = null;
    state.thinkingTexts.clear();
    state.lastRunningToolId = null;
    clearQuestion();
    const container = list();
    if (container) {
      // Match VChat: release each message's animation and scoped-style resources
      // before removing its DOM, then keep a global style cleanup as a fallback.
      container.querySelectorAll(".message-block").forEach((messageElement) => {
        global.E3MessageBlock?.cleanupMessageResources?.(messageElement);
      });
      global.E3MessageBlock?.cleanupScopedStyles?.();
      container.replaceChildren();
    }
    state.nodes.clear();
  }

  function setGeneration(nextGeneration, options = {}) {
    const parsed = Number(nextGeneration);
    if (!Number.isFinite(parsed)) return state.generation;
    const changed = parsed !== state.generation;
    state.generation = parsed;
    if (changed && options.clear) clearConversation();
    return state.generation;
  }

  function resetForWorkspaceSwitch(nextGeneration = null) {
    if (nextGeneration === null || nextGeneration === undefined)
      state.generation += 1;
    else setGeneration(nextGeneration);
    clearConversation();
  }

  global.E3MessageStreamRenderer = {
    state,
    mergeStreamText,
    appendUserMessage,
    appendAssistantMessageText,
    finalizeCurrentAssistant,
    appendMessage,
    appendMessageText,
    appendThinking,
    renderTool,
    finalizeToolResult,
    renderQuestion,
    clearQuestion,
    showError,
    clearConversation,
    setGeneration,
    resetForWorkspaceSwitch,
    scrollToBottom,
  };
})(window);
