"use strict";
(function () {
  const { state, CONSTANTS, widget } = window.VCPDesktop;
  const desktopApi = window.desktopAPI || window.electronAPI;

  // ========== 图标映射 ==========
  function getFileIcon(name, type) {
    if (type === "directory") return "📁";
    var ext =
      name.lastIndexOf(".") !== -1
        ? name.substring(name.lastIndexOf(".")).toLowerCase()
        : "";
    var map = {
      ".txt": "📄",
      ".md": "📝",
      ".log": "📋",
      ".js": "🟨",
      ".ts": "🔷",
      ".jsx": "⚛️",
      ".tsx": "⚛️",
      ".py": "🐍",
      ".java": "☕",
      ".c": "🔧",
      ".cpp": "🔧",
      ".cs": "🔷",
      ".go": "🔵",
      ".html": "🌐",
      ".css": "🎨",
      ".scss": "🎨",
      ".less": "🎨",
      ".json": "📋",
      ".xml": "📋",
      ".yaml": "📋",
      ".yml": "📋",
      ".toml": "📋",
      ".png": "🖼️",
      ".jpg": "🖼️",
      ".jpeg": "🖼️",
      ".gif": "🖼️",
      ".svg": "🖼️",
      ".webp": "🖼️",
      ".ico": "🖼️",
      ".bmp": "🖼️",
      ".mp3": "🎵",
      ".wav": "🎵",
      ".flac": "🎵",
      ".ogg": "🎵",
      ".aac": "🎵",
      ".mp4": "🎬",
      ".avi": "🎬",
      ".mkv": "🎬",
      ".mov": "🎬",
      ".wmv": "🎬",
      ".webm": "🎬",
      ".zip": "📦",
      ".rar": "📦",
      ".7z": "📦",
      ".tar": "📦",
      ".gz": "📦",
      ".pdf": "📕",
      ".doc": "📘",
      ".docx": "📘",
      ".xls": "📗",
      ".xlsx": "📗",
      ".ppt": "📙",
      ".pptx": "📙",
      ".exe": "⚙️",
      ".msi": "⚙️",
      ".bat": "⚙️",
      ".sh": "⚙️",
      ".ps1": "⚙️",
      ".gitignore": "🔒",
      ".env": "🔐",
    };
    return map[ext] || "📄";
  }

  function formatFileSize(bytes) {
    if (bytes === 0 || bytes == null) return "-";
    var units = ["B", "KB", "MB", "GB", "TB"];
    var i = 0;
    var b = bytes;
    while (b >= 1024 && i < units.length - 1) {
      b /= 1024;
      i++;
    }
    return b.toFixed(i === 0 ? 0 : 1) + " " + units[i];
  }

  function formatDate(timestamp) {
    if (!timestamp) return "-";
    var d = new Date(timestamp);
    var pad = function (n) {
      return n < 10 ? "0" + n : "" + n;
    };
    return (
      d.getFullYear() +
      "-" +
      pad(d.getMonth() + 1) +
      "-" +
      pad(d.getDate()) +
      " " +
      pad(d.getHours()) +
      ":" +
      pad(d.getMinutes())
    );
  }

  function escapeHtml(str) {
    if (!str) return "";
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ========== 构建 Widget HTML ==========
  function buildWidgetHtml(mountPath, mode) {
    var css = [
      "<style>",
      '.nfm-container { display:flex; flex-direction:column; height:100%; background:#1e1e2e; color:#cdd6f4; font-family:"Segoe UI",sans-serif; font-size:13px; overflow:hidden; user-select:none; }',
      ".nfm-toolbar { display:flex; align-items:center; gap:6px; padding:6px 10px; background:#181825; border-bottom:1px solid #313244; flex-shrink:0; }",
      ".nfm-toolbar button { background:#313244; border:none; color:#cdd6f4; padding:4px 8px; border-radius:4px; cursor:pointer; font-size:13px; line-height:1; }",
      ".nfm-toolbar button:hover { background:#45475a; }",
      ".nfm-toolbar button:disabled { opacity:0.4; cursor:default; }",
      ".nfm-path { flex:1; padding:3px 8px; background:#11111b; border:1px solid #313244; border-radius:4px; color:#a6adc8; font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }",
      ".nfm-file-header { display:grid; grid-template-columns:24px 1fr 90px 140px; gap:4px; padding:4px 12px; background:#181825; border-bottom:1px solid #313244; font-size:11px; color:#6c7086; flex-shrink:0; }",
      ".nfm-file-list-wrapper { flex:1; overflow-y:auto; overflow-x:hidden; }",
      ".nfm-file-list-wrapper::-webkit-scrollbar { width:6px; }",
      ".nfm-file-list-wrapper::-webkit-scrollbar-track { background:transparent; }",
      ".nfm-file-list-wrapper::-webkit-scrollbar-thumb { background:#45475a; border-radius:3px; }",
      ".nfm-file-row { display:grid; grid-template-columns:24px 1fr 90px 140px; gap:4px; padding:3px 12px; align-items:center; cursor:pointer; border-bottom:1px solid rgba(49,50,68,0.4); }",
      ".nfm-file-row:hover { background:#313244; }",
      ".nfm-file-row.selected { background:#45475a; }",
      ".nfm-file-row .nfm-icon { text-align:center; font-size:15px; line-height:1; }",
      ".nfm-file-row .nfm-name { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }",
      ".nfm-file-row .nfm-size { text-align:right; color:#a6adc8; font-size:12px; }",
      ".nfm-file-row .nfm-date { color:#a6adc8; font-size:12px; }",
      ".nfm-dir-name { color:#89b4fa; }",
      ".nfm-status-bar { display:flex; align-items:center; justify-content:space-between; padding:4px 12px; background:#181825; border-top:1px solid #313244; font-size:11px; color:#6c7086; flex-shrink:0; }",
      ".nfm-loading { display:flex; align-items:center; justify-content:center; height:100%; color:#6c7086; font-size:14px; }",
      ".nfm-empty { display:flex; align-items:center; justify-content:center; height:100%; color:#6c7086; font-size:13px; }",
      ".nfm-error { display:flex; align-items:center; justify-content:center; height:100%; color:#f38ba8; font-size:13px; padding:20px; text-align:center; }",
      ".nfm-ctx-menu { position:fixed; background:#1e1e2e; border:1px solid #45475a; border-radius:6px; padding:4px 0; min-width:160px; box-shadow:0 4px 12px rgba(0,0,0,0.5); z-index:99999; }",
      ".nfm-ctx-item { padding:6px 16px; cursor:pointer; font-size:13px; color:#cdd6f4; }",
      ".nfm-ctx-item:hover { background:#313244; }",
      ".nfm-ctx-sep { height:1px; background:#313244; margin:4px 0; }",
      "</style>",
    ].join("\n");

    var html = [
      '<div class="nfm-container">',
      '  <div class="nfm-toolbar">',
      '    <button class="nfm-btn-up" title="上级目录">⬆️</button>',
      '    <div class="nfm-path"></div>',
      '    <button class="nfm-btn-refresh" title="刷新">🔄</button>',
      "  </div>",
      '  <div class="nfm-file-header">',
      '    <span></span><span>名称</span><span style="text-align:right">大小</span><span>修改时间</span>',
      "  </div>",
      '  <div class="nfm-file-list-wrapper">',
      '    <div class="nfm-loading">⏳ 正在加载...</div>',
      "  </div>",
      '  <div class="nfm-status-bar">',
      '    <span class="nfm-status-text">就绪</span>',
      '    <span class="nfm-status-mode">' +
        (mode === "readwrite" ? "读写" : "只读") +
        "</span>",
      "  </div>",
      "</div>",
    ].join("\n");

    var inlineScript = [
      "<script>",
      "(function() {",
      "    var nfm = null;",
      "    var api = window.desktopAPI || window.electronAPI;",
      '    if (typeof _widgetData !== "undefined" && _widgetData && _widgetData._nfm) {',
      "        nfm = _widgetData._nfm;",
      "    } else {",
      "        var scriptEl = window.document ? window.document.currentScript : null;",
      '        var widgetEl = scriptEl ? scriptEl.closest(".desktop-widget") : null;',
      "        if (widgetEl) {",
      '            var wid = widgetEl.getAttribute("data-widget-id");',
      "            var wState = window.VCPDesktop && window.VCPDesktop.state ? window.VCPDesktop.state.widgets.get(wid) : null;",
      "            if (wState && wState._nfm) nfm = wState._nfm;",
      "        }",
      "    }",
      '    if (!nfm) { console.error("[NFM] Cannot find _nfm state"); return; }',
      '    var container = document.querySelector(".nfm-container");',
      '    if (!container) { console.error("[NFM] Cannot find .nfm-container"); return; }',
      '    var pathDisplay = container.querySelector(".nfm-path");',
      '    var btnUp = container.querySelector(".nfm-btn-up");',
      '    var btnRefresh = container.querySelector(".nfm-btn-refresh");',
      '    var fileListWrapper = container.querySelector(".nfm-file-list-wrapper");',
      '    var statusText = container.querySelector(".nfm-status-text");',
      "    var currentEntries = [];",
      "    var selectedIndex = -1;",
      "",
      "    function getIcon(name, type) {",
      '        if (type === "directory") return "📁";',
      '        var ext = (name.lastIndexOf(".") !== -1) ? name.substring(name.lastIndexOf(".")).toLowerCase() : "";',
      "        var m = {",
      '            ".txt":"📄",".md":"📝",".log":"📋",".js":"🟨",".ts":"🔷",".jsx":"⚛️",".tsx":"⚛️",',
      '            ".py":"🐍",".java":"☕",".c":"🔧",".cpp":"🔧",".html":"🌐",".css":"🎨",',
      '            ".json":"📋",".xml":"📋",".yaml":"📋",".yml":"📋",',
      '            ".png":"🖼️",".jpg":"🖼️",".gif":"🖼️",".svg":"🖼️",".webp":"🖼️",',
      '            ".mp3":"🎵",".wav":"🎵",".mp4":"🎬",".mkv":"🎬",',
      '            ".zip":"📦",".rar":"📦",".7z":"📦",".tar":"📦",".gz":"📦",',
      '            ".pdf":"📕",".doc":"📘",".docx":"📘",".xls":"📗",".xlsx":"📗",".ppt":"📙",".pptx":"📙",',
      '            ".exe":"⚙️",".bat":"⚙️",".sh":"⚙️",".ps1":"⚙️"',
      "        };",
      '        return m[ext] || "📄";',
      "    }",
      "    function fmtSize(bytes) {",
      '        if (bytes === 0 || bytes == null) return "-";',
      '        var u = ["B","KB","MB","GB","TB"]; var i = 0; var b = bytes;',
      "        while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }",
      '        return b.toFixed(i === 0 ? 0 : 1) + " " + u[i];',
      "    }",
      "    function fmtDate(ts) {",
      '        if (!ts) return "-";',
      "        var d = new Date(ts);",
      '        var p = function(n) { return n < 10 ? "0" + n : "" + n; };',
      '        return d.getFullYear() + "-" + p(d.getMonth()+1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());',
      "    }",
      '    function esc(s) { return s ? s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;") : ""; }',
      "",
      "    async function loadDirectory(relPath) {",
      "        fileListWrapper.innerHTML = '<div class=\"nfm-loading\">⏳ 正在加载...</div>';",
      "        selectedIndex = -1;",
      "        try {",
      "            var result = await api.nativeFsList({ mountId: nfm.mountId, capabilityToken: nfm.capabilityToken, path: relPath });",
      "            if (!result || !result.success) {",
      "                fileListWrapper.innerHTML = '<div class=\"nfm-error\">❌ ' + esc(result ? result.error : \"加载失败\") + '</div>';",
      "                return;",
      "            }",
      '            nfm.currentRelativePath = result.currentPath || "";',
      "            currentEntries = result.entries || [];",
      "            updatePathDisplay();",
      "            renderEntries(currentEntries);",
      '            statusText.textContent = currentEntries.length + " 个项目";',
      "            btnUp.disabled = !nfm.currentRelativePath;",
      "        } catch (err) {",
      "            fileListWrapper.innerHTML = '<div class=\"nfm-error\">❌ ' + esc(err.message || String(err)) + '</div>';",
      "        }",
      "    }",
      "",
      "    function updatePathDisplay() {",
      '        var sep = "\\\\";',
      "        var full = nfm.mountPath;",
      "        if (nfm.currentRelativePath) {",
      "            full += sep + nfm.currentRelativePath.replace(/\\//g, sep);",
      "        }",
      "        pathDisplay.textContent = full;",
      "        pathDisplay.title = full;",
      "    }",
      "",
      "    function renderEntries(entries) {",
      "        if (!entries || entries.length === 0) {",
      "            fileListWrapper.innerHTML = '<div class=\"nfm-empty\">📭 此文件夹为空</div>';",
      "            return;",
      "        }",
      "        var rows = entries.map(function(e, idx) {",
      "            var icon = getIcon(e.name, e.type);",
      '            var nameClass = e.type === "directory" ? "nfm-name nfm-dir-name" : "nfm-name";',
      "            return '<div class=\"nfm-file-row\" data-idx=\"' + idx + '\">'",
      "                + '<span class=\"nfm-icon\">' + icon + '</span>'",
      "                + '<span class=\"' + nameClass + '\" title=\"' + esc(e.name) + '\">' + esc(e.name) + '</span>'",
      '                + \'<span class="nfm-size">\' + (e.type === "directory" ? "" : fmtSize(e.size)) + \'</span>\'',
      "                + '<span class=\"nfm-date\">' + fmtDate(e.mtime) + '</span>'",
      "                + '</div>';",
      "        });",
      '        fileListWrapper.innerHTML = rows.join("");',
      "    }",
      "",
      "    function navigateInto(name) {",
      '        var newPath = nfm.currentRelativePath ? nfm.currentRelativePath + "/" + name : name;',
      "        loadDirectory(newPath);",
      "    }",
      "",
      "    function navigateUp() {",
      "        if (!nfm.currentRelativePath) return;",
      '        var parts = nfm.currentRelativePath.replace(/\\\\/g, "/").split("/");',
      "        parts.pop();",
      '        loadDirectory(parts.join("/") || ".");',
      "    }",
      "",
      "    async function openFile(name) {",
      '        var relPath = nfm.currentRelativePath ? nfm.currentRelativePath + "/" + name : name;',
      "        try {",
      "            await api.nativeFsOpen({ mountId: nfm.mountId, capabilityToken: nfm.capabilityToken, path: relPath });",
      "        } catch (err) {",
      '            console.error("[NFM] Open failed:", err);',
      "        }",
      "    }",
      "",
      "    async function revealFile(name) {",
      '        var relPath = nfm.currentRelativePath ? nfm.currentRelativePath + "/" + name : name;',
      "        try {",
      "            await api.nativeFsReveal({ mountId: nfm.mountId, capabilityToken: nfm.capabilityToken, path: relPath });",
      "        } catch (err) {",
      '            console.error("[NFM] Reveal failed:", err);',
      "        }",
      "    }",
      "",
      "    function removeContextMenu() {",
      '        var old = document.querySelector(".nfm-ctx-menu");',
      "        if (old) old.remove();",
      "    }",
      "",
      "    function showContextMenu(x, y, entry) {",
      "        removeContextMenu();",
      '        var menu = document.createElement("div");',
      '        menu.className = "nfm-ctx-menu";',
      "        var items = [];",
      '        if (entry.type === "directory") {',
      '            items.push({ label: "📂 打开文件夹", action: function() { navigateInto(entry.name); } });',
      "        } else {",
      '            items.push({ label: "📄 打开文件", action: function() { openFile(entry.name); } });',
      "        }",
      '        items.push({ label: "📁 在资源管理器中显示", action: function() { revealFile(entry.name); } });',
      "        items.forEach(function(item) {",
      '            var el = document.createElement("div");',
      '            el.className = "nfm-ctx-item";',
      "            el.textContent = item.label;",
      '            el.addEventListener("click", function(ev) { ev.stopPropagation(); removeContextMenu(); item.action(); });',
      "            menu.appendChild(el);",
      "        });",
      "        var maxX = window.innerWidth - 180;",
      "        var maxY = window.innerHeight - (items.length * 32 + 8);",
      '        menu.style.left = Math.min(x, maxX) + "px";',
      '        menu.style.top = Math.min(y, maxY) + "px";',
      "        document.body.appendChild(menu);",
      "        setTimeout(function() {",
      '            document.addEventListener("click", removeContextMenu, { once: true });',
      '            document.addEventListener("contextmenu", removeContextMenu, { once: true });',
      "        }, 0);",
      "    }",
      "",
      "    // === 事件委托 ===",
      '    fileListWrapper.addEventListener("click", function(ev) {',
      "        removeContextMenu();",
      '        var row = ev.target.closest(".nfm-file-row");',
      "        if (!row) return;",
      '        var prev = fileListWrapper.querySelector(".nfm-file-row.selected");',
      '        if (prev) prev.classList.remove("selected");',
      '        row.classList.add("selected");',
      '        selectedIndex = parseInt(row.getAttribute("data-idx"), 10);',
      "    });",
      "",
      '    fileListWrapper.addEventListener("dblclick", function(ev) {',
      '        var row = ev.target.closest(".nfm-file-row");',
      "        if (!row) return;",
      '        var idx = parseInt(row.getAttribute("data-idx"), 10);',
      "        var entry = currentEntries[idx];",
      "        if (!entry) return;",
      '        if (entry.type === "directory") {',
      "            navigateInto(entry.name);",
      "        } else {",
      "            openFile(entry.name);",
      "        }",
      "    });",
      "",
      '    fileListWrapper.addEventListener("contextmenu", function(ev) {',
      "        ev.preventDefault();",
      '        var row = ev.target.closest(".nfm-file-row");',
      "        if (!row) return;",
      '        var idx = parseInt(row.getAttribute("data-idx"), 10);',
      "        var entry = currentEntries[idx];",
      "        if (!entry) return;",
      '        var prev = fileListWrapper.querySelector(".nfm-file-row.selected");',
      '        if (prev) prev.classList.remove("selected");',
      '        row.classList.add("selected");',
      "        selectedIndex = idx;",
      "        showContextMenu(ev.clientX, ev.clientY, entry);",
      "    });",
      "",
      '    btnUp.addEventListener("click", function() { navigateUp(); });',
      '    btnRefresh.addEventListener("click", function() { loadDirectory(nfm.currentRelativePath || "."); });',
      "",
      "    // === 初始加载 ===",
      '    loadDirectory(".");',
      "})();",
      "</script>",
    ].join("\n");

    return css + "\n" + html + "\n" + inlineScript;
  }

  // ========== 创建挂件 ==========
  async function spawnNativeFileMount(data) {
    var widgetId = data.widgetId || "nfm-" + Date.now();
    if (state.widgets.has(widgetId)) {
      console.warn("[NFM] Widget already exists:", widgetId);
      return;
    }
    var config = data.config || {};
    var mountPath = config.mountPath;
    var mode = config.mode || "readonly";
    if (!mountPath) {
      console.error("[NFM] No mountPath provided in config");
      return;
    }

    // 注册挂载
    var regResult;
    try {
      regResult = await desktopApi.nativeFsRegisterMount({
        mountPath: mountPath,
        mode: mode,
        ownerWidgetId: widgetId,
      });
    } catch (err) {
      console.error("[NFM] registerMount failed:", err);
      return;
    }
    if (!regResult || !regResult.success) {
      console.error(
        "[NFM] registerMount error:",
        regResult ? regResult.error : "unknown"
      );
      return;
    }

    // 创建挂件
    var opts = data.options || {};
    var widgetData = widget.create(widgetId, {
      x: opts.x != null ? opts.x : 200,
      y: opts.y != null ? opts.y : 150,
      width: opts.width != null ? opts.width : 880,
      height: opts.height != null ? opts.height : 620,
    });

    // 保存状态
    widgetData._nfm = {
      mountId: regResult.mountId,
      capabilityToken: regResult.capabilityToken,
      mountPath: regResult.rootRealPath || mountPath,
      currentRelativePath: "",
      mode: mode,
    };

    // 注入 HTML
    var fullHtml = buildWidgetHtml(widgetData._nfm.mountPath, mode);
    widgetData.contentBuffer = fullHtml;
    widgetData.contentContainer.innerHTML = fullHtml;
    widget.processInlineStyles(widgetData);
    widgetData.isConstructing = false;
    if (widgetData.element) widgetData.element.classList.remove("constructing");
    widget.autoResize(widgetData);

    // 延迟执行内联脚本
    setTimeout(function () {
      widget.processInlineScripts(widgetData);
    }, 100);

    console.log(
      "[NFM] Native file mount widget spawned:",
      widgetId,
      "->",
      mountPath
    );
  }

  // ========== 监听 DESKTOP_PUSH ==========
  if (desktopApi && desktopApi.onDesktopPush) {
    desktopApi.onDesktopPush(function (data) {
      if (
        data &&
        data.action === "createBuiltinWidget" &&
        data.builtinType === "nativeFileMount"
      ) {
        spawnNativeFileMount(data);
      }
    });
  }

  // ========== 导出 ==========
  window.VCPDesktop = window.VCPDesktop || {};
  window.VCPDesktop.builtinNativeFileMount = {
    spawn: spawnNativeFileMount,
  };

  console.log("[NFM] Native file mount widget module loaded.");
})();
