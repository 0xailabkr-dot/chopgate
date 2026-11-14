import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {evaluate,reasonText,formatCountdown,templates,policyUpdateObject,mockSign,receiptEvents,toRules}=require('../logic.js');
const root=new URL('../',import.meta.url);
const read=p=>readFileSync(new URL(p,root),'utf8');
const cases=JSON.parse(read('fixtures/cases.json'));
test('rules screen: changing the per-tx limit changes the outcome',()=>{const c=cases[0];assert.equal(evaluate({...c.rules,per_tx_limit:'9'},c.request,c.report,c.ctx).verdict,'escalate');assert.equal(evaluate({...c.rules,per_tx_limit:'11'},c.request,c.report,c.ctx).verdict,'pass');});
test('uncertain 62% reads as plain-language reason',()=>{const c=cases.find(c=>c.name==='uncertain');assert.match(reasonText(evaluate(c.rules,c.request,c.report,c.ctx),c.report),/외부 문서에서 나온 지시로 보임 — 확신 62%/);});
test('shared cases match engine',()=>{for(const c of cases)assert.deepEqual(evaluate(c.rules,c.request,c.report,c.ctx),{verdict:c.expected_verdict,lock:c.expected_lock,reasons:c.expected_reasons},c.name);});
test('countdown formatting and expiry',()=>{assert.equal(formatCountdown(252),'남은 시간 04:12');assert.equal(formatCountdown(0),'시간 초과 — 지급되지 않음');assert.equal(formatCountdown(-2),'시간 초과 — 지급되지 않음');});
test('no external requests: no http(s) URLs / fetch / XMLHttpRequest / WebSocket / external script|link in webapp sources',()=>{for(const f of readdirSync(root).filter(f=>/\.(html|css|js|mjs)$/.test(f)))assert.doesNotMatch(read(f),/https?:\/\/|\bfetch\s*\(|XMLHttpRequest|WebSocket|(?:src|href)=["'](?:\/\/|https?:)/i,f);});
test('no JSON editor: no <textarea> or contenteditable with json in index.html',()=>{assert.doesNotMatch(read('index.html'),/<textarea|contenteditable/i);assert.doesNotMatch(read('app.js'),/<textarea|contenteditable/i);});
test('receipt timeline lists all five tier-3 events and tier-1 and tier-2',()=>{for(const event of receiptEvents)assert.ok(read('sample-data.js').includes(`'${event}'`));assert.doesNotMatch(read('app.js'),/1차 계약|2차 이중 잠금|3차 사람 승인/);});
test('save produces an owner-signed policy-update object, not a file write',()=>{const obj=policyUpdateObject(templates.normal,2);assert.equal(obj.domain,'chopgate:spend-rules:v1');assert.equal(obj.rules.rules_nonce,2);assert.match(mockSign(obj).signature,/MOCK/);assert.doesNotMatch(read('app.js'),/writeFile|showSaveFilePicker|localStorage/);assert.notEqual(toRules(templates.safe),templates.safe);});
test('single logic source: webapp has logic.js and no logic.mjs, index.html loads logic.js',()=>{assert.ok(existsSync(new URL('logic.js',root)));assert.ok(!existsSync(new URL('logic.mjs',root)));assert.match(read('index.html'),/<script src="logic\.js"><\/script>/);});

test('pending decision mock includes exact execution content and v2 domain',()=>{
 const {pendingDecisionObject}=require('../logic.js');
 const request={action:'transfer',target:'payee.test',amount:'10',serial:1,instruction_hash:'h'};
 const object=pendingDecisionObject(7,true,request);
 assert.equal(object.domain,'chopgate:pending-decision:v2');assert.equal(object.contract,'mock.chopgate.test');assert.equal(object.id,7);assert.equal(object.approve,true);
 assert.deepEqual(object.request_hash.content,request);assert.equal(object.request_hash.mock,true);
 for(const changed of [{...request,amount:'11'},{...request,target:'other.test'}])assert.notDeepEqual(pendingDecisionObject(7,true,changed),object);
});

// Exercise the actual UI event handlers offline with a small DOM boundary.
import vm from 'node:vm';
const inbox=JSON.parse(read('fixtures/inbox.json'));
function ui(){
 const elements=new Map();
 const element=id=>{if(!elements.has(id))elements.set(id,{innerHTML:'',textContent:'',value:'',dataset:{},showModal(){this.open=true;},close(){this.open=false;},before(node){this.previous=node;}});return elements.get(id);};
 const context=vm.createContext({console,Date,BigInt,setInterval(){},location:{hash:'#pending'},window:{addEventListener(){}},document:{getElementById:element,querySelectorAll(){return [];},querySelector(){return element('preview-card');}}});
 for(const f of ['logic.js','sample-data.js','app.js'])vm.runInContext(read(f),context,{filename:f});
 return {context,element,run:code=>vm.runInContext(code,context)};
}
test('NEAR formatting preserves every decimal without smallest-unit labels',()=>{
 const {formatNear}=require('../logic.js');
 assert.equal(formatNear('1'),'0.000000000000000000000001');
 assert.equal(formatNear('1000000000000000000000000'),'1');
 assert.equal(formatNear(inbox.request.amount),'1.234567890123456789012345');
 const u=ui();assert.match(u.element('main').innerHTML,/0.8 NEAR/);assert.doesNotMatch(u.element('main').innerHTML,/yocto|800000000000000000000000/);
});
test('suspicious approval requires an additional confirmation; 90% is inclusive',()=>{
 const {suspicious}=require('../logic.js');
 assert.equal(suspicious(inbox.report),true);assert.equal(suspicious({...inbox.report,source_q_permille:900}),false);
 assert.equal(suspicious({...inbox.report,source_q_permille:970,category_q_permille:899}),true);
 const u=ui();u.run('confirmPending(1,true)');assert.match(u.element('sheet-content').innerHTML,/한 번 더 확인/);
 assert.match(u.element('sheet-content').innerHTML,/class="caution"/);
 u.element('confirm-pending').onclick();assert.equal(u.run('pending.length'),2);
 assert.match(u.element('sheet-content').innerHTML,/모의 서명으로 승인/);
 u.element('confirm-pending').onclick();assert.equal(u.run('pending.length'),1);assert.equal(u.run('receipts[0].event'),'pending_approved');
 const normal=ui();normal.run("draft.payees.push({alias:'클라우드',account:'new-cloud.near'});confirmPending(2,true)");assert.doesNotMatch(normal.element('sheet-content').innerHTML,/한 번 더 확인/);
 normal.element('confirm-pending').onclick();assert.equal(normal.run('pending.length'),1);
});
test('cards and confirmation use exact signed content, never caller descriptions',()=>{
 const u=ui();u.context.fixture=inbox;
 u.run('pending[0].request={...fixture.request};pending[0].alias=fixture.alias;pending[0].description=fixture.description;renderPending()');
 const card=u.element('main').innerHTML;
 assert.match(card,/actual.near/);assert.match(card,/1.234567890123456789012345 NEAR/);assert.match(card,/처음 보는 수취인/);assert.match(card,/총 최대 지출/);
 assert.doesNotMatch(card,/trusted.near|믿어도 되는 호출자 설명|안전한 구독/);
 u.run("draft.payees.push({alias:'실제 수취인',account:'actual.near'});pending[0].report.instruction_hash=pending[0].request.instruction_hash;confirmPending(1,true)");assert.match(u.element('sheet-content').innerHTML,/actual.near/);
 u.element('confirm-pending').onclick();u.element('confirm-pending').onclick();
 assert.equal(u.run('receipts[0].signed.object.request_hash.content.target'),'actual.near');
});
test('no bulk approval action is rendered; each approval is bound to one id',()=>{
 const u=ui(),html=u.element('main').innerHTML;
 assert.equal((html.match(/data-resolve="approve"/g)||[]).length,1);
 assert.match(html,/data-resolve="approve" data-id="1"/);assert.doesNotMatch(html,/data-resolve="approve" data-id="2"/);assert.match(html,/규칙부터 확인/);
 assert.doesNotMatch(html,/일괄|모두 승인|approve-all|bulk/i);
});
test('history distinguishes approved rejected timeout unsigned with amount and recipient',()=>{
 const {historyStatus}=require('../logic.js');for(const [event,label] of Object.entries(inbox.statuses))assert.equal(historyStatus(event),label);
 const u=ui();u.run('renderHistory()');const html=u.element('main').innerHTML;
 for(const label of Object.values(inbox.statuses))assert.ok(html.includes(label));
 assert.match(html,/subscription.near/);assert.match(html,/0.8 NEAR/);assert.doesNotMatch(html,/>tier2_decision<|>pending_created</);
 u.run('confirmPending(1,false)');u.element('confirm-pending').onclick();assert.equal(u.run('receipts[0].event'),'pending_rejected');
 u.run('pending[0].deadline=0;tick()');assert.equal(u.run('pending.length'),0);assert.equal(u.run('receipts[0].event'),'pending_expired');
 u.run('tick()');assert.equal(u.run('receipts.filter(r=>r.event==="pending_expired").length'),2);
});
test('expiry during confirmation never approves',()=>{
 const u=ui();u.run('confirmPending(1,true)');u.element('confirm-pending').onclick();u.run('pending[0].deadline=0');u.element('confirm-pending').onclick();assert.equal(u.run('receipts[0].event'),'pending_expired');
});
test('rules preview precedes save controls and text stays readable at 390px',()=>{
 assert.match(read('app.js'),/getElementById\('save-controls'\).before\(document.querySelector\('\.preview'\)\)/);
 assert.match(read('app.js'),/aria-pressed/);assert.match(read('app.js'),/90%/);assert.match(read('app.js'),/종료 시각은 제외/);
 assert.match(read('style.css'),/small,\.badge,\.eyebrow,pre,header small\{font-size:14px\}/);
 assert.doesNotMatch(read('app.js'),/Noul|서명하세요/);
});

test('unknown or denied payees cannot approve through a direct handler; preview agrees',()=>{const u=ui();u.run('confirmPending(2,true)');assert.match(u.element('sheet-content').innerHTML,/규칙부터 확인/);assert.equal(u.run('pending.length'),2);assert.equal(u.run('evaluationFor(pending[1]).verdict'), 'deny');u.run('preview()');assert.match(u.element('preview').innerHTML,/거절/);u.run('draft.payees=[];confirmPending(1,true)');assert.match(u.element('sheet-content').innerHTML,/규칙부터 확인/);});
test('AI badges are visibly distinct and history groups recipients',()=>{const u=ui();assert.match(u.element('main').innerHTML,/estimate">AI 추정/);assert.match(read('style.css'),/border:2px dashed/);u.run('renderHistory()');assert.match(u.element('main').innerHTML,/status-pending_approved/);assert.match(u.element('main').innerHTML,/long-recipient-account/);assert.match(u.element('main').innerHTML,/오전|오후/);});
