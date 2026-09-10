(function () {
  "use strict";

  let activeDialog = null;
  let dialogSequence = 0;

  function focus(element) {
    if (element?.isConnected && typeof element.focus === "function") {
      element.focus({ preventScroll: true });
    }
  }

  function copyLegacy(text) {
    const previous = document.activeElement;
    const selection = document.getSelection?.();
    const ranges = selection
      ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange())
      : [];
    const inputSelection = typeof previous?.selectionStart === "number"
      ? [previous.selectionStart, previous.selectionEnd, previous.selectionDirection]
      : null;
    const field = document.createElement("textarea");
    field.value = text;
    field.readOnly = true;
    field.tabIndex = -1;
    field.style.cssText = "position:fixed;top:0;left:-10000px;width:1px;height:1px;opacity:0";
    // A Bootstrap modal traps focus within itself, including a fallback copy field.
    (document.querySelector(".modal.show") || document.body).append(field);
    try {
      focus(field);
      field.select();
      field.setSelectionRange(0, text.length);
      return typeof document.execCommand === "function" && document.execCommand("copy") === true;
    } catch (_) {
      return false;
    } finally {
      field.remove();
      focus(previous);
      if (selection) {
        selection.removeAllRanges();
        ranges.forEach((range) => selection.addRange(range));
      }
      if (inputSelection) previous.setSelectionRange(...inputSelection);
    }
  }

  function showManualCopy(text, t) {
    activeDialog?.dismiss(false);
    const previous = document.activeElement;
    const label = (key, fallback) => {
      const value = typeof t === "function" ? t(key) : null;
      return value && value !== key ? value : fallback;
    };
    const id = `clipboard-dialog-${++dialogSequence}`;
    const dialog = document.createElement("dialog");
    dialog.className = "clipboard-dialog";
    dialog.setAttribute("aria-labelledby", `${id}-title`);
    dialog.setAttribute("aria-describedby", `${id}-help`);
    dialog.setAttribute("aria-modal", "true");
    const header = document.createElement("div");
    header.className = "clipboard-dialog__header";
    const title = document.createElement("h2");
    title.id = `${id}-title`;
    title.textContent = label("clipboard.title", "Copy text manually");
    const close = document.createElement("button");
    close.type = "button";
    close.className = "btn btn-outline-secondary";
    close.textContent = label("clipboard.close", "Close");
    const help = document.createElement("p");
    help.id = `${id}-help`;
    help.className = "clipboard-dialog__help";
    help.textContent = label("clipboard.help", "Automatic copying is unavailable. The text is selected; press Ctrl+C or Command+C to copy it.");
    const field = document.createElement("textarea");
    field.className = "clipboard-dialog__text";
    field.setAttribute("aria-label", label("clipboard.label", "Text to copy"));
    field.readOnly = true;
    field.spellcheck = false;
    field.rows = 7;
    field.value = text;
    header.append(title, close);
    dialog.append(header, help, field);
    const dismiss = (restoreFocus = true) => {
      if (!dialog.isConnected) return;
      dialog.remove();
      if (activeDialog?.element === dialog) activeDialog = null;
      if (restoreFocus) focus(previous);
    };
    activeDialog = { element: dialog, dismiss };
    close.addEventListener("click", () => dismiss());
    dialog.addEventListener("close", () => dismiss());
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      dismiss();
    });
    dialog.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dismiss();
      } else if (event.key === "Tab") {
        // There are two controls; explicitly wrap focus for native and older dialogs.
        if (event.shiftKey && document.activeElement === close) {
          event.preventDefault();
          focus(field);
        } else if (!event.shiftKey && document.activeElement === field) {
          event.preventDefault();
          focus(close);
        }
      }
    });
    (document.querySelector(".modal.show") || document.body).append(dialog);
    if (typeof dialog.showModal === "function") {
      dialog.showModal();
    } else {
      dialog.setAttribute("open", "");
      dialog.setAttribute("role", "dialog");
      dialog.classList.add("clipboard-dialog--fallback");
    }
    focus(field);
    field.select();
    field.setSelectionRange(0, text.length);
  }

  async function copy(text, { t } = {}) {
    const value = String(text ?? "");
    try {
      if (typeof navigator.clipboard?.writeText === "function") {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch (_) {
      // HTTP pages and denied clipboard permission can still support legacy copy.
    }
    if (copyLegacy(value)) return true;
    showManualCopy(value, t);
    return false;
  }

  window.LogArkClipboard = Object.freeze({ copy });
})();
