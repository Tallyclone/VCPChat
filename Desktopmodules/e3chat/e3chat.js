"use strict";

(async function () {
  const api = window.e3chat;
  let chatRunning = false;
  let cancelPending = false;
  let attachments = [];
  const generation = () => window.E3MessageStreamRenderer.state.generation;
  const eventGeneration = (event) => {
    const parsed = Number(event?.connectionGeneration);
    return Number.isFinite(parsed) ? parsed : generation();
  };

  function renderAttachments() {
    const host = document.getElementById("attachment-preview");
    if (!host) return;
    host.innerHTML = "";
    host.hidden = attachments.length === 0;
    attachments.forEach((attachment, index) => {
      const item = document.createElement("div");
      item.className = "attachment-item";
      if (
        String(attachment.type || "").startsWith("image/") &&
        attachment.internalPath
      ) {
        const thumbnail = document.createElement("img");
        thumbnail.className = "attachment-thumbnail";
        thumbnail.src = attachment.internalPath;
        thumbnail.alt = attachment.name || "图片附件";
        thumbnail.addEventListener("error", () => thumbnail.remove(), {
          once: true,
        });
        item.appendChild(thumbnail);
      }
      const name = document.createElement("span");
      name.textContent = attachment.name || "未命名文件";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "attachment-remove";
      remove.textContent = "×";
      remove.title = "移除此附件";
      remove.addEventListener("click", () => {
        attachments.splice(index, 1);
        renderAttachments();
      });
      item.append(name, remove);
      host.appendChild(item);
    });
  }

  function addAttachments(items) {
    const existing = new Set(
      attachments.map((item) => item.id || item.internalPath)
    );
    let limitReached = false;
    for (const item of Array.isArray(items) ? items : []) {
      const key = item?.id || item?.internalPath;
      if (!item || (key && existing.has(key))) continue;
      if (attachments.length >= 10) {
        limitReached = true;
        break;
      }
      attachments.push(item);
      if (key) existing.add(key);
    }
    renderAttachments();
    if (limitReached) {
      window.E3MessageStreamRenderer.showError(
        "一次最多发送 10 个附件",
        "invocation",
        generation()
      );
    }
  }

  async function uploadFiles() {
    try {
      addAttachments(await api.selectFiles());
      document.getElementById("prompt").focus();
    } catch (error) {
      window.E3MessageStreamRenderer.showError(
        error.message,
        "invocation",
        generation()
      );
    }
  }

  async function pasteFiles(event) {
    const files = Array.from(event.clipboardData?.items || [])
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (!files.length) return;
    event.preventDefault();
    try {
      for (const file of files) {
        const data = new Uint8Array(await file.arrayBuffer());
        addAttachments([
          await api.storePastedFile({
            name: file.name || `pasted_image_${Date.now()}.png`,
            type: file.type || "application/octet-stream",
            data,
          }),
        ]);
      }
    } catch (error) {
      window.E3MessageStreamRenderer.showError(
        error.message,
        "invocation",
        generation()
      );
    }
  }

  function setChatRunning(running, pendingCancel = false) {
    chatRunning = !!running;
    cancelPending = chatRunning && !!pendingCancel;
    const button = document.getElementById("chat-action");
    if (!button) return;
    button.classList.toggle("is-running", chatRunning);
    button.disabled = cancelPending;
    document.getElementById("upload-file").disabled = chatRunning;
    document.getElementById("new-session").disabled = chatRunning;
    document.getElementById("sidebar-new-session").disabled = chatRunning;
    button.setAttribute("aria-label", chatRunning ? "取消生成" : "发送消息");
    button.title = chatRunning ? "取消生成" : "发送消息 (Enter)";
  }

  async function startNewSession() {
    attachments = [];
    renderAttachments();
    window.E3WorkspaceSidebar.startNewSession();
    await window.E3WorkspaceSidebar.renderSessions({
      preserveSelection: false,
      selectSessionId: null,
      allowNoSelection: true,
    });
    document.getElementById("prompt").focus();
  }

  async function bootstrap() {
    await api.ready();
    bindUi();
    await connect();
    await window.E3WorkspaceSidebar.renderSessions({ loadSelection: true });
  }

  function bindUi() {
    document
      .getElementById("refresh-workspace")
      .addEventListener("click", async () => {
        await api.refreshWorkspace();
        await window.E3WorkspaceSidebar.renderSessions({
          preserveSelection: true,
          loadSelection: true,
        });
      });
    document
      .getElementById("new-session")
      .addEventListener("click", startNewSession);
    document
      .getElementById("sidebar-new-session")
      .addEventListener("click", startNewSession);
    document
      .getElementById("upload-file")
      .addEventListener("click", uploadFiles);
    document.getElementById("reconnect").addEventListener("click", connect);
    document
      .getElementById("disconnect")
      .addEventListener("click", async () => api.disconnect());
    document.getElementById("composer").addEventListener("submit", sendMessage);
    const prompt = document.getElementById("prompt");
    prompt.addEventListener("paste", pasteFiles);
    prompt.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      if (!chatRunning) event.currentTarget.form.requestSubmit();
    });
    api.onEvent(handleEvent);
  }

  async function connect() {
    const status = await api.connect({});
    window.E3ChatSettingsPanel.renderStatus(status);
    window.E3DiagnosticsPanel.render(await api.getDiagnostics());
  }

  function pickSessionId(result) {
    return result?.activeSessionId || result?.sessionId || result?.id || null;
  }

  async function refreshSessionsAfterSend(result) {
    const selectedId =
      pickSessionId(result) || window.E3WorkspaceSidebar.getActiveSessionId();
    await window.E3WorkspaceSidebar.renderSessions({
      preserveSelection: true,
      selectSessionId: selectedId,
      sessions: Array.isArray(result?.sessions) ? result.sessions : null,
    });
  }

  async function sendMessage(event) {
    event.preventDefault();
    if (chatRunning) {
      if (cancelPending) return;
      setChatRunning(true, true);
      try {
        await api.cancel();
        window.E3MessageStreamRenderer.finalizeCurrentAssistant(generation());
        setChatRunning(false);
      } catch (error) {
        setChatRunning(true);
        window.E3MessageStreamRenderer.showError(
          error.message,
          "invocation",
          generation()
        );
      }
      return;
    }

    const textarea = document.getElementById("prompt");
    const content = textarea.value.trim();
    if (!content && !attachments.length) return;
    const sendingAttachments = attachments.slice();
    const visibleContent =
      content ||
      sendingAttachments.map((item) => `[附件] ${item.name}`).join("\n");

    const activeSessionId = window.E3WorkspaceSidebar.getActiveSessionId();
    const localId = window.E3MessageStreamRenderer.appendUserMessage(
      visibleContent,
      undefined,
      generation()
    );
    textarea.value = "";
    attachments = [];
    renderAttachments();
    setChatRunning(true);

    try {
      const result = await api.sendMessage({
        content,
        attachments: sendingAttachments,
        sessionId: activeSessionId,
        localId,
      });
      const returnedSessionId = pickSessionId(result);
      if (returnedSessionId)
        window.E3WorkspaceSidebar.setActiveSessionId(returnedSessionId);
      await refreshSessionsAfterSend(result);
    } catch (error) {
      window.E3MessageStreamRenderer.finalizeCurrentAssistant(generation());
      setChatRunning(false);
      window.E3MessageStreamRenderer.showError(
        error.message,
        "invocation",
        generation()
      );
      textarea.value = content;
      attachments = sendingAttachments;
      renderAttachments();
    }
  }

  async function handleEvent(event) {
    if (!event) return;
    if (event.type === "connection") {
      if (event.state === "disconnected") setChatRunning(false);
      if (event.workspace?.connectionGeneration !== undefined) {
        window.E3MessageStreamRenderer.setGeneration(
          event.workspace.connectionGeneration,
          { clear: event.state === "connected" }
        );
      }
      window.E3ChatSettingsPanel.renderStatus({
        connected: event.state === "connected",
        workspace: event.workspace,
      });
      window.E3DiagnosticsPanel.render(await api.getDiagnostics());
      if (event.state === "connected")
        await window.E3WorkspaceSidebar.renderSessions({
          preserveSelection: true,
          sessions: event.sessions,
          loadSelection: true,
        });
      return;
    }
    if (event.type === "message")
      return window.E3MessageStreamRenderer.appendAssistantMessageText(
        event.text,
        eventGeneration(event),
        event.messageId || null
      );
    if (event.type === "thinking")
      return window.E3MessageStreamRenderer.appendThinking(
        event.text,
        eventGeneration(event),
        event.messageId || null
      );
    if (event.type === "tool-call")
      return window.E3MessageStreamRenderer.renderTool(
        event.tool,
        eventGeneration(event)
      );
    if (event.type === "tool-result")
      return window.E3MessageStreamRenderer.finalizeToolResult(
        event.toolId,
        event.result,
        event.status,
        event.isError,
        eventGeneration(event)
      );
    if (event.type === "ask-question")
      return window.E3MessageStreamRenderer.renderQuestion(
        event,
        async (requestId, payload) =>
          api.answerQuestion({ requestId, answerPayload: payload }),
        eventGeneration(event)
      );
    if (event.type === "done") {
      window.E3MessageStreamRenderer.finalizeCurrentAssistant(
        eventGeneration(event)
      );
      setChatRunning(false);
      window.E3MessageStreamRenderer.clearQuestion();
      await window.E3WorkspaceSidebar.renderSessions({
        preserveSelection: true,
      });
      return;
    }
    if (event.type === "error") {
      window.E3MessageStreamRenderer.finalizeCurrentAssistant(
        eventGeneration(event)
      );
      setChatRunning(false);
      return window.E3MessageStreamRenderer.showError(
        event.message,
        "e3",
        eventGeneration(event)
      );
    }
    if (event.type === "invocation-error") {
      window.E3MessageStreamRenderer.finalizeCurrentAssistant(
        eventGeneration(event)
      );
      setChatRunning(false);
      return window.E3MessageStreamRenderer.showError(
        event.message,
        "invocation",
        eventGeneration(event)
      );
    }
    if (event.type === "diagnostic")
      window.E3DiagnosticsPanel.render(await api.getDiagnostics());
  }

  await bootstrap();
})();
