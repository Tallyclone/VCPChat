const { ipcMain } = require("electron");
const path = require("path");
const fs = require("fs-extra");
const { CHANNELS } = require("./ipcContracts");

let desktopHandlersRef = null;
let canvasHandlersRef = null;
let mainWindowRef = null;

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const pendingDesktopRemoteRequests = new Map();
const pendingFlowlockRequests = new Map();
let bridgeInitialized = false;

function createRequestId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function settlePendingRequest(map, event, envelope) {
  const requestId = envelope?.requestId;
  if (!requestId || !map.has(requestId)) {
    return false;
  }

  const pending = map.get(requestId);
  if (pending.webContentsId && pending.webContentsId !== event.sender.id) {
    return false;
  }

  clearTimeout(pending.timeoutId);
  map.delete(requestId);

  if (envelope.ok === false) {
    pending.reject(new Error(envelope.error || "Renderer RPC failed."));
    return true;
  }

  pending.resolve(envelope.data);
  return true;
}

function initBridgeListeners() {
  if (bridgeInitialized) {
    return;
  }

  ipcMain.on(CHANNELS.DESKTOP_REMOTE_RESPONSE, (event, envelope) => {
    settlePendingRequest(pendingDesktopRemoteRequests, event, envelope);
  });

  ipcMain.on(CHANNELS.FLOWLOCK_RESPONSE, (event, envelope) => {
    settlePendingRequest(pendingFlowlockRequests, event, envelope);
  });

  bridgeInitialized = true;
}

function requestRendererRpc(
  targetWindow,
  channel,
  pendingMap,
  prefix,
  command,
  payload,
  options = {}
) {
  if (!targetWindow || targetWindow.isDestroyed()) {
    return Promise.reject(
      new Error(options.unavailableMessage || "Target window is not available.")
    );
  }

  const requestId = createRequestId(prefix);
  const timeoutMs = options.timeoutMs || 5000;

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      pendingMap.delete(requestId);
      if (options.resolveOnTimeout !== undefined) {
        resolve(options.resolveOnTimeout);
        return;
      }
      reject(new Error(options.timeoutMessage || `${command} timed out.`));
    }, timeoutMs);

    pendingMap.set(requestId, {
      resolve,
      reject,
      timeoutId,
      webContentsId: targetWindow.webContents.id,
    });

    targetWindow.webContents.send(channel, {
      requestId,
      command,
      payload: payload || {},
      source: options.source || "main-process",
    });
  });
}

async function ensureDesktopWindow(desktopWin, options = {}) {
  let targetWin = desktopWin;
  let openedNow = false;

  if (!targetWin || targetWin.isDestroyed()) {
    await desktopHandlersRef.openDesktopWindow();
    targetWin = desktopHandlersRef.getDesktopWindow();
    openedNow = true;
  }

  if (!targetWin || targetWin.isDestroyed()) {
    throw new Error(options.errorMessage || "Failed to open desktop window.");
  }

  if (openedNow && options.waitAfterOpenMs) {
    await new Promise((resolve) =>
      setTimeout(resolve, options.waitAfterOpenMs)
    );
  }

  return targetWin;
}

function requestDesktopRemote(desktopWin, command, payload, options = {}) {
  return requestRendererRpc(
    desktopWin,
    CHANNELS.DESKTOP_REMOTE_REQUEST,
    pendingDesktopRemoteRequests,
    "desktop-remote",
    command,
    payload,
    options
  );
}

function requestFlowlock(commandPayload, options = {}) {
  return requestRendererRpc(
    mainWindowRef,
    CHANNELS.FLOWLOCK_REQUEST,
    pendingFlowlockRequests,
    "flowlock",
    commandPayload.command,
    commandPayload,
    options
  );
}

function initialize(params) {
  mainWindowRef = params.mainWindow;
  desktopHandlersRef = require("./desktopHandlers");
  canvasHandlersRef = require("./canvasHandlers");
  initBridgeListeners();
  console.log("[DesktopRemoteHandlers] Initialized.");
}

