import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { SHOPEE_STYLES, salesContext, shopeeProductLink, isShopeeSellerUrl, platformForStyle } from '../extension/src/lib/commerce.ts';
import { validShopeeVideo } from '../extension/src/lib/shopee-post.ts';
import { buildContentPrompt, buildScenePrompt, scenePlanExample } from '../extension/src/lib/analysis-prompts.ts';
import { contentIssues, sceneIssues } from '../extension/src/lib/creative-quality.ts';
import { DEFAULT_VIDEO_SETTINGS, durationOptions, clipSecondsForSite, planClips } from '../extension/src/lib/prompt-engine.ts';
import { createAutopilot } from '../extension/src/lib/autopilot.ts';
import * as store from '../extension/src/lib/store.ts';

const product = { id: 'sp', source: 'shopee', sourceUrl: 'https://shopee.co.th/product/123/456', name: 'กระบอกน้ำ', description: 'กระบอกน้ำพร้อมฝา', images: [] };
let data = {};
const clone = (value) => structuredClone(value);
globalThis.chrome = {
  storage: { local: {
    async get(keys) { return Object.fromEntries((typeof keys === 'string' ? [keys] : keys ?? Object.keys(data)).map(key => [key, clone(data[key])])); },
    async set(values) { Object.assign(data, clone(values)); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
  }, onChanged: { addListener() {} } },
  alarms: { onAlarm: { addListener() {} }, async create() {}, async clear() {} },
  tabs: { async remove() {} },
};

test('canonical Shopee links preserve exact shop/item IDs and reject foreign/short links', () => {
  for (const raw of ['https://shopee.co.th/product/123/456?utm_source=aff', 'https://shopee.co.th/ชื่อสินค้า-i.123.456']) assert.deepEqual(shopeeProductLink(raw), {shopId:'123',itemId:'456',url:product.sourceUrl});
  for (const raw of ['http://shopee.co.th/product/123/456', 'https://shopee.co.th.attacker.example/product/123/456', 'https://s.shopee.co.th/abcd', 'https://shopee.co.th/product/123/456x', '', undefined]) assert.equal(shopeeProductLink(raw), null);
  assert.equal(isShopeeSellerUrl('https://seller.shopee.co.th/creator-center'), true);
  assert.equal(isShopeeSellerUrl('https://seller.shopee.co.th.attacker.example/'), false);
  assert.equal(platformForStyle('UGC'), 'tiktok');
});

test('the uploader skips similar ID prefixes and foreign links when choosing a product row', () => {
  const context=vm.createContext({URL,location:{pathname:'/'},setInterval:()=>0,getComputedStyle:()=>({visibility:'visible'})});
  const source=readFileSync(new URL('../extension/src/shopee-upload.ts',import.meta.url),'utf8');
  vm.runInContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText,context);
  const row=(href)=>({textContent:'กระบอกน้ำ',getBoundingClientRect:()=>({width:100,height:20}),querySelectorAll:()=>[{href}],getAttribute:()=>null});
  const exact=row(product.sourceUrl);
  const priceOnly={...row('https://shopee.co.th/product/123/999'),textContent:'กระบอกน้ำ ราคา 456 บาท'};
  const rows=[row('https://shopee.co.th/product/123/4560'),row('https://shopee.co.th/สินค้า-i.123.4560'),row('https://foreign.example/product/123/456'),priceOnly,exact];
  assert.equal(context.spExactProduct({querySelectorAll:()=>rows},{shopId:'123',itemId:'456'}),exact);
});

