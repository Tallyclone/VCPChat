"use strict";
(function (global) {
  const TRUNCATE_THRESHOLD = 50000;
  const TRUNCATE_LINES = 80;
  const fullContentMap = new Map();

  function format(value) {
    if (typeof value === "string") return value;
    if (value === undefined || value === null) return "无";
    try {
      return JSON.stringify(value, null, 2);
    } catch (_) {
      return String(value);
    }
  }

  function renderResultMarkdown(text) {
    if (!text) return "";
    if (global.marked?.parse) {
      try {
        let html = global.marked.parse(text, {
          mangle: false,
          headerIds: false,
        });
        return global.DOMPurify?.sanitize
          ? global.DOMPurify.sanitize(html)
          : html;
      } catch (_) {}
    }
    return `<pre>${global.E3MessageBlock?.escapeHtml?.(text) ?? text}</pre>`;
  }

  function commandOf(tool) {
    const input = tool?.input ?? tool?.arguments;
    if (input && typeof input === "object") {
      return (
        input.command || input.Command || input.cmd || input.Cmd || "command"
      );
    }
    if (typeof input === "string") {
      try {
        const parsed = JSON.parse(input);
        return (
          parsed?.command ||
          parsed?.Command ||
          parsed?.cmd ||
          parsed?.Cmd ||
          "command"
        );
      } catch (_) {
        return input.trim().split(/\s+/)[0] || "command";
      }
    }
    return tool?.command || tool?.Command || "command";
  }

  function create(tool) {
    const el = document.createElement("details");
    el.className = "tool-card e3-tool-card running";
    el.dataset.toolId = String(tool?.id || "");
    el.open = false;

    const summary = document.createElement("summary");
    const name = document.createElement("strong");
    const toolName = tool?.name || tool?.toolName || "unknown";
    name.textContent = `VCPTool·${toolName}·${commandOf(tool)}`;
    const state = document.createElement("span");
    state.className = "tool-status";
    state.textContent = "运行中";
    summary.append(name, state);

    const section = document.createElement("section");
    const inputTitle = document.createElement("h4");
    inputTitle.textContent = "输入";
    const input = document.createElement("pre");
    input.className = "tool-input";
    input.textContent = format(tool?.input);
    const resultTitle = document.createElement("h4");
    resultTitle.className = "tool-result-title";
    resultTitle.hidden = true;
    resultTitle.textContent = "结果";
    const resultDiv = document.createElement("div");
    resultDiv.className = "tool-result";
    resultDiv.hidden = true;
    section.append(inputTitle, input, resultTitle, resultDiv);
    el.append(summary, section);
    return el;
  }

  function update(el, result, status, isError) {
    const value = format(result);
    el.className = `tool-card e3-tool-card ${isError ? "error" : "success"}`;
    el.querySelector(".tool-status").textContent = isError
      ? "失败"
      : status || "完成";
    el.querySelector(".tool-result-title").hidden = false;
    const resultDiv = el.querySelector(".tool-result");
    resultDiv.hidden = false;

    if (value.length > TRUNCATE_THRESHOLD) {
      const truncatedLines = value
        .split("\n")
        .slice(0, TRUNCATE_LINES)
        .join("\n");
      const contentId = `e3-tool-content-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 7)}`;
      fullContentMap.set(contentId, value);
      resultDiv.innerHTML = renderResultMarkdown(truncatedLines);
      const expandBtn = document.createElement("button");
      expandBtn.className = "tool-expand-btn";
      expandBtn.textContent = `显示全部 (${value.length.toLocaleString()} 字符)`;
      expandBtn.addEventListener("click", () => {
        const full = fullContentMap.get(contentId);
        if (full) {
          resultDiv.innerHTML = renderResultMarkdown(full);
          fullContentMap.delete(contentId);
        }
      });
      resultDiv.appendChild(expandBtn);
    } else {
      resultDiv.innerHTML = renderResultMarkdown(value);
    }
  }

  global.E3ToolCard = { create, update };
})(window);
