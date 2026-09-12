const appBaseUrlInput = document.getElementById("appBaseUrl") as HTMLInputElement;
const extensionTokenInput = document.getElementById("extensionToken") as HTMLInputElement;
const saveButton = document.getElementById("save") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLDivElement;

chrome.storage.local.get(["appBaseUrl", "extensionToken"], (result) => {
  appBaseUrlInput.value = (result.appBaseUrl as string | undefined) ?? "http://localhost:3000";
  extensionTokenInput.value = (result.extensionToken as string | undefined) ?? "";
});

saveButton.addEventListener("click", () => {
  chrome.storage.local.set(
    {
      appBaseUrl: appBaseUrlInput.value.trim() || "http://localhost:3000",
      extensionToken: extensionTokenInput.value.trim(),
    },
    () => {
      statusEl.textContent = "บันทึกแล้ว ✓";
      setTimeout(() => (statusEl.textContent = ""), 2000);
    },
  );
});
