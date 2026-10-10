/* ChatGPT web text generation for product analysis, scripts and scenes. */

(() => {
  interface Request {
    type: string;
    prompt?: string;
    images?: { base64: string; mimeType: string }[];
  }

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  let running = false;

  async function waitFor<T>(read: () => T | undefined, timeoutMs: number, intervalMs = 300): Promise<T | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = read();
      if (value !== undefined) return value;
      await sleep(intervalMs);
    }
    return undefined;
  }

  // ChatGPT dropped #prompt-textarea: the composer is now a bare ProseMirror
  // editor inside form[data-chatgpt-composer], and the Send button lost its
  // data-testid. Keep the old selectors as fallbacks for older layouts.
  function composer(): HTMLElement | null {
    return document.querySelector<HTMLElement>(
      '#prompt-textarea[contenteditable="true"], form[data-chatgpt-composer] .ProseMirror[contenteditable="true"], form .ProseMirror[contenteditable="true"][role="textbox"]',
    );
  }

  function composerForm(): HTMLFormElement | null {
    return composer()?.closest("form") ?? null;
  }

  const STOP_SELECTOR = 'button[data-testid="stop-button"], button[aria-label^="Stop"], button[aria-label^="หยุด"]';

  function isGenerating(): boolean {
    return !!(composerForm() ?? document).querySelector(STOP_SELECTOR);
  }

  function attachmentCount(): number {
    return (composerForm() ?? document).querySelectorAll('img, [data-testid*="attachment"], [data-testid*="image-preview"], .composer-attachment-surface img').length;
  }

  function base64ToFile(base64: string, mimeType: string, index: number): File {
    const type = /^image\/(png|jpeg|webp)/.test(mimeType) ? mimeType.split(";")[0] : "image/jpeg";
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new File([bytes], `product-${index + 1}.${type.split("/")[1].replace("jpeg", "jpg")}`, { type });
  }

  async function attachImage(file: File): Promise<boolean> {
    const editor = composer();
    if (!editor) return false;
    const before = attachmentCount();
    const transfer = new DataTransfer();
    transfer.items.add(file);
    editor.focus();
    editor.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
    if (await waitFor(() => attachmentCount() > before ? true : undefined, 5000)) return true;

    // Some ChatGPT versions expose an image/file input instead of accepting a paste event.
    const input = await waitFor(
      () => Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]'))
        .find((item) => !item.accept || /image|\*/.test(item.accept)),
      3000,
    );
    if (!input) return false;
    const files = new DataTransfer();
    files.items.add(file);
    input.files = files.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return !!(await waitFor(() => attachmentCount() > before ? true : undefined, 12000));
  }

  const squash = (text: string) => text.replace(/\s+/g, "");

  /**
   * Pasted as plain text, which keeps the prompt's line breaks, headings and
   * the JSON example readable — typing a newline would send the message. The
   * editor is read back afterwards: a partial or failed paste must not go out.
   */
  async function writePrompt(prompt: string): Promise<boolean> {
    const editor = composer();
    if (!editor) return false;
    editor.focus();
    document.execCommand("selectAll", false);
    document.execCommand("delete", false);
    // ProseMirror re-renders its root after the delete; a paste sent to the
    // element held from before lands nowhere and the box stays empty.
    await sleep(300);
    const target = composer();
    if (!target) return false;
    target.focus();
    const clipboard = new DataTransfer();
    clipboard.setData("text/plain", prompt);
    target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: clipboard, bubbles: true, cancelable: true }));
    const wanted = squash(prompt);
    const written = () => squash(composer()?.innerText ?? "");
    if (await waitFor(() => (written() === wanted ? true : undefined), 3000, 200)) return true;

    // Fallback: one line through insertText.
    const current = composer();
    if (!current) return false;
    current.focus();
    document.execCommand("selectAll", false);
    document.execCommand("delete", false);
    await sleep(300);
    composer()?.focus();
    document.execCommand("insertText", false, prompt.replace(/\s*\n+\s*/g, " "));
    return !!(await waitFor(() => (written() === wanted ? true : undefined), 3000, 200));
  }

  /**
   * ChatGPT's thread no longer carries data-message-author-role. Each turn is
   * now keyed by data-content-search-unit-key ("…user" / "…assistant"), and
   * an answer's markdown root says data-markdown-text-style="assistant-message".
   * Use whichever marker the current layout has.
   */
  function messagesBy(role: "assistant" | "user"): HTMLElement[] {
    const selectors = [
      `[data-message-author-role="${role}"]`,
      `[data-content-search-unit-key*="${role}"]`,
      ...(role === "assistant" ? ['[data-markdown-text-style="assistant-message"]'] : []),
    ];
    for (const selector of selectors) {
      const found = Array.from(document.querySelectorAll<HTMLElement>(selector));
      if (found.length) return found;
    }
    return [];
  }

  function assistantMessages(): HTMLElement[] {
    return messagesBy("assistant");
  }

  function userMessageCount(): number {
    return messagesBy("user").length;
  }

  function replyText(message: HTMLElement): string {
    const blocks = Array.from(message.querySelectorAll<HTMLElement>("pre code"))
      .map((node) => node.innerText.trim()).filter((value) => value.includes("{"));
    if (blocks.length) return blocks.sort((a, b) => b.length - a.length)[0];
    return (message.querySelector<HTMLElement>('.markdown, [data-markdown-text-style="assistant-message"]')?.innerText ?? message.innerText).trim();
  }

  function completeJson(text: string): boolean {
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first < 0 || last <= first) return false;
    try {
      JSON.parse(text.slice(first, last + 1).replace(/,(\s*[}\]])/g, "$1"));
      return true;
    } catch {
      return false;
    }
  }

  const SEND_SELECTOR = 'button[data-testid="send-button"], button#composer-submit-button, button[aria-label="Send prompt"], button[aria-label="Send"], button[aria-label="ส่งพรอมต์"], button[aria-label="ส่ง"]';

  function sendButton(): HTMLButtonElement | null {
    const button = (composerForm() ?? document).querySelector<HTMLButtonElement>(SEND_SELECTOR);
    return button && !button.disabled && button.getAttribute("aria-disabled") !== "true" ? button : null;
  }

  function responseStarted(before: number, beforeUsers: number): boolean {
    return assistantMessages().length > before ||
      userMessageCount() > beforeUsers ||
      isGenerating();
  }

  async function trustedClick(selector: string): Promise<boolean> {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "TRUSTED_CLICK", selector, bringToFront: true }, (result: { ok?: boolean } | undefined) => {
        resolve(!chrome.runtime.lastError && result?.ok === true);
      });
    });
  }

  async function run(request: Request): Promise<{ ok: boolean; text?: string; error?: string }> {
    if (running) return { ok: false, error: "แท็บ ChatGPT กำลังตอบคำถามอื่นอยู่" };
    running = true;
    try {
      const editor = await waitFor(() => composer() ?? undefined, 30000);
      if (!editor) return { ok: false, error: "ไม่พบช่องพิมพ์ ChatGPT — กรุณาล็อกอินที่ chatgpt.com แล้วลองใหม่" };
      for (const [index, image] of (request.images ?? []).entries()) {
        if (!(await attachImage(base64ToFile(image.base64, image.mimeType, index)))) {
          return { ok: false, error: `แนบรูปสินค้า ${index + 1} ใน ChatGPT ไม่สำเร็จ` };
        }
      }
      if (!(await writePrompt(request.prompt ?? ""))) return { ok: false, error: "ใส่คำถามใน ChatGPT ไม่สำเร็จ" };
      const before = assistantMessages().length;
      const beforeUsers = userMessageCount();
      const button = await waitFor(() => sendButton() ?? undefined, 60000);
      if (!button) return { ok: false, error: "ปุ่มส่งใน ChatGPT ไม่พร้อม — ตรวจว่ารูปอัปโหลดเสร็จแล้ว" };
      await extensionRequireLicense();
      button.click();
      if (!(await waitFor(() => responseStarted(before, beforeUsers) ? true : undefined, 6000))) {
        // The composer clears as soon as ChatGPT accepts a prompt, sometimes
        // well before the user bubble or Stop button appears. Do not click
        // Send again after that acknowledgment.
        const accepted = await waitFor(() =>
          responseStarted(before, beforeUsers) || !(composer()?.innerText ?? "").trim() ? true : undefined,
        12000);
        if (accepted) {
          if (!(await waitFor(() => responseStarted(before, beforeUsers) ? true : undefined, 30000))) {
            return { ok: false, error: "ส่งคำถามแล้ว แต่ไม่พบคำตอบจาก ChatGPT ภายในเวลาที่กำหนด" };
          }
        } else {
          await extensionRequireLicense();
          const clicked = await trustedClick(SEND_SELECTOR);
          if (!(await waitFor(() => responseStarted(before, beforeUsers) ? true : undefined, clicked ? 10000 : 3000))) {
            return { ok: false, error: "ChatGPT ไม่รับคำถาม — ตรวจหน้าเว็บและลองใหม่" };
          }
        }
      }

      let last = "";
      let steady = 0;
      let finishedWithoutJsonAt = 0;
      const answer = await waitFor(() => {
        const messages = assistantMessages();
        const message = messages.length > before ? messages[messages.length - 1] : undefined;
        if (!message) return undefined;
        const current = replyText(message);
        if (!current) return undefined;
        const generating = isGenerating();
        steady = !generating && current === last ? steady + 1 : 0;
        last = current;
        if (generating) {
          finishedWithoutJsonAt = 0;
          return undefined;
        }
        if (steady >= 2 && completeJson(current)) return current;
        if (steady >= 10) {
          finishedWithoutJsonAt ||= Date.now();
          // A long pause between streamed tokens is common. Give an
          // incomplete JSON reply time to finish before requesting a repair.
          if (Date.now() - finishedWithoutJsonAt >= 60000) return current;
        } else {
          finishedWithoutJsonAt = 0;
        }
        return undefined;
      }, 4 * 60_000, 1000);
      if (answer) return { ok: true, text: answer };
      // If the page stopped generating but produced malformed JSON, let the
      // caller ask for a short correction in this same conversation.
      const stillGenerating = isGenerating();
      return last && !stillGenerating
        ? { ok: true, text: last }
        : { ok: false, error: "ChatGPT ตอบไม่เสร็จภายในเวลาที่กำหนด" };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      running = false;
    }
  }

  chrome.runtime.onMessage.addListener((message: Request, _sender, sendResponse) => {
    if (message.type !== "RUN_CHATGPT_TEXT_PROMPT" || !message.prompt) return;
    void run(message).then(sendResponse);
    return true;
  });
})();