async function handleCanvasControl(filePath) {
  try {
    if (!filePath) {
      throw new Error("No filePath provided for canvas control.");
    }

    if (!canvasHandlersRef) {
      canvasHandlersRef = require("./canvasHandlers");
    }

    await canvasHandlersRef.createCanvasWindow(filePath);
    return { status: "success", message: "Canvas window command processed." };
  } catch (error) {
    console.error("[DesktopRemoteHandlers] handleCanvasControl error:", error);
    return { status: "error", message: error.message };
  }
}

async function handleFlowlockControl(commandPayload) {
  try {
    const {
      command,
      agentId,
      topicId,
      prompt,
      promptSource,
      target,
      oldText,
      newText,
    } = commandPayload;
    console.log(
      `[DesktopRemoteHandlers] handleFlowlockControl received command: ${command}`,
      commandPayload
    );

    if (!mainWindowRef || mainWindowRef.isDestroyed()) {
      throw new Error("Main window is not available.");
    }

    if (command === "get" || command === "status") {
      const responseData = await requestFlowlock(
        {
          command,
          agentId,
          topicId,
          prompt,
          promptSource,
          target,
          oldText,
          newText,
        },
        {
          timeoutMs: 5000,
          timeoutMessage:
            command === "get"
              ? "Timed out while querying current input content."
              : "Timed out while querying flowlock status.",
        }
      );

      if (command === "get") {
        return {
          status: "success",
          message: `Current input content: "${responseData?.content || ""}"`,
          content: responseData?.content || "",
        };
      }

      const statusInfo = responseData?.status || {};
      const statusText = statusInfo.isActive
        ? `Flowlock is active (Agent: ${statusInfo.agentId}, Topic: ${
            statusInfo.topicId
          }, Processing: ${statusInfo.isProcessing ? "yes" : "no"})`
        : "Flowlock is inactive.";

      return {
        status: "success",
        message: statusText,
        flowlockStatus: statusInfo,
      };
    }

    mainWindowRef.webContents.send("flowlock-command", {
      command,
      agentId,
      topicId,
      prompt,
      promptSource,
      target,
      oldText,
      newText,
    });

    let naturalResponse = "";
    switch (command) {
      case "start":
        naturalResponse = `Flowlock started for agent "${agentId}" topic "${topicId}".`;
        break;
      case "stop":
        naturalResponse = "Flowlock stopped.";
        break;
      case "promptee":
        naturalResponse = `Prompt appended: "${prompt}"`;
        break;
      case "prompter":
        naturalResponse = `Prompt source requested: "${promptSource}"`;
        break;
      case "clear":
        naturalResponse = "Input box cleared.";
        break;
      case "remove":
        naturalResponse = `Removed target text: "${target}"`;
        break;
      case "edit":
        naturalResponse = `Edited "${oldText}" to "${newText}".`;
        break;
      default:
        naturalResponse = `Flowlock command "${command}" dispatched.`;
    }

    return { status: "success", message: naturalResponse };
  } catch (error) {
    console.error(
      "[DesktopRemoteHandlers] handleFlowlockControl error:",
      error
    );
    return { status: "error", message: error.message };
  }
}

