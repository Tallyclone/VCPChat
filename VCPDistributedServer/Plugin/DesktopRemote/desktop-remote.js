// desktop-remote.js
// This script acts as a simple data pipe and validator for DesktopRemote commands.
// It receives a JSON object from stdin, validates and normalizes it, then prints to stdout.
// The actual desktop control logic is handled by the main process (injected handler).

let inputBuffer = "";
process.stdin.setEncoding("utf8");

process.stdin.on("data", (chunk) => {
  inputBuffer += chunk;
});

process.stdin.on("end", () => {
  try {
    if (!inputBuffer.trim()) {
      throw new Error("No input received.");
    }

    const args = JSON.parse(inputBuffer);

    // Flexible command parameter recognition
    const command = args.command || args.Command || args.action || args.Action;

    if (!command) {
      throw new Error(
        "The 'command' parameter is required. Valid commands: 'SetWallpaper', 'QueryDesktop', 'QueryDock', 'ViewWidgetSource', 'CreateWidget', 'SetStyleAutomation', 'GetStyleAutomationStatus'."
      );
    }

    const normalizedCommand = command.toLowerCase();

    if (
      normalizedCommand === "setwallpaper" ||
      normalizedCommand === "set_wallpaper"
    ) {
      // SetWallpaper command
      const wallpaperSource =
        args.wallpaperSource ||
        args.wallpapersource ||
        args.WallpaperSource ||
        args.source ||
        args.Source ||
        args.url ||
        args.URL ||
        args.content ||
        args.Content;

      if (!wallpaperSource) {
        throw new Error(
          "The 'wallpaperSource' parameter is required for SetWallpaper command."
        );
      }

      const commandPayload = {
        command: "SetWallpaper",
        wallpaperSource: wallpaperSource,
      };

      console.log(JSON.stringify(commandPayload));
    } else if (
      normalizedCommand === "querydesktop" ||
      normalizedCommand === "query_desktop" ||
      normalizedCommand === "query"
    ) {
      // QueryDesktop command - no additional parameters needed
      const commandPayload = {
        command: "QueryDesktop",
      };

      console.log(JSON.stringify(commandPayload));
    } else if (
      normalizedCommand === "querydock" ||
      normalizedCommand === "query_dock" ||
      normalizedCommand === "listapps" ||
      normalizedCommand === "list_apps"
    ) {
      // QueryDock command - query the full Dock app list with launch info
      const commandPayload = {
        command: "QueryDock",
      };

      console.log(JSON.stringify(commandPayload));
    } else if (
      normalizedCommand === "viewwidgetsource" ||
      normalizedCommand === "view_widget_source" ||
      normalizedCommand === "viewsource"
    ) {
      // ViewWidgetSource command
      const widgetId =
        args.widgetId ||
        args.widgetid ||
        args.WidgetId ||
        args.widget_id ||
        args.id ||
        args.Id;

      if (!widgetId) {
        throw new Error(
          "The 'widgetId' parameter is required for ViewWidgetSource command."
        );
      }

      const commandPayload = {
        command: "ViewWidgetSource",
        widgetId: widgetId,
      };

      console.log(JSON.stringify(commandPayload));
    } else if (
      normalizedCommand === "createwidget" ||
      normalizedCommand === "create_widget" ||
      normalizedCommand === "create"
    ) {
      // CreateWidget command - create a new widget on the desktop canvas
      const htmlContent =
        args.htmlContent ||
        args.htmlcontent ||
        args.HtmlContent ||
        args.html ||
        args.Html ||
        args.content ||
        args.Content;

      if (!htmlContent) {
        throw new Error(
          "The 'htmlContent' parameter is required for CreateWidget command. Provide the HTML code for the widget."
        );
      }

      // Optional position and size parameters
      const x = _parseNumber(args.x || args.X || args.posX || args.positionX);
      const y = _parseNumber(args.y || args.Y || args.posY || args.positionY);
      const width = _parseNumber(args.width || args.Width || args.w);
      const height = _parseNumber(args.height || args.Height || args.h);

      // Optional widget ID and save options
      const widgetId =
        args.widgetId ||
        args.widgetid ||
        args.WidgetId ||
        args.widget_id ||
        args.id ||
        args.Id ||
        null;
      const autoSave = _parseBoolean(
        args.autoSave || args.autosave || args.AutoSave || args.auto_save
      );
      const saveName =
        args.saveName ||
        args.savename ||
        args.SaveName ||
        args.save_name ||
        args.name ||
        args.Name ||
        null;

      // Optional external script code (plain string, will be saved as app.js)
      const scriptCode =
        args.scriptFiles ||
        args.scriptfiles ||
        args.ScriptFiles ||
        args.script_files ||
        args.scriptCode ||
        args.scriptcode ||
        args.ScriptCode ||
        args.script_code ||
        null;

      const commandPayload = {
        command: "CreateWidget",
        htmlContent: htmlContent,
      };

      // Only include optional fields if they have valid values
      if (x !== null) commandPayload.x = x;
      if (y !== null) commandPayload.y = y;
      if (width !== null) commandPayload.width = width;
      if (height !== null) commandPayload.height = height;
      if (widgetId) commandPayload.widgetId = widgetId;
      if (autoSave) commandPayload.autoSave = true;
      if (saveName) commandPayload.saveName = saveName;

      // Include scriptCode if provided (plain JS string, saved as app.js)
      if (
        scriptCode &&
        typeof scriptCode === "string" &&
        scriptCode.trim().length > 0
      ) {
        commandPayload.scriptCode = scriptCode;
        // When scriptCode is provided, force autoSave (file needs persistent storage)
        commandPayload.autoSave = true;
        if (!commandPayload.saveName) {
          commandPayload.saveName = saveName || "AI Widget";
        }
      }

      console.log(JSON.stringify(commandPayload));
    } else if (
      normalizedCommand === "setstyleautomation" ||
      normalizedCommand === "set_style_automation" ||
      normalizedCommand === "styleautomation" ||
      normalizedCommand === "style_automation"
    ) {
      const configPatch = {};

      const hasEnabled =
        Object.prototype.hasOwnProperty.call(args, "enabled") ||
        Object.prototype.hasOwnProperty.call(args, "Enabled") ||
        Object.prototype.hasOwnProperty.call(args, "enable") ||
        Object.prototype.hasOwnProperty.call(args, "Enable");
      if (hasEnabled) {
        configPatch.enabled = _parseBoolean(
          args.enabled ?? args.Enabled ?? args.enable ?? args.Enable
        );
      }

      const intervalMsRaw =
        args.intervalMs ??
        args.IntervalMs ??
        args.interval ??
        args.Interval ??
        args.pollIntervalMs ??
        args.PollIntervalMs;
      const intervalMs = _parseNumber(intervalMsRaw);
      if (intervalMs !== null) {
        configPatch.intervalMs = intervalMs;
      }

      const metricsOptions = args.metricsOptions ?? args.MetricsOptions ?? null;
      if (metricsOptions && typeof metricsOptions === "object") {
        configPatch.metricsOptions = metricsOptions;
      }

      const rules = args.rules ?? args.Rules ?? null;
      if (rules !== null) {
        if (!Array.isArray(rules)) {
          throw new Error(
            "The 'rules' parameter must be an array when provided."
          );
        }
        configPatch.rules = rules;
      }

      const persist = _parseBoolean(
        args.persist ??
          args.Persist ??
          args.save ??
          args.Save ??
          args.persistConfig ??
          args.PersistConfig
      );

      const commandPayload = {
        command: "SetStyleAutomation",
        configPatch,
        persist,
      };

      console.log(JSON.stringify(commandPayload));
    } else if (
      normalizedCommand === "getstyleautomationstatus" ||
      normalizedCommand === "get_style_automation_status" ||
      normalizedCommand === "styleautomationstatus" ||
      normalizedCommand === "style_automation_status"
    ) {
      const commandPayload = {
        command: "GetStyleAutomationStatus",
      };

      console.log(JSON.stringify(commandPayload));
    } else if (
      normalizedCommand === "createnativefilemount" ||
      normalizedCommand === "create_native_file_mount" ||
      normalizedCommand === "nativefilemount"
    ) {
      // CreateNativeFileMount command - create a NativeFileMount widget on the desktop
      const mountPath =
        args.mountPath ||
        args.mountpath ||
        args.MountPath ||
        args.mount_path ||
        args.path ||
        args.Path;

      if (!mountPath) {
        throw new Error(
          "The 'mountPath' parameter is required for CreateNativeFileMount command. Provide the filesystem path to mount."
        );
      }

      const mode = (args.mode || args.Mode || "readonly").toLowerCase();
      if (mode !== "readonly" && mode !== "readwrite") {
        throw new Error(
          "The 'mode' parameter must be 'readonly' or 'readwrite'."
        );
      }

      const x = _parseNumber(args.x || args.X || args.posX);
      const y = _parseNumber(args.y || args.Y || args.posY);
      const width = _parseNumber(args.width || args.Width || args.w);
      const height = _parseNumber(args.height || args.Height || args.h);

      const commandPayload = {
        command: "CreateNativeFileMount",
        mountPath: mountPath,
        mode: mode,
      };

      if (x !== null) commandPayload.x = x;
      if (y !== null) commandPayload.y = y;
      if (width !== null) commandPayload.width = width;
      if (height !== null) commandPayload.height = height;

      // ====== Frame configuration (flat underscore keys) ======
      const frame = {};
      const frameKeyMap = {
        frame_transparent: "transparent",
        frame_background: "background",
        frame_border: "border",
        frame_shadow: "shadow",
        frame_opacity: "opacity",
        frame_showGrip: "showGrip",
        frame_showgrip: "showGrip",
        frame_showCloseButton: "showCloseButton",
        frame_showclosebutton: "showCloseButton",
        frame_resizable: "resizable",
        frame_minimal: "minimal",
        frame_Minimal: "minimal",
      };
      for (const [flatKey, prop] of Object.entries(frameKeyMap)) {
        if (args[flatKey] !== undefined) {
          frame[prop] = _autoConvertValue(args[flatKey]);
        }
      }
      if (Object.keys(frame).length > 0) {
        commandPayload.frame = frame;
      }

      // ====== UI configuration (flat underscore keys) ======
      const ui = {};

      // CustomUI: html / css / js (string values, no JSON parse needed)
      const customUIHtml =
        args.ui_customUI_html || args.ui_customui_html || null;
      const customUICss = args.ui_customUI_css || args.ui_customui_css || null;
      const customUIJs = args.ui_customUI_js || args.ui_customui_js || null;

      if (customUIHtml || customUICss || customUIJs) {
        ui.customUI = {};
        if (customUIHtml) ui.customUI.html = customUIHtml;
        if (customUICss) ui.customUI.css = customUICss;
        if (customUIJs) ui.customUI.js = customUIJs;
      }

      // Theme / Layout / Actions / Icons (JSON string values, need parse)
      const uiJsonFields = {
        ui_theme: "theme",
        ui_layout: "layout",
        ui_actions: "actions",
        ui_icons: "icons",
      };
      for (const [flatKey, prop] of Object.entries(uiJsonFields)) {
        const raw = args[flatKey] || args[flatKey.toLowerCase()] || null;
        if (raw) {
          if (typeof raw === "object") {
            ui[prop] = raw;
          } else if (typeof raw === "string") {
            try {
              ui[prop] = JSON.parse(raw);
            } catch (e) {
              // Not valid JSON — store as string fallback
              ui[prop] = raw;
            }
          }
        }
      }

      if (Object.keys(ui).length > 0) {
        commandPayload.ui = ui;
      }

      console.log(JSON.stringify(commandPayload));
    } else if (
      normalizedCommand === "editnativefilemount" ||
      normalizedCommand === "edit_native_file_mount" ||
      normalizedCommand === "editfilemount"
    ) {
      // EditNativeFileMount command - edit an existing NativeFileMount widget
      const widgetId =
        args.widgetId ||
        args.widgetid ||
        args.WidgetId ||
        args.widget_id ||
        args.id ||
        args.Id;

      if (!widgetId) {
        throw new Error(
          "The 'widgetId' parameter is required for EditNativeFileMount command."
        );
      }

      const target = args.target || args.Target;
      const replace = args.replace || args.Replace;

      if (!target) {
        throw new Error(
          "The 'target' parameter is required for EditNativeFileMount command. Provide the text to find in the widget source."
        );
      }
      if (replace === undefined || replace === null) {
        throw new Error(
          "The 'replace' parameter is required for EditNativeFileMount command. Provide the replacement text."
        );
      }

      const commandPayload = {
        command: "EditNativeFileMount",
        widgetId: widgetId,
        target: target,
        replace: replace,
      };

      console.log(JSON.stringify(commandPayload));
    } else {
      throw new Error(
        `Unknown command: '${command}'. Valid commands: 'SetWallpaper', 'QueryDesktop', 'QueryDock', 'ViewWidgetSource', 'CreateWidget', 'SetStyleAutomation', 'GetStyleAutomationStatus', 'CreateNativeFileMount', 'EditNativeFileMount'.`
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
});

/**
 * Parse a value as a number, return null if invalid
 * @param {*} val
 * @returns {number|null}
 */
function _parseNumber(val) {
  if (val === undefined || val === null) return null;
  const num = Number(val);
  return isNaN(num) ? null : num;
}

/**
 * Parse a value as a boolean
 * @param {*} val
 * @returns {boolean}
 */
function _parseBoolean(val) {
  if (val === undefined || val === null) return false;
  if (typeof val === "boolean") return val;
  if (typeof val === "string") return val.toLowerCase() === "true";
  return !!val;
}

/**
 * Auto-convert a string value to its appropriate JS type.
 * "true"/"false" → boolean, numeric strings → number, otherwise keep as string.
 * @param {*} val
 * @returns {*}
 */
function _autoConvertValue(val) {
  if (val === undefined || val === null) return val;
  if (typeof val !== "string") return val;
  const lower = val.toLowerCase();
  if (lower === "true") return true;
  if (lower === "false") return false;
  const num = Number(val);
  if (!isNaN(num) && val.trim() !== "") return num;
  return val;
}
