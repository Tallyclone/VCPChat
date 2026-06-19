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
      '.nfm-container { position:relative; display:flex; flex-direction:column; height:100%; background:#1e1e2e; color:#cdd6f4; font-family:"Segoe UI",sans-serif; font-size:13px; overflow:hidden; user-select:none; }',
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
      ".nfm-ctx-menu { position:absolute; background:#1e1e2e; border:1px solid #45475a; border-radius:6px; padding:4px 0; min-width:160px; box-shadow:0 4px 12px rgba(0,0,0,0.5); z-index:99999; }",
      ".nfm-ctx-item { padding:6px 16px; cursor:pointer; font-size:13px; color:#cdd6f4; }",
      ".nfm-ctx-item:hover { background:#313244; }",
      ".nfm-ctx-sep { height:1px; background:#313244; margin:4px 0; }",
      ".nfm-rename-input { background:#11111b; border:1px solid #89b4fa; color:#cdd6f4; padding:2px 6px; font-size:13px; border-radius:3px; outline:none; width:100%; box-sizing:border-box; }",
      ".nfm-file-row.multi-selected { background:#585b70; }",
      ".nfm-toolbar .nfm-sep { width:1px; height:18px; background:#45475a; margin:0 2px; }",
      ".nfm-toast { position:fixed; bottom:40px; left:50%; transform:translateX(-50%); background:#313244; color:#cdd6f4; padding:6px 16px; border-radius:6px; font-size:12px; z-index:99999; pointer-events:none; opacity:0; transition:opacity 0.3s; }",
      ".nfm-toast.show { opacity:1; }",
      ".nfm-dialog-overlay { position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:99999; }",
      ".nfm-dialog { background:#1e1e2e; border:1px solid #45475a; border-radius:8px; padding:20px; min-width:300px; max-width:400px; box-shadow:0 8px 24px rgba(0,0,0,0.6); }",
      ".nfm-dialog-title { font-size:14px; font-weight:600; color:#cdd6f4; margin-bottom:12px; }",
      ".nfm-dialog-input { width:100%; background:#11111b; border:1px solid #45475a; color:#cdd6f4; padding:8px 12px; font-size:13px; border-radius:4px; outline:none; box-sizing:border-box; }",
      ".nfm-dialog-input:focus { border-color:#89b4fa; }",
      ".nfm-dialog-msg { font-size:13px; color:#a6adc8; margin-bottom:16px; line-height:1.5; }",
      ".nfm-dialog-btns { display:flex; justify-content:flex-end; gap:8px; margin-top:16px; }",
      ".nfm-dialog-btns button { padding:6px 16px; border:none; border-radius:4px; font-size:13px; cursor:pointer; }",
      ".nfm-dialog-btns .nfm-btn-cancel { background:#313244; color:#cdd6f4; }",
      ".nfm-dialog-btns .nfm-btn-cancel:hover { background:#45475a; }",
      ".nfm-dialog-btns .nfm-btn-ok { background:#89b4fa; color:#1e1e2e; font-weight:600; }",
      ".nfm-dialog-btns .nfm-btn-ok:hover { background:#b4d0fb; }",
      ".nfm-dialog-btns .nfm-btn-danger { background:#f38ba8; color:#1e1e2e; font-weight:600; }",
      ".nfm-dialog-btns .nfm-btn-danger:hover { background:#f5a0b8; }",
      "</style>",
    ].join("\n");

    var html = [
      '<div class="nfm-container">',
      '  <div class="nfm-toolbar">',
      '    <button class="nfm-btn-up" title="上级目录">⬆️</button>',
      '    <div class="nfm-path"></div>',
      '    <button class="nfm-btn-refresh" title="刷新">🔄</button>',
      '    <div class="nfm-sep"></div>',
      '    <button class="nfm-btn-newfolder" title="新建文件夹">📁+</button>',
      '    <button class="nfm-btn-newfile" title="新建文件">📄+</button>',
      '    <div class="nfm-sep"></div>',
      '    <button class="nfm-btn-delete" title="删除">🗑️</button>',
      '    <button class="nfm-btn-paste" title="粘贴">📋</button>',
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
      '        items.push({ label: "" });',
      '        items.push({ label: "✏️ 重命名 (F2)", action: function() { selectedIndex = currentEntries.indexOf(entry); renameSelected(); } });',
      '        items.push({ label: "📋 复制 (Ctrl+C)", action: function() { selectedIndex = currentEntries.indexOf(entry); copySelectedToClipboard(); } });',
      '        items.push({ label: "🗑️ 删除 (Delete)", action: function() { selectedIndex = currentEntries.indexOf(entry); deleteSelected(); } });',
      "        items.forEach(function(item) {",
      '            if (!item.label) { var sep = document.createElement("div"); sep.className = "nfm-ctx-sep"; menu.appendChild(sep); return; }',
      '            var el = document.createElement("div");',
      '            el.className = "nfm-ctx-item";',
      "            el.textContent = item.label;",
      '            el.addEventListener("click", function(ev) { ev.stopPropagation(); removeContextMenu(); if (item.action) item.action(); });',
      "            menu.appendChild(el);",
      "        });",
      "        var rect = container.getBoundingClientRect();",
      "        var localX = x - rect.left;",
      "        var localY = y - rect.top;",
      "        var maxX = container.clientWidth - 180;",
      "        var maxY = container.clientHeight - (items.length * 32 + 8);",
      '        menu.style.left = Math.max(0, Math.min(localX, maxX)) + "px";',
      '        menu.style.top = Math.max(0, Math.min(localY, maxY)) + "px";',
      "        document.body.appendChild(menu);",
      "        setTimeout(function() {",
      '            document.addEventListener("click", removeContextMenu, { once: true });',
      '            document.addEventListener("contextmenu", removeContextMenu, { once: true });',
      "        }, 0);",
      "    };",
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
      "        ev.stopPropagation();",
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
      '    container.addEventListener("contextmenu", function(ev) { ev.preventDefault(); });',
      "",
      "    // === Phase 2: 新建按钮 ===",
      '    var btnNewFolder = container.querySelector(".nfm-btn-newfolder");',
      '    var btnNewFile = container.querySelector(".nfm-btn-newfile");',
      '    var btnDelete = container.querySelector(".nfm-btn-delete");',
      '    var btnPaste = container.querySelector(".nfm-btn-paste");',
      "",
      "    // === Toast ===",
      "    function showToast(msg) {",
      '        var t = document.createElement("div");',
      '        t.className = "nfm-toast";',
      "        t.textContent = msg;",
      "        document.body.appendChild(t);",
      '        setTimeout(function() { t.classList.add("show"); }, 10);',
      '        setTimeout(function() { t.classList.remove("show"); setTimeout(function() { t.remove(); }, 300); }, 2000);',
      "    }",
      "",
      "    // === 自定义对话框 (替代 prompt/confirm) ===",
      "    function showInputDialog(title, defaultVal) {",
      "        return new Promise(function(resolve) {",
      '            var overlay = document.createElement("div");',
      '            overlay.className = "nfm-dialog-overlay";',
      '            overlay.innerHTML = \'<div class="nfm-dialog"><div class="nfm-dialog-title">\' + esc(title) + \'</div><input class="nfm-dialog-input" type="text" value="\' + esc(defaultVal || \'\') + \'"><div class="nfm-dialog-btns"><button class="nfm-btn-cancel">取消</button><button class="nfm-btn-ok">确定</button></div></div>\';',
      '            var input = overlay.querySelector(".nfm-dialog-input");',
      '            var btnOk = overlay.querySelector(".nfm-btn-ok");',
      '            var btnCancel = overlay.querySelector(".nfm-btn-cancel");',
      "            function done(val) { overlay.remove(); resolve(val); }",
      '            btnOk.addEventListener("click", function() { done(input.value.trim()); });',
      '            btnCancel.addEventListener("click", function() { done(null); });',
      '            overlay.addEventListener("click", function(ev) { if (ev.target === overlay) done(null); });',
      '            input.addEventListener("keydown", function(ev) { if (ev.key === "Enter") { ev.preventDefault(); done(input.value.trim()); } else if (ev.key === "Escape") { done(null); } });',
      "            document.body.appendChild(overlay);",
      "            input.focus();",
      "            input.select();",
      "        });",
      "    }",
      "",
      "    function showConfirmDialog(msg) {",
      "        return new Promise(function(resolve) {",
      '            var overlay = document.createElement("div");',
      '            overlay.className = "nfm-dialog-overlay";',
      '            overlay.innerHTML = \'<div class="nfm-dialog"><div class="nfm-dialog-msg">\' + esc(msg) + \'</div><div class="nfm-dialog-btns"><button class="nfm-btn-cancel">取消</button><button class="nfm-btn-danger">确定删除</button></div></div>\';',
      '            var btnOk = overlay.querySelector(".nfm-btn-danger");',
      '            var btnCancel = overlay.querySelector(".nfm-btn-cancel");',
      "            function done(val) { overlay.remove(); resolve(val); }",
      '            btnOk.addEventListener("click", function() { done(true); });',
      '            btnCancel.addEventListener("click", function() { done(false); });',
      '            overlay.addEventListener("click", function(ev) { if (ev.target === overlay) done(false); });',
      "            document.body.appendChild(overlay);",
      "            btnOk.focus();",
      "        });",
      "    }",
      "",
      "    // === 新建文件夹 ===",
      "    async function createNewFolder() {",
      '        var name = await showInputDialog("新建文件夹名称");',
      "        if (!name) return;",
      "        try {",
      '            await api.nativeFsNewFolder({ mountId: nfm.mountId, capabilityToken: nfm.capabilityToken, parentPath: nfm.currentRelativePath || ".", folderName: name });',
      '            showToast("已创建: " + name);',
      '            loadDirectory(nfm.currentRelativePath || ".");',
      "        } catch (err) {",
      '            showToast("创建失败: " + (err.message || err));',
      "        }",
      "    }",
      "",
      "    // === 新建文件 ===",
      "    async function createNewFile() {",
      '        var name = await showInputDialog("新建文件名称");',
      "        if (!name) return;",
      "        try {",
      '            await api.nativeFsNewFile({ mountId: nfm.mountId, capabilityToken: nfm.capabilityToken, parentPath: nfm.currentRelativePath || ".", fileName: name });',
      '            showToast("已创建: " + name);',
      '            loadDirectory(nfm.currentRelativePath || ".");',
      "        } catch (err) {",
      '            showToast("创建失败: " + (err.message || err));',
      "        }",
      "    }",
      "",
      "    // === 删除选中 ===",
      "    async function deleteSelected() {",
      "        if (selectedIndex < 0 || !currentEntries[selectedIndex]) return;",
      "        var entry = currentEntries[selectedIndex];",
      '        var confirmed = await showConfirmDialog("确定要删除 " + entry.name + " 到回收站吗？");',
      "        if (!confirmed) return;",
      '        var relPath = nfm.currentRelativePath ? nfm.currentRelativePath + "/" + entry.name : entry.name;',
      "        try {",
      "            await api.nativeFsTrash({ mountId: nfm.mountId, capabilityToken: nfm.capabilityToken, paths: [relPath] });",
      '            showToast("已删除: " + entry.name);',
      '            loadDirectory(nfm.currentRelativePath || ".");',
      "        } catch (err) {",
      '            showToast("删除失败: " + (err.message || err));',
      "        }",
      "    }",
      "",
      "    // === 重命名 ===",
      "    async function renameSelected() {",
      "        if (selectedIndex < 0 || !currentEntries[selectedIndex]) return;",
      "        var entry = currentEntries[selectedIndex];",
      '        var row = fileListWrapper.querySelector(".nfm-file-row[data-idx=\\"" + selectedIndex + "\\"]");',
      "        if (!row) return;",
      '        var nameSpan = row.querySelector(".nfm-name");',
      "        if (!nameSpan) return;",
      "        var oldName = entry.name;",
      '        var input = document.createElement("input");',
      '        input.className = "nfm-rename-input";',
      "        input.value = oldName;",
      '        var ext = oldName.lastIndexOf(".");',
      '        nameSpan.textContent = "";',
      "        nameSpan.appendChild(input);",
      "        input.focus();",
      "        if (ext > 0) input.setSelectionRange(0, ext);",
      "        else input.select();",
      '        async function commitRename() { var newName = input.value.trim(); if (!newName || newName === oldName) { nameSpan.textContent = oldName; return; } var relPath = nfm.currentRelativePath ? nfm.currentRelativePath + "/" + oldName : oldName; try { await api.nativeFsRename({ mountId: nfm.mountId, capabilityToken: nfm.capabilityToken, oldPath: relPath, newName: newName }); showToast("已重命名: " + newName); loadDirectory(nfm.currentRelativePath || "."); } catch (err) { showToast("重命名失败: " + (err.message || err)); nameSpan.textContent = oldName; } }',
      '        input.addEventListener("keydown", function(ev) { if (ev.key === "Enter") { ev.preventDefault(); commitRename(); } else if (ev.key === "Escape") { nameSpan.textContent = oldName; } });',
      '        input.addEventListener("blur", function() { commitRename(); });',
      "    }",
      "",
      "    // === 复制到剪贴板 ===",
      "    async function copySelectedToClipboard() {",
      "        if (selectedIndex < 0 || !currentEntries[selectedIndex]) return;",
      "        var entry = currentEntries[selectedIndex];",
      '        var relPath = nfm.currentRelativePath ? nfm.currentRelativePath + "/" + entry.name : entry.name;',
      "        try {",
      "            await api.nativeFsCopyToClipboard({ mountId: nfm.mountId, capabilityToken: nfm.capabilityToken, paths: [relPath] });",
      '            showToast("已复制: " + entry.name);',
      "        } catch (err) {",
      '            showToast("复制失败: " + (err.message || err));',
      "        }",
      "    }",
      "",
      "    // === 粘贴 ===",
      "    async function pasteHere() {",
      "        try {",
      '            await api.nativeFsPasteFromClipboard({ mountId: nfm.mountId, capabilityToken: nfm.capabilityToken, destDir: nfm.currentRelativePath || ".", strategy: "rename" });',
      '            showToast("粘贴完成");',
      '            loadDirectory(nfm.currentRelativePath || ".");',
      "        } catch (err) {",
      '            showToast("粘贴失败: " + (err.message || err));',
      "        }",
      "    }",
      "",
      "    // === 按钮事件 ===",
      '    if (btnNewFolder) btnNewFolder.addEventListener("click", createNewFolder);',
      '    if (btnNewFile) btnNewFile.addEventListener("click", createNewFile);',
      '    if (btnDelete) btnDelete.addEventListener("click", deleteSelected);',
      '    if (btnPaste) btnPaste.addEventListener("click", pasteHere);',
      "",
      "    // === 键盘快捷键 ===",
      '    container.setAttribute("tabindex", "0");',
      '    container.addEventListener("keydown", function(ev) {',
      '        if (ev.key === "Delete") { ev.preventDefault(); deleteSelected(); }',
      '        else if (ev.key === "F2") { ev.preventDefault(); renameSelected(); }',
      '        else if (ev.ctrlKey && ev.key === "c") { ev.preventDefault(); copySelectedToClipboard(); }',
      '        else if (ev.ctrlKey && ev.key === "v") { ev.preventDefault(); pasteHere(); }',
      "    });",
      "",
      "    // === 实时监听文件变更 ===",
      "    if (api.onNativeFsChange) {",
      "        api.onNativeFsChange(function(data) {",
      "            if (data.mountId !== nfm.mountId) return;",
      '            var curDir = nfm.currentRelativePath || "";',
      '            var changeDir = data.directoryPath || "";',
      "            if (curDir === changeDir) {",
      '                loadDirectory(nfm.currentRelativePath || ".");',
      "            }",
      "        });",
      "    }",
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

    // 辅助函数：创建错误卡片
    function showErrorWidget(errorMsg) {
      var opts = data.options || {};
      var widgetData = widget.create(widgetId, {
        x: opts.x != null ? opts.x : 200,
        y: opts.y != null ? opts.y : 150,
        width: opts.width != null ? opts.width : 880,
        height: opts.height != null ? opts.height : 620,
      });
      var errorHtml =
        '<style>.nfm-error-card{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;background:#1e1e2e;color:#cdd6f4;font-family:"Segoe UI",sans-serif;padding:40px;text-align:center;user-select:text}.nfm-error-card .nfm-error-icon{font-size:48px;margin-bottom:16px}.nfm-error-card .nfm-error-title{font-size:18px;font-weight:600;color:#f38ba8;margin-bottom:12px}.nfm-error-card .nfm-error-detail{font-size:13px;color:#a6adc8;line-height:1.6;word-break:break-all}.nfm-error-card .nfm-error-path{background:#11111b;padding:8px 16px;border-radius:6px;margin-top:12px;font-family:monospace;font-size:12px;color:#89b4fa}</style>' +
        '<div class="nfm-error-card">' +
        '<div class="nfm-error-icon">❌</div>' +
        '<div class="nfm-error-title">文件系统挂载失败</div>' +
        '<div class="nfm-error-detail">' +
        escapeHtml(errorMsg) +
        "</div>" +
        (mountPath
          ? '<div class="nfm-error-path">' + escapeHtml(mountPath) + "</div>"
          : "") +
        "</div>";
      widgetData.contentBuffer = errorHtml;
      widgetData.contentContainer.innerHTML = errorHtml;
      widget.processInlineStyles(widgetData);
      widgetData.isConstructing = false;
      if (widgetData.element)
        widgetData.element.classList.remove("constructing");
      widget.autoResize(widgetData);
      console.error("[NFM] Mount failed, showing error widget:", errorMsg);
    }

    if (!mountPath) {
      showErrorWidget("未提供挂载路径 (mountPath)");
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
      showErrorWidget("注册挂载失败: " + (err.message || String(err)));
      return;
    }
    if (!regResult || !regResult.success) {
      showErrorWidget(
        "注册挂载错误: " + (regResult ? regResult.error : "unknown")
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