async function handleDesktopRemoteControl(commandPayload) {
  try {
    const { command } = commandPayload;
    console.log(
      `[DesktopRemoteHandlers] handleDesktopRemoteControl received command: ${command}`,
      commandPayload
    );

    if (!desktopHandlersRef) {
      desktopHandlersRef = require("./desktopHandlers");
    }

    const desktopWin = desktopHandlersRef.getDesktopWindow();

    switch (command) {
      case "SetWallpaper":
        return await _handleSetWallpaper(commandPayload, desktopWin);
      case "QueryDesktop":
        return await _handleQueryDesktop(desktopWin);
      case "QueryDock":
        return await _handleQueryDock(desktopWin);
      case "ViewWidgetSource":
        return await _handleViewWidgetSource(commandPayload, desktopWin);
      case "SetStyleAutomation":
        return await _handleSetStyleAutomation(commandPayload, desktopWin);
      case "GetStyleAutomationStatus":
        return await _handleGetStyleAutomationStatus(desktopWin);
      case "CreateWidget":
        return await _handleCreateWidget(commandPayload, desktopWin);
      case "CreateNativeFileMount":
        return await _handleCreateNativeFileMount(commandPayload, desktopWin);
      case "EditNativeFileMount":
        return await _handleEditNativeFileMount(commandPayload, desktopWin);
      default:
        throw new Error(`Unknown desktop remote command: ${command}`);
    }
  } catch (error) {
    console.error(
      "[DesktopRemoteHandlers] handleDesktopRemoteControl error:",
      error
    );
    return { status: "error", message: error.message };
  }
}

function inferWallpaperType(source) {
  const ext = path.extname(source).toLowerCase().replace(".", "");
  if (["mp4", "webm"].includes(ext)) {
    return "video";
  }
  if (["html", "htm"].includes(ext)) {
    return "html";
  }
  return "image";
}

async function _handleSetWallpaper(commandPayload, desktopWin) {
  const { wallpaperSource } = commandPayload;
  if (!wallpaperSource) {
    throw new Error("wallpaperSource parameter is required for SetWallpaper.");
  }

  const trimmedSource = wallpaperSource.trim();
  const isHtmlContent = /^<!DOCTYPE|^<html/i.test(trimmedSource);
  let wallpaperConfig;

  if (isHtmlContent) {
    const htmlFileName = `ai_wallpaper_${Date.now()}.html`;
    const htmlDir = path.join(PROJECT_ROOT, "AppData", "DesktopData");
    const htmlFilePath = path.join(htmlDir, htmlFileName);
    await fs.ensureDir(htmlDir);
    await fs.writeFile(htmlFilePath, wallpaperSource, "utf-8");
    wallpaperConfig = {
      enabled: true,
      type: "html",
      source: `file:///${htmlFilePath.replace(/\\/g, "/")}`,
      filePath: htmlFilePath,
      opacity: 1,
      blur: 0,
      brightness: 1,
    };
  } else if (
    trimmedSource.startsWith("http://") ||
    trimmedSource.startsWith("https://")
  ) {
    wallpaperConfig = {
      enabled: true,
      type: inferWallpaperType(new URL(trimmedSource).pathname),
      source: trimmedSource,
      filePath: trimmedSource,
      opacity: 1,
      blur: 0,
      brightness: 1,
    };
  } else if (trimmedSource.startsWith("file://")) {
    const localPath = trimmedSource.replace(/^file:\/\/\/?/, "");
    wallpaperConfig = {
      enabled: true,
      type: inferWallpaperType(localPath),
      source: trimmedSource,
      filePath: localPath,
      opacity: 1,
      blur: 0,
      brightness: 1,
    };
  } else {
    throw new Error(
      "wallpaperSource must be an HTTP/HTTPS URL, a file:// URL, or inline HTML."
    );
  }

  const targetWin = await ensureDesktopWindow(desktopWin, {
    waitAfterOpenMs: desktopWin ? 0 : 2000,
    errorMessage: "Unable to open desktop window for wallpaper update.",
  });

  targetWin.webContents.send("desktop-remote-set-wallpaper", wallpaperConfig);

  const mdReport = [
    "### Wallpaper Updated",
    "",
    `- type: ${wallpaperConfig.type}`,
    `- source: \`${wallpaperConfig.filePath || wallpaperConfig.source}\``,
    "- status: dispatched to desktop renderer.",
  ].join("\n");

  return {
    status: "success",
    result: { content: [{ type: "text", text: mdReport }] },
  };
}

