"use strict";

(function () {
  const desktopApi = window.desktopAPI || window.electronAPI;
  const { state, status, widget } = window.VCPDesktop;
  const editingWidgetIds = new Set();

  function sendDesktopRemoteRpcResponse(requestId, response) {
    if (!desktopApi?.sendDesktopRemoteResponse) {
      return;
    }
    desktopApi.sendDesktopRemoteResponse({
      requestId,
      ok: response.ok !== false,
      data: response.data,
      error: response.error,
    });
  }

  function sendDesktopOperationResult(requestId, result = {}) {
    if (!requestId || !desktopApi?.desktopOperationResult) return;
    desktopApi.desktopOperationResult({
      event: "WidgetOperationResult",
      requestId,
      ...result,
    });
  }

  function buildVersions(widgetData) {
    return {
      sourceVersion: readNumber(widgetData?.sourceVersion, 1),
      layoutVersion: readNumber(widgetData?.layoutVersion, 1),
      widgetVersion: readNumber(widgetData?.widgetVersion, 1),
    };
  }

  function clonePlain(value) {
    if (value == null) return value;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (error) {
      return value;
    }
  }

  function readNumber(value, fallback = 1) {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? num : fallback;
  }

  function getWidgetLayout(widgetData) {
    const element = widgetData?.element;
    return {
      x: parseInt(element?.style?.left, 10) || 0,
      y: parseInt(element?.style?.top, 10) || 0,
      width: parseInt(element?.style?.width, 10) || 0,
      height: parseInt(element?.style?.height, 10) || 0,
      zIndex: readNumber(element?.style?.zIndex || widgetData?.zIndex, 1),
      fixedSize: !!widgetData?.fixedSize,
      frame: clonePlain(widgetData?.frameOptions || {}),
    };
  }

  function getNativeFileMountInfo(widgetId, level = "summary") {
    return window.VCPDesktop.builtinNativeFileMount
      ?.getInstance(widgetId)
      ?.getInfo?.(level);
  }

  function getHtmlSourceState(widgetData) {
    const storedSource =
      widgetData.cardSource ||
      widgetData.contentBuffer ||
      widgetData.contentContainer?.innerHTML ||
      "";
    const hasPackage =
      !!widgetData.cardPackage ||
      (widgetData.cardFiles instanceof Map && widgetData.cardFiles.size > 0);
    const sourceFormat = hasPackage
      ? "htmlPackage"
      : widgetData.sourceFormat || "inlineHtml";
    const sourceOrigin =
      widgetData.sourceOrigin && widgetData.sourceOrigin !== "none"
        ? widgetData.sourceOrigin
        : storedSource
        ? "snapshot"
        : "none";
    const sourceCompleteness =
      widgetData.sourceCompleteness && widgetData.sourceCompleteness !== "none"
        ? widgetData.sourceCompleteness
        : storedSource
        ? sourceOrigin === "snapshot"
          ? "degraded"
          : "partial"
        : "none";
    return {
      source: storedSource,
      sourceAvailable: !!storedSource || hasPackage,
      sourceFormat: storedSource || hasPackage ? sourceFormat : "none",
      sourceOrigin,
      sourceCompleteness,
    };
  }

  function normalizePackageFileName(name) {
    return String(name || "")
      .replace(/\\/g, "/")
      .replace(/^\.\//, "")
      .trim();
  }

  function getPackageMainFile(widgetData) {
    return normalizePackageFileName(
      widgetData.cardPackage?.mainFile || "widget.html"
    );
  }

  function getPackageFilesMap(widgetData) {
    if (widgetData.cardFiles instanceof Map && widgetData.cardFiles.size > 0) {
      return widgetData.cardFiles;
    }
    widgetData.cardFiles = new Map();
    const mainFile = getPackageMainFile(widgetData);
    if (widgetData.cardSource || widgetData.contentBuffer) {
      widgetData.cardFiles.set(mainFile, {
        name: mainFile,
        role: "entry",
        encoding: "utf-8",
        editable: true,
        content: widgetData.cardSource || widgetData.contentBuffer || "",
      });
    }
    const manifestFiles = Array.isArray(widgetData.cardPackage?.files)
      ? widgetData.cardPackage.files
      : [];
    for (const file of manifestFiles) {
      const name = normalizePackageFileName(file?.name || file?.path);
      if (!name || widgetData.cardFiles.has(name)) continue;
      widgetData.cardFiles.set(name, {
        name,
        role: file?.role || (name === mainFile ? "entry" : "asset"),
        encoding: file?.encoding || "utf-8",
        editable:
          file?.editable !== false && (file?.encoding || "utf-8") !== "base64",
        content: file?.content || "",
      });
    }
    return widgetData.cardFiles;
  }

  function getPackageFile(widgetData, targetFile) {
    const filesMap = getPackageFilesMap(widgetData);
    const mainFile = getPackageMainFile(widgetData);
    const normalizedTarget = normalizePackageFileName(targetFile || mainFile);
    const file = filesMap.get(normalizedTarget);
    if (!file) {
      return {
        ok: false,
        error: "ERR_TARGET_FILE_NOT_FOUND",
        message: `targetFile 不存在: ${normalizedTarget}`,
      };
    }
    const encoding = file.encoding || "utf-8";
    const editable = file.editable !== false && encoding !== "base64";
    if (!editable) {
      return {
        ok: false,
        error: "ERR_TARGET_FILE_NOT_EDITABLE",
        message: `targetFile 不可编辑: ${normalizedTarget}`,
      };
    }
    return { ok: true, name: normalizedTarget, file, mainFile, filesMap };
  }

  function listPackageFiles(widgetData, includeContent = false) {
    const files = [];
    const filesMap = getPackageFilesMap(widgetData);
    for (const [name, file] of filesMap.entries()) {
      const encoding = file?.encoding || "utf-8";
      files.push({
        name,
        role:
          file?.role ||
          (name === widgetData.cardPackage?.mainFile ? "entry" : "asset"),
        encoding,
        editable: file?.editable !== false && encoding !== "base64",
        ...(includeContent ? { content: file?.content || "" } : {}),
      });
    }
    return files;
  }

  function buildPackageManifest(widgetData, widgetId, name, layout) {
    const mainFile = getPackageMainFile(widgetData);
    return {
      ...(clonePlain(widgetData.cardPackage || {}) || {}),
      schemaVersion: 2,
      id: widgetData.savedId,
      name,
      type: "htmlWidget",
      sourceFormat: "htmlPackage",
      mainFile,
      entry: mainFile,
      files: listPackageFiles(widgetData, false),
      updatedAt: Date.now(),
      layout,
      frame: clonePlain(widgetData.frameOptions || layout.frame || {}),
    };
  }

  function applyHtmlPackageSource(
    widgetId,
    widgetData,
    targetFile,
    nextSource
  ) {
    const targetState = getPackageFile(widgetData, targetFile);
    if (!targetState.ok) return targetState;

    const { name, file, mainFile } = targetState;
    file.content = String(nextSource || "");
    file.encoding = file.encoding || "utf-8";
    file.editable = file.editable !== false;
    widgetData.cardPackage = {
      ...(widgetData.cardPackage || {}),
      schemaVersion: 2,
      type: "htmlWidget",
      sourceFormat: "htmlPackage",
      mainFile,
      entry: widgetData.cardPackage?.entry || mainFile,
      files: listPackageFiles(widgetData, false),
    };
    widgetData.cardType = "htmlWidget";
    widgetData.sourceFormat = "htmlPackage";
    widgetData.sourceOrigin = "stored";
    widgetData.sourceCompleteness = "full";

    if (name === mainFile) {
      widgetData.cardSource = file.content;
      widgetData.contentBuffer = file.content;
      widgetData.contentContainer.innerHTML = file.content;
      widget.processInlineStyles(widgetData);
      widget.processInlineScripts(widgetData);
      widget.autoResize(widgetData);
    }

    window.VCPDesktop.widget?.bumpSourceVersion?.(widgetData);
    return { ok: true, targetFile: name };
  }

  function buildWidgetSummary(widgetId, widgetData) {
    const nativeInfo = getNativeFileMountInfo(widgetId, "summary");
    const htmlState = getHtmlSourceState(widgetData);
    const isNative = !!nativeInfo || widgetData.cardType === "nativeFileMount";
    const type = isNative
      ? "nativeFileMount"
      : widgetData.cardType || "htmlWidget";
    const sourceState = isNative
      ? {
          sourceAvailable: nativeInfo?.sourceAvailable !== false,
          sourceFormat: nativeInfo?.sourceFormat || "desktopBuiltin",
          sourceOrigin:
            nativeInfo?.sourceOrigin || widgetData.sourceOrigin || "generated",
          sourceCompleteness:
            nativeInfo?.sourceCompleteness ||
            widgetData.sourceCompleteness ||
            "full",
        }
      : htmlState;
    const layout = getWidgetLayout(widgetData);
    const saved = !!widgetData.savedId;
    return {
      id: widgetId,
      type,
      title: nativeInfo?.title || widgetData.savedName || widgetId,
      saved,
      savedId: widgetData.savedId || null,
      savedName: widgetData.savedName || null,
      editable:
        sourceState.sourceAvailable &&
        ["htmlWidget", "nativeFileMount"].includes(type),
      ...sourceState,
      sourceVersion: readNumber(
        nativeInfo?.sourceVersion || widgetData.sourceVersion,
        1
      ),
      layoutVersion: readNumber(
        nativeInfo?.layoutVersion || widgetData.layoutVersion,
        1
      ),
      widgetVersion: readNumber(
        nativeInfo?.widgetVersion || widgetData.widgetVersion,
        1
      ),
      layout,
      summary: isNative
        ? {
            mountPath: nativeInfo?.mountPath || nativeInfo?.rootPath || null,
            mode: nativeInfo?.mode || null,
            view: nativeInfo?.view || null,
            customUI: !!nativeInfo?.customUI,
          }
        : {
            htmlLength: htmlState.source.length,
            fileCount: listPackageFiles(widgetData, false).length,
          },
    };
  }

  function buildWidgetDetail(widgetId, widgetData, level = "summary") {
    const summary = buildWidgetSummary(widgetId, widgetData);
    if (level === "summary") return summary;

    const nativeInfo =
      summary.type === "nativeFileMount"
        ? getNativeFileMountInfo(widgetId, "source")
        : null;
    const htmlState = getHtmlSourceState(widgetData);
    const detail = {
      ...summary,
      level,
      favorite: {
        id: widgetData.savedId || null,
        name: widgetData.savedName || null,
      },
      frame: clonePlain(widgetData.frameOptions || {}),
    };

    if (summary.type === "nativeFileMount") {
      Object.assign(detail, {
        source:
          nativeInfo?.source ||
          widgetData.builtinSource ||
          widgetData.cardSource ||
          "",
        config: clonePlain(
          nativeInfo?.config || widgetData.builtinConfig || {}
        ),
        customUI: clonePlain(
          nativeInfo?.customUI || widgetData.builtinCustomUI || null
        ),
        runtimeExcluded: nativeInfo?.runtimeExcluded || [
          "mountId",
          "capabilityToken",
        ],
      });
    } else {
      Object.assign(detail, {
        source: htmlState.source,
        mainFile: widgetData.cardPackage?.mainFile || "widget.html",
        package: clonePlain(widgetData.cardPackage || null),
        files: listPackageFiles(widgetData, level === "source"),
      });
    }

    if (level === "editable" && Array.isArray(detail.files)) {
      detail.files = detail.files.map(({ content, ...file }) => file);
    }
    return detail;
  }

  function normalizePersist(value) {
    if (value === true || value === "true") return "silent";
    if (value === false || value === "false") return "runtime";
    if (["runtime", "ask", "silent"].includes(value)) return value;
    return "runtime";
  }

  function countOccurrences(source, target) {
    if (!target) return 0;
    let count = 0;
    let index = 0;
    while ((index = source.indexOf(target, index)) !== -1) {
      count += 1;
      index += target.length;
    }
    return count;
  }

  function applyTargetReplacements(source, replacements = []) {
    let nextSource = String(source || "");
    for (const item of replacements) {
      const target = String(item?.target || "");
      const replacement = String(item?.replace ?? item?.replacement ?? "");
      if (!target) {
        return {
          ok: false,
          error: "ERR_REPLACEMENT_INVALID",
          message: "target 不能为空",
        };
      }
      const count = countOccurrences(nextSource, target);
      if (count === 0) {
        return { ok: false, error: "ERR_TARGET_NOT_FOUND", target };
      }
      if (count > 1) {
        return { ok: false, error: "ERR_TARGET_NOT_UNIQUE", target };
      }
      nextSource = nextSource.replace(target, replacement);
    }
    return { ok: true, source: nextSource };
  }

  function getCurrentEditSource(widgetId, widgetData, sourceFormat) {
    const summary = buildWidgetSummary(widgetId, widgetData);
    if (
      summary.type === "nativeFileMount" ||
      sourceFormat === "desktopBuiltin"
    ) {
      const nativeInfo = getNativeFileMountInfo(widgetId, "source");
      return (
        nativeInfo?.source ||
        widgetData.builtinSource ||
        widgetData.cardSource ||
        ""
      );
    }
    if (sourceFormat === "htmlPackage") {
      const targetState = getPackageFile(widgetData, null);
      return targetState.ok ? String(targetState.file.content || "") : "";
    }
    return getHtmlSourceState(widgetData).source;
  }

  async function persistWidgetEdit(
    widgetId,
    widgetData,
    source,
    sourceFormat,
    persist
  ) {
    if (persist === "runtime") return { ok: true };
    if (persist === "silent") {
      return { ok: false, error: "ERR_SILENT_PERSIST_DISABLED" };
    }
    if (persist !== "ask") return { ok: true };
    if (!widgetData?.savedId) {
      return {
        ok: false,
        error: "ERR_SAVE_PACKAGE_FAILED",
        message: "未收藏卡片无法执行 persist: ask",
      };
    }
    if (!desktopApi?.desktopSaveWidget) {
      return {
        ok: false,
        error: "ERR_SAVE_PACKAGE_FAILED",
        message: "desktopSaveWidget API 不可用",
      };
    }

    const isNative =
      sourceFormat === "desktopBuiltin" ||
      widgetData.cardType === "nativeFileMount";
    const layout = getWidgetLayout(widgetData);
    const name = widgetData.savedName || widgetId;
    const isHtmlPackage = sourceFormat === "htmlPackage";
    const packageJson = isNative
      ? {
          schemaVersion: 2,
          id: widgetData.savedId,
          name,
          type: "nativeFileMount",
          sourceFormat: "desktopBuiltin",
          entry: "source.desktopbuiltin",
          updatedAt: Date.now(),
          layout,
          frame: clonePlain(widgetData.frameOptions || layout.frame || {}),
          runtimeExcluded: ["mountId", "capabilityToken"],
        }
      : isHtmlPackage
      ? buildPackageManifest(widgetData, widgetId, name, layout)
      : {
          schemaVersion: 2,
          id: widgetData.savedId,
          name,
          type: "htmlWidget",
          sourceFormat: "inlineHtml",
          entry: "widget.html",
          updatedAt: Date.now(),
          layout,
          frame: clonePlain(widgetData.frameOptions || layout.frame || {}),
        };

    const result = await desktopApi.desktopSaveWidget({
      id: widgetData.savedId,
      name,
      html: isNative
        ? widgetData.contentBuffer || ""
        : isHtmlPackage
        ? widgetData.cardSource || widgetData.contentBuffer || ""
        : source,
      thumbnail: "",
      package: packageJson,
      sourceFormat: packageJson.sourceFormat,
      source: isNative ? source : undefined,
      files: isHtmlPackage ? listPackageFiles(widgetData, true) : undefined,
    });
    if (!result?.success) {
      return {
        ok: false,
        error: "ERR_SAVE_PACKAGE_FAILED",
        message: result?.error || "保存收藏失败",
      };
    }
    return {
      ok: true,
      savedId: widgetData.savedId,
      savedName: name,
      packageVersion: 2,
    };
  }

  async function reloadNativeFileMount(widgetId, widgetData, source) {
    const parser = window.VCPDesktop.builtinNativeFileMount?.parseSource;
    const spawner = window.VCPDesktop.builtinNativeFileMount?.spawn;
    if (!parser || !spawner) {
      return { ok: false, error: "ERR_UNSUPPORTED_WIDGET_TYPE" };
    }
    let parsed;
    try {
      parsed = parser(source);
    } catch (error) {
      return {
        ok: false,
        error: "ERR_SOURCE_PARSE_FAILED",
        message: error.message,
      };
    }
    if (parsed.widgetId && parsed.widgetId !== widgetId) {
      return { ok: false, error: "ERR_WIDGET_ID_MISMATCH" };
    }

    const oldSource = getCurrentEditSource(
      widgetId,
      widgetData,
      "desktopBuiltin"
    );
    const savedId = widgetData.savedId || null;
    const savedName = widgetData.savedName || null;
    const oldSourceVersion = readNumber(widgetData.sourceVersion, 1);
    const oldWidgetVersion = readNumber(widgetData.widgetVersion, 1);
    const layout = getWidgetLayout(widgetData);
    const options = {
      ...(parsed.options || {}),
      x: layout.x ?? parsed.options?.x,
      y: layout.y ?? parsed.options?.y,
      width: layout.width ?? parsed.options?.width,
      height: layout.height ?? parsed.options?.height,
      frame: parsed.options?.frame || layout.frame || {},
    };

    const removed = widget.removeForReload
      ? await widget.removeForReload(widgetId)
      : false;
    if (!removed && state.widgets.has(widgetId)) {
      return {
        ok: false,
        error: "ERR_RELOAD_FAILED",
        message: "旧卡片运行态未能安全移除",
      };
    }

    try {
      const result = await spawner({
        widgetId,
        title: parsed.title || "本机文件夹",
        config: parsed.config || {},
        options,
        customUI: parsed.customUI || null,
        source,
      });
      const nextData = state.widgets.get(result?.widgetId || widgetId);
      if (!nextData) throw new Error("spawn returned no widgetData");
      nextData.savedId = savedId;
      nextData.savedName = savedName;
      nextData.sourceVersion = oldSourceVersion + 1;
      nextData.widgetVersion = oldWidgetVersion + 1;
      return {
        ok: true,
        widgetId,
        detail: buildWidgetDetail(widgetId, nextData, "summary"),
      };
    } catch (error) {
      if (oldSource) {
        try {
          const oldParsed = parser(oldSource);
          await spawner({
            widgetId,
            title: oldParsed.title || savedName || "本机文件夹",
            config: oldParsed.config || {},
            options,
            customUI: oldParsed.customUI || null,
            source: oldSource,
          });
          const restoredData = state.widgets.get(widgetId);
          if (restoredData) {
            restoredData.savedId = savedId;
            restoredData.savedName = savedName;
            restoredData.sourceVersion = oldSourceVersion;
            restoredData.widgetVersion = oldWidgetVersion;
          }
        } catch (rollbackError) {
          console.warn(
            "[Desktop IPC] NativeFileMount rollback failed:",
            rollbackError
          );
        }
      }
      return { ok: false, error: "ERR_RELOAD_FAILED", message: error.message };
    }
  }

  async function applyDesktopWidgetEdit(payload = {}) {
    const widgetId = payload.widgetId || payload.id;
    if (!widgetId) return { ok: false, error: "ERR_WIDGET_NOT_FOUND" };
    if (editingWidgetIds.has(widgetId)) {
      return {
        ok: false,
        error: "ERR_WIDGET_VERSION_CONFLICT",
        widgetId,
        message: "该卡片正在编辑或重载",
      };
    }

    editingWidgetIds.add(widgetId);
    try {
      const mode = payload.mode || "targetReplace";
      const sourceFormat = payload.sourceFormat || "inlineHtml";
      const persist = normalizePersist(payload.persist);
      if (persist === "silent") {
        return { ok: false, error: "ERR_SILENT_PERSIST_DISABLED" };
      }
      const widgetData = state.widgets.get(widgetId);
      if (!widgetData)
        return { ok: false, error: "ERR_WIDGET_NOT_FOUND", widgetId };

      const currentVersion = readNumber(widgetData.sourceVersion, 1);
      if (
        payload.baseSourceVersion != null &&
        Number(payload.baseSourceVersion) !== currentVersion
      ) {
        return {
          ok: false,
          error: "ERR_SOURCE_VERSION_CONFLICT",
          widgetId,
          currentSourceVersion: currentVersion,
          baseSourceVersion: Number(payload.baseSourceVersion),
        };
      }

      const targetFile = payload.targetFile || payload.file || null;
      const targetState =
        sourceFormat === "htmlPackage"
          ? getPackageFile(widgetData, targetFile)
          : { ok: true };
      if (!targetState.ok) return { ...targetState, widgetId };
      const currentSource =
        sourceFormat === "htmlPackage"
          ? String(targetState.file.content || "")
          : getCurrentEditSource(widgetId, widgetData, sourceFormat);
      let nextSource;
      if (mode === "replace") {
        nextSource = String(payload.source || "");
      } else if (mode === "targetReplace") {
        const replacements = Array.isArray(payload.replacements)
          ? payload.replacements
          : [{ target: payload.target, replace: payload.replace }];
        const replaced = applyTargetReplacements(currentSource, replacements);
        if (!replaced.ok) return { ...replaced, widgetId };
        nextSource = replaced.source;
      } else {
        return { ok: false, error: "ERR_INVALID_EDIT_MODE", widgetId };
      }

      const latestData = state.widgets.get(widgetId);
      const latestVersion = readNumber(latestData?.sourceVersion, 1);
      if (
        payload.baseSourceVersion != null &&
        Number(payload.baseSourceVersion) !== latestVersion
      ) {
        return {
          ok: false,
          error: "ERR_SOURCE_VERSION_CONFLICT",
          widgetId,
          currentSourceVersion: latestVersion,
          baseSourceVersion: Number(payload.baseSourceVersion),
        };
      }

      const isNative =
        latestData.cardType === "nativeFileMount" ||
        sourceFormat === "desktopBuiltin";
      let editResult;
      if (isNative) {
        editResult = await reloadNativeFileMount(
          widgetId,
          latestData,
          nextSource
        );
      } else if (sourceFormat === "htmlPackage") {
        const packageResult = applyHtmlPackageSource(
          widgetId,
          latestData,
          targetFile,
          nextSource
        );
        if (!packageResult.ok) return { ...packageResult, widgetId };
        editResult = {
          ok: true,
          widgetId,
          targetFile: packageResult.targetFile,
          detail: buildWidgetDetail(
            widgetId,
            state.widgets.get(widgetId),
            "summary"
          ),
        };
      } else if (
        widget.setSource(widgetId, nextSource, {
          sourceFormat: "inlineHtml",
          sourceOrigin: "stored",
          sourceCompleteness: "partial",
        })
      ) {
        editResult = {
          ok: true,
          widgetId,
          detail: buildWidgetDetail(
            widgetId,
            state.widgets.get(widgetId),
            "summary"
          ),
        };
      } else {
        editResult = { ok: false, error: "ERR_RELOAD_FAILED", widgetId };
      }
      if (!editResult.ok) return editResult;

      const nextData = state.widgets.get(widgetId);
      const persistResult = await persistWidgetEdit(
        widgetId,
        nextData,
        nextSource,
        sourceFormat,
        persist
      );
      if (!persistResult.ok) return { ...persistResult, widgetId };
      return {
        ok: true,
        widgetId,
        detail: buildWidgetDetail(
          widgetId,
          state.widgets.get(widgetId),
          "summary"
        ),
        versions: buildVersions(state.widgets.get(widgetId)),
        persist: persistResult.savedId
          ? persistResult
          : { ok: true, mode: persist },
      };
    } finally {
      editingWidgetIds.delete(widgetId);
    }
  }

  async function handleDesktopRemoteRpcRequest(request) {
    const requestId = request?.requestId;
    const command = request?.command;
    const payload = request?.payload || {};

    if (!requestId || !command) {
      return;
    }

    try {
      switch (command) {
        case "QueryDesktop": {
          const widgetsList = [];
          const widgetsDir = "AppData/DesktopWidgets";

          for (const [widgetId, widgetData] of state.widgets) {
            const info = buildWidgetSummary(widgetId, widgetData);
            if (info.savedId) {
              info.savedDir = `${widgetsDir}/${info.savedId}`;
            }
            widgetsList.push(info);
          }

          const iconNames = [];
          const canvas = document.getElementById("desktop-canvas");
          if (canvas) {
            const iconElements = canvas.querySelectorAll(
              ".desktop-shortcut-icon"
            );
            iconElements.forEach((iconEl) => {
              const label = iconEl.querySelector(
                ".desktop-shortcut-icon-label"
              );
              if (label) {
                iconNames.push(label.textContent || "Unnamed");
              }
            });
          }

          sendDesktopRemoteRpcResponse(requestId, {
            ok: true,
            data: {
              widgets: widgetsList,
              icons: iconNames,
              desktopVersion: readNumber(state.desktopVersion, 1),
            },
          });
          return;
        }

        case "QueryDock": {
          const dockItems = [];
          if (state.dock?.items) {
            for (const item of state.dock.items) {
              const info = {
                name: item.name,
                type: item.type || "shortcut",
                visible: item.visible !== false,
              };
              if (item.type === "vchat-app") {
                info.appAction = item.appAction || "";
              } else if (item.type === "builtin") {
                info.builtinId = item.builtinId || "";
              } else {
                info.targetPath = item.targetPath || "";
              }
              dockItems.push(info);
            }
          }

          const vchatApps = [];
          if (window.VCPDesktop.vchatApps?.VCHAT_APPS) {
            for (const app of window.VCPDesktop.vchatApps.VCHAT_APPS) {
              vchatApps.push({
                name: app.name,
                emoji: app.emoji || "",
                appAction: app.appAction,
              });
            }
          }

          const systemTools = [];
          if (window.VCPDesktop.vchatApps?.SYSTEM_TOOLS) {
            for (const tool of window.VCPDesktop.vchatApps.SYSTEM_TOOLS) {
              systemTools.push({
                name: tool.name,
                emoji: tool.emoji || "",
                appAction: tool.appAction,
              });
            }
          }

          sendDesktopRemoteRpcResponse(requestId, {
            ok: true,
            data: {
              dockItems,
              vchatApps,
              systemTools,
              builtinWidgets: [
                { name: "Weather Widget", builtinId: "builtinWeather" },
                { name: "Music Widget", builtinId: "builtinMusic" },
                { name: "App Tray", builtinId: "builtinAppTray" },
              ],
            },
          });
          return;
        }

        case "QueryWidget": {
          const widgetId = payload.widgetId || payload.id;
          const level = ["summary", "editable", "source"].includes(
            payload.level
          )
            ? payload.level
            : "summary";
          const widgetData = state.widgets.get(widgetId);
          if (!widgetData) {
            sendDesktopRemoteRpcResponse(requestId, {
              ok: false,
              error: "ERR_WIDGET_NOT_FOUND",
              data: { widgetId },
            });
            return;
          }

          sendDesktopRemoteRpcResponse(requestId, {
            ok: true,
            data: buildWidgetDetail(widgetId, widgetData, level),
          });
          return;
        }

        case "ViewWidgetSource": {
          const widgetId = payload.widgetId;
          const widgetData = state.widgets.get(widgetId);
          if (!widgetData) {
            sendDesktopRemoteRpcResponse(requestId, {
              ok: false,
              error: `Widget "${widgetId}" does not exist on the current desktop.`,
            });
            return;
          }

          sendDesktopRemoteRpcResponse(requestId, {
            ok: true,
            data: {
              widgetId,
              ...buildWidgetDetail(widgetId, widgetData, "source"),
              html:
                widgetData.contentBuffer ||
                widgetData.contentContainer?.innerHTML ||
                "",
            },
          });
          return;
        }

        case "CreateWidget": {
          const {
            widgetId,
            htmlContent,
            options = {},
            autoSave,
            saveName,
            preSavedId,
            builtinWidgetKey,
            metricComponent,
          } = payload;

          const builtinKey = builtinWidgetKey || metricComponent;
          if (builtinKey && window.VCPDesktop.metricWidgets?.spawn) {
            const spawnResult = window.VCPDesktop.metricWidgets.spawn(
              builtinKey,
              {
                ...options,
                widgetId,
              }
            );
            const createdWidgetId = spawnResult?.widgetId || widgetId;
            const builtinWidgetData = state.widgets.get(createdWidgetId);
            const savedResult =
              autoSave && saveName && builtinWidgetData
                ? await _autoSaveWidget(
                    createdWidgetId,
                    saveName,
                    builtinWidgetData
                  ).catch(() => null)
                : null;

            sendDesktopRemoteRpcResponse(requestId, {
              ok: true,
              data: {
                widgetId: createdWidgetId,
                savedId: savedResult?.id || null,
                savedName: savedResult?.name || null,
                builtinWidgetKey: builtinKey,
              },
            });
            return;
          }

          if (!widgetId || !htmlContent) {
            throw new Error("CreateWidget requires widgetId and htmlContent.");
          }

          const widgetData = widget.create(widgetId, {
            x: options.x || 100,
            y: options.y || 100,
            width: options.width || 320,
            height: options.height || 200,
          });
          if (!widgetData) {
            throw new Error(
              `Widget "${widgetId}" is being removed. Try again shortly.`
            );
          }

          if (preSavedId) {
            widgetData.savedId = preSavedId;
            widgetData.savedName = saveName || "AI Widget";
          }

          widget.appendContent(widgetId, htmlContent);
          widget.finalize(widgetId);

          if (preSavedId) {
            _captureAndUpdateThumbnail(preSavedId, widgetData).catch(() => {});
            if (window.VCPDesktop?.sidebar?.refresh) {
              window.VCPDesktop.sidebar.refresh();
            } else if (window.VCPDesktop?.favorites?.loadList) {
              window.VCPDesktop.favorites.loadList();
            }
          }

          const savedResult =
            !preSavedId && autoSave && saveName
              ? await _autoSaveWidget(widgetId, saveName, widgetData).catch(
                  () => null
                )
              : null;

          sendDesktopRemoteRpcResponse(requestId, {
            ok: true,
            data: {
              widgetId,
              savedId: preSavedId || savedResult?.id || null,
              savedName: (preSavedId ? saveName : savedResult?.name) || null,
            },
          });
          return;
        }

        case "EditWidget":
        case "DESKTOP_WIDGET_EDIT": {
          const result = await applyDesktopWidgetEdit(payload);
          if (result.ok === false) {
            const { ok, error, message, ...data } = result;
            sendDesktopRemoteRpcResponse(requestId, {
              ok: false,
              error,
              data: { ...data, message },
            });
          } else {
            const { ok, ...data } = result;
            sendDesktopRemoteRpcResponse(requestId, {
              ok: true,
              data,
            });
          }
          return;
        }

        case "SetStyleAutomation": {
          if (!window.VCPDesktop?.styleAutomation) {
            throw new Error("styleAutomation module is unavailable.");
          }
          const statusResult =
            await window.VCPDesktop.styleAutomation.setConfigPatch(
              payload.configPatch,
              {
                persist: !!payload.persist,
              }
            );
          sendDesktopRemoteRpcResponse(requestId, {
            ok: true,
            data: {
              action: "set",
              status: statusResult,
            },
          });
          return;
        }

        case "NativeFileMountAction": {
          const targetWidgetId = payload.widgetId;
          const instance =
            window.VCPDesktop.builtinNativeFileMount?.getInstance(
              targetWidgetId
            );
          if (!instance) {
            throw new Error(
              `NativeFileMount widget not found: ${targetWidgetId}`
            );
          }
          const result = await instance.handleAgentAction(payload);
          sendDesktopRemoteRpcResponse(requestId, result);
          return;
        }

        case "QueryNativeFileMounts": {
          sendDesktopRemoteRpcResponse(requestId, {
            ok: true,
            data: window.VCPDesktop.builtinNativeFileMount?.list?.() || [],
          });
          return;
        }

        case "GetStyleAutomationStatus": {
          if (!window.VCPDesktop?.styleAutomation) {
            throw new Error("styleAutomation module is unavailable.");
          }
          sendDesktopRemoteRpcResponse(requestId, {
            ok: true,
            data: {
              action: "status",
              status: window.VCPDesktop.styleAutomation.getStatus(),
            },
          });
          return;
        }

        default:
          sendDesktopRemoteRpcResponse(requestId, {
            ok: false,
            error: `Unknown desktop remote command: ${command}`,
          });
      }
    } catch (err) {
      console.error("[Desktop IPC] RPC bridge error:", err);
      sendDesktopRemoteRpcResponse(requestId, {
        ok: false,
        error: err?.message || String(err),
      });
    }
  }

  function initIpcListeners() {
    if (desktopApi?.onDesktopPush) {
      desktopApi.onDesktopPush((data) => {
        const { action, widgetId, content, options } = data;

        switch (action) {
          case "create":
            widget.create(widgetId, options);
            status.update("streaming", `正在渲染挂件: ${widgetId}`);
            break;
          case "append":
            widget.appendContent(widgetId, content);
            break;
          case "finalize":
            widget.finalize(widgetId);
            status.update("connected", `挂件渲染完成: ${widgetId}`);
            break;
          case "replace":
            widget.replaceInWidgets(data.targetSelector, content);
            status.update("streaming", `替换内容: ${data.targetSelector}`);
            break;
          case "remove":
            widget.remove(widgetId);
            break;
          case "editWidget": {
            applyDesktopWidgetEdit(data.payload || {})
              .then((result) => {
                const ok = result?.ok !== false;
                const receiptWidgetId =
                  result?.widgetId ||
                  data.payload?.widgetId ||
                  data.payload?.id;
                const detail = result?.detail;
                const versions =
                  result?.versions ||
                  buildVersions(state.widgets.get(receiptWidgetId));
                const customUIStatus = detail?.customUI;
                const degraded =
                  ok &&
                  customUIStatus?.requested === true &&
                  customUIStatus?.fallbackToDefault === true;
                if (!ok) {
                  console.warn("[Desktop] Widget edit failed:", result);
                } else {
                  console.info("[Desktop] Widget edit applied:", result);
                }
                sendDesktopOperationResult(data.requestId, {
                  operation: "edit",
                  ok,
                  status: ok
                    ? result.status || (degraded ? "degraded" : "success")
                    : "failed",
                  widgetId: receiptWidgetId,
                  type: detail?.type,
                  sourceFormat: detail?.sourceFormat,
                  versions,
                  detail,
                  customUI: customUIStatus,
                  persist: result?.persist,
                  error: ok ? null : result?.error || "ERR_WIDGET_EDIT_FAILED",
                  message: ok
                    ? result?.message ||
                      (degraded
                        ? "卡片编辑已完成，但 customUI 已回退默认界面"
                        : "卡片编辑并重载成功")
                    : result?.message || result?.error || "卡片编辑失败",
                  rolledBack: result?.rolledBack,
                });
              })
              .catch((error) => {
                console.warn("[Desktop] Widget edit dispatch failed:", error);
                sendDesktopOperationResult(data.requestId, {
                  operation: "edit",
                  ok: false,
                  status: "failed",
                  widgetId: data.payload?.widgetId || data.payload?.id,
                  error: "ERR_WIDGET_EDIT_DISPATCH_FAILED",
                  message: error?.message || String(error),
                });
              });
            break;
          }
          case "createBuiltinWidget": {
            if (
              data.type === "nativeFileMount" &&
              window.VCPDesktop.builtinNativeFileMount?.spawn
            ) {
              window.VCPDesktop.builtinNativeFileMount
                .spawn({
                  title: data.title,
                  config: data.config || {},
                  widgetId: data.widgetId,
                  options: data.options || {},
                  customUI: data.customUI || null,
                  source: data.source || "",
                })
                .then((result) => {
                  const info = result?.instance?.getInfo?.();
                  const widgetId =
                    info?.widgetId || result?.widgetId || data.widgetId;
                  const widgetData = state.widgets.get(widgetId);
                  const customUIStatus = info?.customUI || {
                    requested: !!data.customUI,
                    mounted: false,
                    fallbackToDefault: false,
                    error: null,
                  };
                  const degraded =
                    customUIStatus.requested === true &&
                    customUIStatus.fallbackToDefault === true;
                  if (info?.mountId) {
                    console.info(
                      `[系统通知] NativeFileMount 卡片已创建：widgetId=${info.widgetId}, mountId=${info.mountId}, rootPath=${info.rootPath}, mode=${info.mode}`
                    );
                  }
                  sendDesktopOperationResult(data.requestId, {
                    operation: "create",
                    ok: true,
                    status: degraded ? "degraded" : "success",
                    widgetId,
                    type: "nativeFileMount",
                    sourceFormat: "desktopBuiltin",
                    title: info?.title || data.title || "本机文件夹",
                    versions: info?.versions || buildVersions(widgetData),
                    nativeFileMount: {
                      mountId: info?.mountId,
                      rootPath: info?.rootPath || info?.mountPath,
                      mode: info?.mode,
                      authorized: !!info?.mountId,
                    },
                    customUI: customUIStatus,
                    detail: info,
                    message: degraded
                      ? "NativeFileMount 卡片已创建，但 customUI 已回退默认界面"
                      : "NativeFileMount 卡片创建成功",
                  });
                })
                .catch((error) => {
                  console.warn(
                    "[Desktop] nativeFileMount spawn failed:",
                    error
                  );
                  sendDesktopOperationResult(data.requestId, {
                    operation: "create",
                    ok: false,
                    status: "failed",
                    widgetId: data.widgetId,
                    type: data.type,
                    sourceFormat: "desktopBuiltin",
                    error: "ERR_CREATE_BUILTIN_WIDGET_FAILED",
                    message: error?.message || String(error),
                  });
                });
            } else {
              const error = `Unknown builtin widget type: ${data.type}`;
              console.warn(`[Desktop] ${error}`);
              sendDesktopOperationResult(data.requestId, {
                operation: "create",
                ok: false,
                status: "failed",
                widgetId: data.widgetId,
                type: data.type,
                error: "ERR_UNSUPPORTED_BUILTIN_WIDGET_TYPE",
                message: error,
              });
            }
            break;
          }
          default:
            console.warn(`[Desktop] Unknown action: ${action}`);
        }
      });
    }

    if (desktopApi?.onDesktopStatus) {
      desktopApi.onDesktopStatus((data) => {
        state.isConnected = data.connected;
        status.update(
          data.connected ? "connected" : "waiting",
          data.message || (data.connected ? "已连接" : "等待连接...")
        );
      });
    }

    if (desktopApi?.onDesktopRemoteRequest) {
      desktopApi.onDesktopRemoteRequest((request) => {
        handleDesktopRemoteRpcRequest(request);
      });
    }

    if (desktopApi?.onDesktopRemoteSetWallpaper) {
      desktopApi.onDesktopRemoteSetWallpaper((wallpaperConfig) => {
        console.log(
          "[Desktop IPC] Received remote wallpaper push:",
          wallpaperConfig.type
        );
        try {
          if (state.globalSettings) {
            state.globalSettings.wallpaper = {
              ...state.globalSettings.wallpaper,
              ...wallpaperConfig,
            };
          }

          if (window.VCPDesktop.wallpaper) {
            window.VCPDesktop.wallpaper.apply(wallpaperConfig);
          }

          if (window.VCPDesktop.globalSettings?.save) {
            window.VCPDesktop.globalSettings.save();
          }

          status.update(
            "connected",
            `AI 推送了新壁纸（${wallpaperConfig.type}）`
          );
          status.show();
          setTimeout(() => status.hide(), 3000);
        } catch (err) {
          console.error("[Desktop IPC] Failed to apply remote wallpaper:", err);
          status.update("waiting", "壁纸应用失败");
          status.show();
          setTimeout(() => status.hide(), 3000);
        }
      });
    }
  }

  async function _autoSaveWidget(widgetId, saveName, widgetData) {
    try {
      const savedId = `saved-${Date.now()}-${Math.random()
        .toString(36)
        .substring(2, 8)}`;
      const htmlContent =
        widgetData.contentBuffer ||
        widgetData.contentContainer?.innerHTML ||
        "";

      if (!htmlContent || !desktopApi?.desktopSaveWidget) {
        return null;
      }

      let thumbnail = "";
      try {
        const rect = widgetData.element.getBoundingClientRect();
        if (desktopApi.desktopCaptureWidget) {
          const captureResult = await desktopApi.desktopCaptureWidget({
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          });
          if (captureResult?.success) {
            thumbnail = captureResult.thumbnail;
          }
        }
      } catch (error) {
        console.warn("[Desktop IPC] Thumbnail capture failed:", error.message);
      }

      const result = await desktopApi.desktopSaveWidget({
        id: savedId,
        name: saveName,
        html: htmlContent,
        thumbnail,
      });

      if (result?.success) {
        widgetData.savedName = saveName;
        widgetData.savedId = savedId;
        if (window.VCPDesktop?.sidebar?.refresh) {
          window.VCPDesktop.sidebar.refresh();
        } else if (window.VCPDesktop?.favorites?.loadList) {
          window.VCPDesktop.favorites.loadList();
        }
        return { id: savedId, name: saveName };
      }

      return null;
    } catch (err) {
      console.error("[Desktop IPC] Auto-save error:", err);
      return null;
    }
  }

  async function _captureAndUpdateThumbnail(savedId, widgetData) {
    try {
      await new Promise((resolve) => setTimeout(resolve, 1000));

      if (!desktopApi?.desktopCaptureWidget || !desktopApi?.desktopSaveWidget) {
        return;
      }

      const rect = widgetData.element.getBoundingClientRect();
      const captureResult = await desktopApi.desktopCaptureWidget({
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });

      if (captureResult?.success && captureResult.thumbnail) {
        const htmlContent =
          widgetData.contentBuffer ||
          widgetData.contentContainer?.innerHTML ||
          "";
        await desktopApi.desktopSaveWidget({
          id: savedId,
          name: widgetData.savedName || "AI Widget",
          html: htmlContent,
          thumbnail: captureResult.thumbnail,
        });
      }
    } catch (error) {
      console.warn(
        "[Desktop IPC] _captureAndUpdateThumbnail error:",
        error.message
      );
    }
  }

  window.VCPDesktop = window.VCPDesktop || {};
  window.VCPDesktop.ipc = {
    init: initIpcListeners,
  };
})();
