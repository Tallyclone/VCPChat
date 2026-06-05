"use strict";

(function () {
  const desktopApi = window.desktopAPI || window.electronAPI;
  const { state, CONSTANTS, widget } = window.VCPDesktop;
  const instances = new Map();

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatSize(size) {
    if (!Number.isFinite(size)) return "";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = size;
    let idx = 0;
    while (value >= 1024 && idx < units.length - 1) {
      value /= 1024;
      idx += 1;
    }
    return `${value.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
  }

  const DEFAULT_ICONS = {
    root: "📁",
    folder: "📁",
    folderOpen: "📂",
    directory: "📁",
    file: "📄",
    symlink: "🔗",
    image: "🖼️",
    audio: "🎵",
    video: "🎬",
    archive: "🗜️",
    code: "💻",
    text: "📝",
    pdf: "📕",
    activeFile: "✨",
    selected: "✅",
    up: "⬆",
    ext: {},
  };

  const TOOLBAR_ACTIONS = [
    ["up", "上级"],
    ["refresh", "刷新"],
    ["newFolder", "新建文件夹"],
    ["openWith", "打开方式"],
    ["copy", "复制"],
    ["cut", "剪切"],
    ["paste", "粘贴"],
  ];

  const CONTEXT_MENU_ACTIONS = [
    ["open", "打开"],
    ["openWith", "打开方式"],
    ["reveal", "在资源管理器中显示"],
    ["copy", "复制"],
    ["cut", "剪切"],
    ["paste", "粘贴到当前文件夹"],
    ["rename", "重命名"],
    ["trash", "删除到回收站"],
  ];

  function asObject(value) {
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
  }

  function normalizeActionItem(item) {
    if (item == null || item === false) return null;
    if (typeof item === "string") {
      const id = item.trim();
      return id ? { id } : null;
    }
    if (typeof item === "object") {
      const id = String(item.id || item.action || item.name || "").trim();
      if (!id || item.visible === false) return null;
      return { ...item, id };
    }
    const id = String(item).trim();
    return id ? { id } : null;
  }

  function parseActionList(value) {
    if (Array.isArray(value))
      return value.map(normalizeActionItem).filter(Boolean);
    if (typeof value === "string") {
      return value
        .split(",")
        .map((item) => normalizeActionItem(item))
        .filter(Boolean);
    }
    return null;
  }

  function normalizeActionConfig(value, fallbackActions) {
    if (value === false) return [];
    const directList = parseActionList(value);
    if (directList) return directList;
    const cfg = asObject(value);
    const itemList = parseActionList(cfg.items ?? cfg.include);
    if (itemList) return itemList;
    const disabled = new Set(
      (Array.isArray(cfg.disabled) ? cfg.disabled : []).map((item) =>
        String(item)
      )
    );
    return fallbackActions
      .map(([action]) => ({ id: action }))
      .filter((item) => !disabled.has(item.id));
  }

  function getActionId(action) {
    return typeof action === "object" && action
      ? action.id
      : String(action || "");
  }

  function getActionLabel(action, fallbackLabel) {
    if (typeof action === "object" && action) {
      return action.label ?? action.text ?? fallbackLabel ?? action.id;
    }
    return fallbackLabel ?? String(action || "");
  }

  function getActionIcon(action, fallbackIcon = "") {
    if (typeof action === "object" && action)
      return action.icon ?? fallbackIcon;
    return fallbackIcon;
  }

  function normalizeButtonList(value, fallback = null) {
    if (Array.isArray(value)) return value.map(String).filter(Boolean);
    if (typeof value === "string") {
      return value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    }
    return fallback;
  }

  function normalizeConfig(config = {}) {
    const ui = asObject(config.ui);
    const layout = asObject(ui.layout);
    const actions = asObject(ui.actions);
    const rawIcons = asObject(ui.icons);
    const icons = {
      ...DEFAULT_ICONS,
      ...rawIcons,
      ext: { ...asObject(DEFAULT_ICONS.ext), ...asObject(rawIcons.ext) },
    };
    const requestedView = String(
      layout.view || layout.variant || config.initialView || "list"
    );
    const initialView = ["list", "grid", "compact"].includes(requestedView)
      ? requestedView
      : "list";
    const normalizeBarPosition = (value, fallback = "top") => {
      const position = String(value || fallback);
      return ["top", "bottom", "left", "right", "hidden"].includes(position)
        ? position
        : fallback;
    };
    const confirm = asObject(ui.confirm);
    const rawConfirmStyle = asObject(confirm.style);
    const confirmStyle = {
      ...rawConfirmStyle,
      background:
        confirm.panelBackground ??
        confirm.background ??
        rawConfirmStyle.background,
      foreground:
        confirm.titleColor ??
        confirm.foreground ??
        confirm.color ??
        rawConfirmStyle.foreground,
      color: confirm.titleColor ?? confirm.color ?? rawConfirmStyle.color,
      messageColor:
        confirm.messageColor ??
        confirm.messageForeground ??
        rawConfirmStyle.messageColor,
      detailColor:
        confirm.detailColor ??
        confirm.detailForeground ??
        rawConfirmStyle.detailColor,
      borderColor:
        confirm.panelBorder ??
        confirm.borderColor ??
        rawConfirmStyle.borderColor,
      radius: confirm.panelRadius ?? confirm.radius ?? rawConfirmStyle.radius,
      shadow: confirm.panelShadow ?? confirm.shadow ?? rawConfirmStyle.shadow,
      overlay: confirm.overlay ?? rawConfirmStyle.overlay,
      backdropFilter: confirm.backdropFilter ?? rawConfirmStyle.backdropFilter,
      primaryColor: confirm.primaryColor ?? rawConfirmStyle.primaryColor,
      dangerColor: confirm.dangerColor ?? rawConfirmStyle.dangerColor,
      cancelColor: confirm.cancelColor ?? rawConfirmStyle.cancelColor,
      buttonRadius: confirm.buttonRadius ?? rawConfirmStyle.buttonRadius,
    };
    const agentUI = asObject(ui.agentUI);
    const preview = asObject(agentUI.preview);
    const execution = asObject(agentUI.execution);
    const normalizedAgentUI = {
      ...agentUI,
      preview,
      execution,
      showRiskSummary:
        preview.showRiskSummary !== false && agentUI.showRiskSummary !== false,
      showDetails:
        preview.showDetails !== false && agentUI.showDetails !== false,
      showProgress:
        execution.showProgress !== false && agentUI.showProgress !== false,
      position:
        agentUI.position || preview.position || execution.position || "top",
      previewLayout: preview.layout || agentUI.previewLayout,
      executionLayout: execution.layout || agentUI.executionLayout,
      previewTitle:
        preview.title ?? preview.previewTitle ?? agentUI.previewTitle,
      intentLabel: preview.intentLabel ?? agentUI.intentLabel,
      detailText: preview.detailText ?? agentUI.detailText,
      denyText: preview.denyText ?? agentUI.denyText,
      trustText: preview.trustText ?? agentUI.trustText,
      allowText: preview.allowText ?? agentUI.allowText,
      allowHighRiskText: preview.allowHighRiskText ?? agentUI.allowHighRiskText,
      createsLabel: preview.createsLabel ?? agentUI.createsLabel,
      movesLabel: preview.movesLabel ?? agentUI.movesLabel,
      noTrashText: preview.noTrashText ?? agentUI.noTrashText,
      noOverwriteText: preview.noOverwriteText ?? agentUI.noOverwriteText,
      executionTitle:
        execution.title ?? execution.executionTitle ?? agentUI.executionTitle,
      executionPreparingText:
        execution.preparingText ??
        execution.executionPreparingText ??
        agentUI.executionPreparingText,
      progressTemplate: execution.progressTemplate ?? agentUI.progressTemplate,
      cancellingText: execution.cancellingText ?? agentUI.cancellingText,
      cancelText: execution.cancelText ?? agentUI.cancelText,
      previewButtons: normalizeButtonList(
        preview.buttons ?? agentUI.previewButtons,
        null
      ),
      executionButtons: normalizeButtonList(
        execution.buttons ?? agentUI.executionButtons,
        null
      ),
    };
    return {
      mountPath: config.mountPath,
      mode: config.mode === "readwrite" ? "readwrite" : "readonly",
      showHidden: config.showHidden === true,
      initialView,
      realtime: config.realtime !== false,
      ui: {
        theme: asObject(ui.theme),
        layout: {
          view: initialView,
          variant: initialView,
          toolbarPosition: normalizeBarPosition(layout.toolbarPosition, "top"),
          pathBarPosition: normalizeBarPosition(layout.pathBarPosition, "top"),
          statusBarPosition: normalizeBarPosition(
            layout.statusBarPosition,
            "bottom"
          ),
          showPath:
            layout.showPath !== false &&
            normalizeBarPosition(layout.pathBarPosition, "top") !== "hidden",
          showStatus:
            layout.showStatus !== false &&
            normalizeBarPosition(layout.statusBarPosition, "bottom") !==
              "hidden",
          showToolbar:
            layout.showToolbar !== false &&
            normalizeBarPosition(layout.toolbarPosition, "top") !== "hidden",
          compact: initialView === "compact" || layout.compact === true,
          rowHeight: Number(layout.rowHeight) || null,
          showSize: layout.showSize !== false,
          showMtime: layout.showMtime !== false,
          showHiddenBadge: layout.showHiddenBadge !== false,
          grid: {
            minItemWidth:
              Number(layout.gridMinItemWidth) ||
              Number(asObject(layout.grid).minItemWidth) ||
              116,
            itemHeight:
              Number(layout.gridItemHeight) ||
              Number(asObject(layout.grid).itemHeight) ||
              92,
          },
        },
        actions: {
          toolbar: normalizeActionConfig(
            actions.toolbar ?? ui.toolbar,
            TOOLBAR_ACTIONS
          ),
          contextMenu: normalizeActionConfig(
            actions.contextMenu ?? ui.contextMenu,
            CONTEXT_MENU_ACTIONS
          ),
          readonlyBehavior: actions.readonlyBehavior || "hide",
        },
        icons,
        confirm: {
          ...confirm,
          style: confirmStyle,
          enabled: confirm.enabled !== false,
        },
        agentUI: normalizedAgentUI,
      },
    };
  }

  function cssVar(name, value) {
    if (value == null || value === "") return "";
    return `${name}:${String(value)};`;
  }

  function buildThemeStyle(config) {
    const theme = config.ui?.theme || {};
    const confirmStyle = asObject(config.ui?.confirm?.style);
    const agentStyle = asObject(config.ui?.agentUI?.style);
    return [
      cssVar("--nfm-bg", theme.background),
      cssVar("--nfm-fg", theme.foreground || theme.color),
      cssVar("--nfm-muted", theme.muted),
      cssVar("--nfm-accent", theme.accent),
      cssVar("--nfm-toolbar-bg", theme.toolbarBackground),
      cssVar("--nfm-panel-bg", theme.panelBackground),
      cssVar("--nfm-border", theme.borderColor || theme.border),
      cssVar("--nfm-danger", theme.danger || theme.dangerColor),
      cssVar("--nfm-row-hover", theme.rowHover || theme.rowHoverBackground),
      cssVar("--nfm-selected", theme.selected || theme.selectedBackground),
      cssVar("--nfm-selected-outline", theme.selectedOutline),
      cssVar("--nfm-blur", theme.blur || theme.backdropFilter),
      cssVar("--nfm-transparent", theme.transparent),
      cssVar("--nfm-radius", theme.radius),
      cssVar("--nfm-font", theme.fontFamily),
      cssVar("--nfm-font-size", theme.fontSize),
      cssVar("--nfm-confirm-bg", confirmStyle.background),
      cssVar("--nfm-confirm-fg", confirmStyle.foreground || confirmStyle.color),
      cssVar(
        "--nfm-confirm-title-color",
        confirmStyle.foreground || confirmStyle.color
      ),
      cssVar("--nfm-confirm-message-color", confirmStyle.messageColor),
      cssVar("--nfm-confirm-detail-color", confirmStyle.detailColor),
      cssVar("--nfm-confirm-border", confirmStyle.borderColor),
      cssVar("--nfm-confirm-radius", confirmStyle.radius),
      cssVar("--nfm-confirm-shadow", confirmStyle.shadow),
      cssVar("--nfm-confirm-overlay", confirmStyle.overlay),
      cssVar("--nfm-confirm-backdrop", confirmStyle.backdropFilter),
      cssVar("--nfm-confirm-primary", confirmStyle.primaryColor),
      cssVar("--nfm-confirm-danger", confirmStyle.dangerColor),
      cssVar("--nfm-confirm-cancel", confirmStyle.cancelColor),
      cssVar("--nfm-confirm-button-radius", confirmStyle.buttonRadius),
      cssVar("--nfm-agent-bg", agentStyle.background),
      cssVar("--nfm-agent-fg", agentStyle.foreground || agentStyle.color),
      cssVar("--nfm-agent-border", agentStyle.borderColor),
      cssVar("--nfm-agent-radius", agentStyle.radius),
      cssVar("--nfm-agent-shadow", agentStyle.shadow),
    ].join("");
  }

  function clonePlain(value) {
    if (value == null) return value;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (error) {
      return value;
    }
  }

  function formatSourceValue(value) {
    if (value == null) return "";
    if (Array.isArray(value)) return value.join(", ");
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  }

  function appendSourceField(lines, key, value) {
    if (value == null || value === "") return;
    const text = formatSourceValue(value);
    if (/\r|\n/.test(text) || /[「」]/.test(text)) {
      lines.push(`${key}:「始」`);
      lines.push(text);
      lines.push("「末」");
    } else {
      lines.push(`${key}: ${text}`);
    }
  }

  function appendNestedSourceFields(lines, prefix, value) {
    const obj = asObject(value);
    for (const [key, child] of Object.entries(obj)) {
      const nextKey = `${prefix}.${key}`;
      if (child && typeof child === "object" && !Array.isArray(child)) {
        appendNestedSourceFields(lines, nextKey, child);
      } else {
        appendSourceField(lines, nextKey, child);
      }
    }
  }

  function generateNativeFileMountSource(
    config = {},
    customUI = null,
    options = {}
  ) {
    const lines = ["type: nativeFileMount"];
    appendSourceField(lines, "widgetId", options.widgetId);
    appendSourceField(
      lines,
      "title",
      config.title || options.title || "本机文件夹"
    );
    appendSourceField(lines, "mountPath", config.mountPath);
    appendSourceField(lines, "mode", config.mode || "readonly");
    if (config.showHidden === true)
      appendSourceField(lines, "showHidden", true);
    if (config.initialView)
      appendSourceField(lines, "layout.view", config.initialView);
    if (config.realtime === false) appendSourceField(lines, "realtime", false);
    if (config.ui) appendNestedSourceFields(lines, "ui", config.ui);
    if (options.frame) appendNestedSourceFields(lines, "frame", options.frame);
    if (customUI) {
      appendSourceField(lines, "html", customUI.html || customUI.htmlContent);
      appendSourceField(lines, "css", customUI.css);
      appendSourceField(lines, "js", customUI.js);
      if (customUI.fallbackToDefault === false) {
        appendSourceField(lines, "fallbackToDefault", false);
      }
    }
    return `${lines.join("\n")}\n`;
  }

  function parseNativeFileMountSource(rawText) {
    const START_MARKER = "「始」";
    const END_MARKER = "「末」";
    const START_ESCAPE_MARKER = "「始ESCAPE」";
    const END_ESCAPE_MARKER = "「末ESCAPE」";
    const payload = {
      type: "nativeFileMount",
      title: undefined,
      widgetId: undefined,
      config: {},
      options: {},
      customUI: null,
    };
    const lines = String(rawText || "")
      .replace(/^\uFEFF/, "")
      .split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const rawLine = lines[i];
      const line = rawLine.trim();
      if (!line || line.startsWith("#") || line.startsWith("//")) continue;
      const blockMatch = line.match(
        /^([A-Za-z0-9_.-]+)\s*:\s*(「始(?:ESCAPE)?」)\s*$/
      );
      let key;
      let value;
      if (blockMatch) {
        key = blockMatch[1];
        const startMarker = blockMatch[2];
        const endMarker =
          startMarker === START_ESCAPE_MARKER ? END_ESCAPE_MARKER : END_MARKER;
        const blockLines = [];
        let closed = false;
        while (++i < lines.length) {
          if (lines[i].trim() === endMarker) {
            closed = true;
            break;
          }
          blockLines.push(lines[i]);
        }
        if (!closed)
          throw new Error(`DESKTOP_BUILTIN field "${key}" block is not closed`);
        value = blockLines.join("\n");
      } else {
        const kvMatch = rawLine.match(/^\s*([A-Za-z0-9_.-]+)\s*:\s*([\s\S]*)$/);
        if (!kvMatch) continue;
        key = kvMatch[1];
        value = kvMatch[2].trim();
        const escapeInlineMatch = String(value).match(
          /^「始ESCAPE」([\s\S]*?)「末ESCAPE」$/
        );
        const inlineMatch = String(value).match(/^「始」([\s\S]*?)「末」$/);
        if (escapeInlineMatch) value = escapeInlineMatch[1];
        else if (inlineMatch) value = inlineMatch[1];
        else if (/^(true|false)$/i.test(value))
          value = value.toLowerCase() === "true";
        else if (/^-?\d+(?:\.\d+)?$/.test(value)) value = Number(value);
      }
      if (key === "type") payload.type = String(value || "");
      else if (key === "title" || key === "name")
        payload.title = String(value || "");
      else if (key === "widgetId" || key === "id")
        payload.widgetId = String(value || "");
      else if (
        [
          "mountPath",
          "path",
          "root",
          "rootPath",
          "folder",
          "dir",
          "directory",
        ].includes(key)
      )
        payload.config.mountPath = value;
      else if (key === "mode")
        payload.config.mode = value === "readwrite" ? "readwrite" : "readonly";
      else if (key === "readonly")
        payload.config.mode = value === true ? "readonly" : "readwrite";
      else if (key === "showHidden" || key === "realtime")
        payload.config[key] = value;
      else if (key === "initialView" || key === "view")
        payload.config.initialView = String(value || "list");
      else if (
        key === "layout" ||
        key === "variant" ||
        key === "layout.view" ||
        key === "ui.layout.view"
      ) {
        payload.config.ui = payload.config.ui || {};
        payload.config.ui.layout = payload.config.ui.layout || {};
        payload.config.ui.layout.view = String(value || "list");
        payload.config.initialView = String(value || "list");
      } else if (key.startsWith("ui.")) {
        const parts = key.split(".").slice(1);
        let node = (payload.config.ui = payload.config.ui || {});
        while (parts.length > 1) {
          const part = parts.shift();
          node = node[part] =
            node[part] && typeof node[part] === "object" ? node[part] : {};
        }
        node[parts[0]] = value;
      } else if (key.startsWith("frame.")) {
        const parts = key.split(".").slice(1);
        let node = (payload.options.frame = payload.options.frame || {});
        while (parts.length > 1) {
          const part = parts.shift();
          node = node[part] =
            node[part] && typeof node[part] === "object" ? node[part] : {};
        }
        node[parts[0]] = value;
      } else if (
        ["html", "css", "js", "htmlContent", "fallbackToDefault"].includes(key)
      ) {
        payload.customUI = payload.customUI || {
          runtime: "vcp-widget-shadow",
          version: 2,
        };
        if (key === "htmlContent") payload.customUI.html = String(value || "");
        else payload.customUI[key] = value;
      } else if (key.startsWith("customUI.")) {
        payload.customUI = payload.customUI || {
          runtime: "vcp-widget-shadow",
          version: 2,
        };
        payload.customUI[key.slice("customUI.".length)] = value;
      } else if (key !== "type") {
        payload.config[key] = value;
      }
    }
    if (payload.type !== "nativeFileMount")
      throw new Error("DESKTOP_BUILTIN source is not nativeFileMount");
    if (!payload.config.mountPath)
      throw new Error("DESKTOP_BUILTIN nativeFileMount requires mountPath");
    payload.config.mode =
      payload.config.mode === "readwrite" ? "readwrite" : "readonly";
    return payload;
  }

  async function spawnNativeFileMount({
    title = "本机文件夹",
    config = {},
    widgetId,
    options = {},
    customUI = null,
    source = "",
  } = {}) {
    const normalized = { ...normalizeConfig(config), title };
    const id =
      widgetId ||
      `nfm-${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 6)}`;
    const widgetData = widget.create(id, {
      x: options.x || 160,
      y: options.y || CONSTANTS.TITLE_BAR_HEIGHT + 60,
      width: options.width || 620,
      height: options.height || 460,
      frame: options.frame || null,
    });
    if (!widgetData) return null;

    const canonicalSource =
      source ||
      generateNativeFileMountSource(normalized, customUI, {
        ...options,
        widgetId: id,
        title,
      });
    widgetData.cardType = "nativeFileMount";
    widgetData.sourceFormat = "desktopBuiltin";
    widgetData.sourceOrigin = source ? "stored" : "generated";
    widgetData.sourceCompleteness = "full";
    widgetData.builtinWidgetKey = "nativeFileMount";
    widgetData.builtinConfig = clonePlain(normalized);
    widgetData.builtinCustomUI = clonePlain(customUI || null);
    widgetData.builtinSource = canonicalSource;
    widgetData.cardSource = canonicalSource;
    widgetData.cardPackage = null;
    widgetData.widgetVersion = Number(widgetData.widgetVersion) || 1;
    widgetData.sourceVersion = Number(widgetData.sourceVersion) || 1;
    widgetData.layoutVersion = Number(widgetData.layoutVersion) || 1;

    widgetData.fixedSize = true;
    widgetData.contentContainer.style.width = "100%";
    widgetData.contentContainer.style.height = "100%";
    widgetData.contentContainer.style.overflow = "hidden";
    widgetData.contentContainer.style.display = "block";
    widgetData.contentContainer.innerHTML = buildShell(title, normalized);
    widget.processInlineStyles(widgetData);
    widgetData.isConstructing = false;
    widgetData.element.classList.remove("constructing");

    const root = widgetData.contentContainer.querySelector(".nfm-root");
    const instance = createInstance({
      id,
      title,
      config: normalized,
      root,
      widgetData,
      customUI,
    });
    instances.set(id, instance);
    widgetData.nativeFileMount = instance;
    widgetData._cleanup = async () => {
      await instance.cleanup();
      instances.delete(id);
    };

    try {
      await instance.init();
      return { widgetId: id, instance };
    } catch (error) {
      console.warn("[NativeFileMount] mount initialization failed:", error);
      await instance.cleanup().catch(() => {});
      instances.delete(id);
      widgetData._cleanup = null;
      if (window.VCPDesktop?.widget?.remove) {
        window.VCPDesktop.widget.remove(id);
      } else {
        widgetData.element?.remove?.();
        state.widgets?.delete?.(id);
      }
      throw error;
    }
  }

  function buildShell(title, config) {
    const ui = config.ui || {};
    const layout = ui.layout || {};
    const icons = ui.icons || DEFAULT_ICONS;
    const readonlyWriteActions = new Set([
      "newFolder",
      "cut",
      "paste",
      "rename",
      "trash",
      "move",
      "copyTo",
    ]);
    const readonlyBehavior = ui.actions?.readonlyBehavior || "hide";
    const isReadonly = config.mode !== "readwrite";
    const allowAction = (action) =>
      !isReadonly ||
      !readonlyWriteActions.has(action) ||
      readonlyBehavior !== "hide";
    const disabledAttr = (action) =>
      isReadonly &&
      readonlyWriteActions.has(action) &&
      readonlyBehavior === "disable"
        ? ' disabled aria-disabled="true" title="只读模式不可用"'
        : "";
    const toolbarLabels = new Map(TOOLBAR_ACTIONS);
    const toolbar = (ui.actions?.toolbar || [])
      .filter((action) => allowAction(getActionId(action)))
      .map((action) => {
        const actionId = getActionId(action);
        if (actionId === "separator")
          return '<span class="nfm-separator"></span>';
        if (actionId === "spacer") return '<span class="nfm-spacer"></span>';
        const label = getActionLabel(
          action,
          toolbarLabels.get(actionId) || actionId
        );
        const fallbackIcon = actionId === "up" ? icons.up || "⬆" : "";
        const icon = getActionIcon(action, fallbackIcon);
        const primary = action?.primary ? " primary" : "";
        return `<button class="nfm-btn${primary}" data-act="${escapeHtml(
          actionId
        )}"${disabledAttr(actionId)}>${
          icon ? `${escapeHtml(icon)} ` : ""
        }${escapeHtml(label)}</button>`;
      })
      .join("");
    const toolbarHtml =
      layout.showToolbar === false
        ? ""
        : `<div class="nfm-toolbar"><span class="nfm-title">${escapeHtml(
            icons.root || "📁"
          )} ${escapeHtml(title)}</span><span class="nfm-mode">${escapeHtml(
            config.mode
          )}</span>${toolbar}<span class="nfm-spacer"></span></div>`;
    const compactClass = layout.compact ? " compact" : "";
    const pathHtml =
      layout.showPath === false
        ? ""
        : `<div class="nfm-path">${escapeHtml(config.mountPath || "")}</div>`;
    const statusHtml =
      layout.showStatus === false ? "" : '<div class="nfm-status">就绪</div>';
    const topBars = [];
    const bottomBars = [];
    const leftBars = [];
    const rightBars = [];
    const pushBar = (html, position, fallback = "top") => {
      if (!html) return;
      const target = ["top", "bottom", "left", "right"].includes(position)
        ? position
        : fallback;
      if (target === "bottom") bottomBars.push(html);
      else if (target === "left") leftBars.push(html);
      else if (target === "right") rightBars.push(html);
      else topBars.push(html);
    };
    pushBar(toolbarHtml, layout.toolbarPosition, "top");
    pushBar(pathHtml, layout.pathBarPosition, "top");
    pushBar(statusHtml, layout.statusBarPosition, "bottom");
    const sideLayoutClass =
      leftBars.length || rightBars.length ? " has-side-bars" : "";
    return `