async function _handleQueryDesktop(desktopWin) {
  if (!desktopWin || desktopWin.isDestroyed()) {
    return {
      status: "success",
      result: {
        content: [
          {
            type: "text",
            text: "### Desktop Status Report\n\n- desktopWindow: closed\n- details: Desktop window is not available.",
          },
        ],
      },
    };
  }

  const responseData = await requestDesktopRemote(
    desktopWin,
    "QueryDesktop",
    {},
    {
      timeoutMs: 5000,
      timeoutMessage: "Timed out while querying desktop state.",
    }
  );

  const widgets = responseData?.widgets || [];
  const icons = responseData?.icons || [];

  let mdReport = "### Desktop Status Report\n\n";
  mdReport += `- desktopWindow: open\n- widgets: ${widgets.length}\n- icons: ${icons.length}\n\n`;
  mdReport += "#### Widgets\n\n";
  if (widgets.length === 0) {
    mdReport += "- none\n\n";
  } else {
    mdReport +=
      "| widgetId | saved | savedName | savedDir |\n|---|---|---|---|\n";
    for (const widgetInfo of widgets) {
      mdReport += `| \`${widgetInfo.id}\` | ${
        widgetInfo.savedName ? "yes" : "no"
      } | ${widgetInfo.savedName || "-"} | ${
        widgetInfo.savedDir ? `\`${widgetInfo.savedDir}\`` : "-"
      } |\n`;
    }
    mdReport += "\n";
  }

  mdReport += "#### Desktop Icons\n\n";
  if (icons.length === 0) {
    mdReport += "- none\n";
  } else {
    for (const iconName of icons) {
      mdReport += `- ${iconName}\n`;
    }
  }

  return {
    status: "success",
    result: { content: [{ type: "text", text: mdReport }] },
  };
}

async function _handleQueryDock(desktopWin) {
  if (!desktopWin || desktopWin.isDestroyed()) {
    return {
      status: "success",
      result: {
        content: [
          {
            type: "text",
            text: "### Dock Report\n\n- desktopWindow: closed\n- details: Desktop window is not available.",
          },
        ],
      },
    };
  }

  const responseData = await requestDesktopRemote(
    desktopWin,
    "QueryDock",
    {},
    {
      timeoutMs: 5000,
      timeoutMessage: "Timed out while querying dock state.",
    }
  );

  const dockItems = responseData?.dockItems || [];
  const vchatApps = responseData?.vchatApps || [];
  const systemTools = responseData?.systemTools || [];
  const builtinWidgets = responseData?.builtinWidgets || [];

  let mdReport = "### Dock Report\n\n";
  mdReport += `- dockItems: ${dockItems.length}\n- vchatApps: ${vchatApps.length}\n- systemTools: ${systemTools.length}\n- builtinWidgets: ${builtinWidgets.length}\n\n`;
  mdReport += "#### Dock Items\n\n";

  if (dockItems.length === 0) {
    mdReport += "- none\n\n";
  } else {
    mdReport += "| name | type | visible | launch |\n|---|---|---|---|\n";
    for (const item of dockItems) {
      let launchMethod = "";
      if (item.type === "vchat-app") {
        launchMethod = `dock.launch({type:'vchat-app', appAction:'${item.appAction}'})`;
      } else if (item.type === "builtin") {
        launchMethod = `dock.launch({type:'builtin', builtinId:'${item.builtinId}'})`;
      } else {
        launchMethod = `dock.launch({type:'shortcut', targetPath:'${item.targetPath}'})`;
      }
      mdReport += `| ${item.name} | ${item.type || "shortcut"} | ${
        item.visible !== false ? "yes" : "no"
      } | \`${launchMethod}\` |\n`;
    }
    mdReport += "\n";
  }

  mdReport += "#### VChat Apps\n\n";
  for (const appInfo of vchatApps) {
    mdReport += `- ${appInfo.name} (\`${appInfo.appAction}\`)\n`;
  }
  mdReport += "\n#### System Tools\n\n";
  for (const tool of systemTools) {
    mdReport += `- ${tool.name} (\`${tool.appAction}\`)\n`;
  }
  mdReport += "\n#### Builtin Widgets\n\n";
  for (const builtin of builtinWidgets) {
    mdReport += `- ${builtin.name} (\`${builtin.builtinId}\`)\n`;
  }

  return {
    status: "success",
    result: { content: [{ type: "text", text: mdReport }] },
  };
}

