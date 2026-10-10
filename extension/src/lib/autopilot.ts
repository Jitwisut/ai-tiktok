import { isLicenseFailure } from "./license-client.js";
import { SHOPEE_STYLES, shopeeProductLink, type PublishPlatform } from "./commerce.js";
/**
 * Autopilot: turns a list of products into posted TikTok videos without the
 * user in the loop — analyze → script + scenes → Flow video → TikTok post —
 * one product at a time.
 *
 * Two modes:
 * - batch: work through the chosen products once, back to back, then stop.
 * - schedule: at each daily time slot, take the next product from the pool
 *   (looping forever) and run it through the same steps.
 *
 * The MV3 service worker can be killed at any moment, so nothing lives in
 * memory: the state is in chrome.storage and every step is re-entrant. A
 * one-minute alarm plus job/post storage events drive tick(); a step being
 * worked on holds a lease, so a restarted worker retries it only once the
 * lease has expired.
 */

import * as store from "./store.js";
import { CONTENT_STYLES } from "./analysis-prompts.js";
import { durationOptions } from "./prompt-engine.js";

export type AutopilotPostMode = "auto" | "prepare" | "none";
export type AutopilotSite = "flow" | "aistudio" | "gemini" | "meta";

export interface AutopilotSettings {
  platform?: PublishPlatform;
  targetDuration: number;
  /** A content style, or "rotate" to cycle through all of them. */
  style: string;
  postMode: AutopilotPostMode;
  site: AutopilotSite;
  /** Fixed for this run, even if the general Settings tab changes later. */
  textSource: store.TextSource;
}

type Step = "analyze" | "content" | "video" | "post";

interface CurrentItem {
  productId: string;
  productName: string;
  step: Step;
  attempts: number;
  leaseUntil: number;
  stepStartedAt: number;
  style?: string;
  contentId?: string;
  caption?: string;
  videoId?: string;
  postRequestedAt?: number;
  lastError?: string;
}

export interface AutopilotHistoryEntry {
  platform?: PublishPlatform;
  productId: string;
  productName: string;
  videoId: string | null;
  /** posted: published · ready: form filled, waiting for the user · made: video only · failed */
  status: "posted" | "ready" | "made" | "failed";
  error: string | null;
  style: string | null;
  at: number;
}

export interface AutopilotState {
  status: "idle" | "running" | "paused";
  mode: "batch" | "schedule";
  settings: AutopilotSettings;
  /** Daily "HH:MM" slots, schedule mode only. */
  times: string[];
  /** batch: products still to do · schedule: the rotation pool */
  productIds: string[];
  poolIndex: number;
  styleIndex: number;
  nextRunAt: number | null;
  current: CurrentItem | null;
  history: AutopilotHistoryEntry[];
  consecutiveFailures: number;
  message: string | null;
  startedAt: number;
}

export interface AutopilotDeps {
  requireLicense(): Promise<void>;
  resumeVideo(videoId: string): Promise<void>;
  resumePost(videoId: string): Promise<void>;
  analyzeProduct(productId: string, source: store.TextSource): Promise<unknown>;
  generateContentScenes(
    productId: string, style: string, targetDuration: number, site: AutopilotSite, source: store.TextSource,
    resumeContentId?: string, onContentReady?: (content: store.Content) => Promise<void>, platform?: PublishPlatform,
  ): Promise<{ content: store.Content }>;
  startVideo(contentId: string, targetDuration: number, site: AutopilotSite): Promise<string>;
  prepareTikTokPost(videoId: string, caption: string, autoPost: boolean, productId: string | null): Promise<{ ok: boolean; error?: string }>;
  prepareShopeePost(videoId: string, caption: string, autoPost: boolean, productUrl: string | null): Promise<{ ok: boolean; error?: string }>;
  isManualJobRunning(): Promise<boolean>;
}

const STATE_KEY = "autopilot";
const ALARM = "autopilot-tick";
const HISTORY_MAX = 60;
const MAX_ATTEMPTS = 2;
const RETRY_BACKOFF_MS = 2 * 60_000;
/** Stop spending credits when something is broken for every product, not just one. */
const MAX_CONSECUTIVE_FAILURES = 3;
const LEASE_GEMINI_MS = 5 * 60_000;
const LEASE_START_MS = 3 * 60_000;
const VIDEO_TIMEOUT_MS = 75 * 60_000;
const POST_TIMEOUT_MS = 20 * 60_000;

