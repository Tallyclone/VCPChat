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
    toolGroup: null,
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

  function applyHistoryMetadata(node, history) {
    if (!node) return null;
    if (!history || typeof history !== "object") {
      delete node.__e3History;
      delete node.dataset.e3History;
      delete node.dataset.e3Role;
      delete node.dataset.e3Editable;
      delete node.dataset.e3Deletable;
      delete node.dataset.e3Regenerable;
      return node;
    }
    // Keep only renderer-safe, logical history metadata on the DOM node. The
    // descriptor is produced by the main process and contains no filesystem
    // paths; the backend still revalidates every reference before mutation.
    node.__e3History = history;
    node.dataset.e3History = "true";
    node.dataset.e3Role = String(history.role || "");
    node.dataset.e3Editable = String(history.canEdit === true);
    node.dataset.e3Deletable = String(history.canDelete === true);
    node.dataset.e3Regenerable = String(history.canRegenerate === true);
    return node;
  }

  function ensureMessage(id, role, history = null, options = {}) {
    const container = list();
    if (!container) return null;
    let node = state.nodes.get(id);
    if (!node) {
      node = global.E3MessageBlock.create(role, id, options);
      state.nodes.set(id, node);
      container.appendChild(node);
    }
    return applyHistoryMetadata(node, history);
  }

  function appendUserMessage(
    text,
    id = safeId("user"),
    generation = state.generation,
    options = {}
  ) {
    if (generation !== state.generation) return null;
    state.currentAssistantId = null;
    state.assistantTexts.clear();
    state.currentThinkingId = null;
    state.toolGroup = null;
    state.thinkingTexts.clear();
    const node = ensureMessage(id, "user", options.history || null, options);
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
    state.toolGroup = null;
    state.currentAssistantId = messageId;
    const nextText = mergeStreamText(state.assistantTexts.get(messageId), text);
    state.assistantTexts.set(messageId, nextText);
    const node = ensureMessage(messageId, "assistant", options.history || null);
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

  function appendMessage(
    role,
    text,
    id = null,
    generation = state.generation,
    options = {}
  ) {
    return role === "user"
      ? appendUserMessage(text, id || safeId("user"), generation, options)
      : appendAssistantMessageText(text, generation, id, {
          ...options,
          streaming: false,
        });
  }

  function appendMessageText(text, generation) {
    return appendAssistantMessageText(text, generation);
  }

  function appendThinking(
    text,
    generation = state.generation,
    messageId = null,
    options = {}
  ) {
    if (generation !== state.generation) return;
    const id = messageId
      ? `thinking:${messageId}`
      : state.currentThinkingId || safeId("thinking");
    state.toolGroup = null;
    let node = state.nodes.get(id);
    if (!node) {
      node = global.E3ThinkingBlock.create("");
      node.dataset.blockId = id;
      state.nodes.set(id, node);
      list()?.appendChild(node);
      state.thinkingTexts.set(id, "");
    }
    applyHistoryMetadata(node, options.history || null);
    state.currentThinkingId = id;
    const nextText = mergeStreamText(state.thinkingTexts.get(id), text);
    state.thinkingTexts.set(id, nextText);
    global.E3ThinkingBlock.update(node, nextText);
    scrollToBottom();
    return id;
  }

  function renderTool(tool, generation = state.generation, options = {}) {
    if (generation !== state.generation) return null;
    const id = String(tool?.id || safeId("tool"));
    const existing = state.nodes.get(id);
    if (existing)
      return applyHistoryMetadata(existing, options.history || null);
    const node = global.E3ToolCard.create({ ...tool, id });
    node.dataset.blockId = id;
    state.nodes.set(id, node);
    state.lastRunningToolId = id;
    applyHistoryMetadata(node, options.history || null);
    const container = list();
    if (!container) return node;
    if (!state.toolGroup) {
      state.toolGroup = document.createElement("div");
      state.toolGroup.className = "tool-group";
      container.appendChild(state.toolGroup);
    }
    state.toolGroup.appendChild(node);
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
    state.toolGroup = null;
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
    state.toolGroup = null;
    list()?.appendChild(global.E3ErrorBlock.create(message, source));
    scrollToBottom();
  }

  function removeNode(node) {
    if (!node) return;
    if (node.classList?.contains("message-block")) {
      global.E3MessageBlock?.cleanupMessageResources?.(node);
    }
    for (const [id, candidate] of state.nodes.entries()) {
      if (candidate !== node) continue;
      state.nodes.delete(id);
      state.assistantTexts.delete(id);
      state.thinkingTexts.delete(id);
      if (state.currentAssistantId === id) state.currentAssistantId = null;
      if (state.currentThinkingId === id) state.currentThinkingId = null;
      if (state.lastRunningToolId === id) state.lastRunningToolId = null;
    }
    node.remove();
  }

  function removeHistoryReference(reference) {
    const fingerprint = String(reference?.fingerprint || "");
    const rowIndex = Number(reference?.rowIndex);
    if (!fingerprint) return 0;
    const nodes = Array.from(
      list()?.querySelectorAll('[data-e3-history="true"]') || []
    ).filter((node) => {
      const current = node.__e3History?.reference;
      return (
        String(current?.fingerprint || "") === fingerprint &&
        (!Number.isInteger(rowIndex) || Number(current?.rowIndex) === rowIndex)
      );
    });
    nodes.forEach(removeNode);
    return nodes.length;
  }

  function reconcileHistoryMetadata(descriptors) {
    const expected = Array.isArray(descriptors) ? descriptors : [];
    const expectedQueues = new Map();
    expected.forEach((history) => {
      const fingerprint = String(history?.reference?.fingerprint || "");
      if (!fingerprint) return;
      if (!expectedQueues.has(fingerprint)) expectedQueues.set(fingerprint, []);
      expectedQueues.get(fingerprint).push(history);
    });

    const nodes = Array.from(
      list()?.querySelectorAll('[data-e3-history="true"]') || []
    );
    const groups = [];
    nodes.forEach((node) => {
      const history = node.__e3History;
      const fingerprint = String(history?.reference?.fingerprint || "");
      const rowIndex = Number(history?.reference?.rowIndex);
      const previous = groups[groups.length - 1];
      if (
        previous &&
        previous.fingerprint === fingerprint &&
        previous.rowIndex === rowIndex
      ) {
        previous.nodes.push(node);
      } else {
        groups.push({ fingerprint, rowIndex, nodes: [node] });
      }
    });

    for (const group of groups) {
      const queue = expectedQueues.get(group.fingerprint);
      const history = queue?.shift() || null;
      if (!history) {
        group.nodes.forEach(removeNode);
        continue;
      }
      group.nodes.forEach((node) => applyHistoryMetadata(node, history));
    }

    return Array.from(expectedQueues.values()).every(
      (queue) => queue.length === 0
    );
  }

  function clearConversation() {
    global.E3MessageContextMenu?.close?.();
    state.currentAssistantId = null;
    state.assistantTexts.clear();
    state.currentThinkingId = null;
    state.thinkingTexts.clear();
    state.lastRunningToolId = null;
    state.toolGroup = null;
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
    removeHistoryReference,
    reconcileHistoryMetadata,
    clearConversation,
    setGeneration,
    resetForWorkspaceSwitch,
    scrollToBottom,
  };
})(window);