async function _handleViewWidgetSource(commandPayload, desktopWin) {
  const { widgetId } = commandPayload;
  if (!widgetId) {
    throw new Error("widgetId parameter is required for ViewWidgetSource.");
  }

  if (!desktopWin || desktopWin.isDestroyed()) {
    throw new Error("Desktop window is not available.");
  }

  const responseData = await requestDesktopRemote(
    desktopWin,
    "ViewWidgetSource",
    { widgetId },
    {
      timeoutMs: 5000,
      timeoutMessage: "Timed out while loading widget source.",
    }
  );

  let mdReport = `### Widget Source: \`${widgetId}\`\n\n`;
  if (responseData?.savedName) {
    mdReport += `- savedName: ${responseData.savedName}\n`;
    mdReport += `- savedId: \`${responseData.savedId}\`\n\n`;
  }
  if (responseData?.builtinType) {
    mdReport += `- contentType: builtin\n`;
    mdReport += `- builtinType: ${responseData.builtinType}\n`;
    mdReport += `- sourceFormat: ${responseData.sourceFormat || "unknown"}\n\n`;
  }

  // Builtin widget: 显示 source（原始 key-value 协议文本）
  // 普通 widget: 显示 html
  const content = responseData?.source || responseData?.html || "";
  mdReport += `\`\`\`html\n${content}\n\`\`\``;

  return {
    status: "success",
    result: { content: [{ type: "text", text: mdReport }] },
  };
}

async function _handleSetStyleAutomation(commandPayload, desktopWin) {
  const { configPatch, persist } = commandPayload;
  if (!configPatch || typeof configPatch !== "object") {
    throw new Error(
      "configPatch parameter (object) is required for SetStyleAutomation."
    );
  }

  const targetWin = await ensureDesktopWindow(desktopWin, {
    waitAfterOpenMs: 2000,
    errorMessage: "Unable to open desktop window for style automation update.",
  });

  const responseData = await requestDesktopRemote(
    targetWin,
    "SetStyleAutomation",
    {
      configPatch,
      persist: !!persist,
    },
    {
      timeoutMs: 8000,
      resolveOnTimeout: { timedOut: true },
    }
  );

  if (responseData?.timedOut) {
    return {
      status: "success",
      result: {
        content: [
          {
            type: "text",
            text: `### Style Automation Update Queued\n\n- persist: ${
              persist ? "true" : "false"
            }\n- status: renderer response timed out, but request was dispatched.`,
          },
        ],
      },
    };
  }

  const statusInfo = responseData?.status || {};
  let mdReport = "### Style Automation Updated\n\n";
  mdReport += `- enabled: ${statusInfo.enabled ? "true" : "false"}\n`;
  if (typeof statusInfo.intervalMs === "number") {
    mdReport += `- intervalMs: ${statusInfo.intervalMs}\n`;
  }
  mdReport += `- running: ${statusInfo.running ? "true" : "false"}\n`;
  if (statusInfo.lastError) {
    mdReport += `- lastError: ${statusInfo.lastError}\n`;
  }

  return {
    status: "success",
    result: { content: [{ type: "text", text: mdReport }] },
  };
}

