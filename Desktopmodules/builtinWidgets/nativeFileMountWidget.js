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

  // 检查字符串是否包含未处理的 DESKTOP_PUSH 定界符残留
  function hasDelimiterResidue(str) {
    return (
      str.indexOf("「始」") !== -1 ||
      str.indexOf("「末」") !== -1 ||
      str.indexOf("「始ESCAPE」") !== -1 ||
      str.indexOf("「末ESCAPE」") !== -1
    );
  }

  // ========== Phase 3: customUI 完全接管 ==========
  function buildCustomUIHtml(mountPath, mode, customUI) {
    var css = customUI.css ? "<style>" + customUI.css + "</style>" : "";
    var html = customUI.html || "<div></div>";
    var userJs =
      customUI.js && !hasDelimiterResidue(customUI.js) ? customUI.js : "";
    var apiScript = [
      "<script>",
      "(function() {",
      '    console.log("[NFM-Custom] apiScript IIFE executing...");',
      "    var api = window.desktopAPI || window.electronAPI;",
      "    var nfmState = null;",
      '    if (typeof _widgetData !== "undefined" && _widgetData && _widgetData._nfm) {',
      "        nfmState = _widgetData._nfm;",
      "    }",
      '    if (!nfmState) { console.error("[NFM-Custom] Cannot find _nfm state"); return; }',
      '    console.log("[NFM-Custom] nfmState found, mountPath:", nfmState.mountPath, "mode:", nfmState.mode);',
      "",
      "    var nfm = {",
      "        mountId: nfmState.mountId,",
      "        mountPath: nfmState.mountPath,",
      "        mode: nfmState.mode,",
      '        list: function(relPath) { return api.nativeFsList({ mountId: nfmState.mountId, capabilityToken: nfmState.capabilityToken, path: relPath || "." }).then(function(r) { if (r && r.entries) { r.entries.forEach(function(e) { e.isDir = e.isDirectory = (e.type === "directory"); }); } return r; }); },',
      "        open: function(relPath) { return api.nativeFsStat({ mountId: nfmState.mountId, capabilityToken: nfmState.capabilityToken, path: relPath }).then(function(s) { if (s && s.type === 'directory') { return Promise.reject('[NFM] Cannot open a directory with nfm.open(). Use nfm.list() to navigate into it.'); } return api.nativeFsOpen({ mountId: nfmState.mountId, capabilityToken: nfmState.capabilityToken, path: relPath }); }); },",
      "        reveal: function(relPath) { return api.nativeFsReveal({ mountId: nfmState.mountId, capabilityToken: nfmState.capabilityToken, path: relPath }); },",
      '        newFolder: function(parentPath, name) { return api.nativeFsNewFolder({ mountId: nfmState.mountId, capabilityToken: nfmState.capabilityToken, parentPath: parentPath || ".", folderName: name }); },',
      '        newFile: function(parentPath, name) { return api.nativeFsNewFile({ mountId: nfmState.mountId, capabilityToken: nfmState.capabilityToken, parentPath: parentPath || ".", fileName: name }); },',
      "        rename: function(oldPath, newName) { return api.nativeFsRename({ mountId: nfmState.mountId, capabilityToken: nfmState.capabilityToken, oldPath: oldPath, newName: newName }); },",
      "        trash: function(paths) { return api.nativeFsTrash({ mountId: nfmState.mountId, capabilityToken: nfmState.capabilityToken, paths: Array.isArray(paths) ? paths : [paths] }); },",
      "        copyToClipboard: function(paths) { return api.nativeFsCopyToClipboard({ mountId: nfmState.mountId, capabilityToken: nfmState.capabilityToken, paths: Array.isArray(paths) ? paths : [paths] }); },",
      "        cutToClipboard: function(paths) { return api.nativeFsCutToClipboard({ mountId: nfmState.mountId, capabilityToken: nfmState.capabilityToken, paths: Array.isArray(paths) ? paths : [paths] }); },",
      '        paste: function(destDir, strategy) { return api.nativeFsPasteFromClipboard({ mountId: nfmState.mountId, capabilityToken: nfmState.capabilityToken, destDir: destDir || ".", strategy: strategy || "rename" }); },',
      "        onFileChange: function(callback) { if (api.onNativeFsChange) { api.onNativeFsChange(function(data) { if (data.mountId === nfmState.mountId) callback(data); }); } }",
      "    };",
      "",
      "    window.nfm = nfm;",
      '    console.log("[NFM-Custom] nfm API object created, executing customUI.js (" + ' +
        JSON.stringify(userJs.length) +
        ' + " chars)...");',
      "",
      "    try {",
      "    " + userJs,
      "    } catch(_nfmErr) {",
      '        console.error("[NFM-Custom] customUI.js runtime error:", _nfmErr);',
      "    }",
      '    console.log("[NFM-Custom] customUI.js execution finished");',
      "})();",
      "</script>",
    ].join("\n");
    return css + "\n" + html + "\n" + apiScript;
  }

  // ========== 构建 Widget HTML (Phase 3: 支持 uiConfig) ==========
  function buildWidgetHtml(mountPath, mode, uiConfig) {
    // Layer 3: customUI 完全接管
    // 需要检查 customUI 至少有一个有效子字段（html/js），且值不含残留定界符标记
    if (uiConfig && uiConfig.customUI) {
      var cu = uiConfig.customUI;
      console.log(
        "[NFM] customUI object keys:",
        Object.keys(cu),
        "html:",
        typeof cu.html,
        cu.html ? cu.html.length : 0,
        "css:",
        typeof cu.css,
        cu.css ? cu.css.length : 0,
        "js:",
        typeof cu.js,
        cu.js ? cu.js.length : 0
      );
      var hasValidHtml =
        typeof cu.html === "string" &&
        cu.html.length > 0 &&
        !hasDelimiterResidue(cu.html);
      var hasValidJs =
        typeof cu.js === "string" &&
        cu.js.length > 0 &&
        !hasDelimiterResidue(cu.js);
      if (hasValidHtml || hasValidJs) {
        return buildCustomUIHtml(mountPath, mode, cu);
      }
    }

    // Layer 2: Theme + Layout + Actions + Icons
    var theme = (uiConfig && uiConfig.theme) || {};
    var layout = (uiConfig && uiConfig.layout) || {};
    var actions = (uiConfig && uiConfig.actions) || {};
    var icons = (uiConfig && uiConfig.icons) || {};
    var isGrid = layout.variant === "grid";

    // CSS 变量声明
    var cssVarBlock =
      ".nfm-container {" +
      " --nfm-primary:" +
      (theme.primary || "#89b4fa") +
      ";" +
      " --nfm-bg:" +
      (theme.background || "#1e1e2e") +
      ";" +
      " --nfm-bg-secondary:" +
      (theme.background || "#181825") +
      ";" +
      " --nfm-bg-input:" +
      (theme.background || "#11111b") +
      ";" +
      " --nfm-text:" +
      (theme.foreground || "#cdd6f4") +
      ";" +
      " --nfm-text-secondary:" +
      (theme.foreground || "#a6adc8") +
      ";" +
      " --nfm-text-muted:" +
      (theme.foreground || "#6c7086") +
      ";" +
      " --nfm-border:" +
      (theme.border || "#313244") +
      ";" +
      " --nfm-hover:" +
      (theme.hover || "#313244") +
      ";" +
      " --nfm-accent:" +
      (theme.accent || "#45475a") +
      ";" +
      " --nfm-item-height:" +
      (layout.itemHeight || 32) +
      "px;" +
      " --nfm-grid-cols:" +
      (layout.gridColumns || 4) +
      ";" +
      " --nfm-spacing:" +
      (layout.spacing || 8) +
      "px;" +
      " }";

    var css = [
      "<style>",
      cssVarBlock,
      '.nfm-container { position:relative; display:flex; flex-direction:column; height:100%; background:var(--nfm-bg); color:var(--nfm-text); font-family:"Segoe UI",sans-serif; font-size:13px; overflow:hidden; user-select:none; outline:none; }',
      ".nfm-toolbar { display:flex; align-items:center; gap:6px; padding:6px 10px; background:var(--nfm-bg-secondary); border-bottom:1px solid var(--nfm-border); flex-shrink:0; }",
      ".nfm-toolbar button { background:var(--nfm-accent); border:none; color:var(--nfm-text); padding:4px 8px; border-radius:4px; cursor:pointer; font-size:13px; line-height:1; }",
      ".nfm-toolbar button:hover { background:var(--nfm-hover); }",
      ".nfm-toolbar button:disabled { opacity:0.4; cursor:default; }",
      ".nfm-path { flex:1; padding:3px 8px; background:var(--nfm-bg-input); border:1px solid var(--nfm-border); border-radius:4px; color:var(--nfm-text-secondary); font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }",
      ".nfm-file-header { display:grid; grid-template-columns:24px 1fr 90px 140px; gap:4px; padding:4px 12px; background:var(--nfm-bg-secondary); border-bottom:1px solid var(--nfm-border); font-size:11px; color:var(--nfm-text-muted); flex-shrink:0; }",
      ".nfm-file-list-wrapper { flex:1; overflow-y:auto; overflow-x:hidden; }",
      ".nfm-file-list-wrapper::-webkit-scrollbar { width:6px; }",
      ".nfm-file-list-wrapper::-webkit-scrollbar-track { background:transparent; }",
      ".nfm-file-list-wrapper::-webkit-scrollbar-thumb { background:var(--nfm-accent); border-radius:3px; }",
      ".nfm-file-row { display:grid; grid-template-columns:24px 1fr 90px 140px; gap:4px; padding:3px 12px; align-items:center; cursor:pointer; border-bottom:1px solid rgba(49,50,68,0.4); height:var(--nfm-item-height); }",
      ".nfm-file-row:hover { background:var(--nfm-hover); }",
      ".nfm-file-row.selected { background:var(--nfm-accent); }",
      ".nfm-file-row .nfm-icon { text-align:center; font-size:15px; line-height:1; }",
      ".nfm-file-row .nfm-name { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }",
      ".nfm-file-row .nfm-size { text-align:right; color:var(--nfm-text-secondary); font-size:12px; }",
      ".nfm-file-row .nfm-date { color:var(--nfm-text-secondary); font-size:12px; }",
      ".nfm-dir-name { color:var(--nfm-primary); }",
      ".nfm-status-bar { display:flex; align-items:center; justify-content:space-between; padding:4px 12px; background:var(--nfm-bg-secondary); border-top:1px solid var(--nfm-border); font-size:11px; color:var(--nfm-text-muted); flex-shrink:0; }",
      ".nfm-loading { display:flex; align-items:center; justify-content:center; height:100%; color:var(--nfm-text-muted); font-size:14px; }",
      ".nfm-empty { display:flex; align-items:center; justify-content:center; height:100%; color:var(--nfm-text-muted); font-size:13px; }",
      ".nfm-error { display:flex; align-items:center; justify-content:center; height:100%; color:#f38ba8; font-size:13px; padding:20px; text-align:center; }",
      ".nfm-ctx-menu { position:absolute; background:var(--nfm-bg); border:1px solid var(--nfm-accent); border-radius:6px; padding:4px 0; min-width:160px; box-shadow:0 4px 12px rgba(0,0,0,0.5); z-index:99999; }",
      ".nfm-ctx-item { padding:6px 16px; cursor:pointer; font-size:13px; color:var(--nfm-text); }",
      ".nfm-ctx-item:hover { background:var(--nfm-hover); }",
      ".nfm-ctx-sep { height:1px; background:var(--nfm-border); margin:4px 0; }",
      ".nfm-rename-input { background:var(--nfm-bg-input); border:1px solid var(--nfm-primary); color:var(--nfm-text); padding:2px 6px; font-size:13px; border-radius:3px; outline:none; width:100%; box-sizing:border-box; }",
      ".nfm-file-row.multi-selected { background:#585b70; }",
      ".nfm-toolbar .nfm-sep { width:1px; height:18px; background:var(--nfm-accent); margin:0 2px; }",
      ".nfm-toast { position:fixed; bottom:40px; left:50%; transform:translateX(-50%); background:var(--nfm-border); color:var(--nfm-text); padding:6px 16px; border-radius:6px; font-size:12px; z-index:99999; pointer-events:none; opacity:0; transition:opacity 0.3s; }",
      ".nfm-toast.show { opacity:1; }",
      ".nfm-dialog-overlay { position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:99999; }",
      ".nfm-dialog { background:var(--nfm-bg); border:1px solid var(--nfm-accent); border-radius:8px; padding:20px; min-width:300px; max-width:400px; box-shadow:0 8px 24px rgba(0,0,0,0.6); }",
      ".nfm-dialog-title { font-size:14px; font-weight:600; color:var(--nfm-text); margin-bottom:12px; }",
      ".nfm-dialog-input { width:100%; background:var(--nfm-bg-input); border:1px solid var(--nfm-accent); color:var(--nfm-text); padding:8px 12px; font-size:13px; border-radius:4px; outline:none; box-sizing:border-box; }",
      ".nfm-dialog-input:focus { border-color:var(--nfm-primary); }",
      ".nfm-dialog-msg { font-size:13px; color:var(--nfm-text-secondary); margin-bottom:16px; line-height:1.5; }",
      ".nfm-dialog-btns { display:flex; justify-content:flex-end; gap:8px; margin-top:16px; }",
      ".nfm-dialog-btns button { padding:6px 16px; border:none; border-radius:4px; font-size:13px; cursor:pointer; }",
      ".nfm-dialog-btns .nfm-btn-cancel { background:var(--nfm-border); color:var(--nfm-text); }",
      ".nfm-dialog-btns .nfm-btn-cancel:hover { background:var(--nfm-accent); }",
      ".nfm-dialog-btns .nfm-btn-ok { background:var(--nfm-primary); color:var(--nfm-bg); font-weight:600; }",
      ".nfm-dialog-btns .nfm-btn-ok:hover { background:#b4d0fb; }",
      ".nfm-dialog-btns .nfm-btn-danger { background:#f38ba8; color:#1e1e2e; font-weight:600; }",
      ".nfm-dialog-btns .nfm-btn-danger:hover { background:#f5a0b8; }",
      // Grid layout styles
      ".nfm-container.nfm-grid .nfm-file-header { display:none; }",
      ".nfm-container.nfm-grid .nfm-file-list-wrapper { display:flex; flex-wrap:wrap; align-content:flex-start; padding:var(--nfm-spacing); gap:var(--nfm-spacing); }",
      ".nfm-container.nfm-grid .nfm-file-row { display:flex; flex-direction:column; align-items:center; justify-content:center; width:calc((100% - (var(--nfm-grid-cols) - 1) * var(--nfm-spacing)) / var(--nfm-grid-cols)); height:auto; min-height:80px; padding:var(--nfm-spacing); border-bottom:none; text-align:center; border-radius:6px; grid-template-columns:none; }",
      ".nfm-container.nfm-grid .nfm-file-row .nfm-icon { font-size:28px; margin-bottom:4px; }",
      ".nfm-container.nfm-grid .nfm-file-row .nfm-name { font-size:11px; max-width:100%; word-break:break-all; white-space:normal; -webkit-line-clamp:2; display:-webkit-box; -webkit-box-orient:vertical; overflow:hidden; }",
      ".nfm-container.nfm-grid .nfm-file-row .nfm-size { display:none; }",
      ".nfm-container.nfm-grid .nfm-file-row .nfm-date { display:none; }",
      "</style>",
    ].join("\n");

    // Toolbar generation (configurable)
    var allButtons = [
      { id: "up", cls: "nfm-btn-up", title: "上级目录", icon: "⬆️" },
      { id: "path", special: "path" },
      { id: "refresh", cls: "nfm-btn-refresh", title: "刷新", icon: "🔄" },
      { id: "sep1", sep: true },
      {
        id: "newfolder",
        cls: "nfm-btn-newfolder",
        title: "新建文件夹",
        icon: "📁+",
      },
      { id: "newfile", cls: "nfm-btn-newfile", title: "新建文件", icon: "📄+" },
      { id: "sep2", sep: true },
      { id: "delete", cls: "nfm-btn-delete", title: "删除", icon: "🗑️" },
      { id: "paste", cls: "nfm-btn-paste", title: "粘贴", icon: "📋" },
    ];

    var toolbarFilter = actions.toolbar
      ? actions.toolbar.split(",").map(function (s) {
          return s.trim();
        })
      : null;

    var toolbarHtml = allButtons
      .map(function (btn) {
        if (btn.special === "path") return '    <div class="nfm-path"></div>';
        if (toolbarFilter && !btn.sep && toolbarFilter.indexOf(btn.id) === -1)
          return "";
        if (btn.sep) return '    <div class="nfm-sep"></div>';
        return (
          '    <button class="' +
          btn.cls +
          '" title="' +
          btn.title +
          '">' +
          btn.icon +
          "</button>"
        );
      })
      .filter(function (s) {
        return s !== "";
      })
      .join("\n");

    var containerClass = "nfm-container" + (isGrid ? " nfm-grid" : "");

    var html = [
      '<div class="' + containerClass + '">',
      '  <div class="nfm-toolbar">',
      toolbarHtml,
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

    // Serialize icons config for inline script
    var iconsJson = JSON.stringify(icons);

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
      "    var selectedIndices = new Set();",
      "    var lastClickIndex = -1;",
      "",
      "    function updateVisualSelection() {",
      "        var rows = fileListWrapper.querySelectorAll('.nfm-file-row');",
      "        for (var i = 0; i < rows.length; i++) {",
      "            var idx = parseInt(rows[i].getAttribute('data-idx'), 10);",
      "            if (selectedIndices.has(idx)) {",
      "                rows[i].classList.add('selected');",
      "            } else {",
      "                rows[i].classList.remove('selected');",
      "            }",
      "        }",
      "    }",
      "",
      "    // Phase 3: Custom icons config",
      "    var customIcons = " + iconsJson + ";",
      "",
      "    function getIcon(name, type) {",
      '        if (type === "directory") return customIcons.folder || "📁";',
      '        var ext = (name.lastIndexOf(".") !== -1) ? name.substring(name.lastIndexOf(".")).toLowerCase() : "";',
      "        var extNoDot = ext.substring(1);",
      "        if (customIcons[extNoDot]) return customIcons[extNoDot];",
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
      '        return m[ext] || customIcons.file || "📄";',
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
      "        selectedIndices.clear();",
      "        lastClickIndex = -1;",
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
      "            if (btnUp) btnUp.disabled = !nfm.currentRelativePath;",
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
      "        if (pathDisplay) { pathDisplay.textContent = full; pathDisplay.title = full; }",
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
      '            items.push({ id: "open", label: "📂 打开文件夹", action: function() { navigateInto(entry.name); } });',
      "        } else {",
      '            items.push({ id: "open", label: "📄 打开文件", action: function() { openFile(entry.name); } });',
      "        }",
      '        items.push({ id: "reveal", label: "📁 在资源管理器中显示", action: function() { revealFile(entry.name); } });',
      '        items.push({ id: "_sep1", label: "" });',
      '        items.push({ id: "rename", label: "✏️ 重命名 (F2)", action: function() { renameSelected(); } });',
      '        items.push({ id: "copy", label: "📋 复制 (Ctrl+C)", action: function() { copySelectedToClipboard(); } });',
      '        items.push({ id: "cut", label: "✂️ 剪切 (Ctrl+X)", action: function() { cutSelectedToClipboard(); } });',
      '        items.push({ id: "delete", label: "🗑️ 删除 (Delete)", action: function() { deleteSelected(); } });',
      '        items.push({ id: "_sep2", label: "" });',
      '        items.push({ id: "paste", label: "📌 粘贴 (Ctrl+V)", action: function() { pasteHere(); } });',
      "",
      "        // Phase 3: context menu filtering",
      "        var ctxConfig = (nfm.uiConfig && nfm.uiConfig.actions && nfm.uiConfig.actions.contextMenu) || null;",
      "        if (ctxConfig) {",
      '            var allowed = ctxConfig.split(",").map(function(s){return s.trim();});',
      '            items = items.filter(function(item) { return !item.id || item.id.charAt(0) === "_" || allowed.indexOf(item.id) !== -1; });',
      "        }",
      "",
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
      "        if (!row) {",
      "            // Click on empty area - clear selection",
      "            selectedIndices.clear();",
      "            lastClickIndex = -1;",
      "            updateVisualSelection();",
      "            return;",
      "        }",
      '        var idx = parseInt(row.getAttribute("data-idx"), 10);',
      "        if (ev.shiftKey && lastClickIndex !== -1) {",
      "            // Shift-click: range selection",
      "            var start = Math.min(lastClickIndex, idx);",
      "            var end = Math.max(lastClickIndex, idx);",
      "            if (!ev.ctrlKey) selectedIndices.clear();",
      "            for (var i = start; i <= end; i++) {",
      "                selectedIndices.add(i);",
      "            }",
      "        } else if (ev.ctrlKey) {",
      "            // Ctrl-click: toggle selection",
      "            if (selectedIndices.has(idx)) {",
      "                selectedIndices.delete(idx);",
      "            } else {",
      "                selectedIndices.add(idx);",
      "            }",
      "        } else {",
      "            // Normal click: single selection",
      "            selectedIndices.clear();",
      "            selectedIndices.add(idx);",
      "        }",
      "        lastClickIndex = idx;",
      "        updateVisualSelection();",
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
      '        var row = ev.target.closest(".nfm-file-row");',
      "        if (!row) return;",
      "        ev.preventDefault();",
      "        ev.stopPropagation();",
      '        var idx = parseInt(row.getAttribute("data-idx"), 10);',
      "        var entry = currentEntries[idx];",
      "        if (!entry) return;",
      "        // If right-clicked item is NOT in current selection, replace selection",
      "        if (!selectedIndices.has(idx)) {",
      "            selectedIndices.clear();",
      "            selectedIndices.add(idx);",
      "            lastClickIndex = idx;",
      "            updateVisualSelection();",
      "        }",
      "        showContextMenu(ev.clientX, ev.clientY, entry);",
      "    });",
      "",
      '    if (btnUp) btnUp.addEventListener("click", function() { navigateUp(); });',
      '    if (btnRefresh) btnRefresh.addEventListener("click", function() { loadDirectory(nfm.currentRelativePath || "."); });',
      "",
      "    // Container-level contextmenu: show simplified menu for empty area",
      '    container.addEventListener("contextmenu", function(ev) {',
      "        // Only handle if not triggered by file row (file rows have their own handler)",
      '        var row = ev.target.closest(".nfm-file-row");',
      "        if (row) return;",
      "",
      "        ev.preventDefault();",
      "        ev.stopPropagation();",
      "",
      "        // Show simplified context menu for empty area",
      "        removeContextMenu();",
      '        var menu = document.createElement("div");',
      '        menu.className = "nfm-ctx-menu";',
      "        var emptyItems = [",
      '            { id: "paste", label: "📌 粘贴 (Ctrl+V)", action: function() { pasteHere(); } },',
      '            { id: "_sep1", label: "" },',
      '            { id: "newfolder", label: "📁 新建文件夹", action: function() { createNewFolder(); } },',
      '            { id: "newfile", label: "📄 新建文件", action: function() { createNewFile(); } },',
      '            { id: "_sep2", label: "" },',
      '            { id: "refresh", label: "🔄 刷新", action: function() { loadDirectory(nfm.currentRelativePath || "."); } }',
      "        ];",
      "        emptyItems.forEach(function(item) {",
      '            if (!item.label) { var sep = document.createElement("div"); sep.className = "nfm-ctx-sep"; menu.appendChild(sep); return; }',
      '            var el = document.createElement("div");',
      '            el.className = "nfm-ctx-item";',
      "            el.textContent = item.label;",
      '            el.addEventListener("click", function(e2) { e2.stopPropagation(); removeContextMenu(); if (item.action) item.action(); });',
      "            menu.appendChild(el);",
      "        });",
      "        var rect = container.getBoundingClientRect();",
      "        var localX = ev.clientX - rect.left;",
      "        var localY = ev.clientY - rect.top;",
      "        var maxX = container.clientWidth - 180;",
      "        var maxY = container.clientHeight - (emptyItems.length * 32 + 8);",
      '        menu.style.left = Math.max(0, Math.min(localX, maxX)) + "px";',
      '        menu.style.top = Math.max(0, Math.min(localY, maxY)) + "px";',
      "        document.body.appendChild(menu);",
      "        setTimeout(function() {",
      '            document.addEventListener("click", removeContextMenu, { once: true });',
      '            document.addEventListener("contextmenu", removeContextMenu, { once: true });',
      "        }, 0);",
      "    });",
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
      "        if (selectedIndices.size === 0) return;",
      "        var entries = [];",
      "        selectedIndices.forEach(function(idx) { if (currentEntries[idx]) entries.push(currentEntries[idx]); });",
      "        if (entries.length === 0) return;",
      "        var msg = entries.length === 1 ? '确定要删除 ' + entries[0].name + ' 到回收站吗？' : '确定要删除 ' + entries.length + ' 个项目到回收站吗？';",
      "        var confirmed = await showConfirmDialog(msg);",
      "        if (!confirmed) return;",
      "        var paths = entries.map(function(e) { return nfm.currentRelativePath ? nfm.currentRelativePath + '/' + e.name : e.name; });",
      "        try {",
      "            await api.nativeFsTrash({ mountId: nfm.mountId, capabilityToken: nfm.capabilityToken, paths: paths });",
      "            showToast('已删除: ' + entries.length + ' 个项目');",
      '            loadDirectory(nfm.currentRelativePath || ".");',
      "        } catch (err) {",
      '            showToast("删除失败: " + (err.message || err));',
      "        }",
      "    }",
      "",
      "    // === 重命名 ===",
      "    async function renameSelected() {",
      "        if (selectedIndices.size !== 1) return;",
      "        var idx = Array.from(selectedIndices)[0];",
      "        var entry = currentEntries[idx];",
      "        if (!entry) return;",
      '        var row = fileListWrapper.querySelector(".nfm-file-row[data-idx=\\"" + idx + "\\"]");',
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
      "        if (selectedIndices.size === 0) return;",
      "        var entries = [];",
      "        selectedIndices.forEach(function(idx) { if (currentEntries[idx]) entries.push(currentEntries[idx]); });",
      "        if (entries.length === 0) return;",
      "        var paths = entries.map(function(e) { return nfm.currentRelativePath ? nfm.currentRelativePath + '/' + e.name : e.name; });",
      "        try {",
      "            var result = await api.nativeFsCopyToClipboard({ mountId: nfm.mountId, capabilityToken: nfm.capabilityToken, paths: paths });",
      "            if (result && result.success === false) {",
      '                showToast("复制失败: " + (result.error || "未知错误"));',
      "            } else {",
      "                showToast('已复制: ' + entries.length + ' 个项目');",
      "            }",
      "        } catch (err) {",
      '            showToast("复制失败: " + (err.message || err));',
      "        }",
      "    }",
      "",
      "    // === 剪切到剪贴板 ===",
      "    async function cutSelectedToClipboard() {",
      "        if (selectedIndices.size === 0) return;",
      "        var entries = [];",
      "        selectedIndices.forEach(function(idx) { if (currentEntries[idx]) entries.push(currentEntries[idx]); });",
      "        if (entries.length === 0) return;",
      "        var paths = entries.map(function(e) { return nfm.currentRelativePath ? nfm.currentRelativePath + '/' + e.name : e.name; });",
      "        try {",
      "            var result = await api.nativeFsCutToClipboard({ mountId: nfm.mountId, capabilityToken: nfm.capabilityToken, paths: paths });",
      "            if (result && result.success === false) {",
      '                showToast("剪切失败: " + (result.error || "未知错误"));',
      "            } else {",
      "                showToast('已剪切: ' + entries.length + ' 个项目');",
      "            }",
      "        } catch (err) {",
      '            showToast("剪切失败: " + (err.message || err));',
      "        }",
      "    }",
      "",
      "    // === 粘贴 ===",
      "    async function pasteHere() {",
      "        try {",
      '            var result = await api.nativeFsPasteFromClipboard({ mountId: nfm.mountId, capabilityToken: nfm.capabilityToken, destDir: nfm.currentRelativePath || ".", strategy: "rename" });',
      "            if (result && result.success === false) {",
      '                showToast("粘贴失败: " + (result.error || "未知错误"));',
      "            } else {",
      "                var pastedCount = 0;",
      "                var errorMsgs = [];",
      "                if (result && result.results) {",
      "                    result.results.forEach(function(r) {",
      "                        if (r.error) errorMsgs.push(r.error);",
      "                        else if (r.dest) pastedCount++;",
      "                    });",
      "                }",
      "                if (errorMsgs.length > 0 && pastedCount === 0) {",
      '                    showToast("粘贴失败: " + errorMsgs[0]);',
      "                } else if (pastedCount > 0) {",
      '                    showToast("粘贴完成 (" + pastedCount + " 个文件)");',
      "                } else {",
      '                    showToast("粘贴完成");',
      "                }",
      '                loadDirectory(nfm.currentRelativePath || ".");',
      "            }",
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
      '        else if (ev.ctrlKey && ev.key === "x") { ev.preventDefault(); cutSelectedToClipboard(); }',
      '        else if (ev.ctrlKey && ev.key === "v") { ev.preventDefault(); pasteHere(); }',
      '        else if (ev.ctrlKey && ev.key === "a") { ev.preventDefault(); selectedIndices.clear(); for (var i = 0; i < currentEntries.length; i++) selectedIndices.add(i); if (currentEntries.length > 0) lastClickIndex = 0; updateVisualSelection(); }',
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
    var uiConfig = config.ui || null;

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

    // Phase 3: Frame 配置
    var frameOpts = opts.frame || {};
    var widgetEl = widgetData.element;

    if (frameOpts.transparent === true) {
      widgetEl.style.background = "transparent";
      widgetEl.style.border = "none";
      widgetEl.style.boxShadow = "none";
    }
    if (frameOpts.background !== undefined)
      widgetEl.style.background = frameOpts.background;
    if (frameOpts.border !== undefined)
      widgetEl.style.border = frameOpts.border;
    if (frameOpts.shadow !== undefined)
      widgetEl.style.boxShadow = frameOpts.shadow;
    if (frameOpts.opacity != null)
      widgetEl.style.opacity = String(frameOpts.opacity);

    if (frameOpts.showGrip === false) {
      var gripEl = widgetEl.querySelector(".desktop-widget-grip");
      if (gripEl) gripEl.style.display = "none";
    }
    if (frameOpts.showCloseButton === false) {
      var closeBtnEl = widgetEl.querySelector(".desktop-widget-close-btn");
      if (closeBtnEl) closeBtnEl.style.display = "none";
    }
    if (frameOpts.resizable === false && widgetData._resizeObserver) {
      widgetData._resizeObserver.disconnect();
      widgetData._resizeObserver = null;
    }

    // 保存状态
    widgetData._nfm = {
      mountId: regResult.mountId,
      capabilityToken: regResult.capabilityToken,
      mountPath: regResult.rootRealPath || mountPath,
      currentRelativePath: "",
      mode: mode,
      uiConfig: uiConfig,
    };

    // NativeFileMount 始终使用固定尺寸，禁用自动调整
    widgetData.fixedSize = true;

    // 注入 HTML
    var isCustomUI = !!(uiConfig && uiConfig.customUI);
    var fullHtml = buildWidgetHtml(widgetData._nfm.mountPath, mode, uiConfig);
    console.log(
      "[NFM] Generated HTML length:",
      fullHtml.length,
      "isCustomUI:",
      isCustomUI,
      "hasScript:",
      fullHtml.indexOf("<script>") !== -1
    );
    widgetData.contentBuffer = fullHtml;
    widgetData.contentContainer.innerHTML = fullHtml;
    widget.processInlineStyles(widgetData);
    widgetData.isConstructing = false;
    if (widgetData.element) widgetData.element.classList.remove("constructing");
    widget.autoResize(widgetData);

    // 延迟执行内联脚本
    setTimeout(function () {
      var scripts = widgetData.contentContainer.querySelectorAll("script");
      console.log(
        "[NFM] processInlineScripts: found",
        scripts.length,
        "script(s) in contentContainer"
      );
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
