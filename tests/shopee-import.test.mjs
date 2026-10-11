import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { readShopeePage, scrapeShopeeTab, collectShopeeProducts } from '../extension/src/lib/shopee-import.ts';
const require = createRequire(new URL('../extension/package.json', import.meta.url));
const { parseHTML } = require('linkedom');
const productUrl = 'https://shopee.co.th/product/1383474005/24044757953';
const offerUrl = 'https://affiliate.shopee.co.th/offer/product_offer/24044757953';
const photo = 'https://down-th.img.susercontent.com/file/cloth';
const emitted = ts.transpileModule(readFileSync(new URL('../extension/src/lib/shopee-import.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.ES2020}}).outputText;
const readerSource = emitted.slice(emitted.indexOf('export function readShopeePage'),emitted.indexOf('export async function scrapeShopeeTab')).replace(/^export /,'');

function scrape(html, url = offerUrl) {
  const { document, HTMLElement } = parseHTML(`<html><head></head><body>${html}</body></html>`);
  HTMLElement.prototype.getBoundingClientRect = function () { return { width: this.style.display === 'none' ? 0 : 180, height: 180 }; };
  const context = vm.createContext({ document, location: new URL(url), URL,
    getComputedStyle: el => ({display:el.style.display || 'block',visibility:el.style.visibility || 'visible',backgroundImage:el.style.backgroundImage || el.getAttribute('data-background') || ''}) });
  // Exercise exactly the serialized function Chrome receives, with no imports.
  return JSON.parse(JSON.stringify(vm.runInContext(`${readerSource}\nreadShopeePage()`, context)));
}

test('Affiliate detail imports the actual product instead of the dashboard title or commission', () => {
  const result = scrape(`<aside>eieimadi748\n฿999</aside><section><div style="background-image:url('${photo}')"></div><div>ผ้าเช็ดรถ ทำความสะอาดรถ ขนาด30x40 (คละสี)\n<a href="${productUrl}">ดูสินค้า</a>\nขายได้ 687 ชิ้น ฿ 35.00</div></section><section>ค่าคอมมิชชั่น ฿18.20</section>`);
  assert.deepEqual(result.products, [{url:productUrl,name:'ผ้าเช็ดรถ ทำความสะอาดรถ ขนาด30x40 (คละสี)',price:'35',image:photo,images:[photo]}]);
});

test('product metadata preserves identity, price and images without recommendation photos', () => {
  const result = scrape(`<meta property="og:title" content="ผ้าเช็ดรถ | Shopee Thailand"><meta property="og:image" content="${photo}"><meta property="product:price:amount" content="35"><main><img src="https://down-th.img.susercontent.com/file/unrelated"></main>`, productUrl+'?affiliate=abc');
  assert.equal(result.products[0].url, productUrl);
  assert.equal(result.products[0].name, 'ผ้าเช็ดรถ');
  assert.equal(result.products[0].price, '35');
  assert.deepEqual(result.products[0].images, [photo]);
});

test('Affiliate detail finds a stylesheet photo outside deeply nested product information', () => {
  const result = scrape(`<aside>ยอดบัญชี ฿999</aside><section><div data-background="url('${photo}')"></div>${'<div>'.repeat(8)}<span>ผ้าเช็ดรถ <a href="${productUrl}">ดูสินค้า</a></span><p>฿35.00</p>${'</div>'.repeat(8)}</section><section>ค่าคอมมิชชั่น ฿18.20</section>`);
  assert.equal(result.products[0].image,photo);
  assert.equal(result.products[0].price,'35');
  assert.equal(result.products[0].name,'ผ้าเช็ดรถ');
});

test('unrelated or malformed structured metadata does not replace the current product', () => {
  const result = scrape(`<meta property="og:title" content="ผ้าเช็ดรถ"><script type="application/ld+json">${JSON.stringify({'@type':'Product',url:'https://shopee.co.th/product/1/2',name:{bad:true},image:[photo],offers:{price:'999'}})}</script>`,productUrl);
  assert.equal(result.products[0].name,'ผ้าเช็ดรถ');
  assert.equal(result.products[0].price,undefined);
  assert.deepEqual(result.products[0].images,[]);
});

test('structured product data works when Shopee omits OG tags', () => {
  const result = scrape(`<script type="application/ld+json">${JSON.stringify({'@graph':[{'@type':'Product',url:productUrl,name:'ผ้าเช็ดรถ',image:[photo],offers:{price:'35'}}]})}</script>`, productUrl);
  assert.equal(result.products[0].name,'ผ้าเช็ดรถ');
  assert.equal(result.products[0].price,'35');
  assert.deepEqual(result.products[0].images,[photo]);
});

test('checked rows import only selected products and canonicalize duplicate links', () => {
  const result = scrape(`<table><thead><tr><th><input type="checkbox" checked></th></tr></thead><tbody><tr><td><input type="checkbox" checked><a href="${productUrl}?aff=one">ผ้าเช็ดรถ</a><a href="${productUrl}?aff=two">ผ้าเช็ดรถ</a>฿35</td></tr><tr><td><input type="checkbox"><a href="https://shopee.co.th/product/2/3">ไม่เลือก</a>฿80</td></tr></tbody></table>`);
  assert.equal(result.products.length,1);
  assert.equal(result.products[0].url,productUrl);
});

test('visible offer cards resolve through detail URLs and skip hidden/foreign links', () => {
  const result = scrape(`<a href="${offerUrl}">ผ้าเช็ดรถ</a><a href="${offerUrl}?source=list">อีกลิงก์</a><a style="display:none" href="https://affiliate.shopee.co.th/offer/product_offer/999">ซ่อน</a><a href="https://affiliate.shopee.co.th.attacker.example/offer/product_offer/456">ปลอม</a><a href="https://shopee.co.th/product/1/2x">ไม่ใช่สินค้า</a>`, 'https://affiliate.shopee.co.th/offer/product_offer');
  assert.deepEqual(result.offerUrls,[offerUrl]);
  assert.equal(result.products.length,0);
});

test('Affiliate Ant selection reads only the chosen enclosing offer anchor even with an unchecked input', () => {
  const result = scrape(`<a href="${offerUrl}"><div class="ItemCard__container"><div class="AffiliateItemCard__gelinkSection"><label class="ant-checkbox-wrapper ant-checkbox-wrapper-checked"><input type="checkbox"></label></div></div></a><a href="https://affiliate.shopee.co.th/offer/product_offer/999"><label class="ant-checkbox-wrapper"><input type="checkbox"></label></a>`,'https://affiliate.shopee.co.th/offer/product_offer');
  assert.deepEqual(result.offerUrls,[offerUrl]);
});

test('login/empty pages and unsupported tabs report an actionable error, not a fake product', () => {
  assert.match(scrape('<h1>เข้าสู่ระบบ</h1>',productUrl).error,/เข้าสู่ระบบ/);
  assert.match(scrape('<h1>Shopee Affiliate Program</h1>').error,/ข้อเสนอ/);
  assert.match(scrape('<h1>กระบอกน้ำ</h1>','https://example.com/product/1/2').error,/เปิดหน้าสินค้า/);
});

test('import injects a reader on stale tabs, resolves exact IDs, and closes its temporary tab', async () => {
  const removed=[]; const created=[]; let injected=0;
  globalThis.chrome = {
    tabs:{async get(id){return {id,url:id===1?'https://affiliate.shopee.co.th/offer/product_offer':offerUrl};},async create(options){created.push(options);return {id:2};},async remove(id){removed.push(id);},sendMessage(){throw Error('old receiver must not be used');}},
    scripting:{async executeScript(options){injected++; assert.equal(typeof options.func,'function');return [{result:options.target.tabId===1?{offerUrls:[offerUrl]}:{products:[{url:productUrl,name:'ผ้าเช็ดรถ',images:[photo]}]}}];}}
  };
  const result=await collectShopeeProducts(1);
  assert.equal(result.products[0].url,productUrl);
  assert.deepEqual(created,[{url:offerUrl,active:false}]);
  assert.deepEqual(removed,[2]);
  assert.equal(injected,2);
  assert.deepEqual(result.warnings,[]);
});

test('unsupported tabs are rejected before injecting the scraper', async () => {
  globalThis.chrome={tabs:{async get(){return {url:'chrome://extensions'};}},scripting:{executeScript(){throw Error('must not inject');}}};
  await assert.rejects(scrapeShopeeTab(1),/เปิดหน้าสินค้า/);
});
