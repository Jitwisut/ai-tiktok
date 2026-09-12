// Shared by both site automations (classic scripts in one global scope, so
// every name here is prefixed). Puts the whole workflow on the generation
// page itself — pick a job, pick a length, watch progress — so nothing
// requires hopping back to the app or reopening the toolbar popup, which
// closes the moment you click the page.

interface AiPanelJob {
  videoId: string;
  productName: string;
  hook: string;
  clips: { index: number; prompt: string }[];
  imageUrl: string | null;
}

interface AiPanelContent {
  contentId: string;
  productName: string;
  hook: string;
  sceneCount: number;
  imageUrl: string | null;
}

interface AiPanelConfig {
  site: "aistudio" | "flow";
  siteLabel: string;
}

const AI_PANEL_ID = "ai-affiliate-panel";
let aiPanelConfig: AiPanelConfig | null = null;
let aiPanelBusy = false;
let aiPanelActiveVideoId: string | null = null;

function aiPanelEl(id: string): HTMLElement | null {
  return document.getElementById(`${AI_PANEL_ID}-${id}`);
}

/** Status line, also used by the automations in place of the old banner. */
function aiPanelStatus(text: string, color = "#e5e7eb") {
  const el = aiPanelEl("status");
  if (!el) return;
  el.textContent = text;
  el.style.color = color;
  el.style.display = text ? "block" : "none";
}

function aiPanelSetProgress(current: number, total: number, state: string) {
  const wrap = aiPanelEl("progress");
  const bar = aiPanelEl("bar");
  const label = aiPanelEl("progress-label");
  if (!wrap || !bar || !label) return;

  if (!total || state === "idle") {
    wrap.style.display = "none";
    return;
  }
  const labels: Record<string, string> = {
    generating: "กำลังสร้าง",
    uploading: "กำลังอัปโหลด",
    done: "เสร็จแล้ว",
    failed: "ล้มเหลว",
  };
  wrap.style.display = "block";
  label.textContent = `${labels[state] ?? state} — คลิป ${current}/${total}`;
  bar.style.width = `${Math.round((current / Math.max(1, total)) * 100)}%`;
  bar.style.background = state === "failed" ? "#dc2626" : state === "done" ? "#16a34a" : "#2563eb";
}

function aiPanelRow(
  imageUrl: string | null,
  title: string,
  subtitle: string,
  onRun: (button: HTMLButtonElement) => void,
): HTMLElement {
  const row = document.createElement("div");
  Object.assign(row.style, {
    display: "flex",
    gap: "8px",
    alignItems: "center",
    padding: "8px",
    border: "1px solid #374151",
    borderRadius: "8px",
    marginBottom: "6px",
  } satisfies Partial<CSSStyleDeclaration>);

  const img = document.createElement("img");
  if (imageUrl) img.src = imageUrl;
  Object.assign(img.style, {
    width: "34px",
    height: "34px",
    objectFit: "cover",
    borderRadius: "6px",
    background: "#374151",
    flexShrink: "0",
  } satisfies Partial<CSSStyleDeclaration>);

  const info = document.createElement("div");
  info.style.flex = "1";
  info.style.minWidth = "0";
  const titleEl = document.createElement("div");
  Object.assign(titleEl.style, {
    fontSize: "12px",
    fontWeight: "600",
    color: "#f9fafb",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  } satisfies Partial<CSSStyleDeclaration>);
  titleEl.textContent = title;
  const subEl = document.createElement("div");
  Object.assign(subEl.style, {
    fontSize: "11px",
    color: "#9ca3af",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  } satisfies Partial<CSSStyleDeclaration>);
  subEl.textContent = subtitle;
  info.append(titleEl, subEl);

  const button = document.createElement("button");
  button.textContent = "สร้าง";
  Object.assign(button.style, {
    background: "#2563eb",
    color: "#fff",
    border: "none",
    borderRadius: "6px",
    padding: "6px 12px",
    fontSize: "12px",
    fontWeight: "600",
    cursor: "pointer",
    flexShrink: "0",
  } satisfies Partial<CSSStyleDeclaration>);
  button.addEventListener("click", () => onRun(button));

  row.append(img, info, button);
  return row;
}

function aiPanelRenderContents(contents: AiPanelContent[]) {
  const list = aiPanelEl("contents");
  if (!list) return;
  list.innerHTML = "";
  if (contents.length === 0) {
    list.innerHTML =
      '<div style="font-size:11px;color:#9ca3af;line-height:1.6">ยังไม่มีคอนเทนต์ที่มีฉาก — สร้างคอนเทนต์และฉากในแอปก่อน</div>';
    return;
  }
  for (const content of contents) {
    list.appendChild(
      aiPanelRow(
        content.imageUrl,
        content.productName,
        `${content.sceneCount} ฉาก · ${content.hook}`,
        (button) => aiPanelCreate(content, button),
      ),
    );
  }
}

