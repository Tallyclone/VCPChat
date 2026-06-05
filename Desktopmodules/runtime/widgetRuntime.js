"use strict";

(function () {
  const RUNTIME_API_STORE = "__vcpWidgetRuntimeApis";
  let runtimeSeq = 0;

  function normalizeHtmlContent(input = {}) {
    if (typeof input.htmlContent === "string") return input.htmlContent;
    const html = typeof input.html === "string" ? input.html : "";
    const css = typeof input.css === "string" ? input.css : "";
    const js = typeof input.js === "string" ? input.js : "";
    return `${css ? `<style>${css}</style>` : ""}${html}${
      js ? `<script>${js}</script>` : ""
    }`;
  }

  function createTrackedStore() {
    return {
      intervals: [],
      timeouts: [],
      windowListeners: [],
      docListeners: [],
      runtimeErrorListeners: [],
    };
  }

  function cleanupTrackedStore(store) {
    if (!store) return;
    store.intervals.splice(0).forEach((id) => clearInterval(id));
    store.timeouts.splice(0).forEach((id) => clearTimeout(id));
    store.windowListeners.splice(0).forEach((item) => {
      window.removeEventListener(item.type, item.listener, item.options);
    });
    store.docListeners.splice(0).forEach((item) => {
      item.root?.removeEventListener(item.type, item.listener, item.options);
    });
    store.runtimeErrorListeners.splice(0).forEach((item) => {
      window.removeEventListener(item.type, item.listener, item.options);
    });
  }

  function promoteInlineStyles(shadowRoot, contentContainer) {
    const styleElements = contentContainer.querySelectorAll("style");
    styleElements.forEach((styleEl) => {
      const newStyle = document.createElement("style");
      newStyle.textContent = styleEl.textContent;
      shadowRoot.insertBefore(newStyle, contentContainer);
      styleEl.remove();
    });
  }

  function isLocalScript(url) {
    try {
      if (!url.includes("://")) return true;
      const scriptUrl = new URL(url);
      if (scriptUrl.protocol === "file:") return true;
      if (window.location.protocol === "file:") return false;
      return scriptUrl.origin === window.location.origin;
    } catch (error) {
      return true;
    }
  }

  function escapeForSingleQuotedScript(value) {
    return String(value)
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "\\'")
      .replace(/\r/g, "\\r")
      .replace(/\n/g, "\\n")
      .replace(/<\/script/gi, "<\\/script");
  }

  function buildSandboxCode(runtimeId, userCode) {
    const safeRuntimeId = escapeForSingleQuotedScript(runtimeId);
    return `(function(_realDoc, _realWindow) {
      'use strict';
      var __runtime = _realWindow.${RUNTIME_API_STORE} && _realWindow.${RUNTIME_API_STORE}.get('${safeRuntimeId}');
      if (!__runtime) throw new Error('Widget runtime context not found: ${safeRuntimeId}');
      var _shadowRoot = __runtime.shadowRoot;
      var root = __runtime.contentContainer;
      var _apis = __runtime.apis || {};
      var _tracked = __runtime.tracked;
      var widgetId = __runtime.widgetId || '${safeRuntimeId}';
      var _wrap = function(fn) {
        return typeof fn === 'function'
          ? function() { return fn.apply(this, arguments); }
          : fn;
      };
      var setInterval = function(fn, delay) {
        var id = _realWindow.setInterval(_wrap(fn), delay);
        if (_tracked) _tracked.intervals.push(id);
        return id;
      };
      var clearInterval = function(id) {
        _realWindow.clearInterval(id);
        if (_tracked) {
          var idx = _tracked.intervals.indexOf(id);
          if (idx > -1) _tracked.intervals.splice(idx, 1);
        }
      };
      var setTimeout = function(fn, delay) {
        var id = _realWindow.setTimeout(_wrap(fn), delay);
        if (_tracked) _tracked.timeouts.push(id);
        return id;
      };
      var clearTimeout = function(id) {
        _realWindow.clearTimeout(id);
        if (_tracked) {
          var idx = _tracked.timeouts.indexOf(id);
          if (idx > -1) _tracked.timeouts.splice(idx, 1);
        }
      };
      var requestAnimationFrame = function(callback) {
        return _realWindow.requestAnimationFrame(function(timestamp) { _wrap(callback)(timestamp); });
      };
      var cancelAnimationFrame = function(id) {
        return _realWindow.cancelAnimationFrame(id);
      };
      var window = new Proxy(_realWindow, {
        get: function(target, prop, receiver) {
          if (prop === 'window' || prop === 'self' || prop === 'globalThis' || prop === 'top' || prop === 'parent') return window;
          if (prop === 'document') return document;
          if (Object.prototype.hasOwnProperty.call(_apis, prop)) return _apis[prop];
          if (prop === 'addEventListener') {
            return function(type, listener, options) {
              var wrapped = _wrap(listener);
              if (_tracked) _tracked.windowListeners.push({ type: type, listener: wrapped, options: options, original: listener });
              return _realWindow.addEventListener(type, wrapped, options);
            };
          }
          if (prop === 'removeEventListener') {
            return function(type, listener, options) {
              if (_tracked) {
                var found = _tracked.windowListeners.find(function(l) { return l.type === type && (l.listener === listener || l.original === listener); });
                if (found) {
                  _realWindow.removeEventListener(type, found.listener, options);
                  _tracked.windowListeners = _tracked.windowListeners.filter(function(l) { return l !== found; });
                  return;
                }
              }
              return _realWindow.removeEventListener(type, listener, options);
            };
          }
          if (prop === 'setInterval') return setInterval;
          if (prop === 'clearInterval') return clearInterval;
          if (prop === 'setTimeout') return setTimeout;
          if (prop === 'clearTimeout') return clearTimeout;
          if (prop === 'requestAnimationFrame') return requestAnimationFrame;
          if (prop === 'cancelAnimationFrame') return cancelAnimationFrame;
          return Reflect.get(target, prop, receiver);
        },
        set: function(target, prop, value, receiver) {
          return Reflect.set(target, prop, value, receiver);
        },
        has: function(target, prop) {
          return Object.prototype.hasOwnProperty.call(_apis, prop) || prop in target;
        }
      });
      var document = {
        querySelector: function(sel) { return root.querySelector(sel) || _shadowRoot.querySelector(sel); },
        querySelectorAll: function(sel) { return root.querySelectorAll(sel); },
        getElementById: function(id) { return root.querySelector('#' + CSS.escape(id)); },
        createElement: _realDoc.createElement.bind(_realDoc),
        createTextNode: _realDoc.createTextNode.bind(_realDoc),
        createElementNS: _realDoc.createElementNS.bind(_realDoc),
        createRange: _realDoc.createRange.bind(_realDoc),
        createComment: _realDoc.createComment.bind(_realDoc),
        createDocumentFragment: _realDoc.createDocumentFragment.bind(_realDoc),
        addEventListener: function(type, fn, opts) {
          var wrapped = _wrap(fn);
          if (_tracked) _tracked.docListeners.push({ type: type, listener: wrapped, options: opts, original: fn, root: root });
          root.addEventListener(type, wrapped, opts);
        },
        removeEventListener: function(type, fn, opts) {
          if (_tracked) {
            var found = _tracked.docListeners.find(function(l) { return l.type === type && (l.listener === fn || l.original === fn); });
            if (found) {
              root.removeEventListener(type, found.listener, opts);
              _tracked.docListeners = _tracked.docListeners.filter(function(l) { return l !== found; });
              return;
            }
          }
          root.removeEventListener(type, fn, opts);
        },
        body: root,
        head: null,
        documentElement: root,
        defaultView: window,
      };
      var nfm = _apis.nfm;
      var vcpAPI = _apis.vcpAPI || {
        fetch: function(endpoint, opts) { return window.__vcpProxyFetch ? window.__vcpProxyFetch(endpoint, opts) : Promise.reject(new Error('vcpAPI.fetch unavailable')); },
        post: function(messages, opts) { return window.__vcpProxyPost ? window.__vcpProxyPost(messages, opts) : Promise.reject(new Error('vcpAPI.post unavailable')); },
        weather: function() { return this.fetch('/admin_api/weather'); },
      };
      var marked = _realWindow.marked;
      var hljs = _realWindow.hljs;
      var anime = _realWindow.anime;
      var THREE = _realWindow.THREE;
      var morphdom = _realWindow.morphdom;
      (function(window, document, nfm, vcpAPI, marked, hljs, anime, THREE, morphdom, widgetId, setInterval, clearInterval, setTimeout, clearTimeout, requestAnimationFrame, cancelAnimationFrame) {
        'use strict';
        ${userCode}
      }).call(window, window, document, nfm, vcpAPI, marked, hljs, anime, THREE, morphdom, widgetId, setInterval, clearInterval, setTimeout, clearTimeout, requestAnimationFrame, cancelAnimationFrame);
    })(window.document, window);`;
  }

  function processInlineScripts(runtimeId, contentContainer) {
    const scripts = Array.from(contentContainer.querySelectorAll("script"));
    scripts.forEach((oldScript) => {
      if (oldScript.src) {
        const scriptUrl = oldScript.src;
        const placeholder = document.createComment(
          `[VCPdesktop] Loading runtime script: ${scriptUrl}`
        );
        oldScript.replaceWith(placeholder);
        if (isLocalScript(scriptUrl)) {
          fetch(scriptUrl)
            .then((response) => {
              if (!response.ok)
                throw new Error(`HTTP ${response.status}: ${scriptUrl}`);
              return response.text();
            })
            .then((code) => {
              const script = document.createElement("script");
              script.textContent = buildSandboxCode(runtimeId, code);
              placeholder.parentNode?.insertBefore(
                script,
                placeholder.nextSibling
              );
            })
            .catch((error) => {
              console.warn(
                "[WidgetRuntime] Failed to sandbox local script:",
                error
              );
            });
        } else {
          console.warn(
            "[WidgetRuntime] Blocked external script for customUI:",
            scriptUrl
          );
        }
      } else {
        const script = document.createElement("script");
        script.textContent = buildSandboxCode(
          runtimeId,
          oldScript.textContent || ""
        );
        oldScript.replaceWith(script);
      }
    });
  }

  function renderShadowWidget({
    hostElement,
    htmlContent,
    customUI,
    apis = {},
    options = {},
  } = {}) {
    if (!hostElement)
      throw new Error("renderShadowWidget requires hostElement.");
    const runtimeId =
      options.runtimeId ||
      `vcp-runtime-${Date.now().toString(36)}-${runtimeSeq++}`;
    const widgetId = options.widgetId || runtimeId;
    const tracked = createTrackedStore();
    const content =
      typeof htmlContent === "string"
        ? htmlContent
        : normalizeHtmlContent(customUI || {});

    cleanupTrackedStore(hostElement.__vcpWidgetRuntimeCleanupStore);
    hostElement.innerHTML = "";
    const contentWrapper = document.createElement("div");
    contentWrapper.className = options.wrapperClass || "desktop-widget-content";
    contentWrapper.style.height = "100%";
    const shadowRoot = contentWrapper.attachShadow({ mode: "open" });
    const contentContainer = document.createElement("div");
    contentContainer.className = options.contentClass || "widget-inner-content";
    contentContainer.style.height = "100%";
    shadowRoot.appendChild(contentContainer);
    hostElement.appendChild(contentWrapper);

    const notifyRuntimeError = (error, source = "runtime") => {
      if (typeof options.onRuntimeError === "function") {
        try {
          options.onRuntimeError(error, { runtimeId, widgetId, source });
        } catch (callbackError) {
          console.warn(
            "[WidgetRuntime] onRuntimeError callback failed:",
            callbackError
          );
        }
      }
    };
    const errorListener = (event) => {
      notifyRuntimeError(
        event.error || new Error(event.message || "CustomUI runtime error"),
        "error"
      );
    };
    const rejectionListener = (event) => {
      notifyRuntimeError(
        event.reason || new Error("CustomUI unhandled rejection"),
        "unhandledrejection"
      );
    };
    window.addEventListener("error", errorListener);
    window.addEventListener("unhandledrejection", rejectionListener);
    tracked.runtimeErrorListeners.push(
      { type: "error", listener: errorListener },
      { type: "unhandledrejection", listener: rejectionListener }
    );

    contentContainer.innerHTML = content;
    promoteInlineStyles(shadowRoot, contentContainer);

    window[RUNTIME_API_STORE] = window[RUNTIME_API_STORE] || new Map();
    const runtimeContext = {
      runtimeId,
      widgetId,
      shadowRoot,
      contentContainer,
      apis,
      tracked,
    };
    window[RUNTIME_API_STORE].set(runtimeId, runtimeContext);
    processInlineScripts(runtimeId, contentContainer);

    const cleanup = () => {
      cleanupTrackedStore(tracked);
      window[RUNTIME_API_STORE]?.delete(runtimeId);
      contentWrapper.remove();
      if (hostElement.__vcpWidgetRuntimeCleanupStore === tracked) {
        delete hostElement.__vcpWidgetRuntimeCleanupStore;
      }
    };
    hostElement.__vcpWidgetRuntimeCleanupStore = tracked;
    return { runtimeId, shadowRoot, contentContainer, cleanup };
  }

  window.VCPDesktop = window.VCPDesktop || {};
  window.VCPDesktop.widgetRuntime = {
    renderShadowWidget,
    normalizeHtmlContent,
  };
})();
