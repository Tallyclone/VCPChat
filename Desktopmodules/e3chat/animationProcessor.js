"use strict";

/**
 * E3 Chat Animation Processor
 * 完全对齐 VChat 的 animation.js 安全机制，但不依赖 visibilityOptimizer
 */

(function (global) {
  // CDN URL 映射
  const CDN_TO_LOCAL_MAP = [
    {
      pattern: /https?:\/\/[^'"`;\s]*(?:three\.js|three)[^'"`;\s]*\.js[^'"`;\s]*/gi,
      local: "../../vendor/three.min.js",
    },
    {
      pattern: /https?:\/\/[^'"`;\s]*(?:animejs|anime)[^'"`;\s]*\.js[^'"`;\s]*/gi,
      local: "../../vendor/anime.min.js",
    },
  ];

  // 全局已加载脚本跟踪（跨消息去重）
  if (!global._e3chat_loaded_scripts) {
    global._e3chat_loaded_scripts = new Set();
  }

  // Three.js 上下文跟踪（用于清理）
  const trackedThreeInstances = new Map();
  let isThreePatched = false;

  /**
   * 替换 CDN URL 为本地路径
   */
  function replaceCdnUrls(scriptContent) {
    if (!scriptContent || typeof scriptContent !== "string") {
      return scriptContent;
    }

    let processed = scriptContent;
    CDN_TO_LOCAL_MAP.forEach(({ pattern, local }) => {
      pattern.lastIndex = 0;
      processed = processed.replace(pattern, local);
    });
    return processed;
  }

  /**
   * 修补 Three.js WebGLRenderer，自动检测 DOM 移除并清理
   */
  function patchThreeJS() {
    if (isThreePatched || !global.THREE || !global.THREE.WebGLRenderer) return;

    const OriginalWebGLRenderer = global.THREE.WebGLRenderer;

    global.THREE.WebGLRenderer = function (...args) {
      const renderer = new OriginalWebGLRenderer(...args);

      const originalRender = renderer.render;
      let associatedScene = null;
      let associatedCamera = null;

      renderer.render = function (scene, camera) {
        if (this._disposed) {
          return;
        }

        if (scene && !associatedScene) {
          associatedScene = scene;
        }
        if (camera && !associatedCamera) {
          associatedCamera = camera;
        }

        // 安全检查：如果 canvas 已从 DOM 移除，自动 dispose
        if (!document.body.contains(this.domElement)) {
          if (!this._disposed) this.dispose();
          return;
        }

        try {
          return originalRender.call(this, scene, camera);
        } catch (error) {
          console.error("[E3Chat Three.js Safety] Render error caught:", error);
          if (!this._disposed) this.dispose();
          return;
        }
      };

      const originalDispose = renderer.dispose;
      renderer.dispose = function () {
        if (this._disposed) return;
        this._disposed = true;
        if (originalDispose) {
          return originalDispose.call(this);
        }
      };

      // 使用 MutationObserver 监听 DOM 插入，注册到追踪列表
      const observer = new MutationObserver(() => {
        if (document.body.contains(renderer.domElement)) {
          const contentDiv = renderer.domElement.closest(".message-content");
          if (contentDiv) {
            if (!trackedThreeInstances.has(contentDiv)) {
              trackedThreeInstances.set(contentDiv, []);
            }
            const instance = {
              renderer,
              getScene: () => associatedScene,
            };
            trackedThreeInstances.get(contentDiv).push(instance);
          }
          observer.disconnect();
        }
      });

      observer.observe(document.body, { childList: true, subtree: true });

      return renderer;
    };

    global.THREE.WebGLRenderer.prototype = OriginalWebGLRenderer.prototype;
    isThreePatched = true;
    console.log("[E3Chat] THREE.WebGLRenderer patched with safety checks.");
  }

  /**
   * 加载外部脚本（带去重）
   */
  function loadScript(src, onLoad, onError) {
    if (global._e3chat_loaded_scripts.has(src)) {
      if (onLoad) onLoad();
      return;
    }
    global._e3chat_loaded_scripts.add(src);

    const scriptEl = document.createElement("script");
    scriptEl.src = src;
    scriptEl.onload = () => {
      console.log(`[E3Chat Animation] ✅ Library loaded: ${src}`);
      if (onLoad) onLoad();
    };
    scriptEl.onerror = () => {
      console.error(`[E3Chat Animation] ❌ Failed to load: ${src}`);
      global._e3chat_loaded_scripts.delete(src);
      if (onError) onError();
    };
    document.head.appendChild(scriptEl);
  }

  /**
   * 处理容器内的脚本（核心方法）
   */
  function processScripts(containerElement) {
    const messageItem = containerElement.closest(".message-block");

    const allScripts = Array.from(containerElement.querySelectorAll("script"));
    const threeScripts = allScripts.filter((s) => s.src && s.src.includes("three"));
    const otherExternalScripts = allScripts.filter(
      (s) => s.src && !s.src.includes("three")
    );
    const inlineScripts = allScripts
      .filter((s) => !s.src && s.textContent.trim())
      .map((s) => ({
        textContent: s.textContent,
        previousElementSibling: s.previousElementSibling,
        parentElement: s.parentElement,
        parentNode: s.parentNode,
        id: s.id || "",
        className: s.className || "",
        type: s.type || "",
        dataset: { ...s.dataset },
        getAttribute: (name) => s.getAttribute(name),
        hasAttribute: (name) => s.hasAttribute(name),
      }));

    // 清理所有原始 script 标签
    allScripts.forEach((s) => {
      if (s.parentNode) s.parentNode.removeChild(s);
    });

    const executeInline = () => {
      // 🛡️ 拦截 anime.js 创建（可选，E3 Chat 不需要暂停功能）
      const originalAnime = global.anime;
      let animePatched = false;
      if (originalAnime && !originalAnime._e3chat_patched) {
        global.anime = function (options) {
          const instance = originalAnime(options);
          // E3 Chat 简化版：不注册到 visibilityOptimizer
          return instance;
        };
        Object.assign(global.anime, originalAnime);
        global.anime._e3chat_patched = true;
        animePatched = true;
      }

      // 🛡️ Document API 拦截 - 防止 document.write 崩溃 SPA
      const originalWrite = document.write;
      const originalOpen = document.open;
      const originalClose = document.close;

      const blockedApiHandler = function (...args) {
        console.warn(
          "[E3Chat Animation] Blocked document.write/open/close call:",
          args
        );
      };

      document.write = blockedApiHandler;
      document.open = blockedApiHandler;
      document.close = blockedApiHandler;

      try {
        inlineScripts.forEach((script) => {
          try {
            // CDN URL 重写
            let scriptContent = replaceCdnUrls(script.textContent);

            // 创建 shadow document 代理（兼容 AI 脚本）
            const tempDocId = `_e3chat_doc_${Math.random().toString(36).slice(2, 11)}`;
            const virtualCurrentScript = {
              tagName: "SCRIPT",
              nodeName: "SCRIPT",
              nodeType: Node.ELEMENT_NODE,
              id: script.id,
              className: script.className,
              type: script.type,
              dataset: script.dataset,
              previousElementSibling: script.previousElementSibling,
              parentElement: script.parentElement,
              parentNode: script.parentNode,
              ownerDocument: document,
              getAttribute: script.getAttribute,
              hasAttribute: script.hasAttribute,
            };

            const shadowDocument = new Proxy(document, {
              get(target, prop) {
                if (prop === "currentScript") {
                  return virtualCurrentScript;
                }

                if (prop === "getElementsByTagName") {
                  return function (tagName) {
                    const elements = Array.from(target.getElementsByTagName(tagName));
                    if (String(tagName).toLowerCase() === "script") {
                      const scripts = [...elements, virtualCurrentScript];
                      scripts.item = (index) => scripts[index] || null;
                      return scripts;
                    }
                    elements.item = (index) => elements[index] || null;
                    return elements;
                  };
                }

                const value = target[prop];
                return typeof value === "function" ? value.bind(target) : value;
              },
              set(target, prop, value) {
                target[prop] = value;
                return true;
              },
            });

            global[tempDocId] = shadowDocument;

            const wrappedScript = `
(function() {
    const document = window['${tempDocId}'];
    const container = document.querySelector('.message-block[data-block-id="${messageItem?.dataset.blockId}"] .message-content');
    try {
        ${scriptContent}
    } catch (e) {
        console.error('[E3Chat Animation] Error in AI script:', e);
    }
})();`;

            const newScript = document.createElement("script");
            newScript.textContent = wrappedScript;
            document.head.appendChild(newScript).parentNode.removeChild(newScript);

            // 清理临时变量
            setTimeout(() => {
              delete global[tempDocId];
            }, 0);
          } catch (e) {
            console.error("[E3Chat Animation] Error executing inline script:", e);
          }
        });
      } finally {
        // 恢复原始 API
        document.write = originalWrite;
        document.open = originalOpen;
        document.close = originalClose;
      }
    };

    const loadOtherScriptsAndExecuteInline = () => {
      let remaining = otherExternalScripts.length;
      if (remaining === 0) {
        executeInline();
        return;
      }
      const onScriptLoaded = () => {
        remaining--;
        if (remaining === 0) {
          executeInline();
        }
      };
      otherExternalScripts.forEach((s) => {
        loadScript(replaceCdnUrls(s.src), onScriptLoaded, onScriptLoaded);
      });
    };

    if (threeScripts.length > 0) {
      loadScript("../../vendor/three.min.js", () => {
        patchThreeJS();
        loadOtherScriptsAndExecuteInline();
      });
    } else {
      loadOtherScriptsAndExecuteInline();
    }
  }

  /**
   * 清理动画资源（消息删除/切换会话时调用）
   */
  function cleanupAnimations(contentDiv) {
    if (!contentDiv) return;

    // 1. 清理 anime.js 动画
    if (global.anime) {
      const animatedElements = contentDiv.querySelectorAll("*");
      if (animatedElements.length > 0) anime.remove(animatedElements);
    }

    // 2. 清理 Three.js 资源
    if (trackedThreeInstances.has(contentDiv)) {
      const instancesToClean = trackedThreeInstances.get(contentDiv);
      console.log(
        `[E3Chat Cleanup] Cleaning ${instancesToClean.length} Three.js instance(s)`
      );

      instancesToClean.forEach((instance) => {
        if (instance.renderer && !instance.renderer._disposed) {
          const scene = instance.getScene();
          if (scene) {
            scene.traverse((object) => {
              if (object.isMesh) {
                if (object.geometry) object.geometry.dispose();
                if (object.material) {
                  if (Array.isArray(object.material)) {
                    object.material.forEach((mat) => {
                      if (mat.dispose) mat.dispose();
                    });
                  } else if (object.material.dispose) {
                    object.material.dispose();
                  }
                }
              }
            });
          }
          try {
            instance.renderer.dispose();
          } catch (e) {
            console.warn("[E3Chat Cleanup] Error during renderer disposal:", e);
          }
        }
      });

      trackedThreeInstances.delete(contentDiv);
    }
  }

  // 导出到全局
  global.E3AnimationProcessor = {
    processScripts,
    cleanupAnimations,
  };
})(window);
