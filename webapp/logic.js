(function (root, factory) { const api = factory(); if (typeof module !== 'undefined' && module.exports) module.exports = api; else Object.assign(root, api); })(typeof globalThis !== 'undefined' ? globalThis : this, function () {
function evaluate(rules, request, report, ctx = {}) {
  const rank = {pass:0, escalate:1, deny:2};
  const tight = (...v) => v.reduce((a,b) => rank[a]>=rank[b]?a:b, 'pass');
  let a='pass', b='pass'; const reasons=[];
  const threshold=rules.jev_threshold_permille ?? 900;
  if(report) {
    if(report.instruction_hash!==request.instruction_hash){a='deny';reasons.push('2a_hash_mismatch');}
    if(report.source_label==='external_content'){a=tight(a,report.source_q_permille>=threshold?'deny':'escalate');reasons.push('2a_external_content');}
    else if(report.source_label!=='owner_signed'){a=tight(a,'escalate');reasons.push('2a_unknown');}
    if(report.source_q_permille<threshold || report.source_q_permille>1000){a=tight(a,'escalate');reasons.push('2a_low_confidence');}
    if(report.category_q_permille<threshold || report.category_q_permille>1000){b=tight(b,'escalate');reasons.push('2b_low_confidence');}
  } else if(rules.enabled && rules.jev_required){a='escalate';reasons.push('jev_missing');}
  if(rules.enabled){
    if(!rules.payees.some(p=>p.account===request.target)){b='deny';reasons.push('2b_payee_not_allowed');}
    const checks=[
      [BigInt(request.amount)>BigInt(rules.per_tx_limit),'2b_per_tx_limit'],
      [BigInt(ctx.spent??0)+BigInt(request.amount)>BigInt(rules.per_day_limit) || BigInt(ctx.spent??0)+BigInt(request.amount)>(1n<<128n)-1n,'2b_per_day_limit'],
      [(ctx.count??0)>=rules.max_tx_per_day,'2b_frequency']];
    for(const [failed,code] of checks)if(failed){b=tight(b,'escalate');reasons.push(code);}
    const localMinutes=BigInt(ctx.timestamp_ns??0)/60000000000n+BigInt(rules.tz_offset_min);
    const minute=Number((localMinutes%1440n+1440n)%1440n);
    const s=rules.window_start_min,e=rules.window_end_min;
    if(!(s===e || (s<e?minute>=s && minute<e:minute>=s || minute<e))){b=tight(b,'escalate');reasons.push('2b_time_window');}
    if(!report && rules.allowed_categories.length){b=tight(b,'escalate');reasons.push('2b_category_missing');}
    if(report && rules.allowed_categories.length && !rules.allowed_categories.includes(report.category)){b=tight(b,'escalate');reasons.push('2b_category');}
  }
  const verdict=ctx.tier1_passed===false?'deny':tight(a,b,ctx.prior??'pass');
  return {verdict,lock:a==='deny'?'2a':b==='deny'?'2b':verdict==='pass'?'pass':'2c',reasons};
}
function reasonText(result, report) {
  const words={'2b_category_missing':'지출 종류를 확인할 보고서가 없음','2a_hash_mismatch':'판단한 지시와 결제 지시가 다름','2a_unknown':'지시 출처를 확인할 수 없음','2a_low_confidence':'확신이 낮아 사람 확인이 필요함','2b_payee_not_allowed':'주소록에 없는 받는 사람','2b_per_tx_limit':'한 번에 쓸 수 있는 한도를 넘음','2b_per_day_limit':'하루 한도를 넘음','2b_time_window':'허용 시간대 밖','2b_frequency':'하루 거래 횟수 초과','2b_category':'허용하지 않은 지출 종류','2b_low_confidence':'지출 종류의 확신이 낮아 사람 확인이 필요함','jev_missing':'판단 보고서가 없어 사람 확인이 필요함'};
  return result.reasons.map(code=>code==='2a_external_content'?`외부 문서에서 나온 지시로 보임 — 확신 ${(report?.source_q_permille??0)/10}%`:words[code]??code).join(' · ') || '두 잠금 확인을 통과함';
}
function formatCountdown(secondsLeft) { const s=Math.max(0,Math.ceil(secondsLeft)); return s===0?'시간 초과 — 지급되지 않음':`남은 시간 ${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`; }
const base={rules_nonce:0,enabled:true,per_tx_limit:'1000000000000000000000000',per_day_limit:'2000000000000000000000000',payees:[{alias:'서비스 구독',account:'subscription.near'}],tz_offset_min:540,window_start_min:0,window_end_min:0,max_tx_per_day:5,allowed_categories:['subscription','cloud'],jev_threshold_permille:900,jev_required:true};
const templates={normal:base,safe:{...base,per_tx_limit:'500000000000000000000000',per_day_limit:'1000000000000000000000000',window_start_min:540,window_end_min:1080,max_tx_per_day:3,jev_threshold_permille:950}};
function toRules(state){return {...state,per_tx_limit:String(state.per_tx_limit),per_day_limit:String(state.per_day_limit),payees:state.payees.map(p=>({...p})),allowed_categories:[...state.allowed_categories]};}
function policyUpdateObject(rules,nonce){return {domain:'chopgate:spend-rules:v1',nonce,rules:{...toRules(rules),rules_nonce:nonce}};}
function pendingDecisionObject(id,approve,request){return {domain:'chopgate:pending-decision:v2',contract:'mock.chopgate.test',id,approve,request_hash:{algorithm:'SHA-256(Borsh(action,target,amount,serial,instruction_hash))',mock:true,content:{action:request.action,target:request.target,amount:String(request.amount),serial:request.serial,instruction_hash:request.instruction_hash}}};}
function mockSign(object){return {object,signature:'MOCK — 실제로는 오너 지갑이 서명'};}
const receiptEvents=['tier2_decision','pending_created','pending_approved','pending_rejected','pending_expired','decision','payout'];

function formatNear(value) {
 const n=BigInt(value), unit=10n**24n;
 const fraction=(n%unit).toString().padStart(24,'0').replace(/0+$/,'');
 return `${n/unit}${fraction?'.'+fraction:''}`;
}
function suspicious(report) { return !report || [report.source_q_permille,report.category_q_permille].some(q=>!Number.isFinite(q)||q<900||q>1000); }
function paymentView(object,payees=[]) {
 const data=object.request_hash.content;
 const payee=payees.find(p=>p.account===data.target);
 return {alias:payee?.alias||'새 수취인',target:data.target,amount:formatNear(data.amount),total:formatNear(data.amount),firstSeen:!payee,action:data.action==='transfer'?'송금':'알 수 없는 작업'};
}
function historyStatus(event) { return ({pending_approved:'승인',payout:'승인',pending_rejected:'거절',pending_expired:'시간초과',decision:'서명 안 됨',pending_created:'승인 대기',tier2_decision:'검토 필요'})[event]||'검토 필요'; }
return { formatNear, suspicious, paymentView, historyStatus, evaluate, reasonText, formatCountdown, templates, toRules, policyUpdateObject, pendingDecisionObject, mockSign, receiptEvents };
});
