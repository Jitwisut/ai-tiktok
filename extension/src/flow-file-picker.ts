// Runs in Flow's own JavaScript world (manifest "world": "MAIN").
// Flow's "Upload media" button creates a file <input> and calls .click() on
// it, which opens the OS file dialog — something an extension can't fill in.
// While flow-automation.ts sets the flag attribute below, that click is
// swallowed and the input is tagged so the automation can hand it the
// product photo directly. The flag lives on <html> because the two scripts
// run in separate JavaScript worlds and only share the DOM.

(() => {
  const FLAG = "data-ai-affiliate-capture-file";
  const TAG = "data-ai-affiliate-file-input";

  const capture = (input: HTMLInputElement): boolean => {
    if (input.type !== "file" || !document.documentElement.hasAttribute(FLAG)) return false;
    input.setAttribute(TAG, "");
    // Keep it findable even if Flow creates it detached.
    if (!input.isConnected) {
      input.style.display = "none";
      document.body.appendChild(input);
    }
    return true;
  };

  const originalClick = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function (this: HTMLInputElement) {
    if (capture(this)) return;
    return originalClick.call(this);
  };

  const originalShowPicker = HTMLInputElement.prototype.showPicker;
  if (originalShowPicker) {
    HTMLInputElement.prototype.showPicker = function (this: HTMLInputElement) {
      if (capture(this)) return;
      return originalShowPicker.call(this);
    };
  }
})();
