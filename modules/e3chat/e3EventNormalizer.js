"use strict";

function safeParseJson(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch (_) {
    return value;
  }
}

function eventArguments(payload) {
  return (Array.isArray(payload) ? payload : [payload]).map(safeParseJson);
}

function eventPayload(args) {
  return (
    args.find(
      (value) => value && typeof value === "object" && !Array.isArray(value)
    ) || {}
  );
}

function stringArguments(args) {
  return args.filter((value) => typeof value === "string" && value.length > 0);
}

function firstValue(source, keys, fallback = null) {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return fallback;
}

function firstArgument(args, fallback = null) {
  return (
    args.find(
      (value) => value !== undefined && value !== null && value !== ""
    ) ?? fallback
  );
}

function normalizeHubEvent(name, payload, context = {}) {
  const raw = payload;
  const args = eventArguments(payload);
  const event = eventPayload(args);
  const strings = stringArguments(args);
  const eventName = String(name || "").toLowerCase();
  const base = {
    workspaceIdentity: context.workspaceIdentity || null,
    connectionGeneration: context.connectionGeneration || 0,
    receivedAt: new Date().toISOString(),
  };
  const eventId = firstValue(event, [
    "id",
    "messageId",
    "toolCallId",
    "callId",
    "invocationId",
  ]);
  const trailingText = strings.at(-1) || "";
  const leadingId = strings.length > 1 ? strings[0] : null;

  if (eventName === "chat-message") {
    return {
      ...base,
      type: "message",
      text: String(
        firstValue(event, ["text", "content", "delta", "message"], trailingText)
      ),
      messageId: eventId || leadingId,
      raw,
    };
  }
  if (eventName === "chat-thinking") {
    return {
      ...base,
      type: "thinking",
      text: String(
        firstValue(
          event,
          ["text", "content", "delta", "thinking"],
          trailingText
        )
      ),
      messageId: eventId || leadingId,
      raw,
    };
  }
  if (eventName === "chat-tool-call") {
    const positionalInput =
      event === args[0] && args.length === 1
        ? null
        : args.length >= 3
        ? args[2]
        : args.find(
            (value) =>
              value !== event &&
              (typeof value === "object" ||
                (typeof value === "string" && /^[\[{]/.test(value.trim())))
          ) ?? null;
    const input = firstValue(
      event,
      ["input", "arguments", "args", "parameters"],
      positionalInput
    );
    return {
      ...base,
      type: "tool-call",
      tool: {
        source: "e3",
        id: String(eventId || strings[0] || ""),
        name: String(
          firstValue(
            event,
            ["name", "toolName", "functionName", "function"],
            strings.length > 1 ? strings[1] : "unknown"
          )
        ),
        input: safeParseJson(input),
        status: "running",
      },
      raw,
    };
  }
  if (eventName === "chat-tool-result") {
    const positionalResult = args.length >= 2 ? args[1] : firstArgument(args);
    const positionalStatus = args.length >= 3 ? args[2] : null;
    const positionalError = args.length >= 4 ? args[3] : null;
    const rawIsError = firstValue(event, ["isError"], positionalError);
    const isError =
      rawIsError === true ||
      rawIsError === "true" ||
      rawIsError === 1 ||
      event?.success === false;
    return {
      ...base,
      type: "tool-result",
      toolId: String(eventId || strings[0] || ""),
      result: firstValue(
        event,
        ["content", "result", "output", "error", "message"],
        positionalResult
      ),
      status: isError
        ? "error"
        : String(firstValue(event, ["status"], positionalStatus || "success")),
      isError,
      raw,
    };
  }
  if (eventName === "chat-done") {
    return {
      ...base,
      type: "done",
      usage: event,
      finishReason: event?.finishReason,
      raw,
    };
  }
  if (eventName === "chat-error") {
    return {
      ...base,
      type: "error",
      message: String(
        firstValue(event, ["message", "error"], trailingText || "E3 chat error")
      ),
      code: event?.code,
      raw,
    };
  }
  if (eventName === "chat-ask-question") {
    return {
      ...base,
      type: "ask-question",
      requestId: String(
        firstValue(event, ["requestId", "id"], strings[0] || "")
      ),
      questions: Array.isArray(event?.questions) ? event.questions : [],
      raw,
    };
  }
  return { ...base, type: "diagnostic", name, raw };
}

function normalizeInvocationFailure(method, error, context = {}) {
  return {
    workspaceIdentity: context.workspaceIdentity || null,
    connectionGeneration: context.connectionGeneration || 0,
    receivedAt: new Date().toISOString(),
    type: "invocation-error",
    method,
    message: error?.message || String(error || "Invocation failed"),
    raw: { name: error?.name, stack: error?.stack },
  };
}

module.exports = {
  normalizeHubEvent,
  normalizeInvocationFailure,
  safeParseJson,
};