function aiLabelFixture({on=false, replace=false, synthetic=true, trusted=true, precise=true, unknown=false}={}) {
  let clock=0, clicks=0, trustedClicks=0, current;
  const visible={getBoundingClientRect:()=>({width:32,height:16})};
  const control=(active,action)=>{
    const attrs=new Map();
    return {...visible,classList:{contains:name=>!unknown && name===`eds-react-switch--${active?'open':'close'}`},getAttribute:name=>attrs.get(name)??null,hasAttribute:name=>attrs.has(name),setAttribute:(name,value)=>attrs.set(name,value),removeAttribute:name=>attrs.delete(name),click:action};
  };
  const reuse=control(true,()=>{throw Error('must not click reuse switch');});
  const aiRow={...visible,textContent:'เพิ่มป้ายกำกับ AI',parentElement:null,querySelectorAll:()=>[current]};
  const reuseRow={...visible,textContent:'อนุญาตให้นำเนื้อหาไปใช้ซ้ำหรือเผยแพร่ต่อ',querySelectorAll:()=>[reuse]};
  const form={...visible,textContent:reuseRow.textContent+' เพิ่มป้ายกำกับ AI',querySelectorAll:()=>[reuse,current],parentElement:null};
  reuse.parentElement={parentElement:form,textContent:'',querySelectorAll:()=>[reuse]};
  const activate=()=>{
    if(replace) {current=control(true,()=>{clicks++;});current.parentElement=aiRow;}
    else current.classList={contains:name=>name==='eds-react-switch--open'};
  };
  current=control(on,()=>{clicks++;if(synthetic)activate();});current.parentElement=aiRow;
  const context=vm.createContext({URL,location:{pathname:'/'},setInterval:()=>0,Date:{now:()=>clock},setTimeout:resolve=>{clock+=500;resolve();},getComputedStyle:()=>({visibility:'visible'}),
    document:{querySelectorAll:selector=>selector.includes('aigcLabelTitleRow')?(precise?[aiRow]:[]):[reuse,current]},
    chrome:{runtime:{async sendMessage(message){assert.equal(message.type,'TRUSTED_CLICK');assert.equal(current.getAttribute('data-ai-shopee-label'),'true');trustedClicks++;if(trusted)activate();return {ok:true};}}},
  });
  vm.runInContext(ts.transpileModule(readFileSync(new URL('../extension/src/shopee-upload.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText,context);
  return {context,counts:()=>({clicks,trustedClicks}),current:()=>current};
}

test('AI disclosure already enabled is left on and never clicks the reuse switch', async () => {
  const fixture=aiLabelFixture({on:true});await fixture.context.spAiLabel();
  assert.deepEqual(fixture.counts(),{clicks:0,trustedClicks:0});
});

test('AI disclosure verifies a fresh switch after React replaces the control', async () => {
  const fixture=aiLabelFixture({replace:true});await fixture.context.spAiLabel();
  assert.deepEqual(fixture.counts(),{clicks:1,trustedClicks:0});
});

test('AI disclosure falls back to a trusted click when a synthetic click has no effect', async () => {
  const fixture=aiLabelFixture({synthetic:false});await fixture.context.spAiLabel();
  assert.deepEqual(fixture.counts(),{clicks:1,trustedClicks:1});
  assert.equal(fixture.current().getAttribute('data-ai-shopee-label'),null);
});

test('AI disclosure ignores the reuse switch when labels share a broad ancestor', async () => {
  const fixture=aiLabelFixture({precise:false});await fixture.context.spAiLabel();
  assert.deepEqual(fixture.counts(),{clicks:1,trustedClicks:0});
});

test('AI disclosure stops if it cannot confirm activation and removes the click marker', async () => {
  const fixture=aiLabelFixture({synthetic:false,trusted:false});
  await assert.rejects(fixture.context.spAiLabel(),/เปิดป้ายกำกับ AI ไม่สำเร็จ/);
  assert.deepEqual(fixture.counts(),{clicks:1,trustedClicks:1});
  assert.equal(fixture.current().getAttribute('data-ai-shopee-label'),null);
});

test('an unknown AI disclosure state does not blindly toggle or continue posting', async () => {
  const fixture=aiLabelFixture({unknown:true});await assert.rejects(fixture.context.spAiLabel(),/อ่านสถานะป้าย AI ไม่ได้/);
  assert.deepEqual(fixture.counts(),{clicks:0,trustedClicks:0});
});

test('all four sales settings survive script, storyboard and final video prompts', () => {
  for (const style of SHOPEE_STYLES) {
    for (const site of ['flow','aistudio','gemini','meta']) {
      for (const seconds of durationOptions(site)) {
        const perClip = clipSecondsForSite(site, seconds);
        const count = seconds / perClip;
        const prompt = buildContentPrompt(product, null, style, seconds, perClip, false);
        assert.match(prompt.system, /Shopee Video/);
        assert.match(prompt.system, /150/);
        assert.match(prompt.example.cta, /สินค้าที่แนบ/);
        assert.ok(!prompt.example.script.includes('ตะกร้า'));
        assert.deepEqual(contentIssues(prompt.example.script, style, seconds, perClip), []);
        const example = scenePlanExample(count, perClip, style);
        for (const cast of example.castOptions) assert.equal(cast.setting, salesContext(style));
        const content = { platform:'shopee', style, script:example.scenes.map(s=>s.dialogue || s.voiceover || '').join(' ') };
        assert.deepEqual(sceneIssues(example.scenes, content, count, perClip), []);
        assert.ok(buildScenePrompt(product, content, seconds, perClip, false, null).system.includes(salesContext(style)));
        const clips = planClips({ platform:'shopee',productName:product.name,style,scenes:example.scenes.map((s,position)=>({...s,position})),targetDuration:seconds,clipSeconds:perClip,settings:DEFAULT_VIDEO_SETTINGS });
        assert.equal(clips.length, count);
        for (const clip of clips) { assert.ok(clip.prompt.includes(salesContext(style))); assert.ok(clip.prompt.includes('Shopee Video')); }
      }
    }
  }
});

test('Shopee file validation checks finite duration/size, MP4 and exact limits', () => {
  for (const duration of [3,60]) assert.equal(validShopeeVideo(duration,1024**3,'video/mp4'),null);
  for (const duration of [2.99,60.01,NaN,Infinity]) assert.ok(validShopeeVideo(duration,1024,'video/mp4'));
  for (const bytes of [0,-1,1024**3+1,NaN,Infinity]) assert.ok(validShopeeVideo(8,bytes,'video/mp4'));
  assert.ok(validShopeeVideo(8,1024,'video/webm'));
});

test('Shopee imports deduplicate canonical IDs and retain saved facts on a sparse refresh', async () => {
  data = {};
  await store.importShopeeProducts([{url:'https://shopee.co.th/กระบอกน้ำ-i.123.456',name:product.name,description:product.description,price:'299',images:['https://example.com/product.jpg']}]);
  await store.importShopeeProducts([{url:product.sourceUrl,name:product.name}]);
  const products = await store.listProducts();
  assert.equal(products.length,1); assert.equal(products[0].source,'shopee');
  assert.equal(products[0].price,299); assert.equal(products[0].description,product.description); assert.equal(products[0].images.length,1);
  await assert.rejects(store.importShopeeProducts([{url:'https://example.com/product/1/2',name:'foreign'}]));
});

const settings = { platform:'shopee',targetDuration:8,style:'Shopee Market',postMode:'auto',site:'flow',textSource:'chatgpt-web' };
test('completed videos retain the exact original product link and publishing platform', async () => {
  data = {
    products:[product,{...product,id:'other',sourceUrl:'https://shopee.co.th/product/999/888'}],
    contents:[{id:'content-sp',productId:'sp',platform:'shopee'},{id:'content-legacy',productId:'other'}],
    videos:[{id:'video-sp',contentId:'content-sp',status:'completed',createdAt:2},{id:'video-legacy',contentId:'content-legacy',status:'completed',createdAt:1}],
  };
  const videos=await store.listCompletedVideos();
  assert.equal(videos[0].productShopeeUrl,product.sourceUrl);
  assert.equal(videos[0].platform,'shopee');
  assert.equal(videos[1].productShopeeUrl,'https://shopee.co.th/product/999/888');
  assert.equal(videos[1].platform,'tiktok');
});
const state = () => ({status:'running',mode:'batch',settings:{...settings},productIds:[],poolIndex:0,styleIndex:0,nextRunAt:null,times:[],history:[],consecutiveFailures:0,startedAt:Date.now(),current:{productId:product.id,productName:product.name,step:'post',attempts:0,leaseUntil:0,stepStartedAt:Date.now(),style:'Shopee Market',videoId:'v',caption:'ดูสินค้าที่แนบ #ShopeeVideo'}});
const flush = async (pilot) => { for(let n=0;n<4;n++){await new Promise(resolve=>setImmediate(resolve));await pilot.tick();} };
function deps(overrides={}) { return { requireLicense:async()=>{},resumeVideo:async()=>{},resumePost:async()=>{},analyzeProduct:async()=>{throw Error('unexpected analysis')},generateContentScenes:async()=>{throw Error('unexpected generation')},startVideo:async()=>{throw Error('unexpected render')},isManualJobRunning:async()=>false,prepareTikTokPost:async()=>{throw Error('unexpected TikTok post')},prepareShopeePost:async()=>{throw Error('unexpected Shopee post')},...overrides }; }

test('autopilot dispatches exact Shopee product and records a confirmed publication', async () => {
  data = {products:[product],videos:[{id:'v',status:'completed'}],autopilot:state()};
  let calls=0;
  const pilot=createAutopilot(deps({async prepareShopeePost(videoId,caption,autoPost,url){calls++;assert.equal(videoId,'v');assert.equal(autoPost,true);assert.equal(url,product.sourceUrl);await store.updateVideoJob('v',{shopeePost:{status:'posted',at:Date.now(),error:null}});return {ok:true};}}));
  await flush(pilot);
  assert.equal(calls,1); assert.equal(data.autopilot.history[0].status,'posted');assert.equal(data.autopilot.history[0].platform,'shopee');
});

test('ambiguous Shopee publication pauses and never automatically submits again', async () => {
  const run=state();run.current.postRequestedAt=Date.now()-100;
  data = {products:[product],videos:[{id:'v',status:'completed',shopeePost:{status:'uncertain',at:Date.now(),error:'timeout'}}],autopilot:run};
  const pilot=createAutopilot(deps());await flush(pilot);
  assert.equal(data.autopilot.status,'paused');assert.equal(data.autopilot.history.length,0);
  await pilot.handleMessage({type:'AUTOPILOT_RESUME'});await flush(pilot);
  assert.equal(data.autopilot.status,'paused');
});

test('a stalled preparing state reaches the timeout instead of waiting forever', async () => {
  const run=state();run.current.postRequestedAt=Date.now()-21*60_000;
  data={products:[product],videos:[{id:'v',status:'completed',shopeePost:{status:'preparing',at:Date.now(),error:null}}],autopilot:run};
  const pilot=createAutopilot(deps());await flush(pilot);
  assert.equal(data.autopilot.status,'paused');assert.equal(data.videos[0].shopeePost.status,'uncertain');
});

test('Shopee posting requires a canonical product before starting a paid generation', async () => {
  data={products:[{...product,sourceUrl:'https://s.shopee.co.th/short'}]};
  const pilot=createAutopilot(deps());await flush(pilot);
  const result=await pilot.handleMessage({type:'AUTOPILOT_START',productIds:[product.id],settings});
  assert.equal(result.ok,false);assert.match(result.error,/ลิงก์ Shopee/);
});

test('legacy autopilot settings still publish through TikTok', async () => {
  const run=state();delete run.settings.platform;run.current.style='UGC';
  const tiktokProduct={...product,source:'tiktok',sourceUrl:'https://www.tiktok.com/tiktokstudio/product/123456'};
  data={products:[tiktokProduct],videos:[{id:'v',status:'completed'}],autopilot:run};
  let calls=0;
  const pilot=createAutopilot(deps({async prepareTikTokPost(videoId,caption,autoPost,id){calls++;assert.equal(id,'123456');await store.updateVideoJob(videoId,{tiktokPost:{status:'posted',at:Date.now(),error:null}});return {ok:true};}}));
  await flush(pilot);
  assert.equal(calls,1);assert.equal(data.autopilot.history[0].platform,'tiktok');
});

test('stopping revokes a prepared Shopee task but retains a submitted marker', async () => {
  for(const submitted of [false,true]) {
    const run=state();run.settings={...settings,platform:'shopee'};run.status='paused';run.current.postRequestedAt=Date.now();
    data={products:[product],videos:[{id:'v',status:'completed'}],autopilot:run,'shopeePost:v':{tabId:42,...(submitted?{submittedAt:Date.now()}: {})},'shopeePostTab:42':'v'};
    const pilot=createAutopilot(deps());await flush(pilot);
    await pilot.handleMessage({type:'AUTOPILOT_STOP'});
    assert.equal(data.autopilot.status,'idle');assert.equal(data.autopilot.current,null);
    assert.equal(!!data['shopeePost:v'],submitted);assert.equal(!!data['shopeePostTab:42'],submitted);
    if(!submitted) assert.equal(data.videos[0].shopeePost.status,'failed');
  }
});
