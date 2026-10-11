import { shopeeProductLink } from './commerce.js';
import { MERGED_CLIP_INDEX, type StoredClip } from './library.js';
import { validShopeeVideo } from './shopee-post.js';

export interface PhoneVideo {
  videoId: string;
  productName: string;
  caption: string;
  seconds: number;
  clipCount: number;
  platform?: string;
  productShopeeUrl?: string | null;
  shopeePost?: { status: string } | null;
}
export interface PhoneConnection { base: string; token: string }
export interface PhoneTransfer {
  id: string; videoId: string; productName: string; productUrl: string; caption: string;
  bytes: number; seconds: number; state: string; createdAt: number; expiresAt: number;
  phoneConnectedAt: number | null; downloadRequestedAt: number | null; postedReportedAt: number | null;
}
export function bridgeBase(port: string): string {
  if (!/^\d{4,5}$/.test(port) || Number(port) < 1024 || Number(port) > 65535) throw new Error('พอร์ตต้องเป็นเลข 1024–65535');
  return `http://127.0.0.1:${Number(port)}`;
}
export function selectPhoneClip(video: PhoneVideo, clips: StoredClip[]): StoredClip {
  const own = clips.filter(c => c.videoId === video.videoId);
  const merged = own.find(c => c.index === MERGED_CLIP_INDEX);
  const parts = own.filter(c => c.index >= 0);
  const clip = merged ?? (video.clipCount === 1 && parts.length === 1 && parts[0].index === 0 ? parts[0] : undefined);
  if (!clip) throw new Error('ไม่พบวิดีโอเต็ม — ต่อคลิปให้เสร็จในคลัง/งานก่อนส่งไปมือถือ');
  const invalid = validShopeeVideo(video.seconds, clip.blob.size, clip.mimeType || clip.blob.type);
  if (invalid) throw new Error(invalid);
  return clip;
}
export function phoneMetadata(video: PhoneVideo, caption: string, clip: StoredClip) {
  if (video.platform !== 'shopee') throw new Error('เลือกคลิปที่สร้างสำหรับ Shopee');
  if (clip.videoId !== video.videoId) throw new Error('ไฟล์ไม่ตรงกับคลิป');
  if (caption.length > 150) throw new Error('แคปชันต้องไม่เกิน 150 ตัวอักษร');
  const product = shopeeProductLink(video.productShopeeUrl);
  if (!product) throw new Error('คลิปนี้ไม่มีลิงก์สินค้า Shopee เต็มที่ถูกต้อง — ตรวจสินค้าในคลังก่อน');
  const invalid = validShopeeVideo(video.seconds, clip.blob.size, clip.mimeType || clip.blob.type);
  if (invalid) throw new Error(invalid);
  return { videoId: video.videoId, productName: video.productName, caption, seconds: video.seconds, bytes: clip.blob.size, productUrl: product.url };
}
export async function bridgeRequest<T>(connection: PhoneConnection, path: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<T> {
  if (!/^http:\/\/127\.0\.0\.1:\d{4,5}$/.test(connection.base)) throw new Error('Phone Bridge ต้องอยู่บนคอมพิวเตอร์นี้');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${connection.base}${path}`, { ...init, headers: { ...(connection.token ? { Authorization: `Bearer ${connection.token}` } : {}), ...init.headers }, signal: controller.signal });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? `Phone Bridge: ${response.status}`);
    return result as T;
  } catch (error) {
    if (error instanceof TypeError || (error instanceof DOMException && error.name === 'AbortError')) throw new Error('ติดต่อ Phone Bridge ไม่ได้ — เปิดตัวช่วยไว้ ตรวจพอร์ต แล้วกดอัปเดตสถานะ หากส่งไฟล์ค้างให้ตรวจรายการก่อนส่งใหม่');
    throw error;
  } finally { clearTimeout(timeout); }
}
