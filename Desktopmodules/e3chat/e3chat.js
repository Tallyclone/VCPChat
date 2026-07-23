"use strict";

(async function () {
  const api = window.e3chat;
  let chatRunning = false;
  let cancelPending = false;
  let attachments = [];

  // Custom Viewport History for session persistence
  let viewportHistory = {};

  // Theme colors and wallpapers are bound in each selected theme.
  let currentSelectedTheme = null;
  let currentThemeWallpaperUrl = "";
  let wallpaperApplyVersion = 0;
  let themePreviewObserver = null;

  const VIEWPORT_BACKGROUND_MODES = ["transparent", "black", "white"];
  const VIEWPORT_BACKGROUND_LABELS = {
    transparent: "透明",
    black: "黑色",
    white: "白色",
    custom: "自定义",
  };
  let viewportBackgroundMode = "transparent";
  let viewportBackgroundColor = "#2563EB";
  let viewportColorHsv = { h: 217, s: 0.83, v: 0.92 };
  let viewportColorSnapshot = null;

  function hexToRgba(hex, alpha = 0.85) {
    if (!hex || !hex.startsWith("#")) return hex;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  // Layout Mode
  let currentLayoutMode = "split"; // "split" or "single"

  const generation = () => window.E3MessageStreamRenderer.state.generation;
  const eventGeneration = (event) => {
    const parsed = Number(event?.connectionGeneration);
    return Number.isFinite(parsed) ? parsed : generation();
  };

  const iframe = document.getElementById("e3-viewport-iframe");
  const placeholder = document.getElementById("viewport-placeholder");
  const themeModeToggle = document.getElementById("theme-mode-toggle");
  const themesGrid = document.getElementById("settings-themes-grid");
  const wallpaperBg = document.getElementById("wallpaper-bg");

  // Load viewport drawing command history
  async function loadViewportHistory() {
    try {
      const state = await api.getLocalState("global");
      viewportHistory = state?.viewportHistory || {};
    } catch (e) {
      viewportHistory = {};
    }
  }

  // Save drawing command to persistent history
  async function saveViewportCommand(sessionId, cmd) {
    if (!sessionId) return;
    if (!viewportHistory[sessionId]) {
      viewportHistory[sessionId] = [];
    }
    if (cmd.methodName === "clear") {
      viewportHistory[sessionId] = [];
    } else {
      viewportHistory[sessionId].push(cmd);
    }
    try {
      await api.saveLocalState("global", { viewportHistory });
    } catch (e) {
      console.error("Failed to save viewport history:", e);
    }
  }

  // Viewport bridge renderer (globally accessible for workspaceSessionSidebar)
  window.E3ViewportBridgeRenderer = {
    clearViewport() {
      if (iframe && iframe.contentWindow) {
        iframe.contentWindow.postMessage(
          {
            type: "rpc",
            method: "clear",
            body: [],
            requestId: "clear-internal",
          },
          "*"
        );
      }
    },
    replaySessionViewport(sessionId) {
      this.clearViewport();
      if (!sessionId) return;
      const cmds = viewportHistory[sessionId] || [];
      if (!cmds.length) return;

      // Delay slightly to ensure viewport iframe is ready/cleared
      setTimeout(() => {
        if (!iframe || !iframe.contentWindow) return;
        cmds.forEach((cmd, idx) => {
          iframe.contentWindow.postMessage(
            {
              type: "rpc",
              method: cmd.methodName,
              body: cmd.body,
              requestId: `replay-${sessionId}-${idx}`,
            },
            "*"
          );
        });
      }, 150);
    },
  };

  function resolveThemeWallpaperUrl(wallpaperValue) {
    const match = String(wallpaperValue || "").match(
      /url\(['"]?\.\.\/assets\/wallpaper\/(.*?)['"]?\)/
    );
    return match
      ? new URL(`../../assets/wallpaper/${match[1]}`, window.location.href).href
      : "";
  }

  // Apply CSS variables on both root and body so the loaded VChat stylesheet cannot
  // override E3 Chat's locally selected light-theme variables on body.light-theme.
  function applyThemeVariables(variablesObj) {
    const targets = [document.documentElement, document.body];
    for (const [key, val] of Object.entries(variablesObj)) {
      const wallpaperUrl =
        key === "--chat-wallpaper-dark" || key === "--chat-wallpaper-light"
          ? resolveThemeWallpaperUrl(val)
          : "";
      const value = wallpaperUrl ? `url("${wallpaperUrl}")` : val;
      targets.forEach((target) => target.style.setProperty(key, value));
    }
  }

  // Decode the next wallpaper off-screen first to avoid blocking the theme click frame.
  function applyThemeWallpaper(theme, isLight) {
    wallpaperBg.replaceChildren();
    const darkVars = theme?.variables?.dark || {};
    const lightVars = theme?.variables?.light || {};
    const wpVal = isLight
      ? lightVars["--chat-wallpaper-light"] || darkVars["--chat-wallpaper-dark"]
      : darkVars["--chat-wallpaper-dark"];
    const wallpaperUrl = resolveThemeWallpaperUrl(wpVal);
    const applyVersion = ++wallpaperApplyVersion;
    currentThemeWallpaperUrl = wallpaperUrl;

    wallpaperBg.style.opacity = "";
    wallpaperBg.style.filter = "";
    if (!wallpaperUrl) {
      wallpaperBg.style.backgroundImage = "";
      applyViewportBackground();
      return;
    }

    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      if (applyVersion === wallpaperApplyVersion) {
        wallpaperBg.style.backgroundImage = `url("${wallpaperUrl}")`;
        applyViewportBackground();
      }
    };
    image.src = wallpaperUrl;
    if (image.complete) image.onload();
  }

  // Theme colors and wallpaper are applied together, but only inside E3 Chat.
  function selectTheme(theme, { persist = true } = {}) {
    currentSelectedTheme = theme;
    const isLight = document.body.classList.contains("light-theme");
    const vars = isLight ? theme.variables.light : theme.variables.dark;
    applyThemeVariables(vars || theme.variables.dark || {});
    applyThemeWallpaper(theme, isLight);

    if (persist) {
      api
        .saveLocalState("global", { selectedThemeFile: theme.fileName })
        .catch(() => {});
    }
    const themeOverlay = document.getElementById("theme-overlay");
    if (themeOverlay && !themeOverlay.hidden) updateThemePreview();
  }

  function setThemePreviewWallpaper(element, wallpaperValue) {
    if (!element) return;
    const wallpaperUrl = resolveThemeWallpaperUrl(wallpaperValue);
    element.style.backgroundImage = wallpaperUrl
      ? `url("${wallpaperUrl}")`
      : "";
    element.style.backgroundSize = "cover";
    element.style.backgroundPosition = "center";
  }

  function observeThemePreview(element, wallpaperValue) {
    if (!element) return;
    element.dataset.wallpaperValue = wallpaperValue || "";
    themePreviewObserver?.observe(element);
  }

  // Themes list loader. Wallpaper thumbnails are decoded only when cards approach view.
  async function loadThemesList() {
    try {
      const [themes, state] = await Promise.all([
        api.getThemes(),
        api.getLocalState("global"),
      ]);
      themesGrid.replaceChildren();
      const savedThemeFile = state?.selectedThemeFile || "themes星渊雪境.css";
      const fragment = document.createDocumentFragment();

      themePreviewObserver?.disconnect();
      themePreviewObserver = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            const element = entry.target;
            setThemePreviewWallpaper(element, element.dataset.wallpaperValue);
            themePreviewObserver.unobserve(element);
          });
        },
        {
          root: document.querySelector(".theme-overlay-body"),
          rootMargin: "160px",
        }
      );

      themes.forEach((theme) => {
        const card = document.createElement("div");
        card.className = "theme-card-item";
        card.dataset.fileName = theme.fileName;
        if (theme.fileName === savedThemeFile) {
          card.classList.add("selected");
          currentSelectedTheme = theme;
        }

        const preview = document.createElement("div");
        preview.className = "theme-card-preview";
        const p1 = document.createElement("div");
        p1.className = "theme-card-preview-pane";
        if (theme.variables.dark) {
          p1.style.backgroundColor =
            theme.variables.dark["--secondary-bg"] || "#172A46";
          observeThemePreview(
            p1,
            theme.variables.dark["--chat-wallpaper-dark"]
          );
        }

        const p2 = document.createElement("div");
        p2.className = "theme-card-preview-pane";
        if (theme.variables.light) {
          p2.style.backgroundColor =
            theme.variables.light["--primary-bg"] || "#F0F8FF";
          observeThemePreview(
            p2,
            theme.variables.light["--chat-wallpaper-light"] ||
              theme.variables.dark?.["--chat-wallpaper-dark"]
          );
        }

        preview.append(p1, p2);
        const name = document.createElement("div");
        name.className = "theme-card-name";
        name.textContent = theme.name;
        card.append(preview, name);
        card.addEventListener("click", () => {
          themesGrid
            .querySelector(".theme-card-item.selected")
            ?.classList.remove("selected");
          card.classList.add("selected");
          requestAnimationFrame(() => selectTheme(theme));
        });
        fragment.appendChild(card);
      });

      themesGrid.appendChild(fragment);
      if (!currentSelectedTheme) currentSelectedTheme = themes[0] || null;
      if (currentSelectedTheme)
        selectTheme(currentSelectedTheme, { persist: false });
    } catch (e) {
      console.error("Failed to load themes list:", e);
    }
  }

  function renderAttachments() {
    const host = document.getElementById("attachment-preview");
    if (!host) return;
    host.innerHTML = "";
    host.hidden = attachments.length === 0;
    attachments.forEach((attachment, index) => {
      const item = document.createElement("div");
      item.className = "attachment-item";
      if (
        String(attachment.type || "").startsWith("image/") &&
        attachment.internalPath
      ) {
        const thumbnail = document.createElement("img");
        thumbnail.className = "attachment-thumbnail";
        thumbnail.src = attachment.internalPath;
        thumbnail.alt = attachment.name || "图片附件";
        thumbnail.addEventListener("error", () => thumbnail.remove(), {
          once: true,
        });
        item.appendChild(thumbnail);
      }
      const name = document.createElement("span");
      name.textContent = attachment.name || "未命名文件";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "attachment-remove";
      remove.textContent = "×";
      remove.title = "移除此附件";
      remove.addEventListener("click", () => {
        attachments.splice(index, 1);
        renderAttachments();
        resizeComposerPrompt();
      });
      item.append(name, remove);
      host.appendChild(item);
    });
  }

  function addAttachments(items) {
    const existing = new Set(
      attachments.map((item) => item.id || item.internalPath)
    );
    let limitReached = false;
    for (const item of Array.isArray(items) ? items : []) {
      const key = item?.id || item?.internalPath;
      if (!item || (key && existing.has(key))) continue;
      if (attachments.length >= 10) {
        limitReached = true;
        break;
      }
      attachments.push(item);
      if (key) existing.add(key);
    }
    renderAttachments();
    resizeComposerPrompt();
    if (limitReached) {
      window.E3MessageStreamRenderer.showError(
        "一次最多发送 10 个附件",
        "invocation",
        generation()
      );
    }
  }

  async function uploadFiles() {
    try {
      addAttachments(await api.selectFiles());
      document.getElementById("prompt").focus();
    } catch (error) {
      window.E3MessageStreamRenderer.showError(
        error.message,
        "invocation",
        generation()
      );
    }
  }

  async function pasteFiles(event) {
    const files = Array.from(event.clipboardData?.items || [])
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (!files.length) return;
    event.preventDefault();
    try {
      for (const file of files) {
        const data = new Uint8Array(await file.arrayBuffer());
        addAttachments([
          await api.storePastedFile({
            name: file.name || `pasted_image_${Date.now()}.png`,
            type: file.type || "application/octet-stream",
            data,
          }),
        ]);
      }
    } catch (error) {
      window.E3MessageStreamRenderer.showError(
        error.message,
        "invocation",
        generation()
      );
    }
  }

  function setChatRunning(running, pendingCancel = false) {
    chatRunning = !!running;
    cancelPending = chatRunning && !!pendingCancel;
    const button = document.getElementById("chat-action");
    if (!button) return;
    button.classList.toggle("is-running", chatRunning);
    button.disabled = cancelPending;
    document.getElementById("upload-file").disabled = chatRunning;
    document.getElementById("new-session").disabled = chatRunning;
    document.getElementById("sidebar-new-session").disabled = chatRunning;
    button.setAttribute("aria-label", chatRunning ? "取消生成" : "发送消息");
    button.title = chatRunning ? "取消生成" : "发送消息 (Enter)";
  }

  async function startNewSession() {
    attachments = [];
    renderAttachments();
    window.E3WorkspaceSidebar.startNewSession();
    await window.E3WorkspaceSidebar.renderSessions({
      preserveSelection: false,
      selectSessionId: null,
      allowNoSelection: true,
    });
    document.getElementById("prompt").focus();
  }

  function hsvToHex({ h, s, v }) {
    const hue = ((h % 360) + 360) % 360;
    const chroma = v * s;
    const segment = hue / 60;
    const x = chroma * (1 - Math.abs((segment % 2) - 1));
    let rgb = [0, 0, 0];
    if (segment < 1) rgb = [chroma, x, 0];
    else if (segment < 2) rgb = [x, chroma, 0];
    else if (segment < 3) rgb = [0, chroma, x];
    else if (segment < 4) rgb = [0, x, chroma];
    else if (segment < 5) rgb = [x, 0, chroma];
    else rgb = [chroma, 0, x];
    const offset = v - chroma;
    return `#${rgb
      .map((channel) =>
        Math.round((channel + offset) * 255)
          .toString(16)
          .padStart(2, "0")
      )
      .join("")}`.toUpperCase();
  }

  function hexToHsv(hex) {
    const normalized = /^#[0-9A-F]{6}$/i.test(hex) ? hex : "#2563EB";
    const values = [1, 3, 5].map(
      (index) => parseInt(normalized.slice(index, index + 2), 16) / 255
    );
    const [r, g, b] = values;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    let h = 0;
    if (delta && max === r) h = 60 * (((g - b) / delta) % 6);
    else if (delta && max === g) h = 60 * ((b - r) / delta + 2);
    else if (delta) h = 60 * ((r - g) / delta + 4);
    return {
      h: h < 0 ? h + 360 : h,
      s: max ? delta / max : 0,
      v: max,
    };
  }

  function drawViewportColorWheel() {
    const canvas = document.getElementById("viewport-color-wheel");
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const radius = canvas.width / 2;
    const image = context.createImageData(canvas.width, canvas.height);
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        const dx = x + 0.5 - radius;
        const dy = y + 0.5 - radius;
        const saturation = Math.sqrt(dx * dx + dy * dy) / radius;
        const offset = (y * canvas.width + x) * 4;
        if (saturation > 1) {
          image.data[offset + 3] = 0;
          continue;
        }
        const hue = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
        const color = hsvToHex({ h: hue, s: saturation, v: 1 });
        image.data[offset] = parseInt(color.slice(1, 3), 16);
        image.data[offset + 1] = parseInt(color.slice(3, 5), 16);
        image.data[offset + 2] = parseInt(color.slice(5, 7), 16);
        image.data[offset + 3] = 255;
      }
    }
    context.putImageData(image, 0, 0);
    const angle = (viewportColorHsv.h * Math.PI) / 180;
    const markerRadius = viewportColorHsv.s * radius;
    const markerX = radius + Math.cos(angle) * markerRadius;
    const markerY = radius + Math.sin(angle) * markerRadius;
    context.beginPath();
    context.arc(markerX, markerY, 5, 0, Math.PI * 2);
    context.lineWidth = 2;
    context.strokeStyle = viewportColorHsv.v > 0.55 ? "#000" : "#fff";
    context.stroke();
    context.beginPath();
    context.arc(markerX, markerY, 7, 0, Math.PI * 2);
    context.lineWidth = 1;
    context.strokeStyle = viewportColorHsv.v > 0.55 ? "#fff" : "#000";
    context.stroke();
  }

  function updateViewportColorControls() {
    viewportBackgroundColor = hsvToHex(viewportColorHsv);
    const value = document.getElementById("viewport-color-value");
    const preview = document.getElementById("viewport-color-preview");
    const output = document.getElementById("viewport-color-hex");
    if (value) value.value = String(Math.round(viewportColorHsv.v * 100));
    if (preview) preview.style.backgroundColor = viewportBackgroundColor;
    if (output) output.textContent = viewportBackgroundColor;
    drawViewportColorWheel();
  }

  function makeViewportIframeTransparent() {
    try {
      const doc = iframe.contentDocument;
      if (doc?.documentElement && doc.body) {
        let style = doc.getElementById("e3chat-transparent-background");
        if (!style) {
          style = doc.createElement("style");
          style.id = "e3chat-transparent-background";
          style.textContent =
            "html,body,#root,#root>div,canvas{background:transparent!important;background-color:transparent!important;}";
          doc.head.appendChild(style);
        }
        [doc.documentElement, doc.body, doc.getElementById("root")]
          .filter(Boolean)
          .forEach((element) =>
            element.style.setProperty("background", "transparent", "important")
          );
      }
    } catch (_) {
      // The generated viewport page already contains the transparent override.
    }
  }

  function applyViewportBackground({ persist = false } = {}) {
    const viewportBody = document.getElementById("viewport-body");
    const button = document.getElementById("btn-viewport-background");
    const modeColor = {
      transparent: "transparent",
      black: "#000000",
      white: "#FFFFFF",
      custom: viewportBackgroundColor,
    };
    const background = modeColor[viewportBackgroundMode] || "transparent";
    if (viewportBody) {
      viewportBody.style.setProperty("--viewport-background", background);
      viewportBody.style.backgroundColor = background;
    }
    button?.style.setProperty("--viewport-button-color", background);
    if (button) {
      if (viewportBackgroundMode === "transparent") {
        button.style.removeProperty("--viewport-button-pattern");
      } else {
        button.style.setProperty("--viewport-button-pattern", "none");
      }
      const label =
        VIEWPORT_BACKGROUND_LABELS[viewportBackgroundMode] || "透明";
      button.title = `3D 背景：${label}（左键切换，右键自定义）`;
      button.setAttribute("data-mode", viewportBackgroundMode);
    }
    makeViewportIframeTransparent();
    if (iframe?.contentWindow) {
      const rect = iframe.getBoundingClientRect();
      iframe.contentWindow.postMessage(
        {
          type: "e3chat:set-background",
          mode: viewportBackgroundMode,
          color: background,
          wallpaperUrl: currentThemeWallpaperUrl,
          hostWidth: window.innerWidth,
          hostHeight: window.innerHeight,
          offsetX: rect.left,
          offsetY: rect.top,
        },
        "*"
      );
    }
    if (persist) {
      api
        .saveLocalState("global", {
          viewportBackgroundMode,
          viewportBackgroundColor,
        })
        .catch(() => {});
    }
  }

  async function loadViewportBackgroundState() {
    try {
      const state = await api.getLocalState("global");
      const savedMode = String(state?.viewportBackgroundMode || "transparent");
      viewportBackgroundMode = [
        ...VIEWPORT_BACKGROUND_MODES,
        "custom",
      ].includes(savedMode)
        ? savedMode
        : "transparent";
      viewportBackgroundColor = /^#[0-9A-F]{6}$/i.test(
        state?.viewportBackgroundColor
      )
        ? state.viewportBackgroundColor.toUpperCase()
        : "#2563EB";
    } catch (_) {
      viewportBackgroundMode = "transparent";
      viewportBackgroundColor = "#2563EB";
    }
    viewportColorHsv = hexToHsv(viewportBackgroundColor);
    applyViewportBackground();
  }

  function bindViewportBackgroundUi() {
    const button = document.getElementById("btn-viewport-background");
    const popover = document.getElementById("viewport-color-popover");
    const wheel = document.getElementById("viewport-color-wheel");
    const value = document.getElementById("viewport-color-value");
    const cancel = document.getElementById("viewport-color-cancel");
    const confirm = document.getElementById("viewport-color-confirm");
    let draggingWheel = false;

    const closePopover = (restore) => {
      if (popover.hidden) return;
      popover.hidden = true;
      if (restore && viewportColorSnapshot) {
        viewportBackgroundMode = viewportColorSnapshot.mode;
        viewportBackgroundColor = viewportColorSnapshot.color;
        viewportColorHsv = { ...viewportColorSnapshot.hsv };
        applyViewportBackground();
      }
      viewportColorSnapshot = null;
    };
    const selectWheelColor = (event) => {
      const rect = wheel.getBoundingClientRect();
      const radius = rect.width / 2;
      const dx = event.clientX - rect.left - radius;
      const dy = event.clientY - rect.top - radius;
      const distance = Math.min(Math.sqrt(dx * dx + dy * dy), radius);
      viewportColorHsv.h = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
      viewportColorHsv.s = distance / radius;
      viewportBackgroundMode = "custom";
      updateViewportColorControls();
      applyViewportBackground();
    };

    button.addEventListener("click", () => {
      closePopover(true);
      const index = VIEWPORT_BACKGROUND_MODES.indexOf(viewportBackgroundMode);
      viewportBackgroundMode = VIEWPORT_BACKGROUND_MODES[(index + 1) % 3];
      applyViewportBackground({ persist: true });
    });
    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      viewportColorSnapshot = {
        mode: viewportBackgroundMode,
        color: viewportBackgroundColor,
        hsv: { ...viewportColorHsv },
      };
      viewportColorHsv = hexToHsv(viewportBackgroundColor);
      updateViewportColorControls();
      popover.hidden = false;
    });
    wheel.addEventListener("pointerdown", (event) => {
      draggingWheel = true;
      wheel.setPointerCapture(event.pointerId);
      selectWheelColor(event);
    });
    wheel.addEventListener("pointermove", (event) => {
      if (draggingWheel) selectWheelColor(event);
    });
    wheel.addEventListener("pointerup", (event) => {
      draggingWheel = false;
      wheel.releasePointerCapture(event.pointerId);
    });
    value.addEventListener("input", () => {
      viewportColorHsv.v = Number(value.value) / 100;
      viewportBackgroundMode = "custom";
      updateViewportColorControls();
      applyViewportBackground();
    });
    cancel.addEventListener("click", () => closePopover(true));
    confirm.addEventListener("click", () => {
      viewportBackgroundMode = "custom";
      updateViewportColorControls();
      popover.hidden = true;
      viewportColorSnapshot = null;
      applyViewportBackground({ persist: true });
    });
    document.addEventListener("pointerdown", (event) => {
      if (
        !popover.hidden &&
        !popover.contains(event.target) &&
        event.target !== button
      ) {
        closePopover(true);
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !popover.hidden) closePopover(true);
    });
    iframe.addEventListener("load", () => {
      requestAnimationFrame(() => {
        makeViewportIframeTransparent();
        applyViewportBackground();
      });
      setTimeout(() => {
        makeViewportIframeTransparent();
        applyViewportBackground();
      }, 250);
    });
    window.addEventListener("resize", () => applyViewportBackground());
  }

  async function bootstrap() {
    await api.ready();
    await loadViewportHistory();
    bindUi();
    bindExtraUi();
    await loadViewportBackgroundState();

    // E3 Chat stores its own mode so changing it never changes VChat.
    try {
      const state = await api.getLocalState("global");
      const initialThemeMode = state?.selectedThemeMode || "dark";
      const isLightMode = initialThemeMode === "light";
      document.body.classList.toggle("light-theme", isLightMode);
      document.documentElement.style.colorScheme = isLightMode
        ? "light"
        : "dark";
      themeModeToggle.checked = !isLightMode;
    } catch (_) {
      document.body.classList.remove("light-theme");
      document.documentElement.style.colorScheme = "dark";
      themeModeToggle.checked = true;
    }

    await loadThemesList();

    // Set initial Layout mode
    try {
      const state = await api.getLocalState("global");
      const savedLayout = state?.layoutMode || "split";
      applyLayoutMode(savedLayout);
    } catch (_) {
      applyLayoutMode("split");
    }

    // Set initial viewport source
    try {
      const viewportPath = await api.getViewportPath();
      if (viewportPath) {
        const viewportUrl = `file:///${viewportPath.replace(
          /\\/g,
          "/"
        )}?mode=iframe&port=5000`;
        iframe.src = viewportUrl;
        iframe.style.display = "block";
        placeholder.style.display = "none";
      } else {
        iframe.style.display = "none";
        placeholder.style.display = "flex";
      }
    } catch (_) {
      iframe.style.display = "none";
      placeholder.style.display = "flex";
    }

    // Keep header status matching settings panel
    const origRenderStatus = window.E3ChatSettingsPanel.renderStatus;
    window.E3ChatSettingsPanel.renderStatus = (status) => {
      origRenderStatus(status);
      const badge = document.getElementById("header-status-badge");
      if (badge) {
        const workspace =
          status?.workspace?.displayName ||
          status?.workspace?.identity ||
          "未知工作空间";
        badge.textContent = `${
          status?.connected ? "已连接" : "未连接"
        } · ${workspace}`;
      }
    };

    await connect();
    await window.E3WorkspaceSidebar.renderSessions({ loadSelection: true });
  }

  function applyLayoutMode(mode) {
    currentLayoutMode = mode;
    const bookContainer = document.getElementById("book-container");
    const composer = document.getElementById("composer");
    const floatingSlot = document.getElementById("composer-floating-slot");
    const bookSlot = document.getElementById("composer-book-slot");

    if (mode === "single") {
      bookContainer.classList.remove("split-mode");
      bookContainer.classList.add("single-mode");
      floatingSlot.appendChild(composer);
    } else {
      bookContainer.classList.remove("single-mode");
      bookContainer.classList.add("split-mode");
      bookSlot.appendChild(composer);
    }
    resizeComposerPrompt();
    api.saveLocalState("global", { layoutMode: mode }).catch(() => {});
  }

  function bindExtraUi() {
    bindViewportBackgroundUi();

    // Custom Titlebar Controls
    document
      .getElementById("titlebar-min")
      .addEventListener("click", () => api.minimizeWindow());
    document
      .getElementById("titlebar-max")
      .addEventListener("click", () => api.maximizeWindow());
    document
      .getElementById("titlebar-close")
      .addEventListener("click", () => api.closeWindow());

    // Sidebar sessions/settings tabs
    const tabSessions = document.getElementById("tab-sessions");
    const tabSettings = document.getElementById("tab-settings");
    const panelSessions = document.getElementById("panel-sessions");
    const panelSettings = document.getElementById("panel-settings");
    const activateSidebarTab = (activeTab, activePanel) => {
      [tabSessions, tabSettings].forEach((tab) =>
        tab.classList.toggle("active", tab === activeTab)
      );
      [panelSessions, panelSettings].forEach((panel) =>
        panel.classList.toggle("active", panel === activePanel)
      );
    };
    tabSessions.addEventListener("click", () =>
      activateSidebarTab(tabSessions, panelSessions)
    );
    tabSettings.addEventListener("click", () =>
      activateSidebarTab(tabSettings, panelSettings)
    );

    // Theme Overlay Toggle
    const btnOpenThemes = document.getElementById("btn-open-themes");
    const themeOverlay = document.getElementById("theme-overlay");
    const themeOverlayClose = document.getElementById("theme-overlay-close");

    btnOpenThemes.addEventListener("click", () => {
      themeOverlay.hidden = false;
      updateThemePreview();
    });
    themeOverlayClose.addEventListener("click", () => {
      themeOverlay.hidden = true;
    });

    // Close overlay on Escape
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !themeOverlay.hidden) {
        themeOverlay.hidden = true;
      }
    });

    // Fold Sidebar Toggle and resize handle
    const btnToggleSidebar = document.getElementById("btn-toggle-sidebar");
    const shell = document.getElementById("app-shell");
    const sidebar = document.getElementById("sidebar");
    const sidebarResizeHandle = document.getElementById(
      "sidebar-resize-handle"
    );
    const sidebarMinWidth = 160;
    const sidebarMaxWidth = 420;

    btnToggleSidebar.addEventListener("click", () => {
      shell.classList.toggle("sidebar-collapsed");
    });

    sidebarResizeHandle.addEventListener("pointerdown", (event) => {
      if (shell.classList.contains("sidebar-collapsed")) return;
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = sidebar.getBoundingClientRect().width;
      document.body.classList.add("sidebar-resizing");
      sidebarResizeHandle.setPointerCapture(event.pointerId);

      const resizeSidebar = (moveEvent) => {
        const nextWidth = Math.min(
          sidebarMaxWidth,
          Math.max(sidebarMinWidth, startWidth + moveEvent.clientX - startX)
        );
        sidebar.style.width = `${nextWidth}px`;
      };

      const finishSidebarResize = () => {
        document.body.classList.remove("sidebar-resizing");
        sidebarResizeHandle.removeEventListener("pointermove", resizeSidebar);
        sidebarResizeHandle.removeEventListener(
          "pointerup",
          finishSidebarResize
        );
        sidebarResizeHandle.removeEventListener(
          "pointercancel",
          finishSidebarResize
        );
      };

      sidebarResizeHandle.addEventListener("pointermove", resizeSidebar);
      sidebarResizeHandle.addEventListener("pointerup", finishSidebarResize);
      sidebarResizeHandle.addEventListener(
        "pointercancel",
        finishSidebarResize
      );
    });

    // Split / Single Page Toggle
    const btnToggleLayout = document.getElementById("btn-toggle-layout");
    btnToggleLayout.addEventListener("click", () => {
      applyLayoutMode(currentLayoutMode === "split" ? "single" : "split");
    });

    // Viewport Fullscreen Toggle
    const btnToggleViewportFullscreen = document.getElementById(
      "btn-toggle-viewport-fullscreen"
    );
    const rightPage = document.getElementById("right-page");
    const bookContainer = document.getElementById("book-container");
    btnToggleViewportFullscreen.addEventListener("click", () => {
      const fullscreen = rightPage.classList.toggle("viewport-fullscreen");
      bookContainer.classList.toggle("viewport-fullscreen-active", fullscreen);
      btnToggleViewportFullscreen.title = fullscreen
        ? "退出 3D 视图全屏"
        : "3D 视图全屏显示";
      btnToggleViewportFullscreen.setAttribute(
        "aria-pressed",
        String(fullscreen)
      );
    });

    // Theme mode is local to E3 Chat and does not notify VChat.
    themeModeToggle.addEventListener("change", () => {
      const mode = themeModeToggle.checked ? "dark" : "light";
      const isLight = mode === "light";
      document.body.classList.toggle("light-theme", isLight);
      document.documentElement.style.colorScheme = isLight ? "light" : "dark";
      api.saveLocalState("global", { selectedThemeMode: mode }).catch(() => {});
      if (currentSelectedTheme) {
        selectTheme(currentSelectedTheme);
      }
    });

    // Clock updates
    function updateHeaderTime() {
      const el = document.getElementById("header-time");
      if (!el) return;
      const now = new Date();
      el.textContent = now.toTimeString().split(" ")[0];
    }
    setInterval(updateHeaderTime, 1000);
    updateHeaderTime();

    // Viewport RPC Bridging: Intercept invoke and pipe to iframe
    api.onViewportInvoke((payload) => {
      if (iframe && iframe.contentWindow) {
        iframe.contentWindow.postMessage(
          {
            type: "rpc",
            method: payload.methodName,
            body: payload.body,
            requestId: payload.requestId,
          },
          "*"
        );
      }

      // Save drawing command to history
      const activeId = window.E3WorkspaceSidebar.getActiveSessionId();
      if (activeId) {
        saveViewportCommand(activeId, {
          methodName: payload.methodName,
          body: payload.body,
        });
      }
    });

    // Viewport RPC Response Bridging: Listen to iframe posts and send back to main
    window.addEventListener("message", (event) => {
      const data = event.data;
      if (!data || data.type !== "rpc-response") return;
      api.sendViewportResponse({
        requestId: data.requestId,
        result: data.result,
      });
    });
  }

  function resizeComposerPrompt() {
    const prompt = document.getElementById("prompt");
    if (!prompt) return;
    prompt.style.height = "auto";
    prompt.style.height = `${prompt.scrollHeight}px`;
    prompt.style.overflowY = "hidden";
    requestAnimationFrame(() => {
      const composer = document.getElementById("composer");
      if (composer) {
        document.documentElement.style.setProperty(
          "--composer-overlay-height",
          `${composer.offsetHeight + 28}px`
        );
      }
    });
  }

  function updateThemePreview() {
    if (!currentSelectedTheme) return;
    const darkVars = currentSelectedTheme.variables.dark || {};
    const lightVars = currentSelectedTheme.variables.light || {};
    const paneDark = document.getElementById("e3-preview-pane-dark");
    const paneLight = document.getElementById("e3-preview-pane-light");
    const wpDark = document.getElementById("e3-preview-wp-dark");
    const wpLight = document.getElementById("e3-preview-wp-light");

    if (paneDark) {
      paneDark.style.backgroundColor = hexToRgba(
        darkVars["--secondary-bg"],
        0.85
      );
      paneDark.style.setProperty(
        "--secondary-text",
        darkVars["--secondary-text"] || ""
      );
      setThemePreviewWallpaper(wpDark, darkVars["--chat-wallpaper-dark"]);
    }

    if (paneLight) {
      paneLight.style.backgroundColor = hexToRgba(
        lightVars["--primary-bg"],
        0.85
      );
      paneLight.style.setProperty(
        "--secondary-text",
        lightVars["--secondary-text"] || ""
      );
      setThemePreviewWallpaper(
        wpLight,
        lightVars["--chat-wallpaper-light"] || darkVars["--chat-wallpaper-dark"]
      );
    }
  }

  function bindUi() {
    document
      .getElementById("refresh-workspace")
      .addEventListener("click", async () => {
        await api.refreshWorkspace();
        await window.E3WorkspaceSidebar.renderSessions({
          preserveSelection: true,
          loadSelection: true,
        });
      });
    document
      .getElementById("new-session")
      .addEventListener("click", startNewSession);
    document
      .getElementById("sidebar-new-session")
      .addEventListener("click", startNewSession);
    document
      .getElementById("upload-file")
      .addEventListener("click", uploadFiles);
    document.getElementById("reconnect").addEventListener("click", connect);
    document
      .getElementById("disconnect")
      .addEventListener("click", async () => api.disconnect());
    document.getElementById("composer").addEventListener("submit", sendMessage);

    const prompt = document.getElementById("prompt");
    prompt.addEventListener("paste", pasteFiles);
    prompt.addEventListener("input", resizeComposerPrompt);
    window.addEventListener("resize", resizeComposerPrompt);
    resizeComposerPrompt();
    prompt.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      if (!chatRunning) event.currentTarget.form.requestSubmit();
    });
    api.onEvent(handleEvent);
    window.addEventListener("e3chat:regeneration-start", () => {
      setChatRunning(true);
    });
    window.addEventListener("e3chat:regeneration-error", () => {
      setChatRunning(false);
    });

    // ── Context Menu ──────────────────────────────────────────────
    if (window.E3MessageContextMenu) {
      window.E3MessageContextMenu.init();
      document
        .getElementById("message-list")
        .addEventListener("contextmenu", (event) => {
          const block = event.target.closest(".message-block");
          if (!block) return;
          window.E3MessageContextMenu.show(event, block, { chatRunning });
        });
    }
  }

  async function connect() {
    const status = await api.connect({});
    window.E3ChatSettingsPanel.renderStatus(status);
    window.E3DiagnosticsPanel.render(await api.getDiagnostics());
  }

  function pickSessionId(result) {
    return result?.activeSessionId || result?.sessionId || result?.id || null;
  }

  async function refreshSessionsAfterSend(result) {
    const selectedId =
      pickSessionId(result) || window.E3WorkspaceSidebar.getActiveSessionId();
    await window.E3WorkspaceSidebar.renderSessions({
      preserveSelection: true,
      selectSessionId: selectedId,
      sessions: Array.isArray(result?.sessions) ? result.sessions : null,
    });
  }

  async function sendMessage(event) {
    event.preventDefault();
    if (chatRunning) {
      if (cancelPending) return;
      setChatRunning(true, true);
      try {
        await api.cancel();
        window.E3MessageStreamRenderer.finalizeCurrentAssistant(generation());
        window.E3MessageStreamRenderer.clearGenerationIndicator(true);
        setChatRunning(false);
      } catch (error) {
        setChatRunning(true);
        window.E3MessageStreamRenderer.showError(
          error.message,
          "invocation",
          generation()
        );
      }
      return;
    }

    const textarea = document.getElementById("prompt");
    const content = textarea.value.trim();
    if (!content && !attachments.length) return;
    const sendingAttachments = attachments.slice();
    const visibleContent =
      content ||
      sendingAttachments.map((item) => `[附件] ${item.name}`).join("\n");

    const activeSessionId = window.E3WorkspaceSidebar.getActiveSessionId();
    const localId = window.E3MessageStreamRenderer.appendUserMessage(
      visibleContent,
      undefined,
      generation()
    );
    textarea.value = "";
    resizeComposerPrompt();
    attachments = [];
    renderAttachments();
    setChatRunning(true);
    window.E3MessageStreamRenderer.showGenerationIndicator("生成中…", {
      timestamp: Date.now(),
    });

    try {
      const result = await api.sendMessage({
        content,
        attachments: sendingAttachments,
        sessionId: activeSessionId,
        localId,
      });
      const returnedSessionId = pickSessionId(result);
      if (returnedSessionId)
        window.E3WorkspaceSidebar.setActiveSessionId(returnedSessionId);
      await refreshSessionsAfterSend(result);
      // A new session id may only become known after the done event has already
      // arrived. Reload once the send call settles so the current conversation
      // receives persisted history metadata without requiring a manual switch.
      if (!chatRunning && returnedSessionId) {
        await window.E3WorkspaceSidebar.loadSessionIntoView(returnedSessionId);
      }
    } catch (error) {
      window.E3MessageStreamRenderer.finalizeCurrentAssistant(generation());
      setChatRunning(false);
      window.E3MessageStreamRenderer.showError(
        error.message,
        "invocation",
        generation()
      );
      textarea.value = content;
      resizeComposerPrompt();
      attachments = sendingAttachments;
      renderAttachments();
    }
  }

  async function handleEvent(event) {
    if (!event) return;
    if (event.type === "connection") {
      if (event.state === "disconnected") setChatRunning(false);
      if (event.workspace?.connectionGeneration !== undefined) {
        window.E3MessageStreamRenderer.setGeneration(
          event.workspace.connectionGeneration,
          { clear: event.state === "connected" }
        );
      }
      window.E3ChatSettingsPanel.renderStatus({
        connected: event.state === "connected",
        workspace: event.workspace,
      });
      window.E3DiagnosticsPanel.render(await api.getDiagnostics());
      if (event.state === "connected")
        await window.E3WorkspaceSidebar.renderSessions({
          preserveSelection: true,
          sessions: event.sessions,
          loadSelection: true,
        });
      return;
    }
    if (event.type === "message")
      return window.E3MessageStreamRenderer.appendAssistantMessageText(
        event.text,
        eventGeneration(event),
        event.messageId || null
      );
    if (event.type === "thinking")
      return window.E3MessageStreamRenderer.appendThinking(
        event.text,
        eventGeneration(event),
        event.messageId || null
      );
    if (event.type === "tool-call")
      return window.E3MessageStreamRenderer.renderTool(
        event.tool,
        eventGeneration(event)
      );
    if (event.type === "tool-result")
      return window.E3MessageStreamRenderer.finalizeToolResult(
        event.toolId,
        event.result,
        event.status,
        event.isError,
        eventGeneration(event)
      );
    if (event.type === "ask-question")
      return window.E3MessageStreamRenderer.renderQuestion(
        event,
        async (requestId, payload) =>
          api.answerQuestion({ requestId, answerPayload: payload }),
        eventGeneration(event)
      );
    if (event.type === "done") {
      const completedSessionId = window.E3WorkspaceSidebar.getActiveSessionId();
      window.E3MessageStreamRenderer.finalizeCurrentAssistant(
        eventGeneration(event)
      );
      window.E3MessageStreamRenderer.clearGenerationIndicator(true);
      setChatRunning(false);
      window.E3MessageStreamRenderer.clearQuestion();
      await window.E3WorkspaceSidebar.renderSessions({
        preserveSelection: true,
      });
      // Replace live-only blocks with the persisted, decorated history. For a
      // brand-new chat the id may not be known until sendMessage() returns, so
      // do not accidentally reload the sidebar's fallback first session here.
      if (completedSessionId) {
        await window.E3WorkspaceSidebar.loadSessionIntoView(completedSessionId);
      }
      return;
    }
    if (event.type === "error") {
      window.E3MessageStreamRenderer.finalizeCurrentAssistant(
        eventGeneration(event)
      );
      setChatRunning(false);
      return window.E3MessageStreamRenderer.showError(
        event.message,
        "e3",
        eventGeneration(event)
      );
    }
    if (event.type === "invocation-error") {
      window.E3MessageStreamRenderer.finalizeCurrentAssistant(
        eventGeneration(event)
      );
      setChatRunning(false);
      return window.E3MessageStreamRenderer.showError(
        event.message,
        "invocation",
        eventGeneration(event)
      );
    }
    if (event.type === "diagnostic")
      window.E3DiagnosticsPanel.render(await api.getDiagnostics());
  }

  await bootstrap();
})();
