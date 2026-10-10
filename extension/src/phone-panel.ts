import { getClipsForVideo } from './lib/library.js';
import { bridgeBase, bridgeRequest, phoneMetadata, selectPhoneClip, type PhoneConnection, type PhoneTransfer, type PhoneVideo } from './lib/phone-bridge.js';

const KEY = 'phoneBridgeConnection';
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const button = (text: string, action: () => Promise<void>) => { const el = document.createElement('button'); el.className = 'btn'; el.textContent = text; el.addEventListener('click', async () => { el.disabled = true; try { await action(); } catch (error) { status(error); } finally { el.disabled = false; } }); return el; };
function status(value: unknown) { $('phone-status').textContent = value instanceof Error ? value.message : String(value); }
export function initPhonePanel(options: { getVideos: () => Promise<PhoneVideo[]>; resolve: (videoId: string) => Promise<void> }) {
  let connection: PhoneConnection | null = null;
  let visible = false, uploading = false, refreshing = false;
  let videos: PhoneVideo[] = [], transfers: PhoneTransfer[] = [], qrKey = '', requestedVideo: string | null = null, requestedCaption: string | undefined;
  const input = $<HTMLSelectElement>('phone-video'), address = $<HTMLSelectElement>('phone-address'), caption = $<HTMLTextAreaElement>('phone-caption');
  const request = <T>(path: string, init?: RequestInit, timeout?: number) => {
    if (!connection) return Promise.reject(new Error('เชื่อมต่อ Phone Bridge ก่อน'));
    return bridgeRequest<T>(connection, path, init, timeout);
  };
  const ready = chrome.storage.session.get(KEY).then(data => {
    const saved = data[KEY] as PhoneConnection | undefined;
    if (saved && /^http:\/\/127\.0\.0\.1:\d{4,5}$/.test(saved.base) && /^[a-f0-9]{64}$/.test(saved.token)) {
      connection = saved; $<HTMLInputElement>('phone-port').value = new URL(saved.base).port;
      $('phone-connect-form').hidden = true; $('phone-connected').hidden = false;
    }
  }).catch(error => status(error));
  function selection() {
    const video = videos.find(v => v.videoId === input.value);
    caption.value = requestedVideo === video?.videoId && requestedCaption !== undefined ? requestedCaption : video?.caption ?? '';
    requestedCaption = undefined;
    $('phone-product').textContent = video ? `สินค้า: ${video.productName}${video.shopeePost?.status === 'posted' ? ' · คลิปนี้บันทึกว่าโพสต์แล้ว ระวังโพสต์ซ้ำ' : ''}` : 'ยังไม่มีคลิป Shopee ที่สร้างเสร็จ — สร้างคลิปในแท็บอัตโนมัติก่อน';
    $<HTMLButtonElement>('phone-send').disabled = !video || uploading || !address.value;
  }
  async function loadVideos() {
    const previous = requestedVideo ?? input.value;
    const previousCaption = caption.value;
    const preserveCaption = !requestedVideo && videos.some(v => v.videoId === previous);
    videos = (await options.getVideos()).filter(v => v.platform === 'shopee');
    input.replaceChildren(...videos.map(v => new Option(`${v.productName.slice(0, 55)}${v.shopeePost?.status === 'posted' ? ' (โพสต์แล้ว)' : ''}`, v.videoId)));
    if (videos.some(v => v.videoId === previous)) input.value = previous;
    selection(); if (preserveCaption && input.value === previous) caption.value = previousCaption; requestedVideo = null;
  }
  async function renderTransfers() {
    const key = JSON.stringify([transfers, address.value]); if (key === qrKey) return; qrKey = key;
    const root = $('phone-transfers'); root.replaceChildren();
    for (const transfer of [...transfers].reverse()) {
      const card = document.createElement('section'); card.style.cssText = 'border:1px solid #374151;border-radius:10px;padding:12px;margin-top:12px';
      const title = document.createElement('strong'); title.textContent = transfer.productName; card.append(title);
      const detail = document.createElement('p'); detail.className = 'hint';
      const stage = transfer.postedReportedAt ? 'ผู้ใช้ยืนยันจากหน้ารับคลิปว่าโพสต์พร้อมสินค้าแล้ว — ตรวจคลิปก่อนบันทึกผล' : transfer.downloadRequestedAt ? 'มีการขอดาวน์โหลดไฟล์แล้ว — รอปักสินค้าและโพสต์' : transfer.phoneConnectedAt ? 'เปิดหน้ารับคลิปแล้ว — รอดาวน์โหลด' : transfer.state === 'ready' ? 'พร้อมรับคลิป — สแกน QR ด้วยกล้องมือถือ' : transfer.state === 'uploading' ? 'กำลังส่งไฟล์จากคอมพิวเตอร์' : 'ยังส่งไฟล์ไม่เสร็จ กรุณายกเลิกรายการแล้วส่งใหม่';
      detail.textContent = `${stage} · หมดอายุ ${new Date(transfer.expiresAt).toLocaleTimeString('th-TH')}`; card.append(detail);
      const link = document.createElement('p'); link.className = 'hint'; link.style.overflowWrap = 'anywhere'; link.textContent = transfer.productUrl; card.append(link);
      if (transfer.state === 'ready' && address.value) {
        try {
          const qr = await request<{ mobileUrl: string; svg: string }>(`/api/transfers/${transfer.id}/qr?base=${encodeURIComponent(address.value)}`);
          const image = document.createElement('img'); image.alt = 'QR รับคลิป Shopee บนมือถือ'; image.width = 240; image.style.cssText = 'max-width:100%;display:block;background:white;border-radius:8px';
          // Generated locally by the paired helper. A data URL avoids retaining a blob per card.
          image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr.svg)}`; card.append(image);
          const url = document.createElement('input'); url.type = 'text'; url.readOnly = true; url.value = qr.mobileUrl; url.setAttribute('aria-label', 'ลิงก์รับคลิปบนมือถือ'); card.append(url);
          card.append(button('คัดลอกลิงก์รับคลิป', async () => { await navigator.clipboard.writeText(qr.mobileUrl); status('คัดลอกแล้ว ส่งลิงก์นี้ให้มือถือของคุณเท่านั้น'); }));
        } catch (error) { const hint = document.createElement('p'); hint.className = 'hint'; hint.textContent = error instanceof Error ? error.message : String(error); card.append(hint); qrKey = ''; }
      }
      const video = videos.find(v => v.videoId === transfer.videoId);
      if (transfer.postedReportedAt && video?.shopeePost?.status !== 'posted') card.append(button('ตรวจแล้ว: บันทึกว่าโพสต์พร้อมสินค้าแล้ว', async () => {
        if (!confirm(`ตรวจใน Shopee แล้วว่าคลิป “${transfer.productName}” เผยแพร่และตะกร้าติดสินค้าตรงรายการแล้วใช่ไหม?`)) return;
        await options.resolve(transfer.videoId); await loadVideos(); qrKey = ''; await refresh(); status('บันทึกผลตามการตรวจยืนยันของคุณแล้ว');
      }));
      card.append(button('ยกเลิกลิงก์และลบไฟล์จากตัวช่วย', async () => { await request(`/api/transfers/${transfer.id}`, { method: 'DELETE' }); await refresh(); status('ยกเลิกลิงก์รับคลิปและลบสำเนาในตัวช่วยแล้ว ไฟล์ในคลังยังอยู่'); }));
      root.append(card);
    }
  }
  async function refresh() {
    if (!connection || refreshing) return;
    refreshing = true;
    try {
      const result = await request<{ transfers: PhoneTransfer[]; addresses: string[] }>('/api/transfers');
      transfers = result.transfers;
      const previous = address.value; address.replaceChildren(...result.addresses.map(a => new Option(a, a)));
      if (result.addresses.includes(previous)) address.value = previous;
      $<HTMLButtonElement>('phone-send').disabled = uploading || !input.value || !address.value;
      status(result.addresses.length ? 'เชื่อมต่อ Phone Bridge แล้ว — เปิดหน้าต่างตัวช่วยไว้ระหว่างส่งและรับคลิป' : 'ไม่พบ IP Wi-Fi — เชื่อมต่อคอมพิวเตอร์กับ Wi-Fi แล้วเปิด Phone Bridge ใหม่');
      await renderTransfers();
    } catch (error) { status(error); }
    finally { refreshing = false; }
  }
  $('phone-connect').addEventListener('click', async () => {
    const el = $<HTMLButtonElement>('phone-connect'); el.disabled = true;
    try {
      const code = $<HTMLInputElement>('phone-code').value.trim();
      if (!/^\d{6}$/.test(code)) throw new Error('ใส่รหัส 6 หลักจากหน้าต่าง Phone Bridge');
      const base = bridgeBase($<HTMLInputElement>('phone-port').value.trim());
      const result = await bridgeRequest<{ token: string; protocolVersion: number }>({ base, token: '' }, '/api/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
      if (result.protocolVersion !== 1) throw new Error('เวอร์ชัน Phone Bridge ไม่ตรงกับโปรแกรม กรุณาอัปเดตตัวช่วย');
      connection = { base, token: result.token }; await chrome.storage.session.set({ [KEY]: connection });
      $<HTMLInputElement>('phone-code').value = ''; $('phone-connect-form').hidden = true; $('phone-connected').hidden = false;
      await loadVideos(); await refresh();
    } catch (error) { status(error); } finally { el.disabled = false; }
  });
  $('phone-disconnect').addEventListener('click', async () => {
    if (uploading) { status('รอส่งคลิปเสร็จก่อนตัดการเชื่อมต่อ'); return; }
    await chrome.storage.session.remove(KEY); connection = null; qrKey = ''; $('phone-transfers').replaceChildren(); $('phone-connected').hidden = true; $('phone-connect-form').hidden = false;
    status('ตัดการเชื่อมต่อแล้ว ลิงก์ที่สร้างไว้หมดอายุเองใน 30 นาที ปิดหน้าต่าง Phone Bridge เพื่อยกเลิกทั้งหมดทันที');
  });
  $('phone-refresh').addEventListener('click', async () => { await loadVideos().catch(status); qrKey = ''; await refresh(); });
  input.addEventListener('change', selection);
  address.addEventListener('change', () => { selectionButton(); qrKey = ''; void renderTransfers(); });
  $('phone-send').addEventListener('click', async () => {
    if (uploading) return; uploading = true; selectionButton();
    let created: PhoneTransfer | undefined;
    try {
      const video = videos.find(v => v.videoId === input.value); if (!video) throw new Error('เลือกคลิป Shopee ก่อน');
      if (video.shopeePost?.status === 'posted' && !confirm('คลิปนี้บันทึกว่าโพสต์แล้ว ต้องการส่งไฟล์ให้มือถืออีกครั้งใช่ไหม?')) return;
      if (transfers.some(t => t.videoId === video.videoId)) throw new Error('คลิปนี้มีลิงก์รับอยู่แล้ว ใช้ QR เดิม หรือยกเลิกรายการเดิมก่อนส่งใหม่');
      const clip = selectPhoneClip(video, await getClipsForVideo(video.videoId));
      const metadata = phoneMetadata(video, caption.value, clip);
      status(`กำลังส่งไฟล์ ${(clip.blob.size / 1024 ** 2).toFixed(1)} MB ไป Phone Bridge…`);
      created = await request<PhoneTransfer>('/api/transfers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(metadata) });
      await request(`/api/transfers/${created.id}/video`, { method: 'PUT', headers: { 'Content-Type': 'video/mp4' }, body: clip.blob }, 5 * 60_000);
      qrKey = ''; await refresh(); status('พร้อมแล้ว — สแกน QR ด้วยมือถือ Android หรือ iPhone บน Wi-Fi เดียวกัน');
      $('phone-transfers').lastElementChild?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    } catch (error) {
      // A timeout can mean the helper accepted the file. Never delete or silently resend it.
      qrKey = ''; await refresh(); status(error);
    } finally { uploading = false; selectionButton(); }
  });
  function selectionButton() { $<HTMLButtonElement>('phone-send').disabled = uploading || !input.value || !address.value; }
  const poll = setInterval(() => { if (visible && document.visibilityState === 'visible' && !uploading) void refresh(); }, 5000);
  window.addEventListener('pagehide', () => { clearInterval(poll); });
  return {
    async setVisible(value: boolean) { visible = value; if (value) { await ready; await loadVideos().catch(status); await refresh(); } },
    selectVideo(videoId: string, text?: string) { requestedVideo = videoId; requestedCaption = text; },
  };
}
