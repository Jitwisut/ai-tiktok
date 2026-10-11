import { LICENSE_SERVER_URL } from "./license-config.js";

export interface LicenseSnapshot {
  ok: boolean; status: string; code?: string; error?: string; expiresAt?: string; serverTime?: string;
}
export interface LicenseIdentity { installationId: string; token?: string }
export const LICENSE_MESSAGES: Record<string, string> = {
  not_activated: "กรอก License Key เพื่อเปิดใช้งานในแผงส่วนขยาย",
  invalid_key: "License Key ไม่ถูกต้องหรือถูกเปลี่ยนแล้ว ติดต่อผู้ขายเพื่อรับคีย์ใหม่",
  invalid_token: "การติดตั้งนี้ถูกยกเลิกแล้ว ติดต่อผู้ขายเพื่อเปิดใช้ใหม่",
  expired: "สิทธิ์ใช้งานหมดอายุแล้ว ติดต่อผู้ขายเพื่อเติมวัน",
  suspended: "สิทธิ์ถูกระงับ กรุณาติดต่อผู้ขาย",
  profile_limit: "คีย์นี้เปิดใช้ใน Chrome Profile อื่นแล้ว ติดต่อผู้ขายเพื่อย้ายเครื่อง",
  server_unavailable: "ติดต่อระบบตรวจสิทธิ์ไม่ได้ หยุดเริ่มงานใหม่ชั่วคราวแล้วลองอีกครั้ง",
  rate_limited: "ตรวจสิทธิ์ถี่เกินไป กรุณารอหนึ่งนาทีแล้วลองใหม่",
  invalid_request: "ข้อมูลเปิดใช้ไม่ถูกต้อง กรุณาตรวจคีย์แล้วลองใหม่",
};
export class ExtensionLicenseError extends Error {
  constructor(public code: string, public expiresAt?: string, public serverTime?: string) { super(`สิทธิ์ใช้งาน: ${LICENSE_MESSAGES[code] ?? LICENSE_MESSAGES.server_unavailable}`); }
}
export function isLicenseFailure(error: unknown): boolean {
  return (typeof error === "string" && error.startsWith("สิทธิ์ใช้งาน:")) || error instanceof ExtensionLicenseError || (error instanceof Error && error.message.startsWith("สิทธิ์ใช้งาน:"));
}

// This database belongs to the extension origin. Content scripts use the visited page's
// IndexedDB origin and cannot read it. Never put the token in chrome.storage.local/sync.
let vaultDatabase: Promise<IDBDatabase> | undefined;
function openVault(): Promise<IDBDatabase> {
  return vaultDatabase ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("affiliate-license-vault", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("identity");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { vaultDatabase = undefined; reject(new Error("เปิดที่เก็บสิทธิ์ไม่สำเร็จ")); };
  });
}
async function readVault(): Promise<LicenseIdentity | undefined> {
  const database = await openVault();
  return new Promise((resolve, reject) => {
    const tx = database.transaction("identity", "readonly");
    const request = tx.objectStore("identity").get("current");
    request.onsuccess = () => resolve(request.result as LicenseIdentity | undefined);
    request.onerror = () => reject(new Error("อ่านสิทธิ์ไม่สำเร็จ"));
  });
}
async function writeVault(value: LicenseIdentity): Promise<void> {
  const database = await openVault();
  return new Promise((resolve, reject) => {
    const tx = database.transaction("identity", "readwrite");
    tx.objectStore("identity").put(value, "current");
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(new Error("บันทึกสิทธิ์ไม่สำเร็จ"));
  });
}
export function createLicenseClient(deps: {
  read(): Promise<LicenseIdentity | undefined>; write(value: LicenseIdentity): Promise<void>;
  fetch: typeof fetch; status(value: LicenseSnapshot): Promise<void>; serverUrl: string;
}) {
  let identityPending: Promise<LicenseIdentity> | null = null;
  async function identity() {
    if (!identityPending) identityPending = (async () => {
      const value = await deps.read();
      if (value) return value;
      const created = { installationId: crypto.randomUUID() };
      await deps.write(created); return created;
    })().finally(() => { identityPending = null; });
    return identityPending;
  }
  async function request(action: string, body: object): Promise<LicenseSnapshot & { token?: string }> {
    try {
      const response = await deps.fetch(`${deps.serverUrl}/api/licenses/${action}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        cache: "no-store", credentials: "omit", redirect: "error", signal: AbortSignal.timeout(10_000),
      });
      const result = await response.json() as LicenseSnapshot & { token?: string };
      if (!response.ok || result.ok !== true || result.status !== "active" || !result.expiresAt || !result.serverTime || !Number.isFinite(Date.parse(result.expiresAt)) || !Number.isFinite(Date.parse(result.serverTime)) || Date.parse(result.expiresAt) <= Date.parse(result.serverTime)) {
        throw new ExtensionLicenseError(result.code ?? "server_unavailable", typeof result.expiresAt === "string" && Number.isFinite(Date.parse(result.expiresAt)) ? result.expiresAt : undefined, typeof result.serverTime === "string" && Number.isFinite(Date.parse(result.serverTime)) ? result.serverTime : undefined);
      }
      return result;
    } catch (error) {
      throw error instanceof ExtensionLicenseError ? error : new ExtensionLicenseError("server_unavailable");
    }
  }
  async function publish(result: LicenseSnapshot) {
    // Explicit allowlist prevents activation tokens from ever leaking in a message or storage event.
    await deps.status({ ok: result.ok, status: result.status, code: result.code, error: result.error, expiresAt: result.expiresAt, serverTime: result.serverTime });
  }
  async function check(): Promise<LicenseSnapshot> {
    try {
      const value = await identity();
      if (!value.token) throw new ExtensionLicenseError("not_activated");
      const result = await request("validate", { token: value.token, installationId: value.installationId });
      await publish(result);
      return { ok: true, status: result.status, expiresAt: result.expiresAt, serverTime: result.serverTime };
    } catch (error) {
      const failure = error instanceof ExtensionLicenseError ? error : new ExtensionLicenseError("server_unavailable");
      await publish({ ok: false, status: failure.code, code: failure.code, error: failure.message, expiresAt: failure.expiresAt, serverTime: failure.serverTime });
      throw failure;
    }
  }
  let activating = false;
  async function activate(key: string): Promise<LicenseSnapshot> {
    if (activating) throw new Error("กำลังเปิดใช้คีย์ กรุณารอสักครู่");
    activating = true;
    try {
      const value = await identity();
      const result = await request("activate", { key: key.trim(), installationId: value.installationId });
      if (!result.token) throw new ExtensionLicenseError("server_unavailable");
      await deps.write({ installationId: value.installationId, token: result.token });
      await publish(result);
      return { ok: true, status: result.status, expiresAt: result.expiresAt, serverTime: result.serverTime };
    } finally { activating = false; }
  }
  return { check, activate };
}
const client = createLicenseClient({
  read: readVault, write: writeVault, fetch: (...args) => fetch(...args), serverUrl: LICENSE_SERVER_URL,
  status: value => chrome.storage.local.set({ licenseStatus: value }),
});
export const checkLicense = client.check;
export const activateLicense = client.activate;
export async function requireLicense(): Promise<void> { await checkLicense(); }