export function parseTimes(input: string): string[] {
  const times = input
    .split(/[\s,]+/)
    .map((t) => t.trim().replace(".", ":"))
    .filter(Boolean)
    .map((t) => {
      const m = t.match(/^(\d{1,2}):(\d{2})$/);
      if (!m) return null;
      const h = Number(m[1]);
      const min = Number(m[2]);
      return h < 24 && min < 60 ? `${String(h).padStart(2, "0")}:${m[2]}` : null;
    });
  return [...new Set(times.filter((t): t is string => !!t))].sort();
}

/** The first slot strictly after `after`, in local time. */
export function nextSlot(times: string[], after: number): number | null {
  if (times.length === 0) return null;
  for (let day = 0; day < 8; day++) {
    for (const time of times) {
      const [h, m] = time.split(":").map(Number);
      const slot = new Date(after);
      slot.setDate(slot.getDate() + day);
      slot.setHours(h, m, 0, 0);
      if (slot.getTime() > after) return slot.getTime();
    }
  }
  return null;
}

function tiktokIdOf(product: store.Product | null): string | null {
  return store.tiktokIdFromSourceUrl(product?.sourceUrl);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createAutopilot(deps: AutopilotDeps) {
  async function load(): Promise<AutopilotState | null> {
    const stored = await chrome.storage.local.get(STATE_KEY);
    return (stored[STATE_KEY] as AutopilotState | undefined) ?? null;
  }

  async function save(state: AutopilotState) {
    await chrome.storage.local.set({ [STATE_KEY]: state });
  }

  function pickStyle(state: AutopilotState): string {
    if (state.settings.style !== "rotate") return state.settings.style;
    const styles = state.settings.platform === "shopee" ? SHOPEE_STYLES : CONTENT_STYLES;
    const style = styles[state.styleIndex % styles.length];
    state.styleIndex += 1;
    return style;
  }

  function finish(state: AutopilotState, status: AutopilotHistoryEntry["status"], error: string | null) {
    const cur = state.current!;
    state.history.unshift({
      platform: state.settings.platform ?? "tiktok",
      productId: cur.productId,
      productName: cur.productName,
      videoId: cur.videoId ?? null,
      status,
      error,
      style: cur.style ?? null,
      at: Date.now(),
    });
    state.history.length = Math.min(state.history.length, HISTORY_MAX);
    state.current = null;
    if (status === "failed") {
      state.consecutiveFailures += 1;
      if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        state.status = "paused";
        state.message = `ล้มเหลวติดกัน ${state.consecutiveFailures} ชิ้น — หยุดไว้ก่อนเพื่อไม่ให้เสียเครดิต (ล่าสุด: ${error ?? "-"})`;
      }
    } else {
      state.consecutiveFailures = 0;
    }
  }

  /**
   * The Flow/Gemini tab keeps its job in storage so it can resume after the
   * page reloads. A skipped or stopped item must not resume: refreshing the
   * tab would submit its prompt again and spend credits on a video nobody
   * waits for any more.
   */
  async function forgetTabJob(videoId: string | undefined) {
    if (!videoId) return;
    const stored = await chrome.storage.local.get(["activeFlowJob", "activeGeminiJob", "activeStudioJob", "metaActiveJob", "pendingVideoJob"]);
    const stale = (["activeFlowJob", "activeGeminiJob", "activeStudioJob", "metaActiveJob"] as const).filter(
      (key) => (stored[key] as { job?: { videoId?: string } } | undefined)?.job?.videoId === videoId,
    ) as string[];
    if ((stored.pendingVideoJob as { videoId?: string } | undefined)?.videoId === videoId) stale.push("pendingVideoJob", "pendingVideoJobSite");
    if (stale.length) await chrome.storage.local.remove(stale);
    const key = `shopeePost:${videoId}`;
    const pending = (await chrome.storage.local.get(key))[key] as { tabId: number; submittedAt?: number } | undefined;
    if (pending && !pending.submittedAt) {
      await chrome.storage.local.remove([key, `shopeePostTab:${pending.tabId}`]);
      await chrome.tabs.remove(pending.tabId).catch(() => {});
      await store.updateVideoJob(videoId, { shopeePost: { status: "failed", at: Date.now(), error: "ยกเลิกงานโดยผู้ใช้" } });
    }
  }

  /** A failed step is retried after a pause; the product is given up on after MAX_ATTEMPTS. */
  function failStep(state: AutopilotState, err: unknown) {
    if (isLicenseFailure(err)) {
      state.status = "paused";
      state.message = errorText(err);
      if (state.current) {
        state.current.leaseUntil = 0; state.current.lastError = errorText(err);
        // Preparation was denied before it could start; resume must retry this step.
        if (state.current.step === "post") state.current.postRequestedAt = undefined;
      }
      return;
    }
    const cur = state.current!;
    cur.attempts += 1;
    cur.lastError = errorText(err);
    if (cur.attempts >= MAX_ATTEMPTS) {
      finish(state, "failed", `${stepLabel(cur.step)}: ${cur.lastError}`);
      return;
    }
    if (cur.step === "video") cur.videoId = undefined;
    if (cur.step === "post") cur.postRequestedAt = undefined;
    cur.leaseUntil = Date.now() + RETRY_BACKOFF_MS;
  }

  function advance(cur: CurrentItem, step: Step) {
    cur.step = step;
    cur.attempts = 0;
    cur.leaseUntil = 0;
    cur.stepStartedAt = Date.now();
    cur.lastError = undefined;
  }

  /** Returns true when another step can run straight away. */
  async function step(): Promise<boolean> {
    const state = await load();
    if (!state || state.status !== "running") return false;
    // Runs saved before this setting existed still use the currently selected source.
    if (!state.settings.textSource) {
      state.settings.textSource = (await store.getSettings()).textSource ?? "gemini-web";
      await save(state);
    }
    const now = Date.now();

    if (!state.current) {
      // A job started by hand from the side panel owns Flow until it's done.
      if (await deps.isManualJobRunning()) return false;

      let productId: string | undefined;
      if (state.mode === "batch") {
        productId = state.productIds.shift();
        if (!productId) {
          state.status = "idle";
          const thisRun = state.history.filter((h) => h.at >= state.startedAt);
          const ok = thisRun.filter((h) => h.status !== "failed").length;
          state.message = `ทำครบแล้ว — สำเร็จ ${ok} ชิ้น, ไม่สำเร็จ ${thisRun.length - ok} ชิ้น`;
          await save(state);
          await chrome.alarms.clear(ALARM);
          return false;
        }
      } else {
        if (state.productIds.length === 0) {
          state.status = "idle";
          state.message = "ไม่มีสินค้าในรอบหมุนเวียน";
          await save(state);
          return false;
        }
        state.nextRunAt ??= nextSlot(state.times, now);
        if (!state.nextRunAt || now < state.nextRunAt) {
          await save(state);
          return false;
        }
        productId = state.productIds[state.poolIndex % state.productIds.length];
        state.poolIndex += 1;
        state.nextRunAt = nextSlot(state.times, now);
      }

      const product = await store.getProduct(productId);
      state.current = {
        productId,
        productName: product?.name ?? "(สินค้าถูกลบ)",
        step: "analyze",
        attempts: 0,
        leaseUntil: 0,
        stepStartedAt: now,
      };
      if (!product) {
        finish(state, "failed", "ไม่พบสินค้าในคลังแล้ว");
        await save(state);
        return true;
      }
      state.message = null;
      await save(state);
    }

    const cur = state.current!;
    if (cur.leaseUntil > now) return false;

    // Observation of a submitted video/post is always permitted; initiating another step is paid.
    if (cur.step === "analyze" || cur.step === "content" || (cur.step === "video" && !cur.videoId) || (cur.step === "post" && !cur.postRequestedAt)) {
      try { await deps.requireLicense(); }
      catch (error) { failStep(state, error); await saveMerged(state); return false; }
    }
    switch (cur.step) {
      case "analyze": {
        cur.leaseUntil = now + LEASE_GEMINI_MS;
        await save(state);
        try {
          const source = state.settings.textSource;
          if (!(await store.getAnalysis(cur.productId)) || (await store.getAnalysisSource(cur.productId)) !== source) {
            await deps.analyzeProduct(cur.productId, source);
          }
          advance(cur, "content");
        } catch (err) {
          failStep(state, err);
        }
        await saveMerged(state);
        return true;
      }

      case "content": {
        cur.leaseUntil = now + LEASE_GEMINI_MS;
        cur.style ??= pickStyle(state);
        await save(state);
        try {
          const { content } = await deps.generateContentScenes(
            cur.productId, cur.style, state.settings.targetDuration, state.settings.site, state.settings.textSource,
            cur.contentId,
            async (draft) => {
              cur.contentId = draft.id;
              cur.caption = draft.caption;
              const latest = await load();
              if (latest?.startedAt === state.startedAt && latest.current?.productId === cur.productId && latest.current.step === "content") {
                latest.current.contentId = draft.id;
                latest.current.caption = draft.caption;
                await save(latest);
              }
            },
            state.settings.platform ?? "tiktok",
          );
          cur.contentId = content.id;
          cur.caption = content.caption;
          advance(cur, "video");
        } catch (err) {
          failStep(state, err);
        }
        await saveMerged(state);
        return true;
      }

      case "video": {
        if (!cur.videoId) {
          cur.leaseUntil = now + LEASE_START_MS;
          await save(state);
          try {
            cur.videoId = await deps.startVideo(cur.contentId!, state.settings.targetDuration, state.settings.site);
            cur.leaseUntil = 0;
            cur.stepStartedAt = Date.now();
          } catch (err) {
            failStep(state, err);
          }
          await saveMerged(state);
          return false;
        }

        const video = await store.getVideo(cur.videoId);
        // The generation tab reports failure through jobProgress, not the video record.
        const { jobProgress } = await chrome.storage.local.get("jobProgress");
        const progress = jobProgress as { videoId?: string; state?: string; error?: string } | undefined;
        if (video?.status === "completed") {
          if (state.settings.postMode === "none") finish(state, "made", null);
          else advance(cur, "post");
          await save(state);
          return true;
        }
        const progressError = progress?.videoId === cur.videoId ? progress.error : undefined;
        if (progress?.videoId === cur.videoId && progress.state === "paused") {
          state.status = "paused"; state.message = progressError ?? "สิทธิ์ใช้งาน: กรุณาตรวจสิทธิ์แล้วทำต่อ";
          cur.leaseUntil = 0; await save(state); return false;
        }
        // Out of video allowance every retry and every next product fails the
        // same way — pause on this product instead, so "ทำต่อ" picks it up
        // once the allowance is back (analysis and script are kept).
        if (progressError?.startsWith("โควต้า")) {
          if (video) await store.updateVideoJob(video.id, { status: "failed", errorMessage: progressError });
          cur.videoId = undefined;
          cur.attempts = 0;
          cur.leaseUntil = 0;
          cur.lastError = progressError;
          state.status = "paused";
          state.message = `หยุดไว้ก่อน — ${progressError} แล้วกด "ทำต่อ" เพื่อสร้างวิดีโอชิ้นนี้ต่อ`;
          await save(state);
          return false;
        }
        if (!video || video.status === "failed" || video.status === "cancelled" || (progress?.videoId === cur.videoId && progress.state === "failed")) {
          failStep(state, progressError ?? video?.errorMessage ?? "สร้างวิดีโอไม่สำเร็จ — ดูบันทึกขั้นตอนงานในแท็บคลัง");
          await save(state);
          return true;
        }
        if (now - cur.stepStartedAt > VIDEO_TIMEOUT_MS) {
          failStep(state, "สร้างวิดีโอนานเกินไป");
          await save(state);
          return true;
        }
        return false;
      }

      case "post": {
        if (!cur.postRequestedAt) {
          // Result messages can arrive before prepare resolves. Anchor to request start, not return time.
          cur.postRequestedAt = now;
          cur.leaseUntil = now + LEASE_START_MS;
          await save(state);
          try {
            const product = await store.getProduct(cur.productId);
            const result = state.settings.platform === "shopee"
              ? await deps.prepareShopeePost(cur.videoId!, cur.caption ?? "", state.settings.postMode === "auto", shopeeProductLink(product?.sourceUrl)?.url ?? null)
              : await deps.prepareTikTokPost(
              cur.videoId!,
              cur.caption ?? "",
              state.settings.postMode === "auto",
              tiktokIdOf(product),
            );
            if (!result.ok) throw new Error(result.error ?? "เปิดหน้าโพสต์ไม่สำเร็จ");
            cur.leaseUntil = 0;
          } catch (err) {
            failStep(state, err);
          }
          await saveMerged(state);
          return false;
        }

        const video = await store.getVideo(cur.videoId!);
        const post = state.settings.platform === "shopee" ? video?.shopeePost : video?.tiktokPost;
        if (post?.status === "uncertain") {
          state.status = "paused";
          state.message = "ยังยืนยันผลโพสต์ไม่ได้ — ตรวจบัญชีว่าคลิปขึ้นแล้วหรือไม่แล้วบันทึกผลในคลังก่อนทำต่อ เพื่อป้องกันโพสต์ซ้ำ";
          await save(state);
          return false;
        }
        if (post && post.at >= cur.postRequestedAt && ["posted", "ready", "failed"].includes(post.status)) {
          if (post.status === "posted") finish(state, "posted", null);
          else if (post.status === "ready") finish(state, "ready", null);
          else if (post.status === "failed") failStep(state, post.error ?? "โพสต์ไม่สำเร็จ");
          else return false;
          await save(state);
          return true;
        }
        if (now - cur.postRequestedAt > POST_TIMEOUT_MS) {
          if (state.settings.platform === "shopee") {
            await store.updateVideoJob(cur.videoId!, { shopeePost: { status: "uncertain", at: Date.now(), error: "หน้า Shopee ไม่ตอบกลับ — ตรวจสถานะโพสต์ในคลังก่อนทำต่อ" } });
            state.status = "paused";
            state.message = "หน้า Shopee ไม่ตอบกลับ — ตรวจสถานะโพสต์ในคลังก่อนทำต่อ";
          } else {
            await store.updateVideoJob(cur.videoId!, { tiktokPost: { status: "uncertain", at: Date.now(), error: "หน้า TikTok ไม่ตอบกลับ — ตรวจสถานะโพสต์ในคลังก่อนทำต่อ" } });
            state.status = "paused";
            state.message = "หน้า TikTok ไม่ตอบกลับ — ตรวจสถานะโพสต์ในคลังก่อนทำต่อ";
          }
          await save(state);
          return true;
        }
        return false;
      }
    }
  }

  /**
   * A long Gemini call can overlap a pause or stop from the side panel; keep
   * the user's status and mode changes rather than overwriting them with the
   * copy loaded before the call.
   */
  async function saveMerged(state: AutopilotState) {
    const latest = await load();
    if (latest && latest.startedAt === state.startedAt && latest.status !== "running") {
      state.status = latest.status;
      state.message = latest.message;
    }
    if (latest && latest.startedAt !== state.startedAt) return; // stopped and restarted meanwhile
    await save(state);
  }

  let ticking = false;
  let again = false;

  async function tick() {
    if (ticking) {
      again = true;
      return;
    }
    ticking = true;
    try {
      let rounds = 0;
      do {
        again = false;
        if (await step()) again = true;
      } while (again && ++rounds < 20);
    } catch (err) {
      const state = await load();
      if (state) {
        state.message = `ข้อผิดพลาดในระบบอัตโนมัติ: ${errorText(err)}`;
        await save(state);
      }
    } finally {
      ticking = false;
    }
  }

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM) void tick();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes.videos || changes.jobProgress)) void tick();
  });

  // A worker woken for any reason picks up where the last one left off.
  void tick();

  async function handleMessage(message: { type: string; [key: string]: unknown }): Promise<unknown> {
    switch (message.type) {
      case "AUTOPILOT_GET_STATE":
        return { ok: true, state: await load() };

      case "AUTOPILOT_START": {
        await deps.requireLicense();
        const existing = await load();
        if (existing && existing.status !== "idle") {
          return { ok: false, error: "ระบบอัตโนมัติทำงานอยู่แล้ว — กดหยุดก่อนเริ่มใหม่" };
        }
        const mode = message.mode === "schedule" ? "schedule" : "batch";
        const productIds = (message.productIds as string[] | undefined)?.filter(Boolean) ?? [];
        if (productIds.length === 0) return { ok: false, error: "เลือกสินค้าอย่างน้อย 1 ชิ้น" };
        const times = mode === "schedule" ? parseTimes(String(message.times ?? "")) : [];
        if (mode === "schedule" && times.length === 0) return { ok: false, error: "ใส่เวลาอย่างน้อย 1 เวลา เช่น 09:00, 19:30" };
        const settings = message.settings as AutopilotSettings;
        const textSource = ["gemini-web", "chatgpt-web", "api"].includes(settings?.textSource)
          ? settings.textSource : (await store.getSettings()).textSource ?? "gemini-web";
        const site: AutopilotSite = ["aistudio", "gemini", "meta"].includes(settings?.site) ? settings.site : "flow";
        const platform = settings?.platform === "shopee" ? "shopee" : "tiktok";
        const allowedStyles: readonly string[] = platform === "shopee" ? SHOPEE_STYLES : CONTENT_STYLES;
        if (settings?.style !== "rotate" && settings?.style && !allowedStyles.includes(settings.style)) return { ok: false, error: "สไตล์ไม่ตรงกับแพลตฟอร์มที่เลือก" };
        if (platform === "shopee" && settings?.postMode !== "none") {
          for (const id of productIds) {
            const product = await store.getProduct(id);
            if (!shopeeProductLink(product?.sourceUrl)) return { ok: false, error: `สินค้า ${product?.name ?? id} ไม่มีลิงก์ Shopee — นำเข้าสินค้า Shopee ก่อนเริ่มโพสต์` };
          }
        }
        const lengths = durationOptions(site);
        const now = Date.now();
        const state: AutopilotState = {
          status: "running",
          mode,
          settings: {
            platform: settings?.platform === "shopee" ? "shopee" : "tiktok",
            targetDuration: lengths.includes(Number(settings?.targetDuration)) ? Number(settings.targetDuration) : lengths[0],
            style: settings?.style || "rotate",
            postMode: ["auto", "prepare", "none"].includes(settings?.postMode) ? settings.postMode : "prepare",
            site,
            textSource,
          },
          times,
          productIds,
          poolIndex: 0,
          styleIndex: 0,
          nextRunAt: mode === "schedule" ? nextSlot(times, now) : null,
          current: null,
          history: existing?.history ?? [],
          consecutiveFailures: 0,
          message: null,
          startedAt: now,
        };
        await save(state);
        await chrome.alarms.create(ALARM, { periodInMinutes: 1 });
        void tick();
        return { ok: true, state };
      }

      case "AUTOPILOT_PAUSE":
      case "AUTOPILOT_RESUME": {
        if (message.type === "AUTOPILOT_RESUME") await deps.requireLicense();
        const state = await load();
        if (!state || state.status === "idle") return { ok: false, error: "ระบบอัตโนมัติไม่ได้ทำงาน" };
        if (message.type === "AUTOPILOT_RESUME" && state.current?.videoId) {
          const progress = (await chrome.storage.local.get("jobProgress")).jobProgress as { state?: string; videoId?: string } | undefined;
          if (progress?.state === "paused" && progress.videoId === state.current.videoId) {
            if (state.current.step === "video") await deps.resumeVideo(state.current.videoId);
            else if (state.current.step === "post") await deps.resumePost(state.current.videoId);
          }
        }
        state.status = message.type === "AUTOPILOT_PAUSE" ? "paused" : "running";
        state.message = null;
        if (state.status === "running") {
          state.consecutiveFailures = 0;
          if (state.current) state.current.leaseUntil = 0;
          await chrome.alarms.create(ALARM, { periodInMinutes: 1 });
        }
        await save(state);
        if (state.status === "running") void tick();
        return { ok: true, state };
      }

      case "AUTOPILOT_STOP": {
        const state = await load();
        if (!state) return { ok: true, state: null };
        const videoId = state.current?.videoId;
        state.status = "idle";
        state.current = null;
        state.nextRunAt = null;
        state.message = "หยุดแล้ว (วิดีโอที่ Flow กำลังสร้างอยู่จะยังสร้างต่อจนเสร็จ แต่จะไม่โพสต์)";
        state.startedAt = Date.now();
        await save(state);
        await forgetTabJob(videoId);
        await chrome.alarms.clear(ALARM);
        return { ok: true, state };
      }

      case "AUTOPILOT_SKIP_CURRENT": {
        const state = await load();
        if (!state?.current) return { ok: false, error: "ไม่มีสินค้าที่กำลังทำ" };
        const previousStatus = state.status;
        state.status = "paused";
        await save(state);
        await forgetTabJob(state.current.videoId);
        state.status = previousStatus;
        finish(state, "failed", "ข้ามโดยผู้ใช้");
        state.consecutiveFailures = 0;
        await save(state);
        void tick();
        return { ok: true, state };
      }
    }
    return undefined;
  }

  async function pauseForLicense(message: string) {
    const state = await load();
    if (!state || state.status !== "running") return;
    state.status = "paused"; state.message = message;
    if (state.current) state.current.leaseUntil = 0;
    await save(state);
  }

  return {
    pauseForLicense,
    handleMessage,
    tick,
    async ownsVideo(videoId: string): Promise<boolean> {
      const state = await load();
      return Boolean(state && (state.current?.videoId === videoId || state.history.some((h) => h.videoId === videoId)));
    },
    async isBusy(): Promise<boolean> {
      const state = await load();
      return Boolean(state?.current && state.status !== "idle");
    },
  };
}

export function stepLabel(step: Step): string {
  return { analyze: "วิเคราะห์สินค้า", content: "เขียนสคริปต์และฉาก", video: "สร้างวิดีโอ", post: "โพสต์วิดีโอ" }[step];
}
