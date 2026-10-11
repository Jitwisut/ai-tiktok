import test from 'node:test';
import assert from 'node:assert/strict';
import { bridgeBase, selectPhoneClip, phoneMetadata } from '../extension/src/lib/phone-bridge.ts';
const video = { videoId: 'v1', clipCount: 2, seconds: 16, caption: 'แคปชัน', platform: 'shopee', productName: 'ม็อบ', productShopeeUrl: 'https://shopee.co.th/product/123/456' };
const clip = index => ({ videoId: 'v1', index, mimeType: 'video/mp4', blob: new Blob(['ftypisom'], { type: 'video/mp4' }) });
test('desktop bridge can only connect to validated loopback port', () => {
  assert.equal(bridgeBase('47832'), 'http://127.0.0.1:47832');
  for (const value of ['https://evil.test', '80', '65536', '47832/path', '47832.5', 'abc']) assert.throws(() => bridgeBase(value));
});
test('multi-part videos require completed merged clip and never send one partial clip', () => {
  assert.throws(() => selectPhoneClip(video, [clip(0)]));
  assert.throws(() => selectPhoneClip(video, [clip(0), clip(1)]));
  const merged = clip(-1); assert.equal(selectPhoneClip(video, [clip(0), clip(1), merged]), merged);
  assert.throws(() => selectPhoneClip(video, [{ ...merged, videoId: 'wrong' }]));
  assert.equal(selectPhoneClip({ ...video, clipCount: 1 }, [clip(0)]).index, 0);
  assert.throws(() => selectPhoneClip({ ...video, clipCount: 1 }, [clip(1)]));
});
test('handoff keeps original product IDs, caption edits, video and full file together', () => {
  const data = phoneMetadata(video, 'แก้แคปชัน', clip(-1));
  assert.equal(data.productUrl, video.productShopeeUrl); assert.equal(data.videoId, video.videoId); assert.equal(data.caption, 'แก้แคปชัน'); assert.equal(data.bytes, 8);
  assert.throws(() => phoneMetadata({ ...video, platform: 'tiktok' }, video.caption, clip(-1)));
  assert.throws(() => phoneMetadata(video, video.caption, { ...clip(-1), videoId: 'wrong' }));
  assert.throws(() => phoneMetadata({ ...video, productShopeeUrl: 'https://evil.test/product/1/2' }, video.caption, clip(-1)));
  assert.throws(() => phoneMetadata(video, 'ก'.repeat(151), clip(-1)));
  assert.throws(() => phoneMetadata({ ...video, seconds: 61 }, video.caption, clip(-1)));
});
