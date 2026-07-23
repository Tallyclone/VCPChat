"use strict";

/**
 * E3 Message Context Menu — Right-click menu for E3 chat messages.
 *
 * Provides: Stop generation, Edit, Delete, Regenerate, Copy text,
 * Copy selected, Copy source (original Markdown).
 *
 * Uses `__e3History` metadata on message-block DOM nodes and the
 * `window.e3chat` preload API for backend mutations.
 *
 * Exposed as `window.E3MessageContextMenu`.
 */
(function (global) {
  const api = global.e3chat;

  // ─── helpers ────────────────────────────────────────────────────────

  function toast(msg, type) {
    // Lightweight toast; reuse E3 error block as a fallback visual cue.
    console.log(`[E3ContextMenu] ${type}: ${msg}`);
    // If a global toast helper exists (e.g. from an overlay lib), use it.
    if (global.__e3Toast) {
      global.__e3Toast(msg, type);
      return;
    }
    // Minimal toast implementation
    const el = document.createElement("div");
    el.className = `e3-toast e3-toast-${type || "info"}`;
    el.textContent = msg;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add("show"));
    setTimeout(() => {
      el.classList.remove("show");
      setTimeout(() => el.remove(), 300);
    }, 2500);
  }

  // ─── state ──────────────────────────────────────────────────────────

  let currentMenu = null; // live DOM node of the visible menu
  let activeEditBlock = null; // message-block currently in edit mode
  let activeConfirm = null; // page-local delete confirmation overlay

  // ─── close ──────────────────────────────────────────────────────────

  function close() {
    if (currentMenu) {
      currentMenu.remove();
      currentMenu = null;
    }
  }

  function handleClickOutside(event) {
    if (currentMenu && !currentMenu.contains(event.target)) {
      close();
    }
  }

  function focusPrompt(options = {}) {
    const prompt = document.getElementById("prompt");
    if (!prompt || prompt.disabled) return false;
    prompt.focus({ preventScroll: true });
    if (options.verify !== false) {
      requestAnimationFrame(() => {
        if (document.activeElement !== prompt && !activeConfirm) {
          prompt.focus({ preventScroll: true });
        }
      });
    }
    return document.activeElement === prompt;
  }

  function confirmDelete(preview) {
    if (activeConfirm) activeConfirm.resolve(false);
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "e3-confirm-overlay";
      overlay.setAttribute("role", "presentation");

      const dialog = document.createElement("section");
      dialog.className = "e3-confirm-dialog";
      dialog.setAttribute("role", "alertdialog");
      dialog.setAttribute("aria-modal", "true");
      dialog.setAttribute("aria-labelledby", "e3-confirm-title");

      const title = document.createElement("h2");
      title.id = "e3-confirm-title";
      title.textContent = "删除消息";
      const description = document.createElement("p");
      description.textContent =
        "确定要删除此消息吗？此操作会同步更新会话历史。";
      const quote = document.createElement("blockquote");
      quote.textContent = preview || "（无文本内容）";
      const actions = document.createElement("div");
      actions.className = "e3-confirm-actions";
      const cancelButton = document.createElement("button");
      cancelButton.type = "button";
      cancelButton.className = "e3-confirm-cancel";
      cancelButton.textContent = "取消";
      const confirmButton = document.createElement("button");
      confirmButton.type = "button";
      confirmButton.className = "e3-confirm-delete";
      confirmButton.textContent = "删除";
      actions.append(cancelButton, confirmButton);
      dialog.append(title, description, quote, actions);
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);

      let settled = false;
      const finish = (confirmed) => {
        if (settled) return;
        settled = true;
        overlay.remove();
        document.removeEventListener("keydown", handleKeydown, true);
        if (activeConfirm?.overlay === overlay) activeConfirm = null;
        focusPrompt();
        resolve(confirmed);
      };
      const handleKeydown = (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          finish(false);
        }
      };
      activeConfirm = { overlay, resolve: finish };
      cancelButton.addEventListener("click", () => finish(false));
      confirmButton.addEventListener("click", () => finish(true));
      overlay.addEventListener("pointerdown", (event) => {
        if (event.target === overlay) finish(false);
      });
      document.addEventListener("keydown", handleKeydown, true);
      requestAnimationFrame(() => cancelButton.focus({ preventScroll: true }));
    });
  }

  // ─── show ───────────────────────────────────────────────────────────

  /**
   * @param {MouseEvent}  event        The contextmenu event.
   * @param {HTMLElement}  block        The .message-block `<article>` element.
   * @param {object}       opts
   * @param {boolean}      opts.chatRunning  Whether generation is active.
   */
  function show(event, block, opts = {}) {
    event.preventDefault();
    close();

    const history = block.__e3History || null;
    const role =
      block.dataset.e3Role ||
      (block.classList.contains("message-user") ? "user" : "assistant");
    const canEdit = block.dataset.e3Editable === "true";
    const canDelete = block.dataset.e3Deletable === "true";
    const canRegenerate = block.dataset.e3Regenerable === "true";
    const isStreaming = block.classList.contains("streaming");
    const isEditing = block.classList.contains("e3-editing");
    const chatRunning = !!opts.chatRunning;

    const menu = document.createElement("div");
    menu.className = "e3-context-menu";

    // ── Stop generation (shown only during streaming) ─────────────
    if (isStreaming || chatRunning) {
      menu.appendChild(
        menuItem("⏹ 中止生成", "danger", () => {
          close();
          api
            .cancel()
            .catch((err) => toast(`中止失败: ${err.message}`, "error"));
          // Let the normal event flow (chat-done / error) finalise the UI.
        })
      );
    }

    // For non-streaming messages:
    if (!isStreaming) {
      // ── Copy rendered text ──────────────────────────────────────
      menu.appendChild(
        menuItem("📋 复制文本", null, () => {
          close();
          const content = block.querySelector(".message-content");
          const text = content
            ? content.innerText.replace(/\n{3,}/g, "\n\n").trim()
            : "";
          navigator.clipboard.writeText(text).then(
            () => toast("已复制文本", "success"),
            () => toast("复制失败", "error")
          );
        })
      );

      // ── Copy selected text (only if selection is within this block) ─
      const sel = global.getSelection();
      if (
        sel &&
        !sel.isCollapsed &&
        block.contains(sel.anchorNode) &&
        block.contains(sel.focusNode)
      ) {
        const selectedText = sel.toString().trim();
        if (selectedText) {
          menu.appendChild(
            menuItem("📝 复制选中", null, () => {
              close();
              navigator.clipboard.writeText(selectedText).then(
                () => toast("已复制选中文本", "success"),
                () => toast("复制失败", "error")
              );
            })
          );
        }
      }

      // ── Copy source Markdown ────────────────────────────────────
      if (history && (history.originalText || history.text)) {
        menu.appendChild(
          menuItem("📄 复制源文本", null, () => {
            close();
            const source = history.originalText || history.text || "";
            navigator.clipboard.writeText(source).then(
              () => toast("已复制源文本", "success"),
              () => toast("复制失败", "error")
            );
          })
        );
      }

      // ── Edit ────────────────────────────────────────────────────
      if (canEdit && !isEditing) {
        menu.appendChild(
          menuItem("✏️ 编辑消息", null, () => {
            close();
            enterEditMode(block, history);
          })
        );
      }

      // ── Regenerate ──────────────────────────────────────────────
      if (canRegenerate) {
        menu.appendChild(
          menuItem("🔄 重新生成", "accent", () => {
            close();
            handleRegenerate(block, history);
          })
        );
      }

      // ── Delete ──────────────────────────────────────────────────
      if (canDelete) {
        menu.appendChild(
          menuItem("🗑️ 删除消息", "danger", () => {
            close();
            handleDelete(block, history);
          })
        );
      }
    }

    // If the menu is empty (no items matched), don't show it.
    if (!menu.children.length) return;

    // Position
    menu.style.visibility = "hidden";
    document.body.appendChild(menu);
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    let top = event.clientY;
    let left = event.clientX;
    if (top + mh > window.innerHeight) top = Math.max(5, event.clientY - mh);
    if (left + mw > window.innerWidth) left = Math.max(5, event.clientX - mw);
    menu.style.top = `${top}px`;
    menu.style.left = `${left}px`;
    menu.style.visibility = "visible";
    currentMenu = menu;
  }

  // ─── menu item factory ──────────────────────────────────────────────

  function menuItem(label, modifier, onClick) {
    const el = document.createElement("div");
    el.className =
      "e3-context-menu-item" + (modifier ? ` e3-ctx-${modifier}` : "");
    el.textContent = label;
    el.addEventListener("click", onClick);
    return el;
  }

  // ─── edit mode ──────────────────────────────────────────────────────

  function enterEditMode(block, history) {
    if (activeEditBlock) exitEditMode(activeEditBlock, false);

    const content = block.querySelector(".message-content");
    if (!content) return;
    const sourceText =
      (history && (history.originalText || history.text)) ||
      content.innerText ||
      "";

    block.classList.add("e3-editing");
    activeEditBlock = block;

    const originalDisplay = content.style.display;
    content.style.display = "none";

    const textarea = document.createElement("textarea");
    textarea.className = "e3-edit-textarea";
    textarea.value = sourceText;
    textarea.style.minHeight = `${Math.max(content.offsetHeight || 60, 60)}px`;

    const controls = document.createElement("div");
    controls.className = "e3-edit-controls";

    const saveBtn = document.createElement("button");
    saveBtn.textContent = "保存";
    saveBtn.className = "e3-edit-btn e3-edit-save";
    saveBtn.addEventListener("click", () =>
      commitEdit(block, textarea.value, history)
    );

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "取消";
    cancelBtn.className = "e3-edit-btn e3-edit-cancel";
    cancelBtn.addEventListener("click", () => exitEditMode(block, false));

    controls.append(saveBtn, cancelBtn);
    block.append(textarea, controls);

    // Store original display for restoration
    block.__e3EditOrigDisplay = originalDisplay;

    textarea.focus();
    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Escape") cancelBtn.click();
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        saveBtn.click();
      }
    });
    // Auto-resize
    const autoResize = () => {
      textarea.style.height = "auto";
      textarea.style.height = textarea.scrollHeight + "px";
    };
    textarea.addEventListener("input", autoResize);
    autoResize();
  }

  async function commitEdit(block, newText, history) {
    if (!history || !history.reference) {
      toast("无法编辑：缺少消息引用", "error");
      exitEditMode(block, false);
      return;
    }
    const originalText = history.originalText || history.text || "";
    if (newText === originalText) {
      exitEditMode(block, false);
      return;
    }
    try {
      const result = await api.editMessage({
        sessionId: history.sessionId,
        reference: history.reference,
        newText: newText,
      });
      // Backend accepted — reload the authoritative decorated session so the
      // rendered text and all message references stay in sync.
      toast("消息已编辑", "success");
      exitEditMode(block, true);
      if (history.sessionId) {
        await global.E3WorkspaceSidebar?.loadSessionIntoView?.(
          history.sessionId
        );
      }
    } catch (err) {
      toast(`编辑失败: ${err.message}`, "error");
      // Don't exit edit mode — let user retry or cancel.
    }
  }

  function exitEditMode(block, wasCommitted) {
    if (!block) return;
    const textarea = block.querySelector(".e3-edit-textarea");
    const controls = block.querySelector(".e3-edit-controls");
    const content = block.querySelector(".message-content");
    if (textarea) textarea.remove();
    if (controls) controls.remove();
    if (content) content.style.display = block.__e3EditOrigDisplay || "";
    block.classList.remove("e3-editing");
    delete block.__e3EditOrigDisplay;
    if (activeEditBlock === block) activeEditBlock = null;
  }

  // ─── delete ─────────────────────────────────────────────────────────

  async function handleDelete(block, history) {
    if (!history || !history.reference) {
      toast("无法删除：缺少消息引用", "error");
      return;
    }

    const sourceText = history.text || history.originalText || "";
    const preview = `${sourceText.substring(0, 100)}${
      sourceText.length > 100 ? "..." : ""
    }`;
    if (!(await confirmDelete(preview))) return;

    // Remove every DOM block that belongs to the selected persisted row while
    // keeping the renderer's node/resource maps consistent.
    global.E3MessageStreamRenderer?.removeHistoryReference?.(history.reference);
    focusPrompt();
    try {
      const result = await api.deleteMessage({
        sessionId: history.sessionId,
        reference: history.reference,
      });
      if (history.sessionId) {
        // Patch surviving nodes with authoritative fingerprints/references. A
        // complete redraw is retained only as a safety fallback when matching
        // cannot account for every decorated persisted message.
        await global.E3WorkspaceSidebar?.reconcileDeletedSession?.(
          history.sessionId,
          result?.session
        );
      }
      toast("消息已删除", "success");
    } catch (err) {
      toast(`删除失败: ${err.message}`, "error");
      // The optimistic removal may have hidden a message that was not deleted.
      // Reload the authoritative session to restore the correct conversation.
      if (history.sessionId) {
        await global.E3WorkspaceSidebar?.loadSessionIntoView?.(
          history.sessionId,
          { chunked: true }
        );
      }
    } finally {
      focusPrompt();
    }
  }

  // ─── regenerate ─────────────────────────────────────────────────────

  async function handleRegenerate(block, history) {
    if (!history || !history.reference) {
      toast("无法重新生成：缺少消息引用", "error");
      return;
    }

    global.E3MessageStreamRenderer?.beginRegeneration?.(block, {
      timestamp: Date.now(),
    });
    global.dispatchEvent(new CustomEvent("e3chat:regeneration-start"));

    try {
      await api.regenerateMessage({
        sessionId: history.sessionId,
        reference: history.reference,
      });
      toast("正在重新生成…", "info");
      // The backend will truncate + resend + push events, which the
      // normal event handler in e3chat.js will render.
    } catch (err) {
      global.dispatchEvent(new CustomEvent("e3chat:regeneration-error"));
      global.E3MessageStreamRenderer?.clearGenerationIndicator?.(true);
      toast(`重新生成失败: ${err.message}`, "error");
      if (history.sessionId) {
        await global.E3WorkspaceSidebar?.loadSessionIntoView?.(
          history.sessionId,
          { chunked: true }
        );
      }
    }
  }

  // ─── initialisation ─────────────────────────────────────────────────

  function init() {
    // Global click-outside closer
    document.removeEventListener("click", handleClickOutside, true);
    document.addEventListener("click", handleClickOutside, true);

    // Escape key closer
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !activeConfirm) close();
    });

    // Composer-local focus self-healing. Buttons and nested editors keep their
    // own native focus behavior; clicking the prompt or empty composer space
    // repairs a lost Chromium text-editing focus without stealing other input.
    const composer = document.getElementById("composer");
    composer?.addEventListener("pointerdown", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest("button, input, .e3-edit-textarea")) return;
      if (target === document.getElementById("prompt") || target === composer) {
        requestAnimationFrame(() => focusPrompt({ verify: false }));
      }
    });
  }

  // ─── export ─────────────────────────────────────────────────────────

  global.E3MessageContextMenu = {
    init,
    show,
    close,
  };
})(window);
