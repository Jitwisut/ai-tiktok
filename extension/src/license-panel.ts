import type { LicenseSnapshot } from "./lib/license-client.js";
export function initLicensePanel() {
  const status = document.getElementById("license-status")!;
  const input = document.getElementById("license-key") as HTMLInputElement;
  const activate = document.getElementById("license-activate") as HTMLButtonElement;
  const refresh = document.getElementById("license-refresh") as HTMLButtonElement;
  const remaining = document.getElementById("license-remaining")!;
  let expiry = 0; let anchor = 0; let receivedAt = 0;
  function render(value: LicenseSnapshot) {
    const expiryLabel = value.expiresAt ? ` • หมดอายุ ${new Date(value.expiresAt).toLocaleString("th-TH", { timeZone: "Asia/Bangkok" })} (เวลาไทย)` : "";
    status.textContent = (value.ok ? "เปิดใช้แล้ว" : value.error ?? "กรอก License Key เพื่อเปิดใช้โปรแกรม") + expiryLabel;
    status.style.color = value.ok ? "#86efac" : "#fbbf24";
    expiry = value.expiresAt ? Date.parse(value.expiresAt) : 0;
    anchor = value.serverTime ? Date.parse(value.serverTime) : 0; receivedAt = performance.now(); countdown();
  }
  function countdown() {
    const seconds = Math.max(0, Math.floor((expiry - anchor - (performance.now() - receivedAt)) / 1000));
    remaining.textContent = expiry ? `เหลือ ${Math.floor(seconds / 86400)} วัน ${Math.floor(seconds % 86400 / 3600)} ชั่วโมง ${Math.floor(seconds % 3600 / 60)} นาที${seconds === 0 ? " • ตรวจสิทธิ์อีกครั้ง / ติดต่อผู้ขายเพื่อเติมวัน" : ""}` : "ต่ออายุหรือย้ายเครื่อง: ติดต่อผู้ขาย • ดูคลังและดาวน์โหลดงานเดิมได้เสมอ";
  }
  async function request(type: string) {
    activate.disabled = refresh.disabled = true;
    try {
      const value = await chrome.runtime.sendMessage({ type, ...(type === "LICENSE_ACTIVATE" ? { key: input.value.trim() } : {}) }) as LicenseSnapshot;
      render(value);
      if (value.ok) input.value = "";
    } catch { render({ ok: false, status: "server_unavailable", error: "ติดต่อส่วนขยายไม่ได้ ปิดแล้วเปิดแผงใหม่" }); }
    finally { activate.disabled = refresh.disabled = false; }
  }
  activate.addEventListener("click", () => void request("LICENSE_ACTIVATE"));
  document.getElementById("license-resume")!.addEventListener("click", async () => {
    const result = await chrome.runtime.sendMessage({ type: "LICENSE_RESUME_WORK" }).catch(() => null) as { ok?: boolean; error?: string } | null;
    status.textContent = result?.ok ? "ส่งคำสั่งทำงานต่อแล้ว หากเป็น Autopilot ให้กดทำต่อในแท็บอัตโนมัติด้วย" : result?.error ?? "เริ่มงานต่อไม่สำเร็จ";
  });
  refresh.addEventListener("click", () => void request("LICENSE_CHECK"));
  input.addEventListener("keydown", e => { if (e.key === "Enter" && !activate.disabled) void request("LICENSE_ACTIVATE"); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.licenseStatus) render(changes.licenseStatus.newValue as LicenseSnapshot);
  });
  setInterval(countdown, 1000);
  void request("LICENSE_CHECK");
}
