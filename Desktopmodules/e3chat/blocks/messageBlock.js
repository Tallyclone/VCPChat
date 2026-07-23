"use strict";

(function (global) {
  const TOOL_REQUEST_PATTERN =
    /<<<\[TOOL_REQUEST\]>>>\s*([\s\S]*?)\s*<<<\[END_TOOL_REQUEST\]>>>/g;
  const TOOL_RESULT_PATTERN =
    /\[\[VCP调用结果信息汇总:([\s\S]*?)VCP调用结果结束\]\]/g;
  const THOUGHT_PATTERN =
    /\[--- VCP元思考链(?:\s*"([^"]*)")?\s*---\]([\s\S]*?)\[--- 元思考链结束 ---\]|<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/gi;
  const TOOL_SUMMARY_PATTERN =
    /\[本轮工具调用摘要:\]([\s\S]*?)\[本轮工具调用摘要结束\]/g;

  function escapeHtml(value) {
    return String(value ?? "").replace(
      /[&<>'"]/g,
      (ch) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          "'": "&#39;",
          '"': "&quot;",
        }[ch])
    );
  }

  // --- Scoped CSS tracking ---
  const scopedStyleIds = new Set();

  // --- Render HTML Cache (LRU, 200 entries, 5MB max) ---
  const renderCache = (function () {
    const MAX_ENTRIES = 200;
    const MAX_BYTES = 5 * 1024 * 1024;
    const MIN_LEN = 256;
    const MAX_LEN = 256 * 1024;
    const map = new Map();
    let totalBytes = 0;

    function fnv1a(str) {
      let h = 0x811c9dc5;
      for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
      }
      return (h >>> 0).toString(36);
    }

    function evict() {
      while (
        (map.size > MAX_ENTRIES || totalBytes > MAX_BYTES) &&
        map.size > 0
      ) {
        const firstKey = map.keys().next().value;
        const entry = map.get(firstKey);
        totalBytes -= entry.size;
        map.delete(firstKey);
      }
    }

    return {
      get: function (text) {
        if (text.length < MIN_LEN || text.length > MAX_LEN) return undefined;
        const key = fnv1a(text);
        const entry = map.get(key);
        if (!entry) return undefined;
        map.delete(key);
        map.set(key, entry);
        return entry.html;
      },
      set: function (text, html) {
        if (text.length < MIN_LEN || text.length > MAX_LEN) return;
        const key = fnv1a(text);
        const size = html.length * 2;
        if (map.has(key)) {
          totalBytes -= map.get(key).size;
          map.delete(key);
        }
        map.set(key, { html: html, size: size });
        totalBytes += size;
        evict();
      },
    };
  })();

  // --- Edge-1: Persona Backfill Stripping ---
  const PERSONA_BACKFILL_OPEN_REGEX =
    /<!--\s*persona_(?:delta|expression)\s*:/g;

  function findPersonaJsonEnd(text, startIndex) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = startIndex; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) return i + 1;
      }
    }
    return -1;
  }

  function stripPersonaBackfillTail(text) {
    if (!text || text.indexOf("persona_") === -1) return text;
    let result = "";
    let cursor = 0;
    let strippedAny = false;
    PERSONA_BACKFILL_OPEN_REGEX.lastIndex = 0;
    let match;
    while ((match = PERSONA_BACKFILL_OPEN_REGEX.exec(text)) !== null) {
      if (match.index < cursor) continue;
      result += text.slice(cursor, match.index);
      const jsonStart = text.indexOf("{", match.index + match[0].length);
      if (jsonStart === -1) {
        cursor = text.length;
        strippedAny = true;
        break;
      }
      const jsonEnd = findPersonaJsonEnd(text, jsonStart);
      if (jsonEnd === -1) {
        cursor = text.length;
        strippedAny = true;
        break;
      }
      let end = jsonEnd;
      const closer = text.indexOf("-->", jsonEnd);
      if (closer !== -1 && text.slice(jsonEnd, closer).trim() === "") {
        end = closer + 3;
      }
      cursor = end;
      strippedAny = true;
      PERSONA_BACKFILL_OPEN_REGEX.lastIndex = end;
    }
    if (!strippedAny) return text;
    result += text.slice(cursor);
    return result;
  }

  // --- Edge-2: Adjacent Bold Boundary Normalization ---
  function normalizeAdjacentBoldBoundaries(text) {
    if (typeof text !== "string" || !text.includes("**")) return text;
    const separator = "<!-- -->";
    let result = "";
    let cursor = 0;
    let inBold = false;
    const needsSeparatorAfter = (char) =>
      !!char && !/\s/.test(char) && char !== "<" && char !== "*";
    const needsSeparatorBefore = (char) =>
      !!char && !/\s/.test(char) && char !== ">" && char !== "*";
    while (cursor < text.length) {
      const markerIndex = text.indexOf("**", cursor);
      if (markerIndex === -1) {
        result += text.slice(cursor);
        break;
      }
      const previousChar = markerIndex > 0 ? text[markerIndex - 1] : "";
      result += text.slice(cursor, markerIndex);
      if (
        !inBold &&
        result &&
        !result.endsWith(separator) &&
        needsSeparatorBefore(previousChar)
      ) {
        result += separator;
      }
      result += "**";
      cursor = markerIndex + 2;
      inBold = !inBold;
      if (!inBold) {
        const nextChar = text[cursor] || "";
        if (needsSeparatorAfter(nextChar)) {
          result += separator;
        }
      }
    }
    return result;
  }

  function unwrapRenderableHtmlFence(text) {
    const source = String(text ?? "");
    const openingPattern = /(^|\n)[ \t]*(`{3,})\s*(?:html?|xhtml)\s*\r?\n/i;
    const opening = openingPattern.exec(source);
    if (!opening) return source;

    const fence = opening[2];
    const contentStart = opening.index + opening[0].length;
    const closingPattern = new RegExp(
      `\\r?\\n[ \\t]*${fence}\\s*(?=\\r?\\n|$)`,
      "g"
    );
    closingPattern.lastIndex = contentStart;
    const closing = closingPattern.exec(source);
    const contentEnd = closing ? closing.index : source.length;
    const content = source.slice(contentStart, contentEnd);
    const candidate = content.trimStart();
    if (
      !/^(?:<!doctype\s+html\b|<!--|<(?:html|head|body|main|section|article|div|style|script|canvas|svg)\b)/i.test(
        candidate
      )
    ) {
      return source;
    }

    const prefix = source.slice(0, opening.index) + opening[1];
    const suffix = closing
      ? source.slice(closing.index + closing[0].length)
      : "";
    return `${prefix}${content}${suffix}`;
  }

  function normalizeHtmlAttributeQuotes(text) {
    const source = String(text ?? "");
    if (!/[“”„‟＂‘’‚‛＇]/.test(source)) return source;

    let result = "";
    let cursor = 0;
    while (cursor < source.length) {
      const tagStart = source.indexOf("<", cursor);
      if (tagStart === -1) {
        result += source.slice(cursor);
        break;
      }
      result += source.slice(cursor, tagStart);

      if (source.startsWith("<!--", tagStart)) {
        const commentEnd = source.indexOf("-->", tagStart + 4);
        if (commentEnd === -1) {
          result += source.slice(tagStart);
          break;
        }
        result += source.slice(tagStart, commentEnd + 3);
        cursor = commentEnd + 3;
        continue;
      }

      let tagEnd = tagStart + 1;
      let quote = "";
      for (; tagEnd < source.length; tagEnd++) {
        const ch = source[tagEnd];
        const normalized = /[“”„‟＂]/.test(ch)
          ? '"'
          : /[‘’‚‛＇]/.test(ch)
          ? "'"
          : ch;
        if (!quote && (normalized === '"' || normalized === "'"))
          quote = normalized;
        else if (quote && normalized === quote) quote = "";
        else if (!quote && normalized === ">") break;
      }

      if (tagEnd >= source.length) {
        result += source.slice(tagStart);
        break;
      }

      result += source
        .slice(tagStart, tagEnd + 1)
        .replace(/[“”„‟＂]/g, '"')
        .replace(/[‘’‚‛＇]/g, "'");
      cursor = tagEnd + 1;
    }
    return result;
  }

  function renderMarkdown(text, messageElement, options = {}) {
    const raw = String(text ?? "");
    const streaming = options.streaming === true;

    // Phase 0: An html/htm fence containing an actual widget is executable, including a
    // still-open streaming fence. Normalize typographic quotes only inside HTML tags.
    const unwrappedSource = unwrapRenderableHtmlFence(raw);
    const hasRenderableHtmlFence = unwrappedSource !== raw;
    let source = normalizeHtmlAttributeQuotes(unwrappedSource);

    // Phase 1: Code fence protection (state machine)
    const codeFenceMap = new Map();
    let codeFenceId = 0;
    const lines = source.split("\n");
    const resultLines = [];
    let fenceStartLine = -1;
    let fenceBacktickCount = 0;

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trimStart();
      if (fenceStartLine === -1) {
        const openMatch = trimmed.match(/^(`{3,})/);
        if (openMatch) {
          fenceStartLine = resultLines.length;
          fenceBacktickCount = openMatch[1].length;
          resultLines.push(lines[i]);
        } else {
          resultLines.push(lines[i]);
        }
      } else {
        const closeMatch = trimmed.match(/^(`{3,})\s*$/);
        if (closeMatch && closeMatch[1].length >= fenceBacktickCount) {
          resultLines.push(lines[i]);
          const blockLines = resultLines.splice(fenceStartLine);
          const blockContent = blockLines.join("\n");
          const placeholder = `%%E3_CODEFENCE_${codeFenceId}%%`;
          codeFenceMap.set(placeholder, blockContent);
          codeFenceId++;
          resultLines.push(placeholder);
          fenceStartLine = -1;
          fenceBacktickCount = 0;
        } else {
          resultLines.push(lines[i]);
        }
      }
    }
    // Protect unclosed fence (streaming)
    if (fenceStartLine !== -1) {
      const blockLines = resultLines.splice(fenceStartLine);
      const blockContent = blockLines.join("\n");
      const placeholder = `%%E3_CODEFENCE_${codeFenceId}%%`;
      codeFenceMap.set(placeholder, blockContent);
      codeFenceId++;
      resultLines.push(placeholder);
    }

    let processed = resultLines.join("\n");

    // Phase 2: LaTeX protection (on code-fence-free text)
    const latexMap = new Map();
    let latexId = 0;
    const createLatexPlaceholder = (latex) => {
      const ph = `%%E3_LATEX_${latexId}%%`;
      latexMap.set(ph, latex);
      latexId++;
      return ph;
    };

    // 2a. Protect $$ display math (multi-line)
    processed = processed.replace(
      /(^|\n)([ \t]*)\$\$[ \t]*\n([\s\S]*?)\n[ \t]*\$\$[ \t]*(?=\n|$)/g,
      (match, linePrefix) =>
        `${linePrefix}${createLatexPlaceholder(match.slice(linePrefix.length))}`
    );
    // 2b. Protect $$ display math (single-line)
    processed = processed.replace(
      /(^|\n)([ \t]*)\$\$([^\n]*?\S[^\n]*?)\$\$[ \t]*(?=\n|$)/g,
      (match, linePrefix) =>
        `${linePrefix}${createLatexPlaceholder(match.slice(linePrefix.length))}`
    );
    // 2c. Protect \[...\] display math
    processed = processed.replace(/\\\[[\s\S]*?\\\]/g, (match) =>
      createLatexPlaceholder(match)
    );
    // 2d. Protect \(...\) inline math
    processed = processed.replace(/\\\([\s\S]*?\\\)/g, (match) =>
      createLatexPlaceholder(match)
    );

    // Phase 3: HTML line de-indentation
    // Lines starting with 4+ spaces that begin with HTML tags - de-indent to prevent code block
    processed = processed.replace(
      /^([ \t]{4,})(<(?:div|p|span|h[1-6]|ul|ol|li|table|tr|td|th|thead|tbody|section|article|nav|header|footer|main|aside|figure|figcaption|details|summary|blockquote|form|input|button|select|textarea|label|img|a|br|hr|pre|code|em|strong|i|b|u|s|small|sub|sup|mark|del|ins|abbr|cite|dfn|kbd|var|samp|ruby|rt|rp|bdo|wbr|canvas|svg|video|audio|source|iframe|embed|object|param|map|area)\b)/gim,
      (match, indent, tag) => tag
    );

    // Phase 4: Scoped CSS extraction. CSS belongs to the current message instance,
    // so it is always injected outside the raw HTML cache, matching VChat's cache boundary.
    const styleBlocks = [];
    processed = processed.replace(
      /<style\b[^>]*>([\s\S]*?)<\/style>/gi,
      (match, css) => {
        styleBlocks.push(css);
        return "";
      }
    );
    injectScopedStyles(messageElement, styleBlocks);

    // Only cache the style-free pure HTML conversion. A cache hit must not skip
    // message-scoped CSS injection or later DOM/image/script/animation processing.
    const cacheSource = raw.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
    const cachedHtml = streaming ? undefined : renderCache.get(cacheSource);
    if (cachedHtml !== undefined) return cachedHtml;

    // Phase 4.5: Extract <script> tags before DOMPurify (anti-mXSS heuristic removes them).
    // 先处理独占行脚本并吞掉行首缩进，否则 marked 会把 4 空格缩进的占位符解析成 <pre><code>。
    const scriptBlocks = [];
    const createScriptPlaceholder = (script) => {
      const id = scriptBlocks.length;
      scriptBlocks.push(script);
      return `<span data-e3-script-id="${id}" hidden></span>`;
    };
    processed = processed.replace(
      /(^|\n)[ \t]*(<script\b[^>]*>[\s\S]*?<\/script\s*>)/gi,
      (match, linePrefix, script) =>
        `${linePrefix}${createScriptPlaceholder(script)}`
    );
    processed = processed.replace(
      /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,
      (script) => createScriptPlaceholder(script)
    );

    // Phase 5: LaTeX placeholder lines de-indent (prevent code block)
    processed = processed.replace(
      /(^|\n)[ \t]{4,}(%%E3_LATEX_\d+%%)(?=[ \t]*(?:\n|$))/g,
      (match, prefix, ph) => `${prefix}${ph}`
    );

    // Phase 5.5: Adjacent bold boundary normalization
    processed = normalizeAdjacentBoldBoundaries(processed);

    // Phase 6: Restore code fences before marked.parse
    for (const [placeholder, original] of codeFenceMap.entries()) {
      processed = processed.split(placeholder).join(original);
    }

    // Phase 7: HTML-dominant fragments bypass marked.
    // marked 会在 HTML 块中的空行处结束 HTML 语境，随后把 4 空格缩进的正文和闭合标签
    // 解析成 <pre><code>。完整 HTML/单根 HTML 片段应直接进入清理阶段；显式代码围栏仍走 marked。
    const trimmedProcessed = processed.trim();
    const startsAsHtml =
      !trimmedProcessed.startsWith("```") &&
      /^(?:<!doctype\s+html\b[^>]*>\s*)?(?:<(?:html|body|main|section|article|div)\b|<!doctype\s+html\b)/i.test(
        trimmedProcessed
      );
    // 裸 HTML 或已识别的 html 围栏都绕过 marked。后者可能前置少量说明文字，
    // 但仍必须保持 HTML 块及其缩进完整，避免再次变成 <pre><code>。
    const isHtmlDominant = hasRenderableHtmlFence || startsAsHtml;
    let html;
    if (isHtmlDominant) {
      html = processed;
    } else if (global.marked?.parse) {
      try {
        html = global.marked.parse(processed, {
          mangle: false,
          headerIds: false,
        });
      } catch (_) {}
    }
    html = html ?? escapeHtml(processed).replace(/\n/g, "<br>");

    // Phase 8: Restore LaTeX placeholders
    html = html.replace(/%%E3_LATEX_(\d+)%%/g, (placeholder) => {
      const original = latexMap.get(placeholder);
      return original ? escapeHtml(original) : placeholder;
    });

    // Phase 9: Sanitize (script tags already extracted in Phase 4.5)
    html = global.DOMPurify?.sanitize
      ? global.DOMPurify.sanitize(html, {
          ADD_ATTR: ["data-e3-script-id", "hidden"],
        })
      : html;

    // Phase 9.5: Restore script tags after DOMPurify.
    // marked/DOMPurify 可能调整属性引号、顺序或补充 hidden=""，因此不能依赖精确字符串。
    if (scriptBlocks.length > 0) {
      html = html.replace(
        /<span\b([^>]*\bdata-e3-script-id\s*=\s*(?:["']\d+["']|\d+)[^>]*)>[\s\S]*?<\/span\s*>/gi,
        (match, attributes) => {
          const idMatch = String(attributes).match(
            /\bdata-e3-script-id\s*=\s*(?:["'](\d+)["']|(\d+))/i
          );
          const i = Number.parseInt(idMatch?.[1] ?? idMatch?.[2] ?? "", 10);
          return Number.isInteger(i) && i >= 0 && i < scriptBlocks.length
            ? scriptBlocks[i]
            : "";
        }
      );
    }
    // 防御性清理：内部占位符及旧版本遗留的自定义标签都不应泄漏到聊天正文。
    html = html
      .replace(
        /<span\b[^>]*\bdata-e3-script-id\b[^>]*>[\s\S]*?<\/span\s*>/gi,
        ""
      )
      .replace(
        /(?:<|&lt;)e3-script-placeholder\b[\s\S]*?(?:<|&lt;)\/e3-script-placeholder\s*(?:>|&gt;)/gi,
        ""
      );

    // Cache only the style-free sanitized raw HTML conversion.
    if (!streaming) renderCache.set(cacheSource, html);
    return html;
  }

  function scopeCss(css, scopeId) {
    return String(css || "").replace(
      /([^\r\n,{}]+)(,(?=[^}]*{)|\s*\{)/g,
      (match, selector, separator) => {
        const value = selector.trim();
        if (
          !value ||
          value.startsWith("@") ||
          value === "from" ||
          value === "to" ||
          /^\d+%$/.test(value)
        ) {
          return match;
        }
        if (/^(?::root|html|body)$/i.test(value)) {
          return `#${scopeId}${separator}`;
        }
        if (/^(?::root|html|body)\s+/i.test(value)) {
          return `${value.replace(
            /^(?::root|html|body)\s+/i,
            `#${scopeId} `
          )}${separator}`;
        }
        return `#${scopeId} ${value}${separator}`;
      }
    );
  }

  function injectScopedStyles(messageElement, styleBlocks) {
    if (!messageElement?.id || styleBlocks.length === 0) return;
    const scopeId = messageElement.id;
    scopedStyleIds.add(scopeId);
    const styleEl = document.createElement("style");
    styleEl.dataset.e3Scope = scopeId;
    styleEl.textContent = styleBlocks
      .map((css) => scopeCss(css, scopeId))
      .join("\n");
    document.head.appendChild(styleEl);
  }

  function cleanupScopedStylesForMessage(messageElement) {
    const scopeId = messageElement?.id;
    if (!scopeId) return;
    document.head
      .querySelectorAll(`style[data-e3-scope="${scopeId}"]`)
      .forEach((el) => el.remove());
    scopedStyleIds.delete(scopeId);
  }

  function cleanupScopedStyles() {
    document.head
      .querySelectorAll("style[data-e3-scope]")
      .forEach((el) => el.remove());
    scopedStyleIds.clear();
  }

  function appendMarkdown(container, text, options = {}) {
    if (!text) return;
    const fragment = document.createElement("template");
    const messageElement = container.closest(".message-block");
    fragment.innerHTML = renderMarkdown(text, messageElement, options);
    container.appendChild(fragment.content);
  }

  function formatProtocol(value) {
    const text = String(value ?? "").trim();
    return text || "无内容";
  }

  function extractProtocolField(raw, keys) {
    const source = String(raw ?? "");
    for (const key of keys) {
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const patterns = [
        new RegExp(
          `(?:^|\\n)\\s*${escaped}\\s*:\\s*「始」\\s*([\\s\\S]*?)\\s*「末」`,
          "i"
        ),
        new RegExp(`<${escaped}>\\s*([\\s\\S]*?)\\s*</${escaped}>`, "i"),
        new RegExp(`(?:^|\\n)\\s*${escaped}\\s*:\\s*([^\\n\\r「{]+)`, "i"),
      ];
      for (const pattern of patterns) {
        const match = source.match(pattern);
        if (match?.[1] != null && String(match[1]).trim()) {
          return String(match[1]).trim();
        }
      }
    }
    return "";
  }

  function extractToolName(raw) {
    return (
      extractProtocolField(raw, ["tool_name", "toolName", "name"]) || "VCPTool"
    );
  }

  function extractVcpToolTitle(raw) {
    const toolName = extractToolName(raw);
    const maid =
      extractProtocolField(raw, ["maid", "Maid", "maidName", "MaidName"]) ||
      "unknown";
    const command =
      extractProtocolField(raw, ["command", "Command", "cmd", "Cmd"]) ||
      "command";
    // VCPTool  tool_name·maid·command  (two spaces after label)
    return `VCPTool  ${toolName}·${maid}·${command}`;
  }

  function createProtocolCard(kind, label, title, body, status = "") {
    const card = document.createElement("details");
    // VCPTool request cards reuse E3 native tool-card chrome; only the title text differs.
    if (kind === "tool-request" && !label) {
      card.className =
        "tool-card e3-tool-card vcp-protocol-card vcp-tool-request-card";
    } else {
      card.className = `vcp-protocol-card vcp-${kind}-card`;
    }
    card.open = false;

    const summary = document.createElement("summary");
    // VCP tool-request uses a single combined title: "VCPTool  name·maid·command"
    if (kind === "tool-request" && !label) {
      const titleNode = document.createElement("strong");
      titleNode.className = "tool-name protocol-title";
      titleNode.textContent = title;
      summary.append(titleNode);
    } else {
      const labelNode = document.createElement("span");
      labelNode.className = "protocol-label";
      labelNode.textContent = label;
      const titleNode = document.createElement("strong");
      titleNode.className = "protocol-title";
      titleNode.textContent = title;
      summary.append(labelNode, titleNode);
    }
    if (status) {
      const statusNode = document.createElement("span");
      statusNode.className =
        kind === "tool-request" || kind === "tool-result"
          ? "tool-status protocol-status"
          : "protocol-status";
      statusNode.textContent = status;
      summary.appendChild(statusNode);
    }

    const pre = document.createElement("pre");
    pre.className = "protocol-content";
    pre.textContent = formatProtocol(body);
    card.append(summary, pre);
    return card;
  }

  function appendProtocolBlocks(container, text, options = {}) {
    const source = stripPersonaBackfillTail(String(text ?? ""));
    const matches = [];
    const collect = (pattern, type) => {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(source)))
        matches.push({
          type,
          match,
          index: match.index,
          end: pattern.lastIndex,
        });
    };
    collect(TOOL_REQUEST_PATTERN, "request");
    collect(TOOL_RESULT_PATTERN, "result");
    collect(THOUGHT_PATTERN, "thinking");
    collect(TOOL_SUMMARY_PATTERN, "summary");
    matches.sort((a, b) => a.index - b.index || b.end - a.end);

    let cursor = 0;
    for (const entry of matches) {
      if (entry.index < cursor) continue;
      appendMarkdown(container, source.slice(cursor, entry.index), options);
      if (entry.type === "request") {
        container.appendChild(
          createProtocolCard(
            "tool-request",
            "",
            extractVcpToolTitle(entry.match[1]),
            entry.match[1]
          )
        );
      } else if (entry.type === "result") {
        const body = entry.match[1];
        const name =
          body
            .match(/(?:^|\n)\s*-?\s*工具名称\s*:\s*([^\n\r]+)/)?.[1]
            ?.trim() || "工具结果";
        const status =
          body
            .match(/(?:^|\n)\s*-?\s*执行状态\s*:\s*([^\n\r]+)/)?.[1]
            ?.trim() || "";
        container.appendChild(
          createProtocolCard("tool-result", "VCP 工具结果", name, body, status)
        );
      } else if (entry.type === "thinking") {
        const theme = entry.match[1]?.trim() || "思考过程";
        const body = entry.match[2] ?? entry.match[3] ?? "";
        container.appendChild(
          createProtocolCard("thinking", "VCP 思考", theme, body)
        );
      } else if (entry.type === "summary") {
        const summaryText = entry.match[1]?.trim() || "";
        const chips = document.createElement("div");
        chips.className = "tool-summary-chips";
        summaryText.split("\n").forEach((line) => {
          const trimmed = line.trim();
          if (trimmed) {
            const chip = document.createElement("span");
            chip.className = "tool-chip";
            chip.textContent = trimmed;
            chips.appendChild(chip);
          }
        });
        container.appendChild(chips);
      }
      cursor = entry.end;
    }
    appendMarkdown(container, source.slice(cursor), options);
  }

  function looksLikeSafeSingleDollarMath(content) {
    const trimmedContent = String(content ?? "").trim();
    if (!trimmedContent) return false;

    const hasExplicitMathSignal =
      /\\|[\^_=+\-*/<>]|[A-Za-z]\s*\(|\b(?:lim|sum|int|frac|sqrt|text|mathrm|mathbf|alpha|beta|gamma|theta|lambda|mu|sigma|pi|infty)\b/i.test(
        trimmedContent
      );
    const isSimpleNumericMath =
      /^[+-]?(?:\d+(?:[.,]\d+)*|\.\d+)(?:\s*(?:%|\\%|‰|°))?$/.test(
        trimmedContent
      );

    if (
      /^\d/.test(trimmedContent) &&
      !hasExplicitMathSignal &&
      !isSimpleNumericMath
    )
      return false;
    if (trimmedContent.startsWith("/")) return false;
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmedContent)) return false;
    if (trimmedContent.startsWith("{") && trimmedContent.endsWith("}"))
      return false;
    if (trimmedContent.includes("|")) return false;
    return hasExplicitMathSignal || isSimpleNumericMath;
  }

  function normalizeSafeSingleDollarMathInTextNodes(root) {
    if (!root || !global.NodeFilter) return;
    const walker = document.createTreeWalker(
      root,
      global.NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent) return global.NodeFilter.FILTER_REJECT;
          if (parent.closest("pre, code, script, style, textarea, .katex"))
            return global.NodeFilter.FILTER_REJECT;
          return node.nodeValue?.includes("$")
            ? global.NodeFilter.FILTER_ACCEPT
            : global.NodeFilter.FILTER_REJECT;
        },
      }
    );
    const nodes = [];
    let node;
    while ((node = walker.nextNode())) nodes.push(node);
    nodes.forEach((textNode) => {
      textNode.nodeValue = textNode.nodeValue.replace(
        /(^|[^\w\\$])\$([^\$\n]{1,1200}?)\$(?![\w])/g,
        (match, prefix, formula) =>
          looksLikeSafeSingleDollarMath(formula)
            ? `${prefix}\\(${formula.trim()}\\)`
            : match
      );
    });
  }

  // Animation processing delegated to E3AnimationProcessor (animationProcessor.js)

  function setupMermaidViewer(
    viewer,
    canvas,
    viewport,
    btnZoomIn,
    btnZoomOut,
    btnFit,
    btnReset
  ) {
    let scale = 1;
    let translateX = 0;
    let translateY = 0;
    let isDragging = false;
    let startX = 0;
    let startY = 0;

    const applyTransform = () => {
      canvas.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
    };

    btnZoomIn.addEventListener("click", () => {
      scale = Math.min(scale * 1.25, 5);
      applyTransform();
    });
    btnZoomOut.addEventListener("click", () => {
      scale = Math.max(scale / 1.25, 0.2);
      applyTransform();
    });
    btnFit.addEventListener("click", () => {
      const svg = canvas.querySelector("svg");
      if (!svg) return;
      const vw = viewport.clientWidth;
      const vh = viewport.clientHeight;
      const sw = svg.getBoundingClientRect().width / scale;
      const sh = svg.getBoundingClientRect().height / scale;
      if (sw && sh) {
        scale = Math.min(vw / sw, vh / sh, 2) * 0.95;
        translateX = 0;
        translateY = 0;
        applyTransform();
      }
    });
    btnReset.addEventListener("click", () => {
      scale = 1;
      translateX = 0;
      translateY = 0;
      applyTransform();
    });

    viewport.addEventListener("mousedown", (e) => {
      isDragging = true;
      startX = e.clientX - translateX;
      startY = e.clientY - translateY;
      viewport.style.cursor = "grabbing";
    });
    document.addEventListener("mousemove", (e) => {
      if (!isDragging) return;
      translateX = e.clientX - startX;
      translateY = e.clientY - startY;
      applyTransform();
    });
    document.addEventListener("mouseup", () => {
      isDragging = false;
      viewport.style.cursor = "grab";
    });

    viewport.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.1 : 0.9;
        scale = Math.min(Math.max(scale * factor, 0.2), 5);
        applyTransform();
      },
      { passive: false }
    );
  }

  // --- Visibility Optimizer (IntersectionObserver) ---
  const lazyEnhanceObserver = (function () {
    if (!global.IntersectionObserver) return null;
    const pendingBlocks = new WeakMap();
    const observer = new global.IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const block = entry.target;
            const content = pendingBlocks.get(block);
            if (content) {
              pendingBlocks.delete(block);
              observer.unobserve(block);
              enhanceContentImmediate(content);
            }
          }
        });
      },
      { rootMargin: "200px" }
    );
    return {
      defer: function (block, content) {
        pendingBlocks.set(block, content);
        observer.observe(block);
      },
    };
  })();

  // --- Edge-3: Emoticon URL Smart Matching ---
  function editDistance(s1, s2) {
    s1 = s1.toLowerCase();
    s2 = s2.toLowerCase();
    const costs = [];
    for (let i = 0; i <= s1.length; i++) {
      let lastValue = i;
      for (let j = 0; j <= s2.length; j++) {
        if (i === 0) {
          costs[j] = j;
        } else if (j > 0) {
          let newValue = costs[j - 1];
          if (s1.charAt(i - 1) !== s2.charAt(j - 1)) {
            newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
          }
          costs[j - 1] = lastValue;
          lastValue = newValue;
        }
      }
      if (i > 0) costs[s2.length] = lastValue;
    }
    return costs[s2.length];
  }

  function getStringSimilarity(s1, s2) {
    const longer = s1.length >= s2.length ? s1 : s2;
    const shorter = s1.length >= s2.length ? s2 : s1;
    if (longer.length === 0) return 1.0;
    return (longer.length - editDistance(longer, shorter)) / longer.length;
  }

  let emoticonLibrary = null;

  function getEmoticonLibrary() {
    if (emoticonLibrary !== null) return emoticonLibrary;
    emoticonLibrary = [];
    if (global.electronAPI && global.electronAPI.getEmoticonLibrary) {
      try {
        global.electronAPI
          .getEmoticonLibrary()
          .then(function (lib) {
            emoticonLibrary = Array.isArray(lib) ? lib : [];
          })
          .catch(function () {});
      } catch (_) {}
    }
    return emoticonLibrary;
  }

  function fixEmoticonUrlSmart(originalSrc) {
    const lib = getEmoticonLibrary();
    if (!lib || lib.length === 0) return originalSrc;
    try {
      if (
        !decodeURIComponent(originalSrc).includes("表情包") &&
        !originalSrc.includes("emoticon") &&
        !originalSrc.includes("sticker")
      ) {
        return originalSrc;
      }
    } catch (_) {
      return originalSrc;
    }
    const parts = originalSrc.split("/").filter(Boolean);
    const filename = parts[parts.length - 1] || "";
    const packageName = parts.length > 1 ? parts[parts.length - 2] : "";
    if (!filename) return originalSrc;
    let bestMatch = null;
    let highestScore = -1;
    for (let i = 0; i < lib.length; i++) {
      var item = lib[i];
      const itemParts = (item.url || "").split("/").filter(Boolean);
      const itemFilename = itemParts[itemParts.length - 1] || "";
      const itemPackage =
        itemParts.length > 1 ? itemParts[itemParts.length - 2] : "";
      let packageScore = 0.5;
      if (packageName && itemPackage)
        packageScore = getStringSimilarity(packageName, itemPackage);
      else if (!packageName && !itemPackage) packageScore = 1.0;
      else packageScore = 0.0;
      const filenameScore = getStringSimilarity(filename, itemFilename);
      const score = 0.7 * packageScore + 0.3 * filenameScore;
      if (score > highestScore) {
        highestScore = score;
        bestMatch = item;
      }
    }
    if (bestMatch && highestScore > 0.6) return bestMatch.url;
    return originalSrc;
  }

  function enhanceContentImmediate(content) {
    normalizeSafeSingleDollarMathInTextNodes(content);
    // 1. KaTeX
    if (global.renderMathInElement) {
      try {
        global.renderMathInElement(content, {
          delimiters: [
            { left: "$$", right: "$$", display: true },
            { left: "\\(", right: "\\)", display: false },
            { left: "\\[", right: "\\]", display: true },
          ],
          ignoredTags: [
            "script",
            "noscript",
            "style",
            "textarea",
            "pre",
            "code",
          ],
          throwOnError: false,
        });
      } catch (_) {}
    }

    // 2. Highlight.js
    if (global.hljs)
      content.querySelectorAll("pre code").forEach((node) => {
        try {
          global.hljs.highlightElement(node);
        } catch (_) {}
      });

    // 3. Code copy button
    content.querySelectorAll("pre").forEach((pre) => {
      if (pre.querySelector(".code-copy-btn")) return;
      const code = pre.querySelector("code");
      if (!code) return;
      pre.style.position = "relative";
      const btn = document.createElement("button");
      btn.className = "code-copy-btn";
      btn.textContent = "复制";
      btn.title = "复制代码";
      btn.addEventListener("click", () => {
        navigator.clipboard.writeText(code.textContent).then(() => {
          btn.textContent = "已复制✓";
          setTimeout(() => {
            btn.textContent = "复制";
          }, 2000);
        });
      });
      pre.appendChild(btn);
    });

    // 4. Mermaid diagrams (enhanced: smart char fix + per-element render + interactive viewer)
    if (global.mermaid) {
      const mermaidBlocks = [];
      content.querySelectorAll("pre > code").forEach((code) => {
        const cls = code.className || "";
        if (/language-mermaid|language-flowchart|language-graph/.test(cls)) {
          mermaidBlocks.push(code);
        }
      });
      if (mermaidBlocks.length > 0) {
        global.mermaid.initialize({ startOnLoad: false, theme: "dark" });
        mermaidBlocks.forEach((code, idx) => {
          const pre = code.parentElement;
          // Fix smart characters that break mermaid syntax
          let src = code.textContent;
          src = src.replace(/\u2014|\u2013|\uFF0D/g, "--");
          src = src.replace(/\u201C|\u201D/g, '"');
          src = src.replace(/\u2018|\u2019/g, "'");

          const viewer = document.createElement("div");
          viewer.className = "mermaid-viewer";
          const toolbar = document.createElement("div");
          toolbar.className = "mermaid-viewer-toolbar";
          const btnZoomIn = document.createElement("button");
          btnZoomIn.textContent = "+";
          btnZoomIn.title = "放大";
          const btnZoomOut = document.createElement("button");
          btnZoomOut.textContent = "−";
          btnZoomOut.title = "缩小";
          const btnFit = document.createElement("button");
          btnFit.textContent = "适应";
          btnFit.title = "适应窗口";
          const btnReset = document.createElement("button");
          btnReset.textContent = "重置";
          btnReset.title = "重置视图";
          toolbar.append(btnZoomIn, btnZoomOut, btnFit, btnReset);

          const viewport = document.createElement("div");
          viewport.className = "mermaid-viewer-viewport";
          const canvas = document.createElement("div");
          canvas.className = "mermaid-viewer-canvas";
          viewport.appendChild(canvas);
          viewer.append(toolbar, viewport);
          pre.replaceWith(viewer);

          // Render individually with error fallback
          const mermaidId = `e3-mermaid-${Date.now()}-${idx}`;
          try {
            global.mermaid
              .render(mermaidId, src)
              .then(({ svg }) => {
                canvas.innerHTML = svg;
                setupMermaidViewer(
                  viewer,
                  canvas,
                  viewport,
                  btnZoomIn,
                  btnZoomOut,
                  btnFit,
                  btnReset
                );
              })
              .catch((err) => {
                canvas.innerHTML = `<pre class="mermaid-error">${escapeHtml(
                  err?.message || String(err)
                )}</pre><pre>${escapeHtml(src)}</pre>`;
              });
          } catch (e) {
            // Fallback for sync errors or older mermaid API
            try {
              const { svg } = global.mermaid.render(mermaidId, src);
              canvas.innerHTML = svg;
              setupMermaidViewer(
                viewer,
                canvas,
                viewport,
                btnZoomIn,
                btnZoomOut,
                btnFit,
                btnReset
              );
            } catch (syncErr) {
              canvas.innerHTML = `<pre class="mermaid-error">${escapeHtml(
                syncErr?.message || String(syncErr)
              )}</pre><pre>${escapeHtml(src)}</pre>`;
            }
          }
        });
      }
    }

    // 5. External links → open in system browser
    content.querySelectorAll('a[href^="http"]').forEach((a) => {
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
      a.addEventListener("click", (e) => {
        e.preventDefault();
        const url = a.href;
        if (global.electronAPI && global.electronAPI.sendOpenExternalLink) {
          global.electronAPI.sendOpenExternalLink(url);
        } else {
          try {
            require("electron").shell.openExternal(url);
          } catch (_) {
            window.open(url, "_blank");
          }
        }
      });
    });

    // 6. Image click to preview + Emoticon URL fix
    content.querySelectorAll("img").forEach((img) => {
      if (img.dataset.e3Enhanced) return;
      img.dataset.e3Enhanced = "true";

      // Fix emoticon/sticker relative URLs
      const src = img.src || "";
      if (src.includes("emoticons/") || src.includes("stickers/")) {
        if (src.startsWith("./") || !src.startsWith("http")) {
          const cleaned = src.replace(/^\.\//, "");
          img.src = `../../${cleaned}`;
        }
      }

      // Smart emoticon URL matching on load error
      if (
        src.includes("emoticon") ||
        src.includes("sticker") ||
        src.includes("表情包")
      ) {
        img.onerror = function () {
          const fixed = fixEmoticonUrlSmart(this.src);
          if (fixed !== this.src) {
            this.onerror = null;
            this.src = fixed;
          }
        };
      }

      img.style.cursor = "pointer";
      img.style.maxWidth = "100%";
      img.addEventListener("click", () => {
        if (global.electronAPI && global.electronAPI.openImageViewer) {
          global.electronAPI.openImageViewer({
            src: img.src,
            title: img.alt || "Image",
          });
        } else {
          window.open(img.src, "_blank");
        }
      });
    });

    // 7. anime.js / Three.js script execution
    if (global.E3AnimationProcessor) {
      global.E3AnimationProcessor.processScripts(content);
    }
  }

  function enhanceContent(content) {
    // Lazy enhancement with IntersectionObserver
    if (!lazyEnhanceObserver) {
      enhanceContentImmediate(content);
      return;
    }

    const block = content.closest(".message-block");
    if (!block) {
      enhanceContentImmediate(content);
      return;
    }

    // Always enhance user messages immediately
    if (block.classList.contains("message-user")) {
      enhanceContentImmediate(content);
      return;
    }

    // Check if already visible
    const rect = block.getBoundingClientRect();
    const isVisible = rect.top < window.innerHeight && rect.bottom > 0;

    if (isVisible) {
      enhanceContentImmediate(content);
    } else {
      lazyEnhanceObserver.defer(block, content);
    }
  }

  function formatMessageTime(input) {
    const timestamp = new Date(input || Date.now());
    const value = Number.isNaN(timestamp.getTime()) ? new Date() : timestamp;
    const pad = (number) => String(number).padStart(2, "0");
    return {
      dateTime: value.toISOString(),
      text: `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(
        value.getDate()
      )} ${pad(value.getHours())}:${pad(value.getMinutes())}`,
    };
  }

  function create(role, id, options = {}) {
    const el = document.createElement("article");
    el.className = `message-block ${
      role === "user" ? "message-user" : "message-assistant"
    }`;
    el.id = `e3msg-${Date.now().toString(36)}${Math.random()
      .toString(36)
      .slice(2, 9)}`;
    if (id) el.dataset.blockId = id;
    const roleNode = document.createElement("div");
    roleNode.className = "message-role";
    const timeInfo = formatMessageTime(options.timestamp || Date.now());
    const timeNode = document.createElement("time");
    timeNode.className = "message-time";
    timeNode.dateTime = timeInfo.dateTime;
    timeNode.textContent = timeInfo.text;
    const labelNode = document.createElement("span");
    if (role === "user") {
      labelNode.textContent = "用户";
      // User: time then label, right-aligned via CSS
      roleNode.append(timeNode, labelNode);
    } else {
      labelNode.textContent = "E3";
      // Assistant: E3 then time above frosted glass, left-aligned via CSS
      roleNode.append(labelNode, timeNode);
    }
    const content = document.createElement("div");
    content.className = "message-content";
    el.append(roleNode, content);
    return el;
  }

  function cleanupMessageResources(el) {
    if (!el) return;
    const content = el.querySelector(".message-content");
    if (content && global.E3AnimationProcessor) {
      global.E3AnimationProcessor.cleanupAnimations(content);
    }
    cleanupScopedStylesForMessage(el);
  }

  function update(el, text, options = {}) {
    const content = el.querySelector(".message-content");
    if (!content) return;
    const source = String(text ?? "");
    const streaming = options.streaming === true;
    if (
      el.__e3LastRenderSource === source &&
      el.__e3LastRenderStreaming === streaming
    )
      return;

    cleanupMessageResources(el);
    content.replaceChildren();
    if (el.classList.contains("message-assistant"))
      appendProtocolBlocks(content, source, { streaming });
    else appendMarkdown(content, source, { streaming: false });
    // 对齐 VChat：流式帧只做轻量内容渲染，完成态再执行重型增强。
    if (!streaming) enhanceContent(content);
    el.classList.toggle("streaming", streaming);
    el.__e3LastRenderSource = source;
    el.__e3LastRenderStreaming = streaming;
  }

  global.E3MessageBlock = {
    create,
    update,
    escapeHtml,
    cleanupMessageResources,
    cleanupScopedStyles,
  };
})(window);
