import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createBridge, MAX_BYTES, validateMetadata } from '../server.mjs';
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(100, 7)]);
const metadata = { videoId: 'test-video-1', productName: 'ถังปั่นม็อบ', caption: 'ลองดูวิธีใช้งาน #ShopeeVideo', seconds: 8, bytes: mp4.length, productUrl: 'https://shopee.co.th/product/218506299/7714984143' };
const create = async (t, extra = {}) => { const bridge = await createBridge({ port: 0, host: '127.0.0.1', pairingCode: '123456', ...extra }); t.after(() => bridge.close()); return bridge; };
const api = (bridge, route, token, method = 'GET', body, headers = {}) => fetch(`http://127.0.0.1:${bridge.port}${route}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body ? { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) } : {}) });
const pair = async bridge => (await (await api(bridge, '/api/connect', null, 'POST', { code: '123456' })).json()).token;
const job = async (bridge, token, values = metadata) => (await (await api(bridge, '/api/transfers', token, 'POST', values)).json());
const upload = (bridge, token, job, bytes = mp4) => api(bridge, `/api/transfers/${job.id}/video`, token, 'PUT', bytes, { 'Content-Type': 'video/mp4' });
const qr = async (bridge, token, transfer) => (await (await api(bridge, `/api/transfers/${transfer.id}/qr?base=${encodeURIComponent(bridge.addresses[0])}`, token)).json());
const mobileToken = data => new URLSearchParams(new URL(data.mobileUrl).hash.slice(1)).get('token');

test('metadata enforces exact Shopee product, limits and canonical URL', () => {
  assert.equal(validateMetadata({ ...metadata, productUrl: `${metadata.productUrl}?utm=affiliate` }).productUrl, metadata.productUrl);
  for (const productUrl of ['https://shopee.co.th.evil.test/product/1/2', 'https://s.shopee.co.th/abc', 'http://shopee.co.th/product/1/2', 'https://user@shopee.co.th/product/1/2', 'https://shopee.co.th:1234/product/1/2', 'https://shopee.co.th/product/1/2x']) assert.throws(() => validateMetadata({ ...metadata, productUrl }));
  for (const data of [{ bytes: MAX_BYTES + 1 }, { bytes: -1 }, { seconds: 2 }, { seconds: 61 }, { seconds: Infinity }, { caption: 'ก'.repeat(151) }, { videoId: '../bad' }, { videoId: 123 }, { productUrl: null }]) assert.throws(() => validateMetadata({ ...metadata, ...data }));
});

test('pairing is required, browser origins and rebinding hosts are rejected', async t => {
  const bridge = await create(t);
  assert.equal((await api(bridge, '/api/transfers')).status, 401);
  assert.equal((await api(bridge, '/api/connect', null, 'POST', { code: '654321' })).status, 401);
  assert.equal((await api(bridge, '/api/connect', null, 'POST', { code: '１２３４５６' })).status, 401);
  assert.equal((await api(bridge, '/api/connect', null, 'POST', { code: '123456' }, { Origin: 'https://evil.test' })).status, 403);
  const rebindingStatus = await new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: bridge.port, path: '/mobile', headers: { Host: 'evil.test' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(rebindingStatus, 403);
  const response = await api(bridge, '/api/connect', null, 'POST', { code: '123456' }, { Origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
  assert.equal(response.status, 200); assert.equal(response.headers.get('access-control-allow-origin'), 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
});

test('pairing attempts are rate-limited and recover after a minute', async t => {
  let now = 1000; const bridge = await create(t, { clock: () => now });
  for (let n = 0; n < 5; n++) assert.equal((await api(bridge, '/api/connect', null, 'POST', { code: '000000' })).status, 401);
  assert.equal((await api(bridge, '/api/connect', null, 'POST', { code: '123456' })).status, 429);
  now += 60_001; assert.ok(await pair(bridge));
});

test('complete send → QR → mobile metadata → exact bytes → explicit posted report', async t => {
  const bridge = await create(t), token = await pair(bridge), transfer = await job(bridge, token);
  assert.equal(transfer.state, 'waiting_upload');
  assert.equal((await api(bridge, `/api/transfers/${transfer.id}/qr?base=${encodeURIComponent(bridge.addresses[0])}`, token)).status, 409);
  assert.equal((await upload(bridge, token, transfer)).status, 200);
  const data = await qr(bridge, token, transfer), phoneToken = mobileToken(data);
  assert.match(data.svg, /<svg/); assert.ok(phoneToken); assert.equal(new URL(data.mobileUrl).search, '');
  assert.equal((await api(bridge, `/api/mobile/${transfer.id}`)).status, 401);
  assert.equal((await api(bridge, `/api/mobile/${transfer.id}/video?token=bad`)).status, 401);
  const mobile = await (await api(bridge, `/api/mobile/${transfer.id}`, phoneToken)).json();
  assert.equal(mobile.productUrl, metadata.productUrl); assert.equal(mobile.caption, metadata.caption); assert.ok(mobile.phoneConnectedAt); assert.equal(mobile.postedReportedAt, null);
  const file = await api(bridge, `/api/mobile/${transfer.id}/video?token=${phoneToken}`);
  assert.equal(file.headers.get('content-type'), 'video/mp4'); assert.match(file.headers.get('content-disposition'), /attachment/); assert.deepEqual(Buffer.from(await file.arrayBuffer()), mp4);
  let jobs = await (await api(bridge, '/api/transfers', token)).json();
  assert.ok(jobs.transfers[0].downloadRequestedAt); assert.equal(jobs.transfers[0].postedReportedAt, null); assert.equal(jobs.transfers[0].state, 'ready');
  assert.equal((await api(bridge, `/api/mobile/${transfer.id}/status`, phoneToken, 'POST', { postedWithProduct: false })).status, 400);
  assert.equal((await api(bridge, `/api/mobile/${transfer.id}/status`, phoneToken, 'POST', { postedWithProduct: true })).status, 200);
  jobs = await (await api(bridge, '/api/transfers', token)).json(); assert.ok(jobs.transfers[0].postedReportedAt); assert.equal(jobs.transfers[0].state, 'ready'); // Reporting never claims verified publication.
});

test('each QR is bound to its own clip/product; revoke and expiry remove files and access', async t => {
  let now = 1000; const bridge = await create(t, { clock: () => now, ttlMs: 1000 });
  const token = await pair(bridge), a = await job(bridge, token), b = await job(bridge, token, { ...metadata, videoId: 'other-video', productUrl: 'https://shopee.co.th/product/11/22' });
  await upload(bridge, token, a); await upload(bridge, token, b);
  const tokenA = mobileToken(await qr(bridge, token, a)), tokenB = mobileToken(await qr(bridge, token, b));
  assert.notEqual(tokenA, tokenB); assert.equal((await api(bridge, `/api/mobile/${b.id}`, tokenA)).status, 401);
  assert.equal((await (await api(bridge, `/api/mobile/${b.id}`, tokenB)).json()).productUrl, 'https://shopee.co.th/product/11/22');
  assert.equal((await api(bridge, `/api/transfers/${a.id}`, token, 'DELETE')).status, 200);
  assert.equal((await api(bridge, `/api/mobile/${a.id}`, tokenA)).status, 404); await assert.rejects(access(`${bridge.directory}/${a.id}.mp4`));
  now = 2001; await bridge.cleanup(); assert.equal((await api(bridge, `/api/mobile/${b.id}`, tokenB)).status, 404); await assert.rejects(access(`${bridge.directory}/${b.id}.mp4`));
});

test('bad MP4 and wrong size never become downloadable; QR cannot be redirected', async t => {
  const bridge = await create(t), token = await pair(bridge), bad = await job(bridge, token);
  assert.equal((await upload(bridge, token, bad, Buffer.alloc(mp4.length))).status, 400);
  assert.equal((await api(bridge, `/api/transfers/${bad.id}/qr?base=${encodeURIComponent(bridge.addresses[0])}`, token)).status, 404);
  const small = await job(bridge, token); assert.equal((await upload(bridge, token, small, Buffer.alloc(10))).status, 400);
  const valid = await job(bridge, token); await upload(bridge, token, valid);
  assert.equal((await api(bridge, `/api/transfers/${valid.id}/qr?base=${encodeURIComponent('http://evil.test')}`, token)).status, 400);
  assert.equal((await upload(bridge, token, valid)).status, 409);
});

test('transfer quota prevents filling disk and deletion frees a slot', async t => {
  const bridge = await create(t), token = await pair(bridge), jobs = [];
  for (let n = 0; n < 5; n++) jobs.push(await job(bridge, token, { ...metadata, videoId: `video-${n}` }));
  assert.equal((await api(bridge, '/api/transfers', token, 'POST', metadata)).status, 409);
  await api(bridge, `/api/transfers/${jobs[0].id}`, token, 'DELETE');
  assert.equal((await api(bridge, '/api/transfers', token, 'POST', metadata)).status, 201);
});

test('mobile page has no third-party scripts or embedded transfer credentials', async t => {
  const bridge = await create(t), response = await api(bridge, '/mobile');
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const html = await response.text(); assert.match(html, /Android/); assert.match(html, /iPhone/); assert.match(html, /posted-check/); assert.doesNotMatch(html, /<script[^>]+src="https?:/);
});