async function _handleGetStyleAutomationStatus(desktopWin) {
  if (!desktopWin || desktopWin.isDestroyed()) {
    return {
      status: "success",
      result: {
        content: [
          {
            type: "text",
            text: "### Style Automation Status\n\n- desktopWindow: closed\n- details: open the desktop window first.",
          },
        ],
      },
    };
  }

  const responseData = await requestDesktopRemote(
    desktopWin,
    "GetStyleAutomationStatus",
    {},
    {
      timeoutMs: 5000,
      timeoutMessage: "Timed out while querying style automation status.",
    }
  );

  const statusInfo = responseData?.status || {};
  let mdReport = "### Style Automation Status\n\n";
  mdReport += `- enabled: ${statusInfo.enabled ? "true" : "false"}\n`;
  if (typeof statusInfo.intervalMs === "number") {
    mdReport += `- intervalMs: ${statusInfo.intervalMs}\n`;
  }
  mdReport += `- running: ${statusInfo.running ? "true" : "false"}\n`;
  if (statusInfo.lastError) {
    mdReport += `- lastError: ${statusInfo.lastError}\n`;
  }

  return {
    status: "success",
    result: { content: [{ type: "text", text: mdReport }] },
  };
}

async function _handleCreateWidget(commandPayload, desktopWin) {
  const {
    htmlContent,
    x,
    y,
    width,
    height,
    widgetId,
    autoSave,
    saveName,
    scriptCode,
    builtinWidgetKey,
    metricComponent,
  } = commandPayload;

  if (!htmlContent && !builtinWidgetKey && !metricComponent) {
    throw new Error("htmlContent parameter is required for CreateWidget.");
  }

  const targetWin = await ensureDesktopWindow(desktopWin, {
    waitAfterOpenMs: 2000,
    errorMessage: "Unable to open desktop window for widget creation.",
  });

  const finalWidgetId =
    widgetId ||
    `remote-widget-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  const options = {};
  if (typeof x === "number") options.x = x;
  if (typeof y === "number") options.y = y;
  if (typeof width === "number") options.width = width;
  if (typeof height === "number") options.height = height;

  let savedId = null;
  let finalHtmlContent = htmlContent;
  const hasScriptCode =
    typeof scriptCode === "string" && scriptCode.trim().length > 0;

  if (hasScriptCode) {
    savedId = `saved-${Date.now()}-${Math.random()
      .toString(36)
      .substring(2, 8)}`;
    const widgetDir = path.join(
      PROJECT_ROOT,
      "AppData",
      "DesktopWidgets",
      savedId
    );
    await fs.ensureDir(widgetDir);
    await fs.writeFile(path.join(widgetDir, "app.js"), scriptCode, "utf-8");
    await fs.writeFile(
      path.join(widgetDir, "widget.html"),
      htmlContent,
      "utf-8"
    );
    await fs.writeJson(
      path.join(widgetDir, "meta.json"),
      {
        id: savedId,
        name: saveName || "AI Widget",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      { spaces: 2 }
    );

    const widgetDirUrl = `file:///${widgetDir.replace(/\\/g, "/")}`;
    const appJsUrl = `${widgetDirUrl}/app.js`;
    finalHtmlContent = finalHtmlContent.replace(
      /(<script[^>]*\ssrc\s*=\s*)(["'])app\.js\2/gi,
      `$1$2${appJsUrl}$2`
    );
    finalHtmlContent = finalHtmlContent.replace(
      /(<script[^>]*\ssrc\s*=\s*)app\.js(\s|>)/gi,
      `$1"${appJsUrl}"$2`
    );

    if (!htmlContent.match(/<script[^>]*\ssrc\s*=\s*["']?app\.js/i)) {
      if (finalHtmlContent.includes("</body>")) {
        finalHtmlContent = finalHtmlContent.replace(
          "</body>",
          `<script src="${appJsUrl}"></script>\n</body>`
        );
      } else {
        finalHtmlContent += `\n<script src="${appJsUrl}"></script>`;
      }
    }
  }

  const responseData = await requestDesktopRemote(
    targetWin,
    "CreateWidget",
    {
      widgetId: finalWidgetId,
      htmlContent: finalHtmlContent,
      options,
      autoSave: hasScriptCode ? true : !!autoSave,
      saveName: saveName || (hasScriptCode ? "AI Widget" : null),
      preSavedId: savedId || null,
      builtinWidgetKey: builtinWidgetKey || null,
      metricComponent: metricComponent || null,
    },
    {
      timeoutMs: 8000,
      resolveOnTimeout: { timedOut: true },
    }
  );

  if (responseData?.timedOut) {
    let timeoutReport = "### Widget Creation Queued\n\n";
    timeoutReport += `- widgetId: \`${finalWidgetId}\`\n`;
    timeoutReport += `- position: (${options.x || 100}, ${options.y || 100})\n`;
    timeoutReport += `- size: ${options.width || 320} x ${
      options.height || 200
    }\n`;
    timeoutReport +=
      "- status: renderer response timed out, but request was dispatched.";
    return {
      status: "success",
      result: { content: [{ type: "text", text: timeoutReport }] },
    };
  }

  let mdReport = "### Widget Created\n\n";
  mdReport += `- widgetId: \`${responseData?.widgetId || finalWidgetId}\`\n`;
  mdReport += `- position: (${options.x || 100}, ${options.y || 100})\n`;
  mdReport += `- size: ${options.width || 320} x ${options.height || 200}\n`;

  const finalSavedId = savedId || responseData?.savedId;
  const finalSavedName = saveName || responseData?.savedName;
  if (finalSavedId) {
    mdReport += `- savedName: ${finalSavedName}\n`;
    mdReport += `- savedDir: \`AppData/DesktopWidgets/${finalSavedId}\`\n`;
  }
  if (responseData?.builtinWidgetKey) {
    mdReport += `- builtinWidgetKey: ${responseData.builtinWidgetKey}\n`;
  }
  if (hasScriptCode) {
    mdReport += "- script: `app.js`\n";
  }

  return {
    status: "success",
    result: { content: [{ type: "text", text: mdReport }] },
  };
}

// ========== NativeFileMount Handlers ==========

async function _handleCreateNativeFileMount(commandPayload, desktopWin) {
  const { mountPath, mode, x, y, width, height, ui, frame } = commandPayload;

  const targetWin = await ensureDesktopWindow(desktopWin, {
    errorMessage: "Desktop window is required for CreateNativeFileMount.",
    waitAfterOpenMs: 500,
  });

  const widgetId = `nfm-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 7)}`;

  const rpcPayload = {
    widgetId,
    config: { mountPath, mode: mode || "readonly" },
    options: {
      x: x || 200,
      y: y || 150,
      width: width || 880,
      height: height || 620,
      frame: frame || undefined,
    },
  };

  if (ui && typeof ui === "object") {
    rpcPayload.config.ui = ui;
  }

  try {
    const response = await requestDesktopRemote(
      targetWin,
      "CreateNativeFileMount",
      rpcPayload,
      {
        timeoutMs: 8000,
        timeoutMessage: "CreateNativeFileMount timed out (8s).",
      }
    );

    const data = response?.data || response || {};
    const status = data.status || "mounted";
    const errorMsg = data.error || data.errorMessage || null;
    const customUIFallback = data.customUIFallback || false;
    const customUIFallbackReason = data.customUIFallbackReason || null;
    const runtimeErrors = data.runtimeErrors || null;
    const pollingElapsedMs = data.pollingElapsedMs || null;

    let mdReport = "";
    if (status === "error") {
      mdReport += "### NativeFileMount Failed\n\n";
      mdReport += `- widgetId: \`${widgetId}\`\n`;
      mdReport += `- mountPath: \`${mountPath}\`\n`;
      mdReport += `- status: error ❌\n`;
      mdReport += `- error: ${errorMsg}\n`;
    } else {
      mdReport += "### NativeFileMount Created\n\n";
      mdReport += `- widgetId: \`${widgetId}\`\n`;
      mdReport += `- mountPath: \`${mountPath}\`\n`;
      mdReport += `- mode: ${mode || "readonly"}\n`;
      if (customUIFallback) {
        mdReport += `- status: mounted ⚠️ (CustomUI fallback)\n`;
        mdReport += `- warning: ${customUIFallbackReason}\n`;
      } else if (runtimeErrors && runtimeErrors.length > 0) {
        mdReport += `- status: mounted ⚠️ (CustomUI has runtime errors)\n`;
      } else {
        mdReport += `- status: mounted ✅\n`;
      }
    }

    // Append runtime errors if any
    if (runtimeErrors && runtimeErrors.length > 0) {
      mdReport += `\n#### CustomUI Runtime Errors (${runtimeErrors.length})\n\n`;
      for (const err of runtimeErrors) {
        mdReport += `- \`[${err.source || "unknown"}:${err.line || 0}]\` ${
          err.message
        }\n`;
      }
      mdReport += `\n> These errors occurred within the customUI.js code. Fix the JavaScript logic and retry.\n`;
    }

    if (pollingElapsedMs != null) {
      mdReport += `- responseTime: ${pollingElapsedMs}ms\n`;
    }

    return {
      status: status === "error" ? "error" : "success",
      result: { content: [{ type: "text", text: mdReport }] },
    };
  } catch (err) {
    let mdReport = "### NativeFileMount Failed\n\n";
    mdReport += `- widgetId: \`${widgetId}\`\n`;
    mdReport += `- mountPath: \`${mountPath}\`\n`;
    mdReport += `- status: error ❌\n`;
    mdReport += `- error: ${err.message}\n`;

    return {
      status: "error",
      result: { content: [{ type: "text", text: mdReport }] },
    };
  }
}

async function _handleEditNativeFileMount(commandPayload, desktopWin) {
  const { widgetId, target, replace } = commandPayload;

  const targetWin = await ensureDesktopWindow(desktopWin, {
    errorMessage: "Desktop window is required for EditNativeFileMount.",
    waitAfterOpenMs: 500,
  });

  try {
    const response = await requestDesktopRemote(
      targetWin,
      "EditNativeFileMount",
      { widgetId, target, replace },
      { timeoutMs: 8000, timeoutMessage: "EditNativeFileMount timed out (8s)." }
    );

    const data = response?.data || response || {};
    const status = data.status || "edited";
    const errorMsg = data.error || data.errorMessage || null;

    let mdReport = "";
    if (status === "error") {
      mdReport += "### NativeFileMount Edit Failed\n\n";
      mdReport += `- widgetId: \`${widgetId}\`\n`;
      mdReport += `- status: error ❌\n`;
      mdReport += `- error: ${errorMsg}\n`;
    } else {
      mdReport += "### NativeFileMount Edited\n\n";
      mdReport += `- widgetId: \`${widgetId}\`\n`;
      mdReport += `- status: edited ✅\n`;
      mdReport += `- target: \`${target}\`\n`;
      mdReport += `- replace: \`${replace}\`\n`;
    }

    return {
      status: status === "error" ? "error" : "success",
      result: { content: [{ type: "text", text: mdReport }] },
    };
  } catch (err) {
    let mdReport = "### NativeFileMount Edit Failed\n\n";
    mdReport += `- widgetId: \`${widgetId}\`\n`;
    mdReport += `- status: error ❌\n`;
    mdReport += `- error: ${err.message}\n`;

    return {
      status: "error",
      result: { content: [{ type: "text", text: mdReport }] },
    };
  }
}

module.exports = {
  initialize,
  handleDesktopRemoteControl,
  handleCanvasControl,
  handleFlowlockControl,
};