function aiPanelRenderJobs(jobs: AiPanelJob[], appBaseUrl: string) {
  const list = aiPanelEl("jobs");
  if (!list) return;
  list.innerHTML = "";

  if (jobs.length === 0) {
    list.innerHTML =
      '<div style="font-size:12px;color:#9ca3af;line-height:1.6">ยังไม่มีงานที่รออยู่ — ไปที่หน้า Content ในแอปแล้วกด "สร้างผ่าน Extension"</div>';
    return;
  }

  for (const job of jobs) {
    const image = job.imageUrl?.startsWith("http")
      ? job.imageUrl
      : job.imageUrl
        ? `${appBaseUrl}${job.imageUrl}`
        : null;
    list.appendChild(
      aiPanelRow(image, job.productName, job.hook, (button) => aiPanelRun(job, button)),
    );
  }
}

function aiPanelSetRunning(running: boolean, videoId?: string) {
  aiPanelBusy = running;
  if (running && videoId) aiPanelActiveVideoId = videoId;
  const cancel = aiPanelEl("cancel");
  if (cancel) cancel.style.display = running ? "block" : "none";
}

function aiPanelCancel() {
  const videoId = aiPanelActiveVideoId;
  if (!videoId) return;
  if (!confirm("ยกเลิกงานนี้? คลิปที่สร้างไปแล้วจะถูกทิ้ง")) return;

  aiPanelStatus("กำลังยกเลิก...", "#fbbf24");
  // Stop the loop in this page first, then let the app discard the partial
  // clips — the other order can upload one more clip after cancelling.
  chrome.runtime.sendMessage({ type: "CANCEL_RUNNING_JOB" }, () => {
    chrome.runtime.sendMessage(
      { type: "CANCEL_JOB", videoId },
      (result: { ok: boolean; error?: string }) => {
        aiPanelSetRunning(false);
        aiPanelSetProgress(0, 0, "idle");
        aiPanelStatus(result?.ok ? "ยกเลิกแล้ว" : (result?.error ?? "ยกเลิกไม่สำเร็จ"), "#fbbf24");
        aiPanelLoadAll();
      },
    );
  });
}

/** Creates the job in the app, then immediately starts it on this page. */
function aiPanelCreate(content: AiPanelContent, button: HTMLButtonElement) {
  if (aiPanelBusy) {
    aiPanelStatus("มีงานกำลังทำอยู่แล้วในแท็บนี้", "#fbbf24");
    return;
  }
  const targetDuration = Number((aiPanelEl("duration") as HTMLSelectElement | null)?.value ?? 24);

  button.disabled = true;
  button.textContent = "กำลังสร้าง...";
  aiPanelStatus("กำลังเตรียมงาน...", "#e5e7eb");

  chrome.runtime.sendMessage(
    { type: "CREATE_JOB", contentId: content.contentId, targetDuration },
    (created: {
      ok: boolean;
      error?: string;
      video?: { id: string };
      clips?: AiPanelJob["clips"];
      imageUrl?: string | null;
    }) => {
      button.disabled = false;
      button.textContent = "สร้าง";
      if (!created?.ok || !created.video) {
        aiPanelStatus(created?.error ?? "สร้างงานไม่สำเร็จ", "#f87171");
        return;
      }
      aiPanelRun(
        {
          videoId: created.video.id,
          productName: content.productName,
          hook: content.hook,
          clips: created.clips ?? [],
          imageUrl: created.imageUrl ?? null,
        },
        button,
      );
    },
  );
}

function aiPanelRun(job: AiPanelJob, button: HTMLButtonElement) {
  if (aiPanelBusy) {
    aiPanelStatus("มีงานกำลังทำอยู่แล้วในแท็บนี้", "#fbbf24");
    return;
  }
  const select = aiPanelEl("duration") as HTMLSelectElement | null;
  const targetDuration = Number(select?.value ?? 24);

  aiPanelSetRunning(true, job.videoId);
  button.disabled = true;
  button.textContent = "กำลังเริ่ม...";
  aiPanelStatus("กำลังเตรียมงาน...", "#e5e7eb");

  chrome.runtime.sendMessage(
    { type: "RUN_JOB_FROM_POPUP", job, targetDuration, site: aiPanelConfig?.site },
    (result: { ok: boolean; error?: string }) => {
      button.disabled = false;
      button.textContent = "สร้าง";
      if (!result?.ok) {
        aiPanelSetRunning(false);
        aiPanelStatus(result?.error ?? "เริ่มงานไม่สำเร็จ", "#f87171");
      }
    },
  );
}

function aiPanelLoadContents() {
  chrome.runtime.sendMessage(
    { type: "GET_CONTENTS" },
    (result: { ok: boolean; contents?: AiPanelContent[]; error?: string }) => {
      if (result?.ok) aiPanelRenderContents(result.contents ?? []);
    },
  );
}

function aiPanelLoadAll() {
  aiPanelLoadJobs();
  aiPanelLoadContents();
}

function aiPanelLoadJobs() {
  aiPanelStatus("กำลังโหลดงาน...", "#9ca3af");
  chrome.runtime.sendMessage(
    { type: "GET_PENDING_JOBS" },
    (result: { ok: boolean; jobs?: AiPanelJob[]; appBaseUrl?: string; error?: string }) => {
      if (!result?.ok) {
        aiPanelStatus(result?.error ?? "โหลดงานไม่สำเร็จ", "#f87171");
        return;
      }
      aiPanelStatus("");
      aiPanelRenderJobs(result.jobs ?? [], result.appBaseUrl ?? "");
    },
  );
}

