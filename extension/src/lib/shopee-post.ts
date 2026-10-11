export const SHOPEE_UPLOAD_URL = "https://seller.shopee.co.th/creator-center/video-upload/upload";
export interface ShopeePostJob {
  videoId: string;
  caption: string;
  autoPost: boolean;
  fileName: string;
  productUrl: string;
  productName: string;
  itemId: string;
  shopId: string;
}
export interface PendingShopeePost {
  tabId: number;
  at: number;
  job: ShopeePostJob;
  claimedAt?: number;
  autopilotRun?: number;
  /** Set before clicking Post. Never automatically resubmit an ambiguous publication. */
  submittedAt?: number;
}
export function validShopeeVideo(seconds: number, bytes: number, mime: string): string | null {
  if (!Number.isFinite(seconds) || seconds < 3 || seconds > 60) return "Shopee Video รองรับความยาว 3–60 วินาที";
  if (!Number.isFinite(bytes) || bytes <= 0 || bytes > 1024 ** 3) return "Shopee Video รองรับไฟล์ไม่เกิน 1 GB";
  if (!/^video\/mp4(?:;|$)/i.test(mime)) return "Shopee Video ต้องเป็นไฟล์ MP4";
  return null;
}
