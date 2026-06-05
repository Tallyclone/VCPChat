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

    const validCommands =
      "'SetWallpaper', 'QueryDesktop', 'QueryDock', 'QueryWidget', 'ViewWidgetSource', 'EditWidget', 'DESKTOP_WIDGET_EDIT', 'CreateWidget', 'SetStyleAutomation', 'GetStyleAutomationStatus', 'NativeFileMountAction', 'QueryNativeFileMounts'";

    if (!command) {
      throw new Error(
        `The 'command' parameter is required. Valid commands: ${validCommands}.`
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
      normalizedCommand === "querywidget" ||
      normalizedCommand === "query_widget"
    ) {
      const widgetId = _readWidgetId(args);
      if (!widgetId) {
        throw new Error(
          "The 'widgetId' parameter is required for QueryWidget command."
        );
      }
      const level =
        args.level ||
        args.Level ||
        args.queryLevel ||
        args.QueryLevel ||
        "summary";
      console.log(
        JSON.stringify({
          command: "QueryWidget",
          widgetId,
          level,
        })
      );
    } else if (
      normalizedCommand === "editwidget" ||
      normalizedCommand === "edit_widget" ||
      normalizedCommand === "desktop_widget_edit" ||
      normalizedCommand === "desktopwidgetedit"
    ) {
      const widgetId = _readWidgetId(args);
      if (!widgetId) {
        throw new Error(
          "The 'widgetId' parameter is required for EditWidget command."
        );
      }
      const payload = {
        widgetId,
        mode: args.mode || args.Mode || "targetReplace",
        sourceFormat:
          args.sourceFormat ||
          args.sourceformat ||
          args.SourceFormat ||
          undefined,
        source: args.source ?? args.Source,
        targetFile:
          args.targetFile ||
          args.targetfile ||
          args.TargetFile ||
          args.file ||
          args.File,
        target: args.target ?? args.Target,
        replace:
          args.replace ?? args.Replace ?? args.replacement ?? args.Replacement,
        replacements: Array.isArray(args.replacements || args.Replacements)
          ? args.replacements || args.Replacements
          : undefined,
        persist: args.persist ?? args.Persist ?? "runtime",
      };
      for (const versionKey of [
        "baseSourceVersion",
        "baseWidgetVersion",
        "baseLayoutVersion",
      ]) {
        const value = args[versionKey] ?? args[_capitalize(versionKey)];
        if (value !== undefined && value !== null && value !== "") {
          const numericValue = Number(value);
          payload[versionKey] = Number.isFinite(numericValue)
            ? numericValue
            : value;
        }
      }
      Object.keys(payload).forEach((key) => {
        if (payload[key] === undefined || payload[key] === null)
          delete payload[key];
      });
      console.log(JSON.stringify({ command: "EditWidget", payload }));
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
      normalizedCommand === "querynativefilemounts" ||
      normalizedCommand === "query_native_file_mounts"
    ) {
      console.log(JSON.stringify({ command: "QueryNativeFileMounts" }));
    } else if (
      normalizedCommand === "nativefilemountaction" ||
      normalizedCommand === "native_file_mount_action"
    ) {
      const payload =
        args.payload && typeof args.payload === "object"
          ? args.payload
          : {
              widgetId: args.widgetId || args.widgetid || args.WidgetId,
              mountId: args.mountId || args.mountid || args.MountId,
              source: "agent",
              intent: args.intent || args.Intent || null,
              summary: args.summary || args.Summary || null,
              operations: args.operations || args.Operations || [],
              risk: args.risk || args.Risk || null,
            };
      delete payload.capabilityToken;
      console.log(
        JSON.stringify({ command: "NativeFileMountAction", payload })
      );
    } else {
      throw new Error(
        `Unknown command: '${command}'. Valid commands: ${validCommands}.`
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

function _capitalize(value) {
  return String(value || "").replace(/^./, (ch) => ch.toUpperCase());
}

function _readWidgetId(args) {
  return (
    args.widgetId ||
    args.widgetid ||
    args.WidgetId ||
    args.widget_id ||
    args.id ||
    args.Id ||
    null
  );
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
