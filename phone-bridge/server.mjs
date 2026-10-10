import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { promises as fs, createReadStream, createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';

export const MAX_BYTES = 1024 ** 3;
const publicDir = fileURLToPath(new URL('./public/', import.meta.url));
const fail = (status, message) => Object.assign(new Error(message), { status });
const loopback = ip => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);
const privateIPv4 = ip => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
const equal = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function validateMetadata(data) {
  if (!data || typeof data !== 'object' || typeof data.videoId !== 'string' || !/^[\w-]{1,100}$/.test(data.videoId)) throw fail(400, 'รหัสคลิปไม่ถูกต้อง');
  if (typeof data.productName !== 'string' || !data.productName.trim() || data.productName.length > 1000) throw fail(400, 'ชื่อสินค้าไม่ถูกต้อง');
  if (typeof data.caption !== 'string' || data.caption.length > 150) throw fail(400, 'แคปชันต้องไม่เกิน 150 ตัวอักษร');
  if (!Number.isFinite(data.seconds) || data.seconds < 3 || data.seconds > 60) throw fail(400, 'คลิปต้องยาว 3–60 วินาที');
  if (!Number.isSafeInteger(data.bytes) || data.bytes <= 0 || data.bytes > MAX_BYTES) throw fail(400, 'ไฟล์ต้องไม่เกิน 1 GB');
  let url; try { if (typeof data.productUrl !== 'string') throw new Error(); url = new URL(data.productUrl); } catch { throw fail(400, 'ลิงก์สินค้าไม่ถูกต้อง'); }
  const ids = url.pathname.match(/^\/product\/(\d+)\/(\d+)\/?$/);
  if (url.protocol !== 'https:' || url.hostname !== 'shopee.co.th' || url.port || url.username || url.password || !ids) throw fail(400, 'ใช้ลิงก์สินค้า Shopee เต็มที่ตรงกับคลิป');
  return { videoId: data.videoId, productName: data.productName.trim(), caption: data.caption, seconds: data.seconds, bytes: data.bytes, productUrl: `https://shopee.co.th/product/${ids[1]}/${ids[2]}`, shopId: ids[1], itemId: ids[2] };
}
async function readJson(req) {
  let bytes = 0; const chunks = [];
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 16_384) throw fail(413, 'ข้อมูลใหญ่เกินไป'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw fail(400, 'ข้อมูล JSON ไม่ถูกต้อง'); }
}
export async function createBridge({ port = 47832, host = '0.0.0.0', ttlMs = 30 * 60_000, pairingCode = String(randomInt(100000, 1000000)), clock = Date.now } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-affiliate-phone-'));
  const desktopToken = randomBytes(32).toString('hex');
  const transfers = new Map(); let pairAttempts = []; let addresses = [];
  const info = transfer => ({ id: transfer.id, ...transfer.metadata, state: transfer.state, phoneConnectedAt: transfer.phoneConnectedAt ?? null, downloadRequestedAt: transfer.downloadRequestedAt ?? null, postedReportedAt: transfer.postedReportedAt ?? null, createdAt: transfer.createdAt, expiresAt: transfer.expiresAt });
  const remove = async id => { const transfer = transfers.get(id); if (!transfer) return; transfers.delete(id); await fs.rm(transfer.file, { force: true }); await fs.rm(`${transfer.file}.part`, { force: true }); };
  const cleanup = async () => { for (const [id, t] of transfers) if (clock() >= t.expiresAt) await remove(id); };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
    try {
      const url = new URL(req.url, 'http://bridge.invalid');
      const validHosts = new Set(['localhost', '127.0.0.1', ...addresses.map(a => new URL(a).hostname)]);
      const requestHost = new URL(`http://${req.headers.host}`).hostname;
      if (!validHosts.has(requestHost)) throw fail(403, 'Host ไม่ได้รับอนุญาต');
      const origin = req.headers.origin;
      const extensionOrigin = typeof origin === 'string' && /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
      const sameOrigin = origin === `http://${req.headers.host}`;
      if (origin && !sameOrigin && !(extensionOrigin && loopback(req.socket.remoteAddress))) throw fail(403, 'Origin ไม่ได้รับอนุญาต');
      if (extensionOrigin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type'); }
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      const bearer = req.headers.authorization?.replace(/^Bearer /, '');
      const desktop = () => { if (!loopback(req.socket.remoteAddress) || !equal(bearer, desktopToken)) throw fail(401, 'เชื่อมต่อโปรแกรมด้วยรหัสจาก Phone Bridge ก่อน'); };
      await cleanup();
      if (url.pathname === '/api/connect' && req.method === 'POST') {
        if (!loopback(req.socket.remoteAddress)) throw fail(403, 'เชื่อมต่อจากคอมพิวเตอร์ที่เปิด Phone Bridge เท่านั้น');
        pairAttempts = pairAttempts.filter(at => clock() - at < 60_000);
        if (pairAttempts.length >= 5) throw fail(429, 'ลองรหัสบ่อยเกินไป รอ 1 นาที');
        const data = await readJson(req); pairAttempts.push(clock());
        if (!equal(data.code, pairingCode)) throw fail(401, 'รหัสเชื่อมต่อไม่ถูกต้อง ดูรหัสในหน้าต่าง Phone Bridge');
        pairAttempts = []; json(200, { token: desktopToken, addresses, protocolVersion: 1 }); return;
      }
      if (url.pathname === '/api/desktop' && req.method === 'GET') { desktop(); json(200, { addresses, protocolVersion: 1 }); return; }
      if (url.pathname === '/api/transfers') {
        desktop();
        if (req.method === 'GET') { json(200, { transfers: [...transfers.values()].map(info), addresses }); return; }
        if (req.method === 'POST') {
          const metadata = validateMetadata(await readJson(req));
          if (transfers.size >= 5 || [...transfers.values()].reduce((sum, t) => sum + t.metadata.bytes, 0) + metadata.bytes > MAX_BYTES) throw fail(409, 'พื้นที่ส่งคลิปเต็ม ลบรายการเก่าก่อน (รวมไม่เกิน 1 GB / 5 คลิป)');
          const id = randomUUID(), token = randomBytes(24).toString('hex');
          const transfer = { id, token, metadata, file: path.join(directory, `${id}.mp4`), state: 'waiting_upload', createdAt: clock(), expiresAt: clock() + ttlMs };
          transfers.set(id, transfer); json(201, info(transfer)); return;
        }
      }
      const route = url.pathname.match(/^\/api\/(transfers|mobile)\/([\w-]+)(?:\/(video|qr|status))?$/);
      if (route) {
        const [, kind, id, action] = route;
        if (kind === 'transfers') desktop();
        const t = transfers.get(id); if (!t) throw fail(404, 'ลิงก์หมดอายุหรือยกเลิกแล้ว กรุณาส่งคลิปใหม่จากคอมพิวเตอร์');
        if (kind === 'mobile' && !equal(bearer ?? (action === 'video' ? url.searchParams.get('token') : null), t.token)) throw fail(401, 'ลิงก์รับคลิปไม่ถูกต้อง กรุณาสแกน QR ใหม่');
        if (kind === 'transfers' && !action && req.method === 'DELETE') { if (t.state === 'uploading') throw fail(409, 'รอส่งไฟล์เสร็จก่อนยกเลิก'); await remove(id); json(200, { ok: true }); return; }
        if (kind === 'transfers' && action === 'video' && req.method === 'PUT') {
          if (t.state !== 'waiting_upload') throw fail(409, 'รายการนี้ส่งไฟล์แล้ว');
          if (Number(req.headers['content-length']) !== t.metadata.bytes || !/^video\/mp4(?:;|$)/i.test(req.headers['content-type'] ?? '')) throw fail(400, 'ขนาดไฟล์หรือชนิด MP4 ไม่ตรงกับคลิป');
          t.state = 'uploading'; let received = 0, header = Buffer.alloc(0);
          const limit = new Transform({ transform(chunk, encoding, callback) { received += chunk.length; if (header.length < 64) header = Buffer.concat([header, chunk]).subarray(0, 64); callback(received > t.metadata.bytes ? fail(413, 'ไฟล์ใหญ่เกินขนาดที่ระบุ') : null, chunk); } });
          try {
            await pipeline(req, limit, createWriteStream(`${t.file}.part`, { flags: 'wx', mode: 0o600 }));
            if (received !== t.metadata.bytes || header.subarray(4, 8).toString() !== 'ftyp') throw fail(400, 'ไฟล์ไม่ใช่ MP4 ที่สมบูรณ์');
            if (!transfers.has(id)) throw fail(410, 'การส่งคลิปหมดอายุ');
            await fs.rename(`${t.file}.part`, t.file); t.state = 'ready'; json(200, info(t));
          } catch (error) { await remove(id); throw error; } return;
        }
        if (kind === 'transfers' && action === 'qr' && req.method === 'GET') {
          if (t.state !== 'ready') throw fail(409, 'รอส่งไฟล์เสร็จก่อน');
          const base = url.searchParams.get('base'); if (!addresses.includes(base)) throw fail(400, 'เลือก IP ของคอมพิวเตอร์จากรายการ');
          const mobileUrl = `${base}/mobile#id=${id}&token=${t.token}`;
          const svg = await QRCode.toString(mobileUrl, { type: 'svg', errorCorrectionLevel: 'M', margin: 2, width: 260 });
          json(200, { mobileUrl, svg }); return;
        }
        if (kind === 'mobile' && t.state !== 'ready') throw fail(409, 'คอมพิวเตอร์กำลังส่งคลิป กรุณารอ');
        if (kind === 'mobile' && !action && req.method === 'GET') { t.phoneConnectedAt ??= clock(); json(200, info(t)); return; }
        if (kind === 'mobile' && action === 'video' && req.method === 'GET') {
          t.downloadRequestedAt ??= clock();
          res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': t.metadata.bytes, 'Content-Disposition': `attachment; filename="shopee-${t.metadata.videoId.slice(0, 8)}.mp4"` });
          await pipeline(createReadStream(t.file), res); return;
        }
        if (kind === 'mobile' && action === 'status' && req.method === 'POST') {
          const data = await readJson(req);
          if (data.postedWithProduct !== true || !t.phoneConnectedAt) throw fail(400, 'ยืนยันหลังเผยแพร่และตรวจสินค้าบนคลิปแล้ว');
          t.postedReportedAt = clock(); json(200, info(t)); return;
        }
      }
      if (req.method === 'GET' && ['/mobile', '/mobile.js', '/mobile.css'].includes(url.pathname)) {
        const filename = url.pathname === '/mobile' ? 'mobile.html' : url.pathname.slice(1);
        res.writeHead(200, { 'Content-Type': filename.endsWith('.html') ? 'text/html; charset=utf-8' : filename.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8' });
        res.end(await fs.readFile(path.join(publicDir, filename))); return;
      }
      throw fail(404, 'ไม่พบหน้านี้');
    } catch (error) { if (!res.headersSent && !res.destroyed) json(error.status ?? 500, { error: error.status ? error.message : 'Phone Bridge ทำงานไม่สำเร็จ กรุณาลองใหม่' }); else res.destroy(); }
  });
  server.requestTimeout = 5 * 60_000;
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); }); }
  catch (error) { await fs.rm(directory, { recursive: true, force: true }); throw error; }
  const actualPort = server.address().port;
  const ips = [...new Set(Object.values(os.networkInterfaces()).flat().filter(n => n && !n.internal && n.family === 'IPv4' && privateIPv4(n.address)).map(n => n.address))];
  addresses = host === '127.0.0.1' ? [`http://127.0.0.1:${actualPort}`] : ips.map(ip => `http://${ip}:${actualPort}`);
  const timer = setInterval(() => cleanup().catch(() => {}), 30_000); timer.unref();
  return { port: actualPort, addresses, pairingCode, cleanup, directory, close: async () => { clearInterval(timer); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); } };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PHONE_BRIDGE_PORT ?? 47832);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PHONE_BRIDGE_PORT ต้องเป็น 1024–65535');
  const bridge = await createBridge({ port });
  console.log(`\nAI Affiliate Studio — Phone Bridge\nรหัสเชื่อมต่อ: ${bridge.pairingCode}\nพอร์ต: ${bridge.port}\nเปิดแท็บ “มือถือ” ในส่วนขยาย ใส่รหัสนี้ แล้วเลือกคลิป\nมือถือและคอมพิวเตอร์ต้องใช้ Wi-Fi เดียวกัน\n${bridge.addresses.join('\n') || 'ไม่พบ IP ในเครือข่ายส่วนตัว กรุณาเชื่อมต่อ Wi-Fi แล้วเปิดใหม่'}\nเปิดหน้าต่างนี้ไว้ระหว่างรับคลิป ลิงก์หมดอายุใน 30 นาที\n`);
  const stop = async () => { await bridge.close(); process.exit(0); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
