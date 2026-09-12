interface PendingClip {
  index: number;
  prompt: string;
}

interface PendingJob {
  videoId: string;
  productName: string;
  hook: string;
  clips: PendingClip[];
  imageUrl: string | null;
  duration: number | null;
  aspectRatio: string | null;
}

interface JobProgress {
  videoId: string;
  current: number;
  total: number;
  state: string;
  at: number;
}

const POPUP_CLIP_SECONDS = 8;
const contentEl = document.getElementById("content") as HTMLDivElement;
const progressEl = document.getElementById("progress") as HTMLDivElement;

document.getElementById("openOptions")?.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

function renderMessage(html: string) {
  contentEl.innerHTML = `<p class="msg">${html}</p>`;
}

const PROGRESS_LABEL: Record<string, string> = {
  generating: "กำลังสร้าง",
  uploading: "กำลังอัปโหลด",
  done: "เสร็จแล้ว",
  failed: "ล้มเหลว",
};

function renderProgress(progress: JobProgress | undefined) {
  if (!progress || Date.now() - progress.at > 30 * 60 * 1000) {
    progressEl.hidden = true;
    return;
  }
  progressEl.hidden = false;

  // Progress only advances while the generating tab is open — closing it
  // kills the content script mid-job, and a bar frozen at the last value
  // otherwise looks like the job is still running.
  const stalledMs = Date.now() - progress.at;
  if (progress.state !== "done" && progress.state !== "failed" && stalledMs > 3 * 60 * 1000) {
    progressEl.innerHTML = `
      <div class="progress-row"><span>หยุดค้างที่คลิป ${progress.current}/${progress.total}</span></div>
      <p class="msg">ไม่มีความคืบหน้า ${Math.round(stalledMs / 60000)} นาที — แท็บที่ใช้สร้างอาจถูกปิดไป กดสร้างใหม่ได้เลย</p>
    `;
    return;
  }

  const label = PROGRESS_LABEL[progress.state] ?? progress.state;
  const pct = Math.round((progress.current / Math.max(1, progress.total)) * 100);
  progressEl.innerHTML = `
    <div class="progress-row">
      <span>${label} — คลิป ${progress.current}/${progress.total}</span>
      <span>${pct}%</span>
    </div>
    <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
  `;
}

function renderJobs(jobs: PendingJob[], onStudioPage: boolean) {
  contentEl.innerHTML = "";

  if (!onStudioPage) {
    const note = document.createElement("p");
    note.className = "msg";
    note.textContent = "ไม่ได้อยู่หน้าเว็บสร้างวิดีโอ — กดสร้างแล้วระบบจะเปิดแท็บใหม่ให้";
    contentEl.appendChild(note);
  }

  for (const job of jobs) {
    const row = document.createElement("div");
    row.className = "job";

    const img = document.createElement("img");
    if (job.imageUrl) img.src = job.imageUrl;
    row.appendChild(img);

    const info = document.createElement("div");
    info.className = "job-info";

    const name = document.createElement("div");
    name.className = "job-name";
    name.textContent = job.productName;

    const hook = document.createElement("div");
    hook.className = "job-hook";
    hook.textContent = job.hook;

    const meta = document.createElement("div");
    meta.className = "job-meta";
    meta.textContent = `${job.clips.length} คลิป · ${job.clips.length * POPUP_CLIP_SECONDS} วินาที`;

    info.append(name, hook, meta);
    row.appendChild(info);

    const button = document.createElement("button");
    button.className = "run";
    button.textContent = onStudioPage ? "สร้าง" : "เปิดแท็บ";
    button.addEventListener("click", () => {
      button.disabled = true;
      button.textContent = "กำลังส่ง...";
      const targetDuration = Number(
        (document.getElementById("duration") as HTMLSelectElement).value,
      );
      const site = (document.getElementById("site") as HTMLSelectElement).value;
      chrome.runtime.sendMessage(
        { type: "RUN_JOB_FROM_POPUP", job, targetDuration, site },
        (result: { ok: boolean; error?: string }) => {
          if (result?.ok) {
            button.textContent = "เริ่มแล้ว ✓";
            setTimeout(() => window.close(), 600);
          } else {
            button.disabled = false;
            button.textContent = "ลองใหม่";
            renderMessage(result?.error ?? "ส่งงานไม่สำเร็จ");
          }
        },
      );
    });
    row.appendChild(button);

    contentEl.appendChild(row);
  }
}

async function load() {
  const stored = await chrome.storage.local.get([
    "appBaseUrl",
    "extensionToken",
    "targetDuration",
    "generationSite",
    "jobProgress",
  ]);
  const appBaseUrl = (stored.appBaseUrl as string | undefined) || "http://localhost:3000";
  const extensionToken = (stored.extensionToken as string | undefined) || "";

  const siteSelect = document.getElementById("site") as HTMLSelectElement;
  siteSelect.value = (stored.generationSite as string | undefined) ?? "aistudio";
  siteSelect.addEventListener("change", () => {
    chrome.storage.local.set({ generationSite: siteSelect.value });
  });

  const durationSelect = document.getElementById("duration") as HTMLSelectElement;
  durationSelect.value = String((stored.targetDuration as number | undefined) ?? 24);
  durationSelect.addEventListener("change", () => {
    chrome.storage.local.set({ targetDuration: Number(durationSelect.value) });
  });

  renderProgress(stored.jobProgress as JobProgress | undefined);

  if (!extensionToken) {
    renderMessage('ยังไม่ได้ตั้งค่า Extension Token — กด "ตั้งค่า" ด้านบนก่อนใช้งาน');
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabUrl = tab?.url ?? "";
  const onStudioPage =
    siteSelect.value === "flow"
      ? tabUrl.includes("flow.google.com")
      : tabUrl.includes("aistudio.google.com");

  try {
    const res = await fetch(`${appBaseUrl}/api/videos/extension/pending`, {
      headers: { "X-Extension-Token": extensionToken },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      renderMessage(body.error ?? `โหลดงานไม่สำเร็จ (${res.status})`);
      return;
    }

    const { jobs } = (await res.json()) as { jobs: PendingJob[] };
    if (jobs.length === 0) {
      renderMessage(
        'ยังไม่มีงานที่รออยู่ — ไปที่หน้า Content ในแอปแล้วกด "สร้างผ่าน AI Studio (Extension)" ก่อน',
      );
      return;
    }

    // Product images are served by the app, not this extension origin.
    for (const job of jobs) {
      if (job.imageUrl && !job.imageUrl.startsWith("http")) {
        job.imageUrl = `${appBaseUrl}${job.imageUrl}`;
      }
    }

    renderJobs(jobs, onStudioPage);
  } catch (err) {
    renderMessage(
      `เชื่อมต่อแอปไม่ได้ (${err instanceof Error ? err.message : "unknown"}) — เช็คว่า ${appBaseUrl} เปิดอยู่`,
    );
  }
}

// Keep the progress bar live while the popup stays open.
chrome.storage.onChanged.addListener((changes) => {
  if (changes.jobProgress) renderProgress(changes.jobProgress.newValue as JobProgress | undefined);
});

load();
