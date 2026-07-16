"use strict";

(async function () {
  const api = window.e3chat;
  let chatRunning = false;
  let cancelPending = false;
  const generation = () => window.E3MessageStreamRenderer.state.generation;
  const eventGeneration = (event) => {
    const parsed = Number(event?.connectionGeneration);
    return Number.isFinite(parsed) ? parsed : generation();
  };

  function setChatRunning(running, pendingCancel = false) {
    chatRunning = !!running;
    cancelPending = chatRunning && !!pendingCancel;
    const button = document.getElementById("chat-action");
    if (!button) return;
    button.classList.toggle("is-running", chatRunning);
    button.disabled = cancelPending;
    button.setAttribute("aria-label", chatRunning ? "取消生成" : "发送消息");
    button.title = chatRunning ? "取消生成" : "发送消息 (Enter)";
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
      .addEventListener("click", async () => {
        window.E3WorkspaceSidebar.startNewSession();
        await window.E3WorkspaceSidebar.renderSessions({
          preserveSelection: false,
          selectSessionId: null,
          allowNoSelection: true,
        });
      });
    document.getElementById("reconnect").addEventListener("click", connect);
    document
      .getElementById("disconnect")
      .addEventListener("click", async () => api.disconnect());
    document.getElementById("composer").addEventListener("submit", sendMessage);
    document.getElementById("prompt").addEventListener("keydown", (event) => {
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
    if (!content) return;

    const activeSessionId = window.E3WorkspaceSidebar.getActiveSessionId();
    const localId = window.E3MessageStreamRenderer.appendUserMessage(
      content,
      undefined,
      generation()
    );
    textarea.value = "";
    setChatRunning(true);

    try {
      const result = await api.sendMessage({
        content,
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
