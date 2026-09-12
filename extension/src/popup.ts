interface PendingJob {
  videoId: string;
  productName: string;
  hook: string;
  prompt: string;
  imageUrl: string | null;
  duration: number | null;
  aspectRatio: string | null;
}

const contentEl = document.getElementById("content") as HTMLDivElement;

document.getElementById("openOptions")?.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

function renderMessage(html: string) {
  contentEl.innerHTML = `<p class="msg">${html}</p>`;
}

function renderJobs(jobs: PendingJob[], onStudioPage: boolean) {
  contentEl.innerHTML = "";

  if (!onStudioPage) {
    const note = document.createElement("p");
    note.className = "msg";
    note.textContent = "ไม่ได้อยู่หน้า AI Studio — กดสร้างแล้วระบบจะเปิดแท็บใหม่ให้";
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
    info.append(name, hook);
    row.appendChild(info);

    const button = document.createElement("button");
    button.className = "run";
    button.textContent = onStudioPage ? "สร้าง" : "เปิดแท็บ";
    button.addEventListener("click", () => {
      button.disabled = true;
      button.textContent = "กำลังส่ง...";
      chrome.runtime.sendMessage(
        { type: "RUN_JOB_FROM_POPUP", job },
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
  const stored = await chrome.storage.local.get(["appBaseUrl", "extensionToken"]);
  const appBaseUrl = (stored.appBaseUrl as string | undefined) || "http://localhost:3000";
  const extensionToken = (stored.extensionToken as string | undefined) || "";

  if (!extensionToken) {
    renderMessage('ยังไม่ได้ตั้งค่า Extension Token — กด "ตั้งค่า" ด้านบนก่อนใช้งาน');
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const onStudioPage = (tab?.url ?? "").includes("aistudio.google.com");

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

load();