<style>
.nfm-root{--nfm-bg:rgba(18,24,38,.92);--nfm-fg:#e5eefc;--nfm-muted:#94a3b8;--nfm-accent:#6366f1;--nfm-toolbar-bg:rgba(255,255,255,.06);--nfm-panel-bg:rgba(15,23,42,.98);--nfm-border:rgba(255,255,255,.08);--nfm-danger:#ef4444;--nfm-row-hover:rgba(99,102,241,.16);--nfm-selected:rgba(99,102,241,.22);--nfm-selected-outline:rgba(165,180,252,.55);--nfm-blur:none;--nfm-transparent:transparent;--nfm-radius:12px;--nfm-font:"Segoe UI",system-ui,sans-serif;--nfm-font-size:13px;${buildThemeStyle(
      config
    )}height:100%;width:100%;display:flex;flex-direction:column;background:var(--nfm-bg);color:var(--nfm-fg);border-radius:var(--nfm-radius);overflow:hidden;font-family:var(--nfm-font);font-size:var(--nfm-font-size);border:1px solid var(--nfm-border);-webkit-app-region:no-drag}
.nfm-root.compact{font-size:calc(var(--nfm-font-size) - 1px)}.nfm-root.compact .nfm-toolbar{padding:6px}.nfm-root.compact .nfm-row{height:28px}.nfm-toolbar{display:flex;align-items:center;gap:8px;padding:10px;background:var(--nfm-toolbar-bg);border-bottom:1px solid var(--nfm-border);flex-shrink:0;flex-wrap:wrap}
.nfm-title{font-weight:700;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.nfm-mode{font-size:11px;padding:2px 6px;border-radius:999px;background:color-mix(in srgb,var(--nfm-accent) 30%,transparent)}
.nfm-spacer{flex:1}.nfm-separator{width:1px;align-self:stretch;background:var(--nfm-border);margin:0 2px}.nfm-btn{border:0;border-radius:var(--nfm-confirm-button-radius,8px);padding:6px 9px;background:rgba(255,255,255,.09);color:var(--nfm-fg);cursor:pointer}.nfm-btn.primary{background:var(--nfm-confirm-primary,rgba(99,102,241,.65))}.nfm-btn:hover{background:rgba(255,255,255,.16)}.nfm-btn.danger{color:#fecaca;background:var(--nfm-confirm-danger,rgba(255,255,255,.09))}.nfm-dialog-actions .nfm-btn:not(.danger){background:var(--nfm-confirm-cancel,rgba(255,255,255,.09))}.nfm-dialog-actions .nfm-btn[data-confirm-ok]:not(.danger){background:var(--nfm-confirm-primary,rgba(255,255,255,.09))}.nfm-path{padding:8px 10px;color:#a5b4fc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-bottom:1px solid rgba(255,255,255,.06)}
.nfm-main{flex:1;min-height:0;display:flex;overflow:hidden}.nfm-side{flex-shrink:0;min-height:0;overflow:auto}.nfm-list{flex:1;min-height:0;overflow:auto;padding:6px}.nfm-virtual{position:relative;min-height:100%}.nfm-row{position:absolute;left:0;right:0;height:var(--nfm-row-height,34px);display:grid;grid-template-columns:28px minmax(120px,1fr) 86px 140px;gap:8px;align-items:center;padding:0 8px;border-radius:8px;cursor:pointer;user-select:none;-webkit-user-drag:none}.nfm-root[data-view="grid"] .nfm-virtual{display:grid;grid-template-columns:repeat(auto-fill,minmax(var(--nfm-grid-min,116px),1fr));grid-auto-rows:var(--nfm-grid-height,92px);gap:8px;align-content:start}.nfm-root[data-view="grid"] .nfm-row{position:relative;left:auto;right:auto;top:auto!important;height:auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:8px;text-align:center}.nfm-root[data-view="grid"] .nfm-row>span:first-child{font-size:26px}.nfm-root[data-view="grid"] .nfm-name{max-width:100%;white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}.nfm-root[data-view="grid"] .nfm-meta{display:none}.nfm-row:hover,.nfm-row.selected{background:rgba(99,102,241,.22)}.nfm-row.selected{outline:1px solid rgba(165,180,252,.55)}.nfm-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.nfm-meta{font-size:12px;color:var(--nfm-muted)}.nfm-status{min-height:24px;padding:4px 10px;color:#cbd5e1;border-top:1px solid rgba(255,255,255,.06);font-size:12px;flex-shrink:0}.nfm-empty{padding:32px;text-align:center;color:var(--nfm-muted)}.nfm-menu{position:absolute;z-index:30;min-width:150px;padding:6px;background:var(--nfm-panel-bg);border:1px solid rgba(148,163,184,.35);border-radius:10px;box-shadow:0 14px 36px rgba(0,0,0,.38)}.nfm-menu button{display:block;width:100%;padding:7px 10px;border:0;border-radius:7px;background:transparent;color:var(--nfm-fg);text-align:left;cursor:pointer}.nfm-menu button:hover{background:rgba(99,102,241,.24)}.nfm-menu button.danger{color:#fecaca}.nfm-menu-separator{height:1px;background:rgba(148,163,184,.28);margin:5px 4px}.nfm-dialog{position:absolute;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;background:var(--nfm-confirm-overlay,rgba(2,6,23,.46));backdrop-filter:var(--nfm-confirm-backdrop,none)}.nfm-dialog[data-position='top']{align-items:flex-start;padding-top:18px}.nfm-dialog[data-position='bottom']{align-items:flex-end;padding-bottom:18px}.nfm-dialog-panel{width:min(340px,calc(100% - 28px));padding:14px;background:var(--nfm-confirm-bg,var(--nfm-panel-bg));color:var(--nfm-confirm-fg,var(--nfm-fg));border:1px solid var(--nfm-confirm-border,rgba(148,163,184,.35));border-radius:var(--nfm-confirm-radius,12px);box-shadow:var(--nfm-confirm-shadow,0 18px 44px rgba(0,0,0,.42))}.nfm-dialog-panel h3{color:var(--nfm-confirm-title-color,var(--nfm-confirm-fg,var(--nfm-fg)))}.nfm-dialog-panel label{display:block;margin-bottom:8px;color:var(--nfm-confirm-message-color,var(--nfm-confirm-fg,var(--nfm-fg)))}.nfm-dialog-panel input{width:100%;padding:8px 10px;border:1px solid rgba(148,163,184,.42);border-radius:8px;background:rgba(15,23,42,.9);color:var(--nfm-fg);outline:none}.nfm-confirm-details{max-height:120px;overflow:auto;margin:8px 0;padding:8px;border:1px solid rgba(148,163,184,.25);border-radius:8px;color:var(--nfm-confirm-detail-color,var(--nfm-muted));font-size:12px}.nfm-confirm-affected-count{margin:8px 0 0;color:var(--nfm-confirm-detail-color,var(--nfm-muted));font-size:12px}.nfm-dialog[data-variant='glass']{backdrop-filter:var(--nfm-confirm-backdrop,blur(8px))}.nfm-dialog[data-variant='minimal']{background:transparent;backdrop-filter:none}.nfm-dialog[data-variant='minimal'] .nfm-dialog-panel{box-shadow:none}.nfm-dialog-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}.nfm-agent{position:absolute;inset:40px 18px auto 18px;background:var(--nfm-agent-bg,var(--nfm-panel-bg));color:var(--nfm-agent-fg,var(--nfm-fg));border:1px solid var(--nfm-agent-border,rgba(248,113,113,.35));border-radius:var(--nfm-agent-radius,12px);padding:14px;box-shadow:var(--nfm-agent-shadow,0 16px 40px rgba(0,0,0,.35));z-index:5}.nfm-agent[data-position='bottom']{inset:auto 18px 40px 18px}.nfm-agent[data-position='center']{inset:50% 18px auto 18px;transform:translateY(-50%)}.nfm-agent[data-layout='compact'] ul,.nfm-agent[data-show-details='0'] details,.nfm-agent[data-show-risk-summary='0'] ul,.nfm-agent[data-show-progress='0'] [data-agent-progress]{display:none}.nfm-agent h3{margin:0 0 8px}.nfm-agent-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}.nfm-job-cancel{margin-left:8px;padding:2px 6px;border:0;border-radius:6px;background:rgba(248,113,113,.22);color:#fecaca;cursor:pointer}
</style>
<div class="nfm-root${compactClass}${sideLayoutClass}" tabindex="0" data-mode="${escapeHtml(
      config.mode
    )}" data-view="${escapeHtml(config.initialView)}">
  ${topBars.filter(Boolean).join("\n  ")}
  <div class="nfm-main">
    ${
      leftBars.length
        ? `<div class="nfm-side left">${leftBars.join("\n")}</div>`
        : ""
    }
    <div class="nfm-list"><div class="nfm-empty">正在挂载...</div></div>
    ${
      rightBars.length
        ? `<div class="nfm-side right">${rightBars.join("\n")}</div>`
        : ""
    }
  </div>
  ${bottomBars.filter(Boolean).join("\n  ")}
</div>`;
  }

  function createInstance({ id, title, config, root, widgetData, customUI }) {
    let mountId = null;
    let capabilityToken = null;
    let ownerWidgetId = id;
    let rootPath = null;
    let currentDir = null;
    let parentDir = null;
    let hasMore = false;
    let nextCursor = null;
    let entries = [];
    let selected = new Set(); // stores stable entry.path values, not virtual row indexes
    let unsubChanged = null;
    let unsubResync = null;
    let unsubJob = null;
    let busy = false;
    let virtualScrollTop = 0;
    let virtualViewportHeight = 0;
    let virtualRenderScheduled = false;
    let customRuntimeHandle = null;
    let customUIActive = false;
    let customUIRequested = !!customUI;
    let customUIMounted = false;
    let customUIFallbackToDefault = false;
    let customUIError = null;
    let contextMenuEl = null;
    let contextMenuTargetPath = null;
    let statusHoldUntil = 0;
    const changeCallbacks = new Set();
    const jobProgressCallbacks = new Set();
    let agentRequestCallback = null;

    let listEl = root.querySelector(".nfm-list");
    let pathEl = root.querySelector(".nfm-path");
    let statusEl = root.querySelector(".nfm-status");

    function getEntryIcon(entry) {
      const icons = config.ui?.icons || DEFAULT_ICONS;
      if (entry?.type === "directory")
        return icons.directory || icons.folder || "📁";
      if (entry?.type === "symlink") return icons.symlink || "🔗";
      const name = String(entry?.name || "");
      const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
      if (ext && icons.ext?.[ext]) return icons.ext[ext];
      const groups = {
        image: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"],
        audio: ["mp3", "wav", "flac", "aac", "ogg", "m4a"],
        video: ["mp4", "mkv", "avi", "mov", "webm", "wmv"],
        archive: ["zip", "rar", "7z", "tar", "gz", "bz2", "xz"],
        code: [
          "js",
          "ts",
          "jsx",
          "tsx",
          "css",
          "html",
          "json",
          "py",
          "go",
          "rs",
          "java",
          "c",
          "cpp",
          "cs",
          "php",
          "rb",
          "sh",
          "ps1",
        ],
        text: ["txt", "md", "log", "csv", "yml", "yaml", "ini", "toml"],
        pdf: ["pdf"],
      };
      for (const [group, extensions] of Object.entries(groups)) {
        if (extensions.includes(ext) && icons[group]) return icons[group];
      }
      return icons.file || "📄";
    }

    function setStatus(text, options = {}) {
      if (customUIActive || !statusEl) return;
      if (!options.force && Date.now() < statusHoldUntil) return;
      statusEl.textContent = text;
      if (options.holdMs) statusHoldUntil = Date.now() + options.holdMs;
    }

    function getModalHost() {
      return widgetData.contentContainer || root || document.body;
    }

    function focusRoot() {
      try {
        root?.focus?.({ preventScroll: true });
      } catch (_) {
        root?.focus?.();
      }
    }

    function removeContextMenu() {
      if (contextMenuEl) {
        contextMenuEl.remove();
        contextMenuEl = null;
      }
      contextMenuTargetPath = null;
    }

    function selectIndex(index, append = false) {
      if (!Number.isInteger(index) || !entries[index]) return null;
      const entry = entries[index];
      const key = entry.path;
      if (!key) return null;
      if (append) {
        if (selected.has(key)) selected.delete(key);
        else selected.add(key);
      } else {
        selected.clear();
        selected.add(key);
      }
      return entry;
    }

    function syncSelectionStyles() {
      root.querySelectorAll(".nfm-row").forEach((row) => {
        const entry = entries[Number(row.dataset.index)];
        const isSelected = !!entry?.path && selected.has(entry.path);
        row.classList.toggle("selected", isSelected);
        row.dataset.selected = isSelected ? "1" : "0";
        row.setAttribute("aria-selected", isSelected ? "true" : "false");
        row.style.background = "";
        row.style.outline = "";
        row.style.boxShadow = "";
      });
    }

    function clearSelection() {
      if (selected.size === 0) return false;
      selected.clear();
      syncSelectionStyles();
      return true;
    }

    function isEditableTarget(target) {
      const el = target?.closest?.(
        "input, textarea, select, [contenteditable='true'], [contenteditable='']"
      );
      return !!el;
    }

    function isReadonlyWriteAction(action) {
      return [
        "newFolder",
        "cut",
        "paste",
        "rename",
        "trash",
        "move",
        "copyTo",
      ].includes(action);
    }

    function getReadonlyBehavior() {
      return config.ui?.actions?.readonlyBehavior || "hide";
    }

    function isActionEnabled(action, area = "toolbar") {
      const actionId = getActionId(action);
      const list = config.ui?.actions?.[area];
      if (
        Array.isArray(list) &&
        !list.some((item) => getActionId(item) === actionId)
      )
        return false;
      return !(
        config.mode !== "readwrite" &&
        isReadonlyWriteAction(actionId) &&
        getReadonlyBehavior() !== "disable"
      );
    }

    function isHighRiskConfirm(type) {
      return [
        "trash",
        "overwrite",
        "crossDeviceMove",
        "agentHighRisk",
      ].includes(type);
    }

    function nfmConfirm({
      type = "normal",
      severity = null,
      title = "确认操作",
      message = "确定继续？",
      confirmText = "确定",
      cancelText = "取消",
      danger = false,
      details = null,
      actions = null,
    } = {}) {
      const confirmConfig = config.ui?.confirm || {};
      const resolvedSeverity = String(severity || type || "normal");
      const isDangerSeverity = [
        "danger",
        "error",
        "warning",
        "trash",
        "overwrite",
        "crossDeviceMove",
        "agentHighRisk",
      ].includes(resolvedSeverity);
      if (confirmConfig.enabled === false && !isHighRiskConfirm(type)) {
        return Promise.resolve({
          action: "skipped",
          accepted: true,
          confirmed: false,
          skipped: true,
        });
      }
      const configuredOrder = normalizeButtonList(
        confirmConfig.buttonOrder,
        null
      );
      const actionList = Array.isArray(actions)
        ? actions
        : [
            {
              id: "cancel",
              label: confirmConfig.cancelText || cancelText,
              role: "cancel",
            },
            {
              id: "confirm",
              label: confirmConfig.confirmText || confirmText,
              role: danger || isDangerSeverity ? "danger" : "primary",
            },
          ];
      const rawAffectedCount = Number(
        confirmConfig.affectedCount ??
          confirmConfig.count ??
          (Array.isArray(details) ? details.length : null)
      );
      const affectedCount = Number.isFinite(rawAffectedCount)
        ? Math.max(0, rawAffectedCount)
        : 0;
      const orderedActions = configuredOrder
        ? actionList.slice().sort((a, b) => {
            const ai = configuredOrder.indexOf(a.id);
            const bi = configuredOrder.indexOf(b.id);
            return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
          })
        : actionList;
      return new Promise((resolve) => {
        removeContextMenu();
        const overlay = document.createElement("div");
        overlay.className = "nfm-dialog";
        overlay.dataset.confirmType = type;
        overlay.dataset.position = confirmConfig.position || "center";
        overlay.dataset.variant = confirmConfig.variant || "default";
        const iconMap = asObject(confirmConfig.icons);
        const icon =
          confirmConfig.showIcon === false
            ? ""
            : confirmConfig.icon ||
              iconMap[type] ||
              iconMap[danger ? "danger" : "warning"] ||
              "";
        const configDetails = Array.isArray(confirmConfig.details)
          ? confirmConfig.details
          : [];
        const extraDetails = Array.isArray(details)
          ? details
          : details && typeof details === "object"
          ? Object.entries(details).map(([label, value]) => ({ label, value }))
          : [];
        const detailItems = [...configDetails, ...extraDetails];
        const detailHtml =
          confirmConfig.showDetails === false || detailItems.length === 0
            ? ""
            : `<div class="nfm-confirm-details">${detailItems
                .slice(0, Number(confirmConfig.maxPreviewItems) || 8)
                .map(
                  (item) =>
                    `<div>${escapeHtml(item.label || "")}: ${escapeHtml(
                      item.value || item
                    )}</div>`
                )
                .join("")}</div>`;
        const affectedHtml =
          confirmConfig.showAffectedCount === true && affectedCount > 0
            ? `<div class="nfm-confirm-affected-count">影响 ${escapeHtml(
                affectedCount
              )} 项</div>`
            : "";
        const buttons = orderedActions
          .map((item) => {
            const id = String(item.id || item.action || "confirm");
            const role = item.role || (id === "cancel" ? "cancel" : "primary");
            const cls =
              role === "danger"
                ? " danger"
                : role === "primary"
                ? " primary"
                : "";
            return `<button class="nfm-btn${cls}" data-confirm-action="${escapeHtml(
              id
            )}" data-confirm-role="${escapeHtml(role)}">${escapeHtml(
              item.label || id
            )}</button>`;
          })
          .join("");
        overlay.innerHTML = `<div class="nfm-dialog-panel"><h3>${
          icon ? `${escapeHtml(icon)} ` : ""
        }${escapeHtml(confirmConfig.title || title)}</h3><label>${escapeHtml(
          confirmConfig.message || message
        )}</label>${affectedHtml}${detailHtml}<div class="nfm-dialog-actions">${buttons}</div></div>`;
        root.appendChild(overlay);
        const finish = (actionId) => {
          const action =
            orderedActions.find(
              (item) => String(item.id || item.action) === actionId
            ) || orderedActions[0];
          const role =
            action?.role || (actionId === "cancel" ? "cancel" : "primary");
          const accepted = role !== "cancel" && actionId !== "cancel";
          overlay.remove();
          focusRoot();
          resolve({
            action: actionId,
            accepted,
            confirmed: accepted && isHighRiskConfirm(type),
          });
        };
        overlay.addEventListener("click", (event) => {
          if (event.target === overlay) finish("cancel");
          const actionId = event.target?.dataset?.confirmAction;
          if (actionId) finish(actionId);
        });
        overlay.addEventListener("keydown", (event) => {
          event.stopPropagation();
          if (event.key === "Escape") {
            event.preventDefault();
            finish("cancel");
          }
        });
        setTimeout(
          () =>
            overlay
              .querySelector(
                "[data-confirm-role='primary'],[data-confirm-role='danger']"
              )
              ?.focus?.(),
          0
        );
      });
    }

    function askText(label, defaultValue = "") {
      return new Promise((resolve) => {
        removeContextMenu();
        const overlay = document.createElement("div");
        overlay.className = "nfm-dialog";
        overlay.innerHTML = `<div class="nfm-dialog-panel"><label>${escapeHtml(
          label
        )}</label><input data-dialog-input value="${escapeHtml(
          defaultValue
        )}" /><div class="nfm-dialog-actions"><button class="nfm-btn" data-dialog-cancel="1">取消</button><button class="nfm-btn" data-dialog-ok="1">确定</button></div></div>`;
        root.appendChild(overlay);
        const input = overlay.querySelector("[data-dialog-input]");
        const finish = (value) => {
          overlay.remove();
          focusRoot();
          resolve(value);
        };
        overlay.addEventListener("click", (event) => {
          if (event.target === overlay || event.target?.dataset?.dialogCancel) {
            finish(null);
          } else if (event.target?.dataset?.dialogOk) {
            finish(input.value.trim());
          }
        });
        overlay.addEventListener("keydown", (event) => {
          event.stopPropagation();
          if (event.key === "Escape") {
            event.preventDefault();
            finish(null);
          } else if (event.key === "Enter") {
            event.preventDefault();
            finish(input.value.trim());
          }
        });
        setTimeout(() => {
          input?.focus?.();
          input?.select?.();
        }, 0);
      });
    }

    function scheduleVirtualRender() {
      if (customUIActive || virtualRenderScheduled) return;
      virtualRenderScheduled = true;
      requestAnimationFrame(() => {
        virtualRenderScheduled = false;
        render();
      });
    }

    async function init() {
      bindEvents();
      const result = await desktopApi.nativeFsRegisterMount({
        ...config,
        ownerWidgetId: id,
      });
      if (result?.success === false)
        throw new Error(result.message || result.error);
      mountId = result.mountId;
      capabilityToken = result.capabilityToken;
      ownerWidgetId = result.ownerWidgetId;
      rootPath = result.rootPath;
      currentDir = rootPath;
      notifyMountCreated();
      setStatus(`已挂载：${rootPath}`);
      subscribe();
      await loadDir(currentDir);
      if (isValidCustomUI(customUI)) {
        await renderCustomUI();
      }
    }

    function notifyMountCreated() {
      const notice = `[系统通知] NativeFileMount 卡片已创建：widgetId=${id}, mountId=${mountId}, rootPath=${rootPath}, mode=${config.mode}`;
      const payload = {
        action: "nativeFileMountCreated",
        type: "nativeFileMount",
        widgetId: id,
        mountId,
        title,
        rootPath,
        mode: config.mode,
        message: notice,
        customUI: {
          requested: customUIRequested,
          mounted: customUIMounted,
          fallbackToDefault: customUIFallbackToDefault,
          error: customUIError,
        },
      };
      window.dispatchEvent(
        new CustomEvent("vcp:native-file-mount-created", { detail: payload })
      );
      console.info(notice);
    }

    function subscribe() {
      unsubChanged = desktopApi.onNativeFsChanged?.((data) => {
        if (data.mountId === mountId) loadDir(currentDir, { quiet: true });
      });
      unsubResync = desktopApi.onNativeFsResync?.((data) => {
        if (data.mountId === mountId) {
          setStatus(`需要重新同步：${data.reason}`);
          setTimeout(() => loadDir(currentDir, { quiet: true }), 800);
        }
      });
      unsubJob = desktopApi.onNativeFsJobProgress?.((data) => {
        const progressText = data.completed
          ? ` ${data.completed}/${data.total || "?"}`
          : "";
        const cancelButton =
          data.status === "running"
            ? ` <button class="nfm-job-cancel" data-job-cancel="${escapeHtml(
                data.jobId
              )}">取消</button>`
            : "";
        emitJobProgress(data);
        if (!customUIActive && statusEl) {
          if (data.status === "failed") {
            statusEl.textContent = `任务失败：${data.error || "未知错误"}`;
            statusHoldUntil = Date.now() + 15000;
          } else if (Date.now() >= statusHoldUntil) {
            statusEl.innerHTML = `任务 ${escapeHtml(data.jobId)}: ${escapeHtml(
              data.status
            )}${escapeHtml(progressText)}${cancelButton}`;
          }
        }
        if (["completed", "cancelled"].includes(data.status))
          loadDir(currentDir, { quiet: true });
      });
    }

    async function cleanup() {
      removeContextMenu();
      if (customRuntimeHandle?.cleanup) {
        try {
          customRuntimeHandle.cleanup();
        } catch (error) {
          console.warn("[NativeFileMount] customUI cleanup failed:", error);
        }
        customRuntimeHandle = null;
      }
      changeCallbacks.clear();
      jobProgressCallbacks.clear();
      agentRequestCallback = null;
      if (unsubChanged) unsubChanged();
      if (unsubResync) unsubResync();
      if (unsubJob) unsubJob();
      if (mountId && capabilityToken) {
        await desktopApi
          .nativeFsUnmount({ mountId, ownerWidgetId, capabilityToken })
          .catch(() => {});
      }
    }

    function isValidCustomUI(value) {
      return (
        value &&
        typeof value === "object" &&
        value.runtime === "vcp-widget-shadow" &&
        (typeof value.htmlContent === "string" ||
          typeof value.html === "string" ||
          typeof value.css === "string" ||
          typeof value.js === "string")
      );
    }

    function toSafeRelativePath(relativePath = ".") {
      const raw = String(relativePath || ".").trim() || ".";
      if (
        /^[a-zA-Z]:[\\/]/.test(raw) ||
        raw.startsWith("\\\\") ||
        raw.startsWith("/")
      ) {
        throw new Error("ERR_PATH_ESCAPE");
      }
      const parts = raw.replace(/\\/g, "/").split("/").filter(Boolean);
      if (parts.some((part) => part === ".."))
        throw new Error("ERR_PATH_ESCAPE");
      return parts.filter((part) => part !== ".").join("/");
    }

    function resolveRelativePath(relativePath = ".") {
      const safeRel = toSafeRelativePath(relativePath);
      if (!rootPath) throw new Error("ERR_MOUNT_NOT_READY");
      if (!safeRel) return rootPath;
      const sep = rootPath.includes("\\") ? "\\" : "/";
      return (
        rootPath.replace(/[\\/]$/, "") + sep + safeRel.replace(/[\\/]/g, sep)
      );
    }

    function emitChange(event) {
      const payload = {
        ...(event || {}),
        widgetId: id,
        mountId,
        currentPath: currentDir,
        entries: entries.map(toPublicEntry),
      };
      changeCallbacks.forEach((callback) => {
        try {
          callback(payload);
        } catch (error) {
          console.warn(
            "[NativeFileMount] nfm.onChange callback failed:",
            error
          );
        }
      });
    }

    function emitJobProgress(event) {
      const payload = {
        ...(event || {}),
        widgetId: id,
        mountId,
        currentPath: currentDir,
      };
      jobProgressCallbacks.forEach((callback) => {
        try {
          callback(payload);
        } catch (error) {
          console.warn(
            "[NativeFileMount] nfm.onJobProgress callback failed:",
            error
          );
        }
      });
    }

    function toPublicEntry(entry) {
      return {
        name: entry.name,
        relativePath: entry.relativePath,
        type: entry.type,
        size: entry.size,
        mtime: entry.mtime,
        hidden: entry.hidden === true,
        readonly: entry.readonly === true,
      };
    }

    function createNfmApi() {
      const resolveMany = (relativePaths) =>
        (Array.isArray(relativePaths) ? relativePaths : [relativePaths])
          .filter((item) => item != null && item !== "")
          .map((item) => resolveRelativePath(item));

      const api = {
        version: 2,
        getInfo: () => ({
          widgetId: id,
          mountId,
          title,
          rootPath,
          mode: config.mode,
          currentPath: currentDir,
        }),
        list: async (relativePath = ".", options = {}) => {
          const dirPath = resolveRelativePath(relativePath);
          const limit = Math.max(
            1,
            Math.min(Number(options.limit) || 1000, 5000)
          );
          const cursor = Math.max(0, Number(options.cursor) || 0);
          const result = await desktopApi.nativeFsList({
            mountId,
            dirPath,
            limit,
            cursor,
          });
          if (result?.success === false)
            throw new Error(result.message || result.error);
          const publicEntries = (result.entries || []).map(toPublicEntry);
          if (options && options.withMeta === true) {
            return {
              entries: publicEntries,
              dirPath: result.dirPath,
              parentDir: result.parentDir || null,
              hasMore: result.hasMore === true,
              nextCursor: result.nextCursor,
              largeDirectory: result.largeDirectory === true,
            };
          }
          return publicEntries;
        },
        open: async (relativePath) => {
          const targetPath = resolveRelativePath(relativePath);
          return privilegedAction("open", [targetPath], {}, "customUI");
        },
        openWith: async (relativePath) => {
          const targetPath = resolveRelativePath(relativePath);
          return privilegedAction("openWith", [targetPath], {}, "customUI");
        },
        reveal: async (relativePath) => {
          const targetPath = resolveRelativePath(relativePath);
          return privilegedAction("reveal", [targetPath], {}, "customUI");
        },
        copy: async (relativePaths) => {
          return privilegedAction(
            "copy",
            resolveMany(relativePaths),
            {},
            "customUI"
          );
        },
        cut: async (relativePaths) => {
          return privilegedAction(
            "cut",
            resolveMany(relativePaths),
            {},
            "customUI"
          );
        },
        paste: async (relativeDir = ".", options = {}) => {
          const destDir = resolveRelativePath(relativeDir);
          const conflictStrategy = options.conflictStrategy || "ask";
          let confirmed = options.confirmed === true;
          if (conflictStrategy === "overwrite" && !confirmed) {
            const decision = await nfmConfirm({
              type: "overwrite",
              title: "确认覆盖",
              message: "粘贴会覆盖同名文件或文件夹，确定继续？",
              confirmText: "覆盖",
              danger: true,
              affectedCount: 1,
            });
            if (!decision.accepted)
              return { success: false, error: "ERR_USER_CANCELLED" };
            confirmed = true;
          }
          return privilegedAction(
            "paste",
            [],
            { destDir, conflictStrategy, confirmed },
            "customUI"
          );
        },
        clipboardPreview: async () => getClipboardPreview(),
        resolve: (relativePath = ".") => resolveRelativePath(relativePath),
        relative: (absolutePath) => {
          const absolute = String(absolutePath || "").replace(/[\\/]$/, "");
          if (!rootPath || !absolute) return "";
          const rootNorm = rootPath.replace(/[\\/]$/, "");
          const isWindowsPath = /^[a-zA-Z]:[\\/]/.test(rootNorm);
          const cmpAbsolute = isWindowsPath ? absolute.toLowerCase() : absolute;
          const cmpRoot = isWindowsPath ? rootNorm.toLowerCase() : rootNorm;
          if (cmpAbsolute === cmpRoot) return ".";
          const sep = rootNorm.includes("\\") ? "\\" : "/";
          const prefix = rootNorm + sep;
          const cmpPrefix = cmpRoot + sep;
          if (!cmpAbsolute.startsWith(cmpPrefix))
            throw new Error("ERR_PATH_ESCAPE");
          return absolute.slice(prefix.length).replace(/\\/g, "/");
        },
        rename: async (relativePath, newName) => {
          const targetPath = resolveRelativePath(relativePath);
          return privilegedAction(
            "rename",
            [targetPath],
            { newName },
            "customUI"
          );
        },
        trash: async (relativePaths) => {
          const paths = resolveMany(relativePaths);
          const decision = await nfmConfirm({
            type: paths.length > 1 ? "bulkTrash" : "trash",
            title: "删除到回收站",
            message: `确定将 ${paths.length} 项删除到回收站？`,
            confirmText: "删除",
            danger: true,
            affectedCount: paths.length,
          });
          if (!decision.accepted)
            return { success: false, error: "ERR_USER_CANCELLED" };
          return privilegedAction(
            "trash",
            paths,
            { confirmed: true },
            "customUI"
          );
        },
        newFolder: async (parentRelativePath = ".", name) => {
          let relativeDir = parentRelativePath;
          let folderName = name;
          if (folderName == null) {
            folderName = parentRelativePath;
            relativeDir = ".";
          }
          const parentDir = resolveRelativePath(relativeDir);
          const result = await privilegedAction(
            "newFolder",
            [],
            { name: folderName, parentDir },
            "customUI"
          );
          if (result?.success !== false)
            await loadDir(currentDir || rootPath, { quiet: true });
          return result;
        },
        move: async (from, to, options = {}) => {
          const source = resolveRelativePath(from);
          const target = resolveRelativePath(to);
          const conflictStrategy = options.conflictStrategy || "ask";
          let confirmed = options.confirmed === true;
          if (conflictStrategy === "overwrite" && !confirmed) {
            const decision = await nfmConfirm({
              type: "overwrite",
              title: "确认覆盖移动",
              message: "移动会覆盖目标位置的同名文件或文件夹，确定继续？",
              confirmText: "覆盖",
              danger: true,
              affectedCount: 1,
            });
            if (!decision.accepted)
              return { success: false, error: "ERR_USER_CANCELLED" };
            confirmed = true;
          }
          return privilegedAction(
            "move",
            [source],
            { from: source, to: target, conflictStrategy, confirmed },
            "customUI"
          );
        },
        copyTo: async (from, to, options = {}) => {
          const source = resolveRelativePath(from);
          const target = resolveRelativePath(to);
          const conflictStrategy = options.conflictStrategy || "ask";
          let confirmed = options.confirmed === true;
          if (conflictStrategy === "overwrite" && !confirmed) {
            const decision = await nfmConfirm({
              type: "overwrite",
              title: "确认覆盖复制",
              message: "复制会覆盖目标位置的同名文件或文件夹，确定继续？",
              confirmText: "覆盖",
              danger: true,
              affectedCount: 1,
            });
            if (!decision.accepted)
              return { success: false, error: "ERR_USER_CANCELLED" };
            confirmed = true;
          }
          return handleAgentAction({
            widgetId: id,
            mountId,
            source: "customUI",
            summary: "customUI copyTo",
            operations: [
              {
                action: "copy",
                from: source,
                to: target,
                conflictStrategy,
                confirmed,
              },
            ],
            risk: { overwrites: confirmed ? 1 : 0 },
          });
        },
        refresh: async () => {
          await loadDir(currentDir || rootPath, {
            quiet: true,
            eventType: "refresh",
          });
          return true;
        },
        requestOperations: async (plan = {}) => {
          return handleAgentAction({
            ...(plan || {}),
            widgetId: id,
            mountId,
            source: "customUI",
          });
        },
        confirm: async (options = {}) => nfmConfirm(options),
        onChange: (callback) => {
          if (typeof callback !== "function") return () => {};
          changeCallbacks.add(callback);
          return () => changeCallbacks.delete(callback);
        },
        onJobProgress: (callback) => {
          if (typeof callback !== "function") return () => {};
          jobProgressCallbacks.add(callback);
          return () => jobProgressCallbacks.delete(callback);
        },
        onAgentRequest: (callback) => {
          agentRequestCallback =
            typeof callback === "function" ? callback : null;
          return () => {
            if (agentRequestCallback === callback) agentRequestCallback = null;
          };
        },
      };

      return Object.freeze(api);
    }

    function cleanupCustomRuntime() {
      if (!customRuntimeHandle?.cleanup) {
        customRuntimeHandle = null;
        return;
      }
      try {
        customRuntimeHandle.cleanup();
      } catch (cleanupError) {
        console.warn(
          "[NativeFileMount] customUI cleanup failed:",
          cleanupError
        );
      }
      customRuntimeHandle = null;
    }

    function restoreDefaultUIAfterCustomFailure(error, source = "runtime") {
      console.warn(`[NativeFileMount] customUI ${source} failed:`, error);
      cleanupCustomRuntime();
      customUIActive = false;
      customUIMounted = false;
      customUIError = error?.message || String(error);
      if (customUI?.fallbackToDefault === false) {
        customUIFallbackToDefault = false;
        customUIActive = true;
        widgetData.contentContainer.innerHTML = `<div class="nfm-root"><div class="nfm-empty">CustomUI 运行失败：${escapeHtml(
          error?.message || String(error)
        )}</div></div>`;
        root = widgetData.contentContainer.querySelector(".nfm-root") || root;
        listEl = root.querySelector(".nfm-list");
        pathEl = root.querySelector(".nfm-path");
        statusEl = root.querySelector(".nfm-status");
        return false;
      }
      customUIFallbackToDefault = true;
      widgetData.contentContainer.innerHTML = buildShell(title, config);
      widget.processInlineStyles(widgetData);
      root = widgetData.contentContainer.querySelector(".nfm-root") || root;
      listEl = root.querySelector(".nfm-list");
      pathEl = root.querySelector(".nfm-path");
      statusEl = root.querySelector(".nfm-status");
      bindEvents();
      render();
      setStatus(`CustomUI 已回退默认界面：${error?.message || String(error)}`);
      return false;
    }

    async function renderCustomUI() {
      const runtime = window.VCPDesktop?.widgetRuntime;
      if (!runtime?.renderShadowWidget) {
        console.warn(
          "[NativeFileMount] widgetRuntime is unavailable, fallback to default UI."
        );
        return false;
      }

      const stagingHost = document.createElement("div");
      stagingHost.className = "nfm-custom-ui-staging";
      stagingHost.style.display = "none";
      widgetData.contentContainer.appendChild(stagingHost);

      try {
        customRuntimeHandle = runtime.renderShadowWidget({
          hostElement: stagingHost,
          customUI,
          apis: { nfm: createNfmApi() },
          options: {
            runtimeId: `${id}-custom-ui`,
            widgetId: id,
            wrapperClass: "nfm-custom-ui-runtime",
            contentClass: "widget-inner-content",
            onRuntimeError: (error, meta = {}) => {
              if (!customUIActive) return;
              restoreDefaultUIAfterCustomFailure(
                error,
                meta.source || "runtime"
              );
            },
          },
        });

        const customRoot = stagingHost.firstElementChild;
        if (!customRoot) throw new Error("ERR_CUSTOM_UI_EMPTY_ROOT");
        customRoot.style.display = "";
        customRoot.style.width = "100%";
        customRoot.style.height = "100%";
        customRoot.style.minHeight = "0";
        if (!customRoot.style.overflow) customRoot.style.overflow = "auto";
        widgetData.contentContainer.innerHTML = "";
        widgetData.contentContainer.appendChild(customRoot);
        customUIActive = true;
        customUIMounted = true;
        customUIFallbackToDefault = false;
        customUIError = null;
        return true;
      } catch (error) {
        stagingHost.remove();
        return restoreDefaultUIAfterCustomFailure(error, "render");
      }
    }

    async function loadDir(dir, options = {}) {
      if (!mountId || busy) return;
      const requestedDir = dir || currentDir || rootPath;
      const previousDir = currentDir;
      const previousSelection = new Set(selected);
      busy = true;
      try {
        if (!options.quiet) setStatus("加载中...");
        const result = await desktopApi.nativeFsList({
          mountId,
          dirPath: requestedDir,
          limit: 300,
          cursor: options.append ? nextCursor : 0,
        });
        if (result?.success === false) {
          setStatus(result.message || result.error);
          return;
        }
        const resultDir = result.dirPath;
        const isSameDirRefresh =
          !options.append &&
          options.preserveSelection !== false &&
          previousDir &&
          resultDir === previousDir;
        currentDir = resultDir;
        parentDir = result.parentDir || null;
        hasMore = result.hasMore === true;
        nextCursor = result.nextCursor;
        entries = options.append
          ? entries.concat(result.entries || [])
          : result.entries || [];
        if (options.append || isSameDirRefresh) {
          selected = new Set(
            entries
              .filter(
                (entry) => entry.path && previousSelection.has(entry.path)
              )
              .map((entry) => entry.path)
          );
        } else {
          selected.clear();
        }
        if (!options.append && !isSameDirRefresh) virtualScrollTop = 0;
        virtualViewportHeight = customUIActive
          ? virtualViewportHeight
          : listEl.clientHeight || virtualViewportHeight;
        if (!customUIActive) {
          render();
          setStatus(
            `${entries.length} 项${hasMore ? "（还有更多）" : ""}${
              result.largeDirectory ? "，大目录模式" : ""
            }`
          );
        }
        emitChange({
          type: options.eventType || "list",
          quiet: options.quiet === true,
        });
      } catch (error) {
        console.warn("[NativeFileMount] loadDir failed:", error);
        setStatus(error?.message || String(error));
      } finally {
        busy = false;
      }
    }

    function render() {
      if (customUIActive) return;
      if (pathEl) pathEl.textContent = currentDir || "";
      if (entries.length === 0) {
        listEl.innerHTML = '<div class="nfm-empty">空文件夹</div>';
        return;
      }
      const isGrid = config.ui?.layout?.view === "grid";
      const viewportHeight = listEl.clientHeight || virtualViewportHeight || 0;
      virtualViewportHeight = viewportHeight;
      const scrollTop = listEl.scrollTop || 0;
      virtualScrollTop = scrollTop;
      const gridCfg = config.ui?.layout?.grid || {};
      const rowHeight = isGrid
        ? Number(gridCfg.itemHeight) || 92
        : config.ui?.layout?.compact
        ? 28
        : Number(config.ui?.layout?.rowHeight) || 34;
      const gridMin = Math.max(Number(gridCfg.minItemWidth) || 116, 72);
      const columns = isGrid
        ? Math.max(Math.floor((listEl.clientWidth || gridMin) / gridMin), 1)
        : 1;
      const virtualRows = isGrid
        ? Math.ceil(entries.length / columns)
        : entries.length;
      const buffer = 8;
      const startRow = Math.max(Math.floor(scrollTop / rowHeight) - buffer, 0);
      const endRow = Math.min(
        Math.ceil((scrollTop + viewportHeight) / rowHeight) + buffer,
        virtualRows
      );
      const start = isGrid ? startRow * columns : startRow;
      const end = isGrid ? Math.min(endRow * columns, entries.length) : endRow;
      const topPad = startRow * rowHeight;
      const bottomPad = Math.max(virtualRows - endRow, 0) * rowHeight;
      const rows = entries
        .slice(start, end)
        .map((entry, localIndex) => {
          const index = start + localIndex;
          const icon = getEntryIcon(entry);
          const isSelected = !!entry.path && selected.has(entry.path);
          const topStyle = isGrid ? "" : `top:${index * rowHeight}px`;
          const sizeHtml =
            config.ui?.layout?.showSize === false
              ? ""
              : `<span class="nfm-meta">${
                  entry.type === "file" ? formatSize(entry.size) : ""
                }</span>`;
          const mtimeHtml =
            config.ui?.layout?.showMtime === false
              ? ""
              : `<span class="nfm-meta">${new Date(
                  entry.mtime
                ).toLocaleString()}</span>`;
          const hiddenBadge =
            config.ui?.layout?.showHiddenBadge === false ||
            !String(entry.name || "").startsWith(".")
              ? ""
              : '<span class="nfm-meta">隐藏</span>';
          return `<div class="nfm-row${
            isSelected ? " selected" : ""
          }" data-index="${index}" data-selected="${
            isSelected ? "1" : "0"
          }" aria-selected="${
            isSelected ? "true" : "false"
          }" style="${topStyle}"><span>${icon}</span><span class="nfm-name">${escapeHtml(
            entry.name
          )}</span>${sizeHtml}${mtimeHtml}${hiddenBadge}</div>`;
        })
        .join("");
      const loadMore = hasMore
        ? '<div class="nfm-empty"><button class="nfm-btn" data-act="loadMore">加载更多</button></div>'
        : "";
      const virtualStyle = isGrid
        ? `min-height:${
            virtualRows * rowHeight
          }px;padding-top:${topPad}px;padding-bottom:${bottomPad}px;--nfm-grid-min:${gridMin}px;--nfm-grid-height:${rowHeight}px`
        : `height:${
            entries.length * rowHeight
          }px;padding-top:${topPad}px;padding-bottom:${bottomPad}px`;
      listEl.innerHTML = `<div class="nfm-virtual" style="${virtualStyle}">${rows}</div>${loadMore}`;
    }

    function bindEvents() {
      listEl.addEventListener("scroll", () => {
        virtualScrollTop = listEl.scrollTop || 0;
        scheduleVirtualRender();
      });
      const handleRowPointer = (event) => {
        if (event.button !== 0) return;
        if (
          event.target.closest(
            "[data-act],[data-menu-act],[data-job-cancel],input,textarea,select"
          )
        )
          return;
        const row = event.target.closest(".nfm-row");
        if (!row) {
          focusRoot();
          removeContextMenu();
          if (!event.ctrlKey && !event.metaKey) clearSelection();
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        focusRoot();
        removeContextMenu();
        if (
          !selectIndex(
            Number(row.dataset.index),
            event.ctrlKey || event.metaKey
          )
        )
          return;
        syncSelectionStyles();
      };
      // Only bind on root: pointer events bubble from .nfm-list to .nfm-root.
      // Binding both root and list toggles Ctrl/Meta selection twice and can make
      // selected state appear to vanish immediately.
      root.addEventListener("pointerdown", handleRowPointer);
      root.addEventListener("click", async (event) => {
        if (isEditableTarget(event.target)) return;
        focusRoot();
        const menuBtn = event.target.closest("[data-menu-act]");
        if (menuBtn) {
          const action = menuBtn.dataset.menuAct;
          removeContextMenu();
          return handleFileMenuAction(action);
        }
        removeContextMenu();
        const cancelBtn = event.target.closest("[data-job-cancel]");
        if (cancelBtn) {
          await desktopApi.nativeFsCancelJob?.({
            jobId: cancelBtn.dataset.jobCancel,
          });
          setStatus(`正在取消任务：${cancelBtn.dataset.jobCancel}`);
          return;
        }
        const btn = event.target.closest("[data-act]");
        if (btn) return handleToolbar(btn.dataset.act);
      });
      root.addEventListener("dblclick", async (event) => {
        focusRoot();
        removeContextMenu();
        const row = event.target.closest(".nfm-row");
        if (!row) return;
        const entry = selectIndex(Number(row.dataset.index), false);
        syncSelectionStyles();
        if (!entry) return;
        if (entry.type === "directory") await loadDir(entry.path);
        else await privilegedAction("open", [entry.path]);
      });
      root.addEventListener("contextmenu", (event) => {
        const row = event.target.closest(".nfm-row");
        if (!row) return;
        event.preventDefault();
        event.stopPropagation();
        focusRoot();
        const entry = selectIndex(
          Number(row.dataset.index),
          event.ctrlKey || event.metaKey
        );
        syncSelectionStyles();
        if (entry) showFileContextMenu(event, entry);
      });
      root.addEventListener("keydown", handleKeydown);
      root.addEventListener("dragstart", async (event) => {
        const paths = selectedEntries().map((entry) => entry.path);
        if (paths.length)
          await desktopApi.nativeFsStartDrag({
            mountId,
            ownerWidgetId,
            capabilityToken,
            paths,
          });
      });
      root.addEventListener("dragover", (event) => event.preventDefault());
      root.addEventListener("drop", async (event) => {
        event.preventDefault();
        const files = Array.from(event.dataTransfer?.files || [])
          .map((file) => file.path)
          .filter(Boolean);
        if (files.length) {
          const strategy = await askConflictStrategy("导入文件");
          if (!strategy) return;
          await desktopApi.nativeFsImportFiles({
            mountId,
            ownerWidgetId,
            capabilityToken,
            source: "user",
            destDir: currentDir,
            externalPaths: files,
            conflictStrategy: strategy.strategy,
            confirmed: strategy.confirmed,
          });
        }
      });
    }

    function selectedEntries() {
      return entries.filter((entry) => entry.path && selected.has(entry.path));
    }

    function selectedPaths() {
      return selectedEntries().map((entry) => entry.path);
    }

    function ensureSelection(actionLabel = "操作") {
      const paths = selectedPaths();
      if (paths.length === 0) {
        setStatus(`请先选择要${actionLabel}的文件或文件夹`);
        return null;
      }
      return paths;
    }

    function normalizeNameForCompare(name) {
      return String(name || "")
        .normalize("NFC")
        .toLowerCase();
    }

    async function getClipboardPreview() {
      const result = await privilegedAction(
        "clipboardPreview",
        [],
        {},
        "user",
        {
          quietSuccess: true,
          quietErrors: true,
        }
      );
      if (result?.success === false) return null;
      return result;
    }

    function predictPasteConflictFromCurrentEntries(preview) {
      const items = Array.isArray(preview?.items) ? preview.items : [];
      if (items.length === 0) return false;
      const existingNames = new Set(
        entries.map((entry) => normalizeNameForCompare(entry.name))
      );
      return items.some((item) =>
        existingNames.has(normalizeNameForCompare(item.name))
      );
    }

    function showFileContextMenu(event, entry) {
      removeContextMenu();
      contextMenuTargetPath = entry?.path || null;
      const menu = document.createElement("div");
      menu.className = "nfm-menu";
      menu.style.visibility = "hidden";
      menu.style.left = "0px";
      const canOpenWith = entry.type === "file" || entry.type === "symlink";
      const labels = new Map(CONTEXT_MENU_ACTIONS);
      const menuItems = (config.ui?.actions?.contextMenu || [])
        .filter((action) => isActionEnabled(action, "contextMenu"))
        .filter((action) => getActionId(action) !== "openWith" || canOpenWith)
        .map((action) => {
          const actionId = getActionId(action);
          if (actionId === "separator")
            return '<div class="nfm-menu-separator"></div>';
          if (actionId === "spacer") return "";
          const defaultLabel =
            actionId === "open" && entry.type === "directory"
              ? "打开文件夹"
              : labels.get(actionId) || actionId;
          const label = getActionLabel(action, defaultLabel);
          const danger =
            actionId === "trash" || action?.danger ? ' class="danger"' : "";
          const disabled =
            config.mode !== "readwrite" &&
            isReadonlyWriteAction(actionId) &&
            getReadonlyBehavior() === "disable"
              ? ' disabled aria-disabled="true" title="只读模式不可用"'
              : "";
          const icon = getActionIcon(action, "");
          return `<button${danger}${disabled} data-menu-act="${escapeHtml(
            actionId
          )}">${icon ? `${escapeHtml(icon)} ` : ""}${escapeHtml(
            label
          )}</button>`;
        })
        .join("");
      menu.innerHTML =
        menuItems || '<button data-menu-act="open">打开</button>';
      root.appendChild(menu);
      contextMenuEl = menu;
      const margin = 6;
      const rootRect = root.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const menuWidth = menuRect.width || 170;
      const menuHeight = menuRect.height || 240;
      const pointerX = event.clientX - rootRect.left;
      const pointerY = event.clientY - rootRect.top;
      const maxX = Math.max(margin, rootRect.width - menuWidth - margin);
      const maxY = Math.max(margin, rootRect.height - menuHeight - margin);
      const x = Math.max(margin, Math.min(pointerX, maxX));
      let y = pointerY;
      if (y + menuHeight + margin > rootRect.height) {
        y = pointerY - menuHeight;
      }
      y = Math.max(margin, Math.min(y, maxY));
      menu.style.left = `${x}px`;
      menu.style.top = `${y}px`;
      menu.style.visibility = "visible";
    }

    async function handleFileMenuAction(action) {
      if (!isActionEnabled(action, "contextMenu")) {
        return setStatus("只读模式下该操作不可用");
      }
      if (action === "open") {
        const entry = selectedEntries()[0];
        if (!entry) return setStatus("请先选择一个文件或文件夹");
        if (entry.type === "directory") return loadDir(entry.path);
        return privilegedAction("open", [entry.path]);
      }
      if (action === "openWith") return handleToolbar("openWith");
      if (action === "reveal") {
        const entry = selectedEntries()[0];
        if (!entry) return setStatus("请先选择一个文件或文件夹");
        return privilegedAction("reveal", [entry.path]);
      }
      if (action === "copy") {
        const paths = ensureSelection("复制");
        if (!paths) return;
        return privilegedAction("copy", paths);
      }
      if (action === "cut") {
        const paths = ensureSelection("剪切");
        if (!paths) return;
        return privilegedAction("cut", paths);
      }
      if (action === "paste") return pasteToCurrentDir();
      if (action === "rename") return renameSelected();
      if (action === "trash") return trashSelected();
    }

    async function handleToolbar(action) {
      if (!isActionEnabled(action, "toolbar")) {
        return setStatus("只读模式下该操作不可用");
      }
      if (action === "refresh") return loadDir(currentDir);
      if (action === "loadMore")
        return loadDir(currentDir, { append: true, quiet: true });
      if (action === "up") return goUp();
      if (action === "openWith") {
        const entry = selectedEntries()[0];
        if (entry && (entry.type === "file" || entry.type === "symlink")) {
          return privilegedAction("openWith", [entry.path]);
        }
        return setStatus("请先选择一个文件");
      }
      if (action === "copy") {
        const paths = ensureSelection("复制");
        if (!paths) return;
        return privilegedAction("copy", paths);
      }
      if (action === "cut") {
        const paths = ensureSelection("剪切");
        if (!paths) return;
        return privilegedAction("cut", paths);
      }
      if (action === "paste") return pasteToCurrentDir();
      if (action === "newFolder") {
        const name = await askText("新文件夹名称", "新建文件夹");
        if (name) {
          const result = await privilegedAction("newFolder", [], {
            name,
            parentDir: currentDir,
          });
          if (result?.success !== false)
            await loadDir(currentDir, { quiet: true });
        }
      }
    }

    async function handleKeydown(event) {
      if (isEditableTarget(event.target)) return;
      if (event.key === "F5") {
        event.preventDefault();
        await loadDir(currentDir);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const entry = selectedEntries()[0];
        if (!entry) return setStatus("请先选择一个文件或文件夹");
        if (entry.type === "directory") return loadDir(entry.path);
        return privilegedAction("open", [entry.path]);
      }
      if (event.key === "Backspace") {
        event.preventDefault();
        await goUp();
        return;
      }
      if (event.key === "Delete") {
        event.preventDefault();
        await trashSelected();
        return;
      }
      if (event.key === "F2") {
        event.preventDefault();
        await renameSelected();
        return;
      }
      if (event.ctrlKey && event.key.toLowerCase() === "a") {
        event.preventDefault();
        entries.forEach((entry) => {
          if (entry.path) selected.add(entry.path);
        });
        render();
        return;
      }
      if (event.ctrlKey && event.key.toLowerCase() === "c") {
        event.preventDefault();
        const paths = ensureSelection("复制");
        if (paths) await privilegedAction("copy", paths);
        return;
      }
      if (event.ctrlKey && event.key.toLowerCase() === "x") {
        event.preventDefault();
        const paths = ensureSelection("剪切");
        if (paths) await privilegedAction("cut", paths);
        return;
      }
      if (event.ctrlKey && event.key.toLowerCase() === "v") {
        event.preventDefault();
        await pasteToCurrentDir();
      }
    }

    async function pasteToCurrentDir() {
      const destDir = currentDir || rootPath;
      const preview = await getClipboardPreview();
      let conflictChoice = null;
      if (predictPasteConflictFromCurrentEntries(preview)) {
        conflictChoice = await askConflictStrategy("粘贴");
        if (!conflictChoice) {
          setStatus("已取消粘贴");
          return { success: false, error: "ERR_USER_CANCELLED" };
        }
      }

      const result = await privilegedAction("paste", [], {
        destDir,
        conflictStrategy: conflictChoice?.strategy || "ask",
        confirmed: conflictChoice?.confirmed === true,
      });
      if (
        result?.success !== false ||
        result.error !== "ERR_CONFLICT_NEEDS_CONFIRM"
      ) {
        return result;
      }
      const strategy = await askConflictStrategy("粘贴");
      if (!strategy) {
        setStatus("已取消粘贴");
        return { success: false, error: "ERR_USER_CANCELLED" };
      }
      return privilegedAction("paste", [], {
        destDir,
        conflictStrategy: strategy.strategy,
        confirmed: strategy.confirmed,
      });
    }

    async function goUp() {
      if (!parentDir) return;
      await loadDir(parentDir);
    }

    async function trashSelected() {
      const paths = selectedEntries().map((entry) => entry.path);
      if (!paths.length) return setStatus("请先选择要删除的文件或文件夹");
      const decision = await nfmConfirm({
        type: paths.length > 1 ? "bulkTrash" : "trash",
        title: "删除到回收站",
        message: `确定将 ${paths.length} 项删除到回收站？`,
        confirmText: "删除",
        danger: true,
        affectedCount: paths.length,
      });
      if (!decision.accepted) {
        setStatus("已取消删除");
        return { success: false, error: "ERR_USER_CANCELLED" };
      }
      const result = await privilegedAction("trash", paths, {
        confirmed: true,
      });
      if (result?.success !== false) await loadDir(currentDir, { quiet: true });
      return result;
    }

    async function renameSelected() {
      const entry = selectedEntries()[0];
      if (!entry) return setStatus("请先选择一个文件或文件夹");
      const name = await askText("重命名", entry.name);
      if (name && name !== entry.name) {
        const result = await privilegedAction("rename", [entry.path], {
          newName: name,
        });
        if (result?.success !== false)
          await loadDir(currentDir, { quiet: true });
      }
    }

    async function privilegedAction(
      action,
      targetPaths,
      payload,
      source = "user",
      options = {}
    ) {
      const requestPayload = { ...(payload || {}) };
      let result = await desktopApi.nativeFsAction({
        mountId,
        ownerWidgetId,
        capabilityToken,
        source,
        action,
        targetPaths,
        payload: requestPayload,
      });
      if (result?.success === false) {
        if (result.error === "ERR_CONFLICT_NEEDS_CONFIRM") {
          if (!options.quietErrors)
            setStatus("存在同名目标，请选择自动重命名或确认覆盖后重试");
        } else if (result.error === "ERR_CROSS_DEVICE_CONFIRM_REQUIRED") {
          const decision = await nfmConfirm({
            type: "crossDeviceMove",
            title: "确认跨盘剪切/移动",
            message:
              "跨盘剪切/移动不能直接重命名完成，将降级为复制到目标位置后把原文件移入回收站。确定继续？",
            confirmText: "继续",
            danger: true,
            affectedCount: Array.isArray(targetPaths) ? targetPaths.length : 1,
          });
          if (!decision.accepted) {
            setStatus("已取消跨盘剪切/移动");
            return { success: false, error: "ERR_USER_CANCELLED" };
          }
          result = await desktopApi.nativeFsAction({
            mountId,
            ownerWidgetId,
            capabilityToken,
            source,
            action,
            targetPaths,
            payload: { ...requestPayload, confirmedCrossDevice: true },
          });
          if (result?.success === false) {
            setStatus(result.message || result.error);
          } else {
            setStatus(`${action} 已提交`);
          }
        } else if (!options.quietErrors) {
          setStatus(result.message || result.error, {
            force: true,
            holdMs: 15000,
          });
        }
      } else if (!options.quietSuccess) setStatus(`${action} 已提交`);
      return result;
    }

    async function askConflictStrategy(label) {
      return new Promise((resolve) => {
        removeContextMenu();
        const overlay = document.createElement("div");
        overlay.className = "nfm-dialog";
        overlay.innerHTML = `<div class="nfm-dialog-panel"><label>${escapeHtml(
          `${label}遇到同名文件，请选择处理方式`
        )}</label><div class="nfm-dialog-actions"><button class="nfm-btn" data-dialog-choice="cancel">取消</button><button class="nfm-btn" data-dialog-choice="autoRename">重命名</button><button class="nfm-btn danger" data-dialog-choice="overwrite">覆盖</button></div></div>`;
        root.appendChild(overlay);
        const finish = (value) => {
          overlay.remove();
          focusRoot();
          resolve(value);
        };
        overlay.addEventListener("click", async (event) => {
          if (event.target === overlay) return finish(null);
          const choice = event.target?.dataset?.dialogChoice;
          if (!choice) return;
          if (choice === "cancel") return finish(null);
          if (choice === "overwrite") {
            overlay.style.display = "none";
            const decision = await nfmConfirm({
              type: "overwrite",
              title: "确认覆盖",
              message: `${label}会覆盖同名文件或文件夹，确定继续？`,
              confirmText: "覆盖",
              danger: true,
              affectedCount: 1,
            });
            if (!decision.accepted) return finish(null);
            return finish({ strategy: "overwrite", confirmed: true });
          }
          return finish({ strategy: "autoRename", confirmed: false });
        });
        overlay.addEventListener("keydown", (event) => {
          event.stopPropagation();
          if (event.key === "Escape") {
            event.preventDefault();
            finish(null);
          }
        });
        setTimeout(() => {
          overlay.querySelector("[data-dialog-choice='autoRename']")?.focus?.();
        }, 0);
      });
    }

    async function handleAgentAction(payload = {}) {
      if (
        !payload ||
        payload.widgetId !== id ||
        (payload.mountId && payload.mountId !== mountId)
      ) {
        return { ok: false, error: "ERR_WIDGET_NOT_FOUND" };
      }
      const operations = Array.isArray(payload.operations)
        ? payload.operations
        : [];
      const decision = await showAgentPreview(payload);
      if (!decision.accepted)
        return {
          ok: true,
          data: { status: "rejected", reason: "user_denied" },
        };
      let completed = 0;
      const execution = showAgentExecution(operations.length);
      try {
        for (const op of operations) {
          if (execution.cancelled) {
            const remaining = operations.length - completed;
            return {
              ok: true,
              data: {
                status: "cancelled",
                completed,
                remaining,
                summary: `用户已取消，已完成 ${completed} 个操作，剩余 ${remaining} 个`,
              },
            };
          }
          execution.update(completed + 1, operations.length, op);
          const result = await executeAgentOperation(op, decision);
          if (result?.success === false) {
            return {
              ok: true,
              data: {
                status:
                  result.error === "ERR_USER_CANCELLED"
                    ? "cancelled"
                    : "partial_failed",
                completed,
                failed: operations.length - completed,
                remaining: operations.length - completed,
                stoppedAtOp: op.id,
                error: result.error,
                summary: `第 ${completed + 1} 个操作失败`,
              },
            };
          }
          completed += 1;
          await loadDir(currentDir, { quiet: true });
        }
        return {
          ok: true,
          data: {
            status: "completed",
            completed,
            failed: 0,
            summary: `已完成 ${completed} 个操作`,
          },
        };
      } finally {
        execution.close();
      }
    }

    function showAgentExecution(total) {
      let cancelled = false;
      const agentUI = config.ui?.agentUI || {};
      const modal = document.createElement("div");
      modal.className = "nfm-agent";
      modal.dataset.position =
        agentUI.execution?.position || agentUI.position || "top";
      modal.dataset.layout = agentUI.executionLayout || "default";
      modal.dataset.showProgress = agentUI.showProgress === false ? "0" : "1";
      const titleText = agentUI.executionTitle || "🤖 Agent 正在执行文件操作";
      const cancelText = agentUI.cancelText || "取消后续操作";
      const executionButtons = normalizeButtonList(agentUI.executionButtons, [
        "cancel",
      ]);
      const buttonsHtml = executionButtons.includes("cancel")
        ? `<button class="nfm-btn danger" data-agent-cancel="1">${escapeHtml(
            cancelText
          )}</button>`
        : "";
      modal.innerHTML = `<h3>${escapeHtml(
        titleText
      )}</h3><div data-agent-progress>${escapeHtml(
        agentUI.executionPreparingText || `准备执行，共 ${total} 个操作`
      )}</div>${
        buttonsHtml ? `<div class="nfm-agent-actions">${buttonsHtml}</div>` : ""
      }`;
      root.appendChild(modal);
      modal.addEventListener("click", (event) => {
        if (!event.target?.dataset?.agentCancel) return;
        cancelled = true;
        const progress = modal.querySelector("[data-agent-progress]");
        if (progress)
          progress.textContent =
            agentUI.cancellingText || "正在取消：当前操作完成后将停止后续操作";
      });
      return {
        get cancelled() {
          return cancelled;
        },
        update(index, totalCount, op) {
          const progress = modal.querySelector("[data-agent-progress]");
          if (progress) {
            const actionName = op?.action || "操作";
            progress.textContent = agentUI.progressTemplate
              ? String(agentUI.progressTemplate)
                  .replaceAll("{index}", index)
                  .replaceAll("{total}", totalCount)
                  .replaceAll("{action}", actionName)
              : `正在执行 ${index}/${totalCount}：${actionName}`;
          }
        },
        close() {
          modal.remove();
        },
      };
    }

    async function showAgentPreview(payload) {
      const operations = Array.isArray(payload.operations)
        ? payload.operations
        : [];
      const creates =
        payload.risk?.creates ||
        operations.filter((op) => op.action === "newFolder").length ||
        0;
      const moves =
        payload.risk?.moves ||
        operations.filter((op) => op.action === "move").length ||
        0;
      const trashes =
        payload.risk?.trashes ||
        operations.filter((op) => op.action === "trash").length ||
        0;
      const overwrites =
        payload.risk?.overwrites ||
        operations.filter((op) => op.conflictStrategy === "overwrite").length ||
        0;
      const highRisk = trashes > 0 || overwrites > 0;

      if (typeof agentRequestCallback === "function") {
        try {
          const customDecision = await agentRequestCallback({
            ...(payload || {}),
            widgetId: id,
            mountId,
            operations,
            risk: { creates, moves, trashes, overwrites, highRisk },
          });
          if (customDecision && typeof customDecision === "object") {
            const accepted = customDecision.accepted === true;
            if (!accepted) return { accepted: false };
            if (highRisk && customDecision.highRiskConfirmed !== true) {
              const decision = await nfmConfirm({
                type: "agentHighRisk",
                title: "确认 Agent 高风险文件操作",
                message:
                  "本次 Agent 任务包含删除或覆盖等高风险文件操作。即使 customUI 已允许，也必须进行系统兜底确认。确定继续？",
                confirmText: "确认执行",
                danger: true,
                affectedCount: operations.length,
              });
              if (!decision.accepted) return { accepted: false };
              return {
                ...customDecision,
                accepted: true,
                highRiskConfirmed: true,
              };
            }
            return { ...customDecision, accepted: true };
          }
        } catch (error) {
          console.warn("[NativeFileMount] nfm.onAgentRequest failed:", error);
        }
      }

      return new Promise((resolve) => {
        const agentUI = config.ui?.agentUI || {};
        const modal = document.createElement("div");
        modal.className = "nfm-agent";
        modal.dataset.position =
          agentUI.preview?.position || agentUI.position || "top";
        modal.dataset.layout = agentUI.previewLayout || "default";
        modal.dataset.showRiskSummary =
          agentUI.showRiskSummary === false ? "0" : "1";
        modal.dataset.showDetails = agentUI.showDetails === false ? "0" : "1";
        const previewTitle =
          agentUI.previewTitle || "🤖 Agent 请求执行文件操作";
        const intentLabel = agentUI.intentLabel || "意图";
        const detailText = agentUI.detailText || "查看详情";
        const denyText = agentUI.denyText || "拒绝";
        const trustText = agentUI.trustText || "信任本次任务";
        const allowText = agentUI.allowText || "允许执行";
        const allowHighRiskText =
          agentUI.allowHighRiskText || "⚠ 确认执行高风险操作";
        const previewButtons = normalizeButtonList(agentUI.previewButtons, [
          "deny",
          "trust",
          "allow",
        ]);
        const previewButtonHtml = previewButtons
          .filter((button) => ["deny", "trust", "allow"].includes(button))
          .map((button) => {
            const text =
              button === "deny"
                ? denyText
                : button === "trust"
                ? trustText
                : highRisk
                ? allowHighRiskText
                : allowText;
            const danger = button === "allow" ? " danger" : "";
            return `<button class="nfm-btn${danger}" data-agent="${button}">${escapeHtml(
              text
            )}</button>`;
          })
          .join("");
        modal.innerHTML = `<h3>${escapeHtml(
          previewTitle
        )}</h3><div>${escapeHtml(intentLabel)}：${escapeHtml(
          payload.summary || payload.intent || "文件操作"
        )}</div><ul><li>${escapeHtml(
          agentUI.createsLabel || "新建"
        )} ${creates} 个文件夹</li><li>${escapeHtml(
          agentUI.movesLabel || "移动"
        )} ${moves} 个文件</li><li>${escapeHtml(
          trashes
            ? `⚠️ 删除 ${trashes} 项`
            : agentUI.noTrashText || "不删除文件"
        )}</li><li>${escapeHtml(
          overwrites
            ? `⚠️ 覆盖 ${overwrites} 项`
            : agentUI.noOverwriteText || "不覆盖文件"
        )}</li></ul><details><summary>${escapeHtml(
          detailText
        )}</summary><pre>${escapeHtml(
          JSON.stringify(operations, null, 2)
        )}</pre></details>${
          previewButtonHtml
            ? `<div class="nfm-agent-actions">${previewButtonHtml}</div>`
            : ""
        }`;
        root.appendChild(modal);
        modal.addEventListener("click", async (event) => {
          const act = event.target?.dataset?.agent;
          if (!act) return;
          modal.remove();
          let highRiskConfirmed = act === "allow" && highRisk;
          if ((act === "trust" || act === "allow") && highRisk) {
            const decision = await nfmConfirm({
              type: "agentHighRisk",
              title: "确认 Agent 高风险文件操作",
              message:
                "本次 Agent 任务包含删除或覆盖等高风险文件操作。确定继续？",
              confirmText: "确认执行",
              danger: true,
              affectedCount: operations.length,
            });
            highRiskConfirmed = decision.accepted === true;
          }
          resolve({
            accepted:
              act === "allow" ||
              (act === "trust" && (!highRisk || highRiskConfirmed)),
            trusted: act === "trust",
            highRiskConfirmed,
          });
        });
        setTimeout(() => {
          if (modal.isConnected) {
            modal.remove();
            resolve({ accepted: false });
          }
        }, 120000);
      });
    }

    async function executeAgentOperation(op, decision = {}) {
      const strategy = op.conflictStrategy || "ask";
      const confirmed =
        op.confirmed === true ||
        (strategy === "overwrite" && decision.highRiskConfirmed === true);
      if (op.action === "openWith") {
        return { success: false, error: "ERR_AGENT_OPENWITH_FORBIDDEN" };
      }
      if (op.action === "newFolder")
        return privilegedAction(
          "newFolder",
          [],
          {
            name: op.name,
            parentDir: op.parentDir || currentDir,
          },
          "agent"
        );
      if (op.action === "rename")
        return privilegedAction(
          "rename",
          [op.from || op.path],
          {
            newName: op.newName || op.name,
          },
          "agent"
        );
      if (op.action === "trash")
        return privilegedAction(
          "trash",
          [op.path || op.from],
          {
            confirmed:
              op.confirmed === true || decision.highRiskConfirmed === true,
          },
          "agent"
        );
      if (op.action === "move")
        return privilegedAction(
          "move",
          [op.from],
          {
            from: op.from,
            to: op.to,
            conflictStrategy: strategy,
            confirmed,
          },
          "agent"
        );
      if (op.action === "copy") {
        return privilegedAction(
          "copyTo",
          [op.from || op.path],
          {
            from: op.from || op.path,
            to: op.to,
            toDir: op.toDir || currentDir,
            conflictStrategy: strategy,
            confirmed,
          },
          "agent"
        );
      }
      return { success: false, error: "ERR_UNSUPPORTED_AGENT_ACTION" };
    }

    return {
      init,
      cleanup,
      handleAgentAction,
      getInfo: (level = "summary") => {
        const source =
          widgetData.builtinSource ||
          generateNativeFileMountSource(config, customUI, {
            widgetId: id,
            title,
            frame: widgetData.frameOptions,
          });
        const base = {
          widgetId: id,
          mountId,
          title,
          rootPath,
          mountPath: rootPath,
          mode: config.mode,
          view: config.initialView,
          type: "nativeFileMount",
          sourceFormat: "desktopBuiltin",
          sourceAvailable: true,
          sourceOrigin: widgetData.sourceOrigin || "generated",
          sourceCompleteness: "full",
          sourceVersion: widgetData.sourceVersion || 1,
          layoutVersion: widgetData.layoutVersion || 1,
          widgetVersion: widgetData.widgetVersion || 1,
          versions: {
            sourceVersion: widgetData.sourceVersion || 1,
            layoutVersion: widgetData.layoutVersion || 1,
            widgetVersion: widgetData.widgetVersion || 1,
          },
          customUI: {
            requested: customUIRequested,
            mounted: customUIMounted,
            fallbackToDefault: customUIFallbackToDefault,
            error: customUIError,
          },
        };
        if (level === "summary") return base;
        return {
          ...base,
          source,
          config: clonePlain(config),
          customUI: {
            requested: customUIRequested,
            mounted: customUIMounted,
            fallbackToDefault: customUIFallbackToDefault,
            error: customUIError,
            definition: clonePlain(customUI),
          },
          frame: clonePlain(widgetData.frameOptions || {}),
          runtimeExcluded: ["mountId", "capabilityToken"],
        };
      },
    };
  }

  window.VCPDesktop = window.VCPDesktop || {};
  window.VCPDesktop.builtinNativeFileMount = {
    spawn: spawnNativeFileMount,
    generateSource: generateNativeFileMountSource,
    parseSource: parseNativeFileMountSource,
    getInstance: (widgetId) => instances.get(widgetId),
    list: () =>
      Array.from(instances.values())
        .map((instance) => instance.getInfo())
        .filter((item) => item.mountId),
  };
})();
