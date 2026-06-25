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
      "    // ---- Runtime error collection ----",
      "    if (!nfmState.runtimeErrors) { nfmState.runtimeErrors = []; }",
      "    function _nfmPushError(msg, source, lineno) {",
      "        if (nfmState.runtimeErrors.length >= 10) return;",
      "        nfmState.runtimeErrors.push({ message: String(msg).slice(0, 300), source: source || 'customUI.js', line: lineno || 0, ts: Date.now() });",
      "    }",
      "    window.addEventListener('error', function(ev) {",
      "        _nfmPushError(ev.message || ev.error, ev.filename || 'customUI', ev.lineno);",
      "    });",
      "    window.addEventListener('unhandledrejection', function(ev) {",
      "        var reason = ev.reason;",
      "        var msg = reason instanceof Error ? reason.message : String(reason);",
      "        _nfmPushError('UnhandledPromiseRejection: ' + msg, 'customUI.js(async)', 0);",
      "    });",
      "    // ---- End error collection ----",
      "",
      "    var nfm = {",
      "        mountId: nfmState.mountId,",
      "        mountPath: nfmState.mountPath,",
      "        mode: nfmState.mode,",
      '        list: function(relPath) { return api.nativeFsList({ mountId: nfmState.mountId, capabilityToken: nfmState.capabilityToken, path: relPath || "." }).then(function(r) { if (!r || !r.success) { return { success: false, error: r ? r.error : "Unknown error", entries: [], currentPath: "" }; } r.entries = r.entries || []; r.entries.forEach(function(e) { e.isDir = e.isDirectory = (e.type === "directory"); }); return r; }); },',
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
      "        _nfmPushError(_nfmErr.message || String(_nfmErr), 'customUI.js(sync)', _nfmErr.lineNumber || 0);",
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
      " --nfm-primary:" + (theme.primary || "hsl(217, 91%, 60%)") + ";" +
      " --nfm-primary-glow:rgba(137, 180, 250, 0.15);" +
      " --nfm-bg:" + (theme.background || "rgba(15, 15, 15, 0.2)") + ";" +
      " --nfm-bg-secondary:" + (theme.background || "rgba(10, 10, 10, 0.15)") + ";" +
      " --nfm-bg-input:" + (theme.background || "rgba(0, 0, 0, 0.2)") + ";" +
      " --nfm-text:" + (theme.foreground || "hsl(226, 64%, 90%)") + ";" +
      " --nfm-text-secondary:" + (theme.foreground || "hsl(228, 24%, 72%)") + ";" +
      " --nfm-text-muted:" + (theme.foreground || "hsl(233, 14%, 53%)") + ";" +
      " --nfm-border:" + (theme.border || "rgba(255, 255, 255, 0.08)") + ";" +
      " --nfm-hover:" + (theme.hover || "rgba(255, 255, 255, 0.05)") + ";" +
      " --nfm-selected:" + (theme.hover || "rgba(255, 255, 255, 0.09)") + ";" +
      " --nfm-accent:" + (theme.accent || "rgba(255, 255, 255, 0.03)") + ";" +
      " --nfm-shadow-lg:0 16px 40px rgba(0, 0, 0, 0.4);" +
      " --nfm-shadow-sm:0 2px 8px rgba(0, 0, 0, 0.2);" +
      " --nfm-item-height:" + (layout.itemHeight || 38) + "px;" +
      " --nfm-grid-cols:" + (layout.gridColumns || 4) + ";" +
      " --nfm-spacing:" + (layout.spacing || 8) + "px;" +
      " }";

    var css = [
      "<style>",
      cssVarBlock,
      '.nfm-container { position:relative; display:flex; flex-direction:column; height:100%; background:var(--nfm-bg); color:var(--nfm-text); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; font-size:13px; overflow:hidden; user-select:none; outline:none; backdrop-filter:blur(10px) saturate(130%); -webkit-backdrop-filter:blur(10px) saturate(130%); border:1px solid var(--nfm-border); border-radius:12px; }',
      ".nfm-toolbar { display:flex; align-items:center; gap:6px; padding:8px 12px; background:transparent; border-bottom:1px solid rgba(255,255,255,0.04); flex-shrink:0; }",
      ".nfm-svg-icon { width:14px; height:14px; stroke:currentColor; stroke-width:2.2; stroke-linecap:round; stroke-linejoin:round; fill:none; display:inline-block; vertical-align:middle; }",
      ".nfm-toolbar button { display:inline-flex; align-items:center; justify-content:center; width:28px; height:28px; padding:0; background:transparent; border:1px solid transparent; color:var(--nfm-text-secondary); border-radius:6px; cursor:pointer; transition:all 0.2s cubic-bezier(0.4, 0, 0.2, 1); }",
      ".nfm-toolbar button:hover { background:var(--nfm-hover); border-color:var(--nfm-border); color:var(--nfm-primary); transform:translateY(-1px); }",
      ".nfm-toolbar button:active { transform:scale(0.95); }",
      ".nfm-toolbar button:disabled { opacity:0.3; cursor:default; transform:none; }",
      ".nfm-toolbar button.nfm-btn-delete:hover { color:#f38ba8; background:rgba(243, 139, 168, 0.1); border-color:rgba(243, 139, 168, 0.2); }",
      ".nfm-path { flex:1; padding:6px 12px; background:var(--nfm-bg-input); border:1px solid var(--nfm-border); border-radius:6px; color:var(--nfm-text); font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace; font-size:11.5px; letter-spacing:0.3px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; box-shadow:none; }",
      ".nfm-file-header { display:grid; grid-template-columns:24px 1fr 90px 140px; gap:4px; padding:6px 16px; background:transparent; border-bottom:1px solid rgba(255,255,255,0.03); font-size:11px; color:var(--nfm-text-muted); flex-shrink:0; text-transform:uppercase; letter-spacing:0.5px; }",
      ".nfm-file-list-wrapper { flex:1; overflow-y:auto; overflow-x:hidden; padding:4px 0; }",
      ".nfm-file-list-wrapper::-webkit-scrollbar { width:6px; }",
      ".nfm-file-list-wrapper::-webkit-scrollbar-track { background:transparent; }",
      ".nfm-file-list-wrapper::-webkit-scrollbar-thumb { background:var(--nfm-hover); border-radius:3px; }",
      ".nfm-file-list-wrapper::-webkit-scrollbar-thumb:hover { background:var(--nfm-selected); }",
      ".nfm-file-row { display:grid; grid-template-columns:24px 1fr 90px 140px; gap:4px; padding:3px 16px; align-items:center; cursor:pointer; height:var(--nfm-item-height); margin:4px 8px; border-radius:6px; transition:all 0.15s ease; position:relative; }",
      ".nfm-file-row:hover { background:var(--nfm-hover); }",
      ".nfm-file-row.selected { background:var(--nfm-selected); }",
      ".nfm-file-row.selected::before { content:''; position:absolute; left:0; top:15%; height:70%; width:3px; background:var(--nfm-primary); border-radius:2px; box-shadow:0 0 8px var(--nfm-primary); }",
      ".nfm-file-row .nfm-icon { text-align:center; font-size:16px; line-height:1; }",
      ".nfm-file-row .nfm-name { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-weight:500; }",
      ".nfm-file-row .nfm-size { text-align:right; color:var(--nfm-text-secondary); font-size:12px; }",
      ".nfm-file-row .nfm-date { color:var(--nfm-text-muted); font-size:12px; padding-left:10px; }",
      ".nfm-dir-name { color:var(--nfm-text); font-weight: 500; }",
      ".nfm-status-bar { display:flex; align-items:center; justify-content:space-between; padding:6px 16px; background:var(--nfm-bg-secondary); border-top:1px solid var(--nfm-border); font-size:11px; color:var(--nfm-text-muted); flex-shrink:0; }",
      ".nfm-loading { display:flex; align-items:center; justify-content:center; height:100%; color:var(--nfm-text-muted); font-size:13px; gap:8px; }",
      ".nfm-empty { display:flex; align-items:center; justify-content:center; height:100%; color:var(--nfm-text-muted); font-size:13px; }",
      ".nfm-error { display:flex; align-items:center; justify-content:center; height:100%; color:#f38ba8; font-size:13px; padding:20px; text-align:center; }",
      ".nfm-ctx-menu { position:fixed; backdrop-filter:blur(25px); -webkit-backdrop-filter:blur(25px); background:rgba(40,40,40,0.85); border:1px solid var(--nfm-border); border-radius:8px; padding:4px 0; min-width:160px; box-shadow:var(--nfm-shadow-lg); z-index:99999; }",
      ".nfm-ctx-item { display:flex; align-items:center; gap:10px; padding:6px 16px; cursor:pointer; font-size:13px; color:var(--nfm-text); transition:all 0.15s ease; }",
      ".nfm-ctx-item:hover { background:var(--nfm-hover); color:var(--nfm-primary); }",
      ".nfm-ctx-item .nfm-svg-icon { width:14px; height:14px; stroke:currentColor; stroke-width:2.2; stroke-linecap:round; stroke-linejoin:round; fill:none; display:inline-block; flex-shrink:0; }",
      ".nfm-ctx-sep { height:1px; background:var(--nfm-border); margin:4px 0; }",
      ".nfm-rename-input { background:var(--nfm-bg-input); border:1px solid var(--nfm-primary); color:var(--nfm-text); padding:2px 6px; font-size:13px; border-radius:4px; outline:none; width:100%; box-sizing:border-box; box-shadow:0 0 8px var(--nfm-primary-glow); }",
      ".nfm-file-row.multi-selected { background:var(--nfm-hover); box-shadow:inset 2px 0 0 var(--nfm-text-muted); }",
      ".nfm-toolbar .nfm-sep { width:1px; height:18px; background:var(--nfm-border); margin:0 4px; }",
      ".nfm-toast { position:fixed; bottom:40px; left:50%; transform:translateX(-50%); backdrop-filter:blur(15px); -webkit-backdrop-filter:blur(15px); background:rgba(45,45,45,0.85); border:1px solid var(--nfm-border); color:var(--nfm-text); padding:8px 20px; border-radius:20px; font-size:12px; z-index:99999; pointer-events:none; opacity:0; transition:all 0.3s cubic-bezier(0.4, 0, 0.2, 1); box-shadow:var(--nfm-shadow-lg); }",
      ".nfm-toast.show { opacity:1; transform:translateX(-50%) translateY(-5px); }",
      ".nfm-dialog-overlay { position:fixed; top:0; left:0; right:0; bottom:0; backdrop-filter:blur(10px); -webkit-backdrop-filter:blur(10px); background:rgba(0,0,0,0.6); display:flex; align-items:center; justify-content:center; z-index:99999; }",
      ".nfm-dialog { backdrop-filter:blur(15px); -webkit-backdrop-filter:blur(15px); background:rgba(45,45,45,0.8); border:1px solid var(--nfm-border); border-radius:14px; padding:20px; min-width:300px; max-width:400px; box-shadow:var(--nfm-shadow-lg); transform:scale(0.95); opacity:0; animation:nfmDialogEnter 0.25s cubic-bezier(0.34, 1.56, 0.64, 1) forwards; }",
      "@keyframes nfmDialogEnter { to { transform:scale(1); opacity:1; } }",
      ".nfm-dialog-title { font-size:15px; font-weight:600; color:var(--nfm-text); margin-bottom:12px; }",
      ".nfm-dialog-input { width:100%; background:var(--nfm-bg-input); border:1px solid var(--nfm-border); color:var(--nfm-text); padding:8px 12px; font-size:13px; border-radius:6px; outline:none; box-sizing:border-box; transition:border-color 0.2s; }",
      ".nfm-dialog-input:focus { border-color:var(--nfm-primary); }",
      ".nfm-dialog-msg { font-size:13px; color:var(--nfm-text-secondary); margin-bottom:16px; line-height:1.5; }",
      ".nfm-dialog-btns { display:flex; justify-content:flex-end; gap:8px; margin-top:16px; }",
      ".nfm-dialog-btns button { padding:8px 16px; border:none; border-radius:6px; font-size:13px; cursor:pointer; font-weight:500; transition:all 0.2s; }",
      ".nfm-dialog-btns .nfm-btn-cancel { background:rgba(255,255,255,0.05); border:1px solid var(--nfm-border); color:var(--nfm-text-secondary); }",
      ".nfm-dialog-btns .nfm-btn-cancel:hover { background:var(--nfm-hover); color:var(--nfm-text); }",
      ".nfm-dialog-btns .nfm-btn-ok { background:var(--nfm-primary); color:#11111b; font-weight:600; }",
      ".nfm-dialog-btns .nfm-btn-ok:hover { background:white; opacity:0.95; }",
      ".nfm-dialog-btns .nfm-btn-danger { background:#f38ba8; color:#11111b; font-weight:600; }",
      ".nfm-dialog-btns .nfm-btn-danger:hover { background:white; opacity:0.95; }",
      // Grid layout styles
      ".nfm-container.nfm-grid .nfm-file-header { display:none; }",
      ".nfm-container.nfm-grid .nfm-file-list-wrapper { display:flex; flex-wrap:wrap; align-content:flex-start; padding:var(--nfm-spacing); gap:var(--nfm-spacing); }",
      ".nfm-container.nfm-grid .nfm-file-row { display:flex; flex-direction:column; align-items:center; justify-content:center; width:calc((100% - (var(--nfm-grid-cols) - 1) * var(--nfm-spacing)) / var(--nfm-grid-cols)); height:auto; min-height:80px; padding:var(--nfm-spacing); border-bottom:none; text-align:center; border-radius:8px; grid-template-columns:none; margin:0; }",
      ".nfm-container.nfm-grid .nfm-file-row .nfm-icon { font-size:28px; margin-bottom:6px; }",
      ".nfm-container.nfm-grid .nfm-file-row .nfm-name { font-size:11px; max-width:100%; word-break:break-all; white-space:normal; -webkit-line-clamp:2; display:-webkit-box; -webkit-box-orient:vertical; overflow:hidden; line-height:1.3; }",
      ".nfm-container.nfm-grid .nfm-file-row .nfm-size { display:none; }",
      ".nfm-container.nfm-grid .nfm-file-row .nfm-date { display:none; }",
      ".nfm-container.nfm-grid .nfm-file-row.selected::before { left:15%; top:auto; bottom:4px; height:3px; width:70%; }",
      "</style>",
    ].join("\n");

    // Toolbar generation (configurable)
    var allButtons = [
      { id: "up", cls: "nfm-btn-up", title: "上级目录", icon: '<svg class="nfm-svg-icon" viewBox="0 0 24 24"><path d="m18 15-6-6-6 6"/></svg>' },
      { id: "path", special: "path" },
      { id: "refresh", cls: "nfm-btn-refresh", title: "刷新", icon: '<svg class="nfm-svg-icon" viewBox="0 0 24 24"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>' },
      { id: "sep1", sep: true },
      {
        id: "newfolder",
        cls: "nfm-btn-newfolder",
        title: "新建文件夹",
        icon: '<svg class="nfm-svg-icon" viewBox="0 0 24 24"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/><line x1="12" y1="10" x2="12" y2="16"/><line x1="9" y1="13" x2="15" y2="13"/></svg>',
      },
      { id: "newfile", cls: "nfm-btn-newfile", title: "新建文件", icon: '<svg class="nfm-svg-icon" viewBox="0 0 24 24"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>' },
      { id: "sep2", sep: true },
      { id: "delete", cls: "nfm-btn-delete", title: "删除", icon: '<svg class="nfm-svg-icon" viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>' },
      { id: "paste", cls: "nfm-btn-paste", title: "粘贴", icon: '<svg class="nfm-svg-icon" viewBox="0 0 24 24"><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>' },
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
      '    <span class="nfm-status-mode">' + (mode === "readwrite" ? "读写" : "只读") + '</span>',
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
      '    if (!document.getElementById("nfm-global-styles")) {',
      "        var globalStyle = document.createElement('style');",
      "        globalStyle.id = 'nfm-global-styles';",
      "        globalStyle.textContent = [",
      "            '.nfm-ctx-menu { position:fixed; backdrop-filter:blur(10px) saturate(130%); -webkit-backdrop-filter:blur(10px) saturate(130%); background:rgba(20, 20, 20, 0.75); border:1px solid rgba(255, 255, 255, 0.08); border-radius:8px; padding:6px 0; min-width:170px; box-shadow:0 10px 30px rgba(0,0,0,0.5); z-index:99999; }',",
      "            '.nfm-ctx-item { display:flex; align-items:center; gap:10px; padding:6px 14px; cursor:pointer; font-size:12px; color:rgba(255, 255, 255, 0.85); transition:all 0.15s ease; font-family:-apple-system,BlinkMacSystemFont,\\\"Segoe UI\\\",Roboto,sans-serif; }',",
      "            '.nfm-ctx-item:hover { background:rgba(255, 255, 255, 0.08); color:hsl(217, 91%, 60%); }',",
      "            '.nfm-ctx-item .nfm-svg-icon { width:13px; height:13px; stroke:currentColor; stroke-width:2.2; stroke-linecap:round; stroke-linejoin:round; fill:none; display:inline-block; flex-shrink:0; }',",
      "            '.nfm-ctx-sep { height:1px; background:rgba(255, 255, 255, 0.08); margin:4px 0; }'",
      "        ].join('\\n');",
      "        document.head.appendChild(globalStyle);",
      "    }",
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
      '        var old = container.ownerDocument.querySelector(".nfm-ctx-menu");',
      "        if (old) old.remove();",
      "    }",
      "",
      "    function showContextMenu(x, y, entry) {",
      "        removeContextMenu();",
      "        var menu = container.ownerDocument.createElement(\"div\");",
      "        menu.className = \"nfm-ctx-menu\";",
      "        var items = [];",
      "        if (entry.type === \"directory\") {",
      "            items.push({ id: \"open\", label: \"打开文件夹\", icon: \"folder\", action: function() { navigateInto(entry.name); } });",
      "        } else {",
      "            items.push({ id: \"open\", label: \"打开文件\", icon: \"file\", action: function() { openFile(entry.name); } });",
      "        }",
      "        items.push({ id: \"reveal\", label: \"在资源管理器中显示\", icon: \"reveal\", action: function() { revealFile(entry.name); } });",
      "        items.push({ id: \"_sep1\", label: \"\" });",
      "        items.push({ id: \"rename\", label: \"重命名 (F2)\", icon: \"rename\", action: function() { renameSelected(); } });",
      "        items.push({ id: \"copy\", label: \"复制 (Ctrl+C)\", icon: \"copy\", action: function() { copySelectedToClipboard(); } });",
      "        items.push({ id: \"cut\", label: \"剪切 (Ctrl+X)\", icon: \"cut\", action: function() { cutSelectedToClipboard(); } });",
      "        items.push({ id: \"delete\", label: \"删除 (Delete)\", icon: \"delete\", action: function() { deleteSelected(); } });",
      "        items.push({ id: \"_sep2\", label: \"\" });",
      "        items.push({ id: \"paste\", label: \"粘贴 (Ctrl+V)\", icon: \"paste\", action: function() { pasteHere(); } });",
      "",
      "        // Phase 3: context menu filtering",
      "        var ctxConfig = (nfm.uiConfig && nfm.uiConfig.actions && nfm.uiConfig.actions.contextMenu) || null;",
      "        if (ctxConfig) {",
      "            var allowed = ctxConfig.split(\",\").map(function(s){return s.trim();});",
      "            items = items.filter(function(item) { return !item.id || item.id.charAt(0) === \"_\" || allowed.indexOf(item.id) !== -1; });",
      "        }",
      "",
      "        var svgMap = {",
      "            folder: '<svg class=\"nfm-svg-icon\" viewBox=\"0 0 24 24\"><path d=\"M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z\"/></svg>',",
      "            file: '<svg class=\"nfm-svg-icon\" viewBox=\"0 0 24 24\"><path d=\"M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z\"/><path d=\"M14 2v4a2 2 0 0 0 2 2h4\"/></svg>',",
      "            reveal: '<svg class=\"nfm-svg-icon\" viewBox=\"0 0 24 24\"><path d=\"M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z\"/><circle cx=\"12\" cy=\"12\" r=\"3\"/></svg>',",
      "            rename: '<svg class=\"nfm-svg-icon\" viewBox=\"0 0 24 24\"><path d=\"M12 20h9\"/><path d=\"M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z\"/></svg>',",
      "            copy: '<svg class=\"nfm-svg-icon\" viewBox=\"0 0 24 24\"><rect x=\"9\" y=\"9\" width=\"13\" height=\"13\" rx=\"2\" ry=\"2\"/><path d=\"M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1\"/></svg>',",
      "            cut: '<svg class=\"nfm-svg-icon\" viewBox=\"0 0 24 24\"><circle cx=\"6\" cy=\"6\" r=\"3\"/><circle cx=\"6\" cy=\"18\" r=\"3\"/><line x1=\"20\" y1=\"4\" x2=\"8.12\" y2=\"15.88\"/><line x1=\"14.47\" y1=\"14.48\" x2=\"20\" y2=\"20\"/><line x1=\"8.12\" y1=\"8.12\" x2=\"12\" y2=\"12\"/></svg>',",
      "            delete: '<svg class=\"nfm-svg-icon\" viewBox=\"0 0 24 24\"><path d=\"M3 6h18\"/><path d=\"M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6\"/><path d=\"M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2\"/><line x1=\"10\" y1=\"11\" x2=\"10\" y2=\"17\"/><line x1=\"14\" y1=\"11\" x2=\"14\" y2=\"17\"/></svg>',",
      "            paste: '<svg class=\"nfm-svg-icon\" viewBox=\"0 0 24 24\"><rect x=\"8\" y=\"2\" width=\"8\" height=\"4\" rx=\"1\" ry=\"1\"/><path d=\"M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2\"/></svg>'",
      "        };",
      "",
      "        items.forEach(function(item) {",
      "            if (!item.label) { var sep = container.ownerDocument.createElement(\"div\"); sep.className = \"nfm-ctx-sep\"; menu.appendChild(sep); return; }",
      "            var el = container.ownerDocument.createElement(\"div\");",
      "            el.className = \"nfm-ctx-item\";",
      "            var iconHtml = svgMap[item.icon] || '';",
      "            el.innerHTML = iconHtml + '<span class=\"nfm-ctx-label\">' + item.label + '</span>';",
      "            el.addEventListener(\"click\", function(ev) { ev.stopPropagation(); removeContextMenu(); if (item.action) item.action(); });",
      "            menu.appendChild(el);",
      "        });",
      "        var maxX = window.innerWidth - 180;",
      "        var maxY = window.innerHeight - (items.length * 32 + 8);",
      "        menu.style.left = Math.max(0, Math.min(x, maxX)) + \"px\";",
      "        menu.style.top = Math.max(0, Math.min(y, maxY)) + \"px\";",
      "        container.ownerDocument.body.appendChild(menu);",
      "        setTimeout(function() {",
      "            container.ownerDocument.addEventListener(\"click\", removeContextMenu, { once: true });",
      "            container.ownerDocument.addEventListener(\"contextmenu\", removeContextMenu, { once: true });",
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
      '        var menu = container.ownerDocument.createElement("div");',
      '        menu.className = "nfm-ctx-menu";',
      "        var emptyItems = [",
      '            { id: "paste", label: "粘贴 (Ctrl+V)", icon: "paste", action: function() { pasteHere(); } },',
      '            { id: "_sep1", label: "" },',
      '            { id: "newfolder", label: "新建文件夹", icon: "newfolder", action: function() { createNewFolder(); } },',
      '            { id: "newfile", label: "新建文件", icon: "newfile", action: function() { createNewFile(); } },',
      '            { id: "_sep2", label: "" },',
      '            { id: "refresh", label: "刷新", icon: "refresh", action: function() { loadDirectory(nfm.currentRelativePath || "."); } }',
      "        ];",
      "        var svgMap = {",
      '            folder: \'<svg class="nfm-svg-icon" viewBox="0 0 24 24"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>\',',
      '            file: \'<svg class="nfm-svg-icon" viewBox="0 0 24 24"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>\',',
      '            reveal: \'<svg class="nfm-svg-icon" viewBox="0 0 24 24"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>\',',
      '            rename: \'<svg class="nfm-svg-icon" viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>\',',
      '            copy: \'<svg class="nfm-svg-icon" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>\',',
      '            cut: \'<svg class="nfm-svg-icon" viewBox="0 0 24 24"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>\',',
      '            delete: \'<svg class="nfm-svg-icon" viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>\',',
      '            paste: \'<svg class="nfm-svg-icon" viewBox="0 0 24 24"><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>\',',
      '            newfolder: \'<svg class="nfm-svg-icon" viewBox="0 0 24 24"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/><line x1="12" y1="10" x2="12" y2="16"/><line x1="9" y1="13" x2="15" y2="13"/></svg>\',',
      '            newfile: \'<svg class="nfm-svg-icon" viewBox="0 0 24 24"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>\',',
      '            refresh: \'<svg class="nfm-svg-icon" viewBox="0 0 24 24"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>\'',
      "        };",
      "        emptyItems.forEach(function(item) {",
      '            if (!item.label) { var sep = container.ownerDocument.createElement("div"); sep.className = "nfm-ctx-sep"; menu.appendChild(sep); return; }',
      '            var el = container.ownerDocument.createElement("div");',
      '            el.className = "nfm-ctx-item";',
      "            var iconHtml = svgMap[item.icon] || '';",
      "            el.innerHTML = iconHtml + '<span class=\"nfm-ctx-label\">' + item.label + '</span>';",
      '            el.addEventListener("click", function(e2) { e2.stopPropagation(); removeContextMenu(); if (item.action) item.action(); });',
      "            menu.appendChild(el);",
      "        });",
      "        var maxX = window.innerWidth - 180;",
      "        var maxY = window.innerHeight - (emptyItems.length * 32 + 8);",
      "        menu.style.left = Math.max(0, Math.min(ev.clientX, maxX)) + \"px\";",
      "        menu.style.top = Math.max(0, Math.min(ev.clientY, maxY)) + \"px\";",
      "        container.ownerDocument.body.appendChild(menu);",
      "        setTimeout(function() {",
      '            container.ownerDocument.addEventListener("click", removeContextMenu, { once: true });',
      '            container.ownerDocument.addEventListener("contextmenu", removeContextMenu, { once: true });',
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

  // ========== 辅助函数：重建 source 文本 ==========
  function _rebuildSourceText(data) {
    var config = data.config || {};
    var opts = data.options || {};
    var lines = [];
    lines.push("type: nativeFileMount");
    if (config.mountPath)
      lines.push("mountPath:「始」" + config.mountPath + "「末」");
    if (config.mode) lines.push("mode: " + config.mode);
    if (opts.width) lines.push("width: " + opts.width);
    if (opts.height) lines.push("height: " + opts.height);
    if (opts.x != null) lines.push("x: " + opts.x);
    if (opts.y != null) lines.push("y: " + opts.y);
    var frame = opts.frame || {};
    for (var fKey in frame) {
      if (frame.hasOwnProperty(fKey)) {
        lines.push("frame." + fKey + ": " + String(frame[fKey]));
      }
    }
    if (config.ui) {
      _flattenObject("ui", config.ui, lines);
    }
    return lines.join("\n");
  }

  function _flattenObject(prefix, obj, lines) {
    for (var key in obj) {
      if (!obj.hasOwnProperty(key)) continue;
      var fullKey = prefix + "." + key;
      var val = obj[key];
      if (val && typeof val === "object" && !Array.isArray(val)) {
        _flattenObject(fullKey, val, lines);
      } else {
        var strVal = String(val);
        if (strVal.indexOf("\n") !== -1) {
          lines.push(fullKey + ":「始ESCAPE」" + strVal + "「末ESCAPE」");
        } else {
          lines.push(fullKey + ": " + strVal);
        }
      }
    }
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

      // 保存错误状态
      widgetData._nfm = {
        mountId: null,
        capabilityToken: null,
        mountPath: mountPath,
        currentRelativePath: "",
        mode: mode,
        uiConfig: uiConfig,
        status: "error",
        errorMessage: errorMsg,
      };

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
      frame: opts.frame || undefined,
    });

    // Phase 3: Frame 配置
    var frameOpts = opts.frame || {};
    var widgetEl = widgetData.element;
    // 强制使外部挂件容器与内容区域透明、无边框、无阴影，并绕过 Chromium 的圆角+裁剪毛玻璃渲染 Bug
    if (widgetEl) {
      widgetEl.style.background = "transparent";
      widgetEl.style.border = "none";
      widgetEl.style.boxShadow = "none";
      widgetEl.style.contain = "none"; // 移除 contain 限制，允许 backdrop-filter 穿透合成

      var contentEl = widgetEl.querySelector('.desktop-widget-content');
      if (contentEl) {
        contentEl.style.background = "transparent";
        contentEl.style.borderRadius = "0"; // 移除外层圆角以使内层毛玻璃渲染
        contentEl.style.overflow = "visible"; // 移除裁剪以便内层容器独立处理毛玻璃和阴影
      }
    }
    if (widgetData.contentContainer) {
      widgetData.contentContainer.style.background = "transparent";
    }
    if (widgetData.shadowRoot) {
      var overrideStyle = document.createElement("style");
      overrideStyle.textContent = ":host { overflow: visible !important; }";
      widgetData.shadowRoot.appendChild(overrideStyle);
    }
    if (frameOpts.opacity != null)
      widgetEl.style.opacity = String(frameOpts.opacity);

    if (frameOpts.showGrip === false) {
      var gripEl = widgetEl.querySelector(".desktop-widget-grip");
      if (gripEl) gripEl.style.display = "none";
    } else if (frameOpts.showGrip === true) {
      var gripEl = widgetEl.querySelector(".desktop-widget-grip");
      if (gripEl) gripEl.style.display = "";
    }
    if (frameOpts.showCloseButton === false) {
      var closeBtnEl = widgetEl.querySelector(".desktop-widget-close-btn");
      if (closeBtnEl) closeBtnEl.style.display = "none";
    } else if (frameOpts.showCloseButton === true) {
      var closeBtnEl = widgetEl.querySelector(".desktop-widget-close-btn");
      if (closeBtnEl) closeBtnEl.style.display = "";
    }
    // resizable（即 autoResize：内容变化时自动调整挂件尺寸）默认关闭。
    // NativeFileMount 有固定布局，内容溢出应由内部 overflow 滚动处理，
    // 不应让挂件随内容无限撑大，破坏 Agent 指定的 width/height。
    // 仅当 Agent 显式传 frame_resizable: true 时才开启 autoResize。
    if (frameOpts.resizable === true) {
      widgetData.fixedSize = false;
    } else {
      widgetData.fixedSize = true;
    }

    // 保存状态
    widgetData._nfm = {
      mountId: regResult.mountId,
      capabilityToken: regResult.capabilityToken,
      mountPath: regResult.rootRealPath || mountPath,
      currentRelativePath: "",
      mode: mode,
      uiConfig: uiConfig,
      status: "mounted",
      errorMessage: null,
    };

    // 保存原始 BUILTIN source 文本，用于收藏保存和编辑
    widgetData._builtinSource = data._builtinSource || null;
    widgetData._builtinType = "nativeFileMount";
    if (!widgetData._builtinSource) {
      widgetData._builtinSource = _rebuildSourceText(data);
    }

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

  // ========== Edit 模式处理 ==========
  function handleEditBuiltinWidget(data) {
    var widgetId = data.widgetId;
    if (!widgetId) {
      console.warn("[NFM] editBuiltinWidget: missing widgetId");
      return;
    }

    var widgetData = state.widgets.get(widgetId);
    if (!widgetData || !widgetData._builtinSource) {
      console.warn(
        "[NFM] editBuiltinWidget: widget not found or no source:",
        widgetId
      );
      return;
    }

    var mode = data.mode || "targetReplace";
    if (mode === "targetReplace") {
      var target = data.target;
      var replace = data.replace;
      if (target == null || replace == null) {
        console.warn("[NFM] editBuiltinWidget: missing target or replace");
        return;
      }

      var source = widgetData._builtinSource;
      var idx = source.indexOf(target);

      // Fallback: 如果精确匹配失败，尝试去除定界符标记后匹配
      // Agent 可能在 target 中包含或遗漏定界符，导致与 source 中的文本不一致
      if (idx === -1) {
        var stripDelimiters = function (s) {
          return s
            .replace(/「始ESCAPE」/g, "")
            .replace(/「末ESCAPE」/g, "")
            .replace(/「始」/g, "")
            .replace(/「末」/g, "");
        };
        var strippedSource = stripDelimiters(source);
        var strippedTarget = stripDelimiters(target);
        var strippedIdx = strippedSource.indexOf(strippedTarget);
        if (strippedIdx !== -1) {
          // 在去定界符的文本上匹配成功 — 用去定界符的 source 做替换
          var strippedReplace = stripDelimiters(replace);
          var newStrippedSource =
            strippedSource.substring(0, strippedIdx) +
            strippedReplace +
            strippedSource.substring(strippedIdx + strippedTarget.length);
          console.log(
            "[NFM] editBuiltinWidget: matched via delimiter-stripped fallback, respawning widget:",
            widgetId
          );
          _respawnFromSource(widgetId, widgetData, newStrippedSource);
          return;
        }
        console.warn(
          "[NFM] editBuiltinWidget: target not found in source (also tried stripped match):",
          target.substring(0, 100) + "..."
        );
        return;
      }

      var newSource =
        source.substring(0, idx) +
        replace +
        source.substring(idx + target.length);
      console.log(
        "[NFM] editBuiltinWidget: source modified, respawning widget:",
        widgetId
      );

      _respawnFromSource(widgetId, widgetData, newSource);
    } else {
      console.warn("[NFM] editBuiltinWidget: unknown mode:", mode);
    }
  }

  async function _respawnFromSource(widgetId, oldWidgetData, newSource) {
    var parsed = _parseSourceText(newSource);
    if (!parsed || parsed.type !== "nativeFileMount") {
      console.error("[NFM] _respawnFromSource: invalid source after edit");
      return;
    }

    var rect = oldWidgetData.element
      ? oldWidgetData.element.getBoundingClientRect()
      : null;
    var oldNfm = oldWidgetData._nfm || {};

    // 保存位置信息和 capabilityToken
    var newWidgetId =
      "nfm-edit-" +
      Date.now() +
      "-" +
      Math.random().toString(36).substring(2, 7);
    var spawnData = {
      widgetId: newWidgetId,
      config: parsed.config,
      options: {
        x: rect ? Math.round(rect.left) : 200,
        y: rect ? Math.round(rect.top) : 150,
        width: parsed.options.width || (rect ? Math.round(rect.width) : 880),
        height: parsed.options.height || (rect ? Math.round(rect.height) : 620),
        frame: parsed.options.frame || {},
      },
      _builtinSource: newSource,
    };

    // 先注销旧 mount（在 remove 之前调用，因为 remove 后 widgetData 会被清理）
    if (oldNfm.mountId && oldNfm.capabilityToken) {
      try {
        await desktopApi.nativeFsUnmount({
          mountId: oldNfm.mountId,
          capabilityToken: oldNfm.capabilityToken,
        });
      } catch (err) {
        console.warn("[NFM] Failed to unmount old mount:", err);
      }
    }

    // 移除旧 widget（带退出动画，使用新 ID 避免 removingWidgetIds 冲突）
    widget.remove(widgetId);

    // 用新 ID 重新创建 widget（无需等待旧 widget 动画完成）
    await spawnNativeFileMount(spawnData);
    console.log(
      "[NFM] Respawned widget from edited source:",
      newWidgetId,
      "(old:",
      widgetId,
      ")"
    );
  }

  // ========== 轻量级 source 文本解析 ==========
  function _parseSourceText(source) {
    var result = { type: "", config: {}, options: {} };
    var lines = source.split(/\r?\n/);
    var i = 0;

    while (i < lines.length) {
      var trimmed = lines[i].trim();
      i++;
      if (!trimmed || trimmed.charAt(0) === "#" || trimmed.indexOf("//") === 0)
        continue;

      var colonIdx = trimmed.indexOf(":");
      if (colonIdx === -1) continue;

      var key = trimmed.substring(0, colonIdx).trim();
      var value = trimmed.substring(colonIdx + 1).trim();

      // 定界符常量
      var DELIM_START_ESC =
        "\u300C\u59CB\u0045\u0053\u0043\u0041\u0050\u0045\u300D";
      var DELIM_END_ESC =
        "\u300C\u672B\u0045\u0053\u0043\u0041\u0050\u0045\u300D";
      var DELIM_START = "\u300C\u59CB\u300D";
      var DELIM_END = "\u300C\u672B\u300D";

      // 定界符处理：深度计数配对（支持嵌套）
      var startsWithEsc = value.indexOf(DELIM_START_ESC) === 0;
      var startsWithNorm = !startsWithEsc && value.indexOf(DELIM_START) === 0;

      if (startsWithEsc || startsWithNorm) {
        var openMark = startsWithEsc ? DELIM_START_ESC : DELIM_START;
        var closeMark = startsWithEsc ? DELIM_END_ESC : DELIM_END;

        // 把当前行冒号后文本 + 剩余所有行拼成一个完整文本
        var fullText = value + "\n" + lines.slice(i).join("\n");

        // 从 openMark 之后开始深度配对扫描
        var depth = 1;
        var pos = openMark.length;
        var matchContent = null;
        var matchEndPos = -1;
        while (pos < fullText.length && depth > 0) {
          if (fullText.indexOf(openMark, pos) === pos) {
            depth++;
            pos += openMark.length;
          } else if (fullText.indexOf(closeMark, pos) === pos) {
            depth--;
            if (depth === 0) {
              matchContent = fullText.substring(openMark.length, pos);
              matchEndPos = pos + closeMark.length;
              break;
            }
            pos += closeMark.length;
          } else {
            pos++;
          }
        }

        if (matchContent !== null) {
          value = matchContent.replace(/^\n+|\n+$/g, ""); // 去首尾空行
          // 计算消耗了多少行
          var consumed = fullText.substring(0, matchEndPos);
          var newlineCount = 0;
          for (var ci = 0; ci < consumed.length; ci++) {
            if (consumed.charAt(ci) === "\n") newlineCount++;
          }
          i += newlineCount; // 跳过消耗的行
        } else {
          // fallback: 没找到配对，取到文件末尾
          value = fullText.substring(openMark.length).replace(/^\n+|\n+$/g, "");
          i = lines.length;
        }
      } else {
        // 无定界符 — 值就是冒号后面的内容（已 trim）
        // 但仍检查是否有单行残留定界符需要剥离
        var escMatch = value.match(
          /^\u300C\u59CBESCAPE\u300D([\s\S]*?)\u300C\u672BESCAPE\u300D$/
        );
        if (escMatch) {
          value = escMatch[1];
        } else {
          var normMatch = value.match(
            /^\u300C\u59CB\u300D([\s\S]*?)\u300C\u672B\u300D$/
          );
          if (normMatch) {
            value = normMatch[1];
          }
        }
      }

      if (key === "type") {
        result.type = value;
      } else if (
        key === "width" ||
        key === "height" ||
        key === "x" ||
        key === "y"
      ) {
        result.options[key] = Number(value) || 0;
      } else if (key.indexOf("frame.") === 0) {
        if (!result.options.frame) result.options.frame = {};
        var frameProp = key.substring(6);
        result.options.frame[frameProp] = _autoConvert(value);
      } else if (key.indexOf("ui.") === 0) {
        _setNested(result.config, key, _autoConvert(value));
      } else {
        result.config[key] = _autoConvert(value);
      }
    }

    return result.type ? result : null;
  }

  function _autoConvert(v) {
    if (v === "true") return true;
    if (v === "false") return false;
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    return v;
  }

  function _setNested(obj, dottedKey, value) {
    var parts = dottedKey.split(".");
    var target = obj;
    for (var i = 0; i < parts.length - 1; i++) {
      if (!target[parts[i]] || typeof target[parts[i]] !== "object") {
        target[parts[i]] = {};
      }
      target = target[parts[i]];
    }
    target[parts[parts.length - 1]] = value;
  }

  // ========== QueryDesktop: getQueryInfo ==========
  function getQueryInfo(widgetId) {
    var widgetData = state.widgets.get(widgetId);
    if (!widgetData || !widgetData._nfm) return null;

    var nfm = widgetData._nfm;
    var selectedItems = [];

    if (widgetData.contentContainer) {
      var selectedRows = widgetData.contentContainer.querySelectorAll(
        ".nfm-file-row.selected"
      );
      selectedRows.forEach(function (row) {
        var nameEl = row.querySelector(".nfm-file-name");
        if (nameEl) selectedItems.push(nameEl.textContent || "");
      });
    }

    return {
      type: "nativeFileMount",
      title: widgetData.savedName || "File Browser",
      nativeFileMount: {
        mountPath: nfm.mountPath,
        mode: nfm.mode,
        currentPath: nfm.currentRelativePath || "",
        selectedItems: selectedItems,
        status: nfm.status || "mounted",
        errorMessage: nfm.errorMessage || null,
      },
      source: widgetData._builtinSource || null,
      sourceFormat: "builtinKeyValue",
    };
  }

  // ========== DESKTOP_PUSH 监听已移除 ==========
  // NativeFileMount 现在完全通过 DesktopRemote Tool Request RPC 驱动
  // 创建: CreateNativeFileMount command → ipcBridge.js → spawn()
  // 编辑: EditNativeFileMount command → ipcBridge.js → edit()

  // ========== 导出 ==========
  window.VCPDesktop = window.VCPDesktop || {};
  window.VCPDesktop.builtinNativeFileMount = {
    spawn: spawnNativeFileMount,
    edit: handleEditBuiltinWidget,
    getQueryInfo: getQueryInfo,
  };

  console.log("[NFM] Native file mount widget module loaded.");
})();