function aiPanelMount(config: AiPanelConfig) {
  if (document.getElementById(AI_PANEL_ID)) return;
  aiPanelConfig = config;

  const panel = document.createElement("div");
  panel.id = AI_PANEL_ID;
  Object.assign(panel.style, {
    position: "fixed",
    top: "72px",
    right: "16px",
    width: "300px",
    zIndex: "2147483647",
    background: "#111827",
    border: "1px solid #374151",
    borderRadius: "12px",
    padding: "12px",
    boxShadow: "0 10px 30px rgba(0,0,0,0.45)",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    color: "#f9fafb",
  } satisfies Partial<CSSStyleDeclaration>);

  panel.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
      <div style="font-size:13px;font-weight:700">AI Affiliate Studio</div>
      <div style="display:flex;gap:6px;align-items:center">
        <button id="${AI_PANEL_ID}-refresh" title="โหลดใหม่"
          style="background:none;border:none;color:#9ca3af;cursor:pointer;font-size:14px">⟳</button>
        <button id="${AI_PANEL_ID}-toggle"
          style="background:none;border:none;color:#9ca3af;cursor:pointer;font-size:14px">—</button>
      </div>
    </div>

    <div id="${AI_PANEL_ID}-body">
      <div style="font-size:11px;color:#9ca3af;margin-bottom:8px">สร้างที่ ${config.siteLabel}</div>

      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
        <span style="font-size:12px;color:#d1d5db">ความยาว</span>
        <select id="${AI_PANEL_ID}-duration"
          style="flex:1;background:#1f2937;color:#f9fafb;border:1px solid #374151;border-radius:6px;padding:4px 6px;font-size:12px">
          <option value="8">8 วินาที (1 คลิป)</option>
          <option value="16">16 วินาที (2 คลิป)</option>
          <option value="24" selected>24 วินาที (3 คลิป)</option>
          <option value="32">32 วินาที (4 คลิป)</option>
        </select>
      </div>

      <div id="${AI_PANEL_ID}-progress" style="display:none;margin-bottom:10px">
        <div id="${AI_PANEL_ID}-progress-label" style="font-size:11px;font-weight:600;margin-bottom:4px"></div>
        <div style="height:5px;background:#374151;border-radius:999px;overflow:hidden">
          <div id="${AI_PANEL_ID}-bar" style="height:100%;width:0%;background:#2563eb;transition:width .3s"></div>
        </div>
      </div>

      <button id="${AI_PANEL_ID}-cancel"
        style="display:none;width:100%;background:#7f1d1d;color:#fecaca;border:1px solid #b91c1c;border-radius:6px;padding:6px;font-size:12px;font-weight:600;cursor:pointer;margin-bottom:10px">
        ยกเลิกงานนี้
      </button>

      <div id="${AI_PANEL_ID}-status" style="font-size:11px;line-height:1.6;margin-bottom:8px;display:none"></div>

      <div style="font-size:11px;font-weight:700;color:#9ca3af;margin-bottom:6px">งานที่รออยู่</div>
      <div id="${AI_PANEL_ID}-jobs"></div>

      <div style="font-size:11px;font-weight:700;color:#9ca3af;margin:12px 0 6px">สร้างจากคอนเทนต์</div>
      <div id="${AI_PANEL_ID}-contents" style="max-height:230px;overflow-y:auto"></div>
    </div>`;

  document.body.appendChild(panel);

  aiPanelEl("refresh")?.addEventListener("click", aiPanelLoadAll);
  aiPanelEl("cancel")?.addEventListener("click", aiPanelCancel);
  aiPanelEl("toggle")?.addEventListener("click", () => {
    const body = aiPanelEl("body");
    const toggle = aiPanelEl("toggle");
    if (!body || !toggle) return;
    const hidden = body.style.display === "none";
    body.style.display = hidden ? "block" : "none";
    toggle.textContent = hidden ? "—" : "+";
  });

  // Progress is written by the automation to storage, so the panel stays
  // accurate even after the page reloads mid-job.
  chrome.storage.onChanged.addListener((changes) => {
    const progress = changes.jobProgress?.newValue as
      | { current: number; total: number; state: string }
      | undefined;
    if (!progress) return;
    aiPanelSetProgress(progress.current, progress.total, progress.state);
    if (progress.state === "done" || progress.state === "failed" || progress.state === "cancelled") {
      aiPanelSetRunning(false);
      aiPanelLoadAll();
    }
  });

  chrome.storage.local.get("jobProgress", (stored) => {
    const progress = stored.jobProgress as
      | { videoId: string; current: number; total: number; state: string; at: number }
      | undefined;
    if (progress && progress.state !== "done" && progress.state !== "failed" && progress.state !== "cancelled") {
      aiPanelSetRunning(true, progress.videoId);
      aiPanelSetProgress(progress.current, progress.total, progress.state);
    }
  });

  aiPanelLoadAll();
}
