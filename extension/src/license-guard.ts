// Classic content-script helper. It receives only a decision, never the activation token.
async function extensionRequireLicense(): Promise<void> {
  const result = await chrome.runtime.sendMessage({ type: "LICENSE_CHECK" }).catch(() => null) as { ok?: boolean; error?: string } | null;
  if (!result?.ok) throw new Error(result?.error?.startsWith("สิทธิ์ใช้งาน:") ? result.error : "สิทธิ์ใช้งาน: ติดต่อระบบตรวจสิทธิ์ไม่ได้ กรุณาลองอีกครั้ง");
}

async function extensionReportLicensePause(videoId: string, error: unknown): Promise<boolean> {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.startsWith("สิทธิ์ใช้งาน:")) return false;
  await chrome.runtime.sendMessage({ type: "LICENSE_JOB_PAUSED", videoId, error: message }).catch(() => {});
  return true;
}
