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

interface AiPanelConfig {
  site: "aistudio" | "flow";
  siteLabel: string;
}

const AI_PANEL_ID = "ai-affiliate-panel";
const AI_PANEL_CLIP_SECONDS = 8;
let aiPanelConfig: AiPanelConfig | null = null;
let aiPanelBusy = false;

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
    img.src = job.imageUrl?.startsWith("http") ? job.imageUrl : `${appBaseUrl}${job.imageUrl ?? ""}`;
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
    info.innerHTML = `
      <div style="font-size:12px;font-weight:600;color:#f9fafb;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${job.productName}</div>
      <div style="font-size:11px;color:#9ca3af;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${job.hook}</div>`;

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
    button.addEventListener("click", () => aiPanelRun(job, button));

    row.append(img, info, button);
    list.appendChild(row);
  }
}

function aiPanelRun(job: AiPanelJob, button: HTMLButtonElement) {
  if (aiPanelBusy) {
    aiPanelStatus("มีงานกำลังทำอยู่แล้วในแท็บนี้", "#fbbf24");
    return;
  }
  const select = aiPanelEl("duration") as HTMLSelectElement | null;
  const targetDuration = Number(select?.value ?? 24);

  aiPanelBusy = true;
  button.disabled = true;
  button.textContent = "กำลังเริ่ม...";
  aiPanelStatus("กำลังเตรียมงาน...", "#e5e7eb");

  chrome.runtime.sendMessage(
    { type: "RUN_JOB_FROM_POPUP", job, targetDuration, site: aiPanelConfig?.site },
    (result: { ok: boolean; error?: string }) => {
      button.disabled = false;
      button.textContent = "สร้าง";
      if (!result?.ok) {
        aiPanelBusy = false;
        aiPanelStatus(result?.error ?? "เริ่มงานไม่สำเร็จ", "#f87171");
      }
    },
  );
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

      <div id="${AI_PANEL_ID}-status" style="font-size:11px;line-height:1.6;margin-bottom:8px;display:none"></div>
      <div id="${AI_PANEL_ID}-jobs"></div>
    </div>`;

  document.body.appendChild(panel);

  aiPanelEl("refresh")?.addEventListener("click", aiPanelLoadJobs);
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
    if (progress.state === "done" || progress.state === "failed") {
      aiPanelBusy = false;
      aiPanelLoadJobs();
    }
  });

  aiPanelLoadJobs();
}
