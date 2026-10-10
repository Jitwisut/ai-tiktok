const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.hash.slice(1));
const id = params.get('id'), token = params.get('token');
const message = (text, error = false) => { $('message').textContent = text; $('message').className = error ? 'error' : ''; };
const api = async (action = '', data) => {
  try {
    const response = await fetch(`/api/mobile/${encodeURIComponent(id)}${action}`, { method: data ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(data ? { 'Content-Type': 'application/json' } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
  } catch (error) {
    if (error instanceof TypeError) throw new Error('เชื่อมต่อคอมพิวเตอร์ไม่ได้ ตรวจว่าใช้ Wi-Fi เดียวกันและ Phone Bridge ยังเปิดอยู่');
    throw error;
  }
};
async function copy(id) {
  const input = $(id);
  try { if (!navigator.clipboard?.writeText || !window.isSecureContext) throw new Error(); await navigator.clipboard.writeText(input.value); message('คัดลอกแล้ว'); }
  catch { input.focus(); input.select(); input.setSelectionRange(0, input.value.length); if (document.execCommand('copy')) message('คัดลอกแล้ว'); else message('กดค้างบนข้อความที่เลือก แล้วเลือก “คัดลอก”'); }
}
function deviceHelp() { $('device-help').textContent = $('device').value === 'iphone' ? 'iPhone: เปิดแอปไฟล์ → ดาวน์โหลด → เปิด MP4 → แชร์ → บันทึกวิดีโอ เพื่อให้คลิปอยู่ในแอปรูปภาพ แล้วเลือกคลิปจาก Shopee' : 'Android: เปิด Shopee แล้วเลือกวิดีโอจาก Downloads/ดาวน์โหลด หากยังไม่พบคลิป เปิดแอป Files/ไฟล์ → Downloads แล้วตรวจว่าไฟล์ดาวน์โหลดเสร็จ'; }
$('device').value = /iPhone|iPad/.test(navigator.userAgent) ? 'iphone' : 'android';
$('device').addEventListener('change', deviceHelp); deviceHelp();
$('copy-caption').addEventListener('click', () => copy('caption'));
$('copy-link').addEventListener('click', () => copy('product-url'));
$('download').addEventListener('click', () => message('เริ่มขอดาวน์โหลดแล้ว กรุณาตรวจในแอปไฟล์ว่าดาวน์โหลดเสร็จ'));
$('posted-check').addEventListener('change', () => { $('report').disabled = !$('posted-check').checked; });
$('report').addEventListener('click', async () => {
  if (!$('posted-check').checked) return;
  $('report').disabled = true;
  try { await api('/status', { postedWithProduct: true }); message('ส่งคำยืนยันของคุณกลับคอมพิวเตอร์แล้ว กลับไปบันทึกผลในแท็บมือถือ'); $('report').textContent = 'แจ้งผลแล้ว'; }
  catch (error) { message(error.message, true); $('report').disabled = false; }
});
try {
  if (!/^[\w-]{1,100}$/.test(id ?? '') || !/^[a-f0-9]{48}$/.test(token ?? '')) throw new Error('ลิงก์รับคลิปไม่ครบ กรุณาสแกน QR จากโปรแกรมใหม่');
  const data = await api();
  $('product-name').textContent = data.productName;
  $('details').textContent = `${data.seconds} วินาที · ${(data.bytes / 1024 ** 2).toFixed(1)} MB · ลิงก์หมดอายุ ${new Date(data.expiresAt).toLocaleTimeString('th-TH')}`;
  $('caption').value = data.caption; $('product-url').value = data.productUrl;
  $('product-ids').textContent = `รหัสสินค้า ${data.itemId} · รหัสร้าน ${data.shopId}`;
  $('open-product').href = data.productUrl;
  $('download').href = `/api/mobile/${encodeURIComponent(id)}/video?token=${encodeURIComponent(token)}`;
  $('content').hidden = false;
  message(data.postedReportedAt ? 'คุณแจ้งว่าโพสต์พร้อมสินค้าแล้ว' : 'เชื่อมต่อกับคอมพิวเตอร์แล้ว รับคลิปตามขั้นตอนด้านล่าง');
} catch (error) { message(error.message || 'เชื่อมต่อไม่ได้ กรุณาใช้ Wi-Fi เดียวกับคอมพิวเตอร์และเปิด Phone Bridge ไว้', true); }
