/**
 * VCPdesktop - 收藏系统管理模块
 * 负责：收藏保存/加载/删除/恢复、IPC 持久化调用
 */

"use strict";

(function () {
  const desktopApi = window.desktopAPI || window.electronAPI;
  const { state, status, widget, sidebar, thumbnail } = window.VCPDesktop;

  function clonePlain(value) {
    if (value == null) return value;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (error) {
      return value;
    }
  }

  function getWidgetLayout(widgetData) {
    const element = widgetData?.element;
    return {
      x: parseInt(element?.style?.left, 10) || 0,
      y: parseInt(element?.style?.top, 10) || 0,
      width: parseInt(element?.style?.width, 10) || 0,
      height: parseInt(element?.style?.height, 10) || 0,
      zIndex: parseInt(element?.style?.zIndex || widgetData?.zIndex, 10) || 1,
      fixedSize: !!widgetData?.fixedSize,
    };
  }

  function getPackageMainFile(widgetData) {
    return String(
      widgetData.cardPackage?.mainFile ||
        widgetData.cardPackage?.entry ||
        "widget.html"
    )
      .replace(/\\/g, "/")
      .replace(/^\.\//, "");
  }

  function ensureHtmlPackageFiles(widgetData) {
    const mainFile = getPackageMainFile(widgetData);
    if (!(widgetData.cardFiles instanceof Map)) {
      widgetData.cardFiles = new Map();
    }
    if (!widgetData.cardFiles.has(mainFile)) {
      const html =
        widgetData.cardSource ||
        widgetData.contentBuffer ||
        widgetData.contentContainer?.innerHTML ||
        "";
      widgetData.cardFiles.set(mainFile, {
        name: mainFile,
        role: "entry",
        encoding: "utf-8",
        editable: true,
        content: html,
      });
    }
    widgetData.cardPackage = {
      ...(clonePlain(widgetData.cardPackage || {}) || {}),
      schemaVersion: 2,
      type: "htmlWidget",
      sourceFormat: "htmlPackage",
      mainFile,
      entry: mainFile,
      files: listPackageFiles(widgetData, false),
    };
    widgetData.cardType = "htmlWidget";
    widgetData.sourceFormat = "htmlPackage";
    widgetData.sourceOrigin = "stored";
    widgetData.sourceCompleteness = "full";
    return mainFile;
  }

  function listPackageFiles(widgetData, includeContent = false) {
    const files = [];
    if (!(widgetData.cardFiles instanceof Map)) return files;
    const mainFile = getPackageMainFile(widgetData);
    for (const [name, file] of widgetData.cardFiles.entries()) {
      const encoding = file?.encoding || "utf-8";
      files.push({
        name,
        role: file?.role || (name === mainFile ? "entry" : "asset"),
        encoding,
        editable: file?.editable !== false && encoding !== "base64",
        ...(includeContent ? { content: file?.content || "" } : {}),
      });
    }
    return files;
  }

  function buildFavoritePackage(widgetData, saveId, name) {
    const isNative =
      widgetData.cardType === "nativeFileMount" ||
      widgetData.sourceFormat === "desktopBuiltin";
    const layout = getWidgetLayout(widgetData);
    const frame = clonePlain(widgetData.frameOptions || {});
    if (isNative) {
      return {
        schemaVersion: 2,
        id: saveId,
        name,
        type: "nativeFileMount",
        sourceFormat: "desktopBuiltin",
        entry: "source.desktopbuiltin",
        updatedAt: Date.now(),
        layout,
        frame,
        runtimeExcluded: ["mountId", "capabilityToken"],
      };
    }
    const mainFile = ensureHtmlPackageFiles(widgetData);
    return {
      schemaVersion: 2,
      id: saveId,
      name,
      type: "htmlWidget",
      sourceFormat: "htmlPackage",
      mainFile,
      entry: mainFile,
      files: listPackageFiles(widgetData, false),
      updatedAt: Date.now(),
      layout,
      frame,
    };
  }

  function getNativeSource(widgetData, widgetId) {
    const api = window.VCPDesktop.builtinNativeFileMount;
    const info = api?.getInstance?.(widgetId)?.getInfo?.("source");
    return (
      info?.source || widgetData.builtinSource || widgetData.cardSource || ""
    );
  }

  function resolveSpawnLayout(result, x, y) {
    const layout = result?.package?.layout || {};
    return {
      x: x != null ? x : layout.x,
      y: y != null ? y : layout.y,
      width: layout.width,
      height: layout.height,
      frame: result?.package?.frame || layout.frame || {},
    };
  }

  async function spawnNativeFavorite(result, favoriteId, x, y) {
    const api = window.VCPDesktop.builtinNativeFileMount;
    if (!api?.parseSource || !api?.spawn) {
      throw new Error("NativeFileMount API not available");
    }
    const parsed = api.parseSource(result.source || "");
    const widgetId = `fav-${favoriteId}-${Date.now()}`;
    const layout = resolveSpawnLayout(result, x, y);
    const source = api.generateSource
      ? api.generateSource(parsed.config || {}, parsed.customUI || null, {
          ...(parsed.options || {}),
          ...layout,
          widgetId,
          title: parsed.title || result.name || "本机文件夹",
          frame: layout.frame || parsed.options?.frame || {},
        })
      : result.source;
    const spawned = await api.spawn({
      widgetId,
      title: parsed.title || result.name || "本机文件夹",
      config: parsed.config || {},
      options: {
        ...(parsed.options || {}),
        ...layout,
        frame: layout.frame || parsed.options?.frame || {},
      },
      customUI: parsed.customUI || null,
      source,
    });
    const nextData = state.widgets.get(spawned?.widgetId || widgetId);
    if (!nextData)
      throw new Error("NativeFileMount spawn returned no widgetData");
    nextData.savedId = favoriteId;
    nextData.savedName = result.name || favoriteId;
    nextData.sourceOrigin = "stored";
    nextData.sourceCompleteness = "full";
    status.update("connected", `已加载: ${result.name || favoriteId}`);
    return nextData;
  }

  function applyHtmlFavoriteData(widgetData, result, favoriteId) {
    const html = String(result.html || "");
    widgetData.savedId = favoriteId;
    widgetData.savedName = result.name || favoriteId;
    widgetData.cardType = "htmlWidget";
    widgetData.sourceFormat =
      result.sourceFormat === "htmlPackage" ? "htmlPackage" : "inlineHtml";
    widgetData.sourceOrigin = result.schemaVersion >= 2 ? "stored" : "snapshot";
    widgetData.sourceCompleteness =
      result.sourceFormat === "htmlPackage" ? "full" : "partial";
    widgetData.cardPackage = result.package || null;
    widgetData.cardFiles = new Map();
    if (result.sourceFormat === "htmlPackage" && Array.isArray(result.files)) {
      for (const file of result.files) {
        if (!file?.name) continue;
        widgetData.cardFiles.set(file.name, {
          name: file.name,
          role: file.role,
          encoding: file.encoding || "utf-8",
          editable:
            file.editable !== false && (file.encoding || "utf-8") !== "base64",
          content: file.content || "",
        });
      }
    }
    if (
      widgetData.sourceFormat === "htmlPackage" &&
      !widgetData.cardFiles.has(
        widgetData.cardPackage?.mainFile || "widget.html"
      )
    ) {
      const mainFile =
        widgetData.cardPackage?.mainFile ||
        widgetData.cardPackage?.entry ||
        "widget.html";
      widgetData.cardFiles.set(mainFile, {
        name: mainFile,
        role: "entry",
        encoding: "utf-8",
        editable: true,
        content: html,
      });
    }
    widgetData.cardSource = html;
    widgetData.contentBuffer = html;
    widgetData.contentContainer.innerHTML = html;
    widget.processInlineStyles(widgetData);
    widgetData.isConstructing = false;
    widgetData.element.classList.remove("constructing");
    widget.autoResize(widgetData);
    setTimeout(() => {
      widget.processInlineScripts(widgetData);
    }, 100);
  }

  // ============================================================
  // 执行收藏
  // ============================================================

  /**
   * 执行收藏操作：截图 + 保存HTML + IPC持久化
   * @param {string} widgetId
   * @param {string} name - 收藏名称
   */
  async function performSave(widgetId, name) {
    const widgetData = state.widgets.get(widgetId);
    if (!widgetData) {
      console.error(
        "[Desktop] performSave: widgetData not found for",
        widgetId
      );
      return;
    }

    const saveId =
      widgetData.savedId ||
      `fav_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const htmlContent =
      widgetData.contentBuffer || widgetData.contentContainer.innerHTML || "";
    const packageManifest = buildFavoritePackage(widgetData, saveId, name);
    const nativeSource =
      packageManifest.sourceFormat === "desktopBuiltin"
        ? getNativeSource(widgetData, widgetId)
        : undefined;
    const packageFiles =
      packageManifest.sourceFormat === "htmlPackage"
        ? listPackageFiles(widgetData, true)
        : undefined;
    console.log(
      `[Desktop] performSave: id=${saveId}, name=${name}, htmlLen=${htmlContent.length}, sourceFormat=${packageManifest.sourceFormat}`
    );

    let thumbnailDataUrl = "";
    try {
      thumbnailDataUrl = await thumbnail.capture(widgetData);
      console.log(
        `[Desktop] Thumbnail captured: ${thumbnailDataUrl.length} chars`
      );
    } catch (err) {
      console.warn("[Desktop] Failed to capture thumbnail:", err);
    }

    if (desktopApi?.desktopSaveWidget) {
      try {
        console.log("[Desktop] Calling desktopSaveWidget IPC...");
        const result = await desktopApi.desktopSaveWidget({
          id: saveId,
          name,
          html: htmlContent,
          thumbnail: thumbnailDataUrl,
          package: packageManifest,
          sourceFormat: packageManifest.sourceFormat,
          source: nativeSource,
          files: packageFiles,
        });
        console.log("[Desktop] desktopSaveWidget result:", result);
        if (result?.success) {
          widgetData.savedName = name;
          widgetData.savedId = saveId;
          widgetData.widgetVersion =
            (Number(widgetData.widgetVersion) || 0) + 1;
          if (state)
            state.desktopVersion = (Number(state.desktopVersion) || 0) + 1;
          status.update("connected", `已收藏: ${name}`);
          await loadFavoritesList();
          console.log(
            "[Desktop] Favorites refreshed after save, count:",
            state.favorites.length
          );
        } else {
          status.update("waiting", `收藏失败: ${result?.error || "未知错误"}`);
        }
      } catch (err) {
        console.error("[Desktop] Save widget error:", err);
        status.update("waiting", "收藏失败");
      }
    } else {
      console.warn("[Desktop] desktopSaveWidget API not available");
      status.update("waiting", "收藏API不可用");
    }
  }

  // ============================================================
  // 加载收藏列表
  // ============================================================

  /**
   * 从主进程加载收藏列表
   */
  async function loadFavoritesList() {
    if (!desktopApi?.desktopListWidgets) {
      console.log(
        "[Desktop] desktopListWidgets API not available yet, skipping."
      );
      return;
    }
    try {
      const result = await desktopApi.desktopListWidgets();
      if (result?.success) {
        state.favorites = result.widgets || [];
        sidebar.render();
      }
    } catch (err) {
      console.warn(
        "[Desktop] Load favorites unavailable (restart main process?):",
        err.message
      );
    }
  }

  // ============================================================
  // 从收藏恢复到桌面
  // ============================================================

  /**
   * 从收藏中恢复一个 widget 到桌面
   * @param {string} favoriteId - 收藏 ID
   * @param {number} [x] - 放置 X 坐标
   * @param {number} [y] - 放置 Y 坐标
   */
  async function spawnFromFavorite(favoriteId, x, y) {
    if (!desktopApi?.desktopLoadWidget) return;
    try {
      const result = await desktopApi.desktopLoadWidget(favoriteId);
      if (!result?.success) {
        status.update("waiting", `加载失败: ${result?.error || "未知错误"}`);
        return;
      }

      if (result.sourceFormat === "desktopBuiltin" && result.source) {
        await spawnNativeFavorite(result, favoriteId, x, y);
        return;
      }

      if (result.html) {
        const layout = resolveSpawnLayout(result, x, y);
        const widgetId = `fav-${favoriteId}-${Date.now()}`;
        const widgetData = widget.create(widgetId, {
          x: layout.x != null ? layout.x : 150 + Math.random() * 200,
          y: layout.y != null ? layout.y : 100 + Math.random() * 200,
          width: layout.width,
          height: layout.height,
          frame: layout.frame,
        });
        if (!widgetData) {
          throw new Error(
            `Widget "${widgetId}" is being removed. Try again shortly.`
          );
        }
        applyHtmlFavoriteData(widgetData, result, favoriteId);
        status.update("connected", `已加载: ${result.name || favoriteId}`);
      }
    } catch (err) {
      console.error("[Desktop] Spawn from favorite error:", err);
      status.update("waiting", "加载收藏失败");
    }
  }

  // ============================================================
  // 刷新挂件
  // ============================================================

  /**
   * 刷新挂件（从文件重新加载已收藏的内容）
   * @param {string} widgetId
   */
  async function refreshWidget(widgetId) {
    const widgetData = state.widgets.get(widgetId);
    if (!widgetData || !widgetData.savedId) {
      status.update("waiting", "该挂件未收藏，无法刷新");
      return;
    }

    if (!desktopApi?.desktopLoadWidget) return;
    try {
      const result = await desktopApi.desktopLoadWidget(widgetData.savedId);
      if (!result?.success) {
        status.update("waiting", `刷新失败: ${result?.error || "未知错误"}`);
        return;
      }
      if (result.sourceFormat === "desktopBuiltin") {
        const x = parseInt(widgetData.element?.style?.left, 10) || undefined;
        const y = parseInt(widgetData.element?.style?.top, 10) || undefined;
        const savedId = widgetData.savedId;
        if (widget.removeForReload) {
          await widget.removeForReload(widgetId);
        } else {
          widget.remove(widgetId);
        }
        await spawnNativeFavorite(result, savedId, x, y);
        status.update("connected", `已刷新: ${result.name || savedId}`);
        return;
      }
      if (result.html) {
        applyHtmlFavoriteData(widgetData, result, widgetData.savedId);
        status.update("connected", `已刷新: ${widgetData.savedName}`);
      }
    } catch (err) {
      console.error("[Desktop] Refresh widget error:", err);
      status.update("waiting", "刷新失败");
    }
  }

  // ============================================================
  // 删除收藏
  // ============================================================

  /**
   * 删除收藏
   * @param {string} favoriteId
   */
  async function deleteFavorite(favoriteId) {
    if (desktopApi?.desktopDeleteWidget) {
      try {
        const result = await desktopApi.desktopDeleteWidget(favoriteId);
        if (result?.success) {
          status.update("connected", "已删除收藏");
          loadFavoritesList();
        }
      } catch (err) {
        console.error("[Desktop] Delete favorite error:", err);
      }
    }
  }

  // ============================================================
  // 导出
  // ============================================================
  window.VCPDesktop = window.VCPDesktop || {};
  window.VCPDesktop.favorites = {
    performSave,
    loadList: loadFavoritesList,
    spawnFromFavorite,
    refresh: refreshWidget,
    deleteFavorite,
  };
})();
