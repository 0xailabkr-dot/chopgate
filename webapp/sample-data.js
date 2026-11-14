const sampleReport={source_label:'external_content',source_q_permille:620,instruction_hash:'sample-instruction-hash',category:'subscription',category_q_permille:950,mode:'mock'};
const sampleRequest={action:'transfer',serial:1,target:'subscription.near',amount:'800000000000000000000000',instruction_hash:'sample-instruction-hash'};
const sampleReceipts=[
 {event:'tier2_decision',tier:2,result:'보류',why:'외부 문서에서 나온 지시로 보임 — 확신 62%',lock:'2c',reasons:['2a_external_content','2a_low_confidence']},
 {event:'pending_created',tier:3,result:'보류',why:'오너 확인을 기다림'},
 {event:'pending_approved',tier:3,result:'통과',why:'오너가 서명으로 승인함'},
 {event:'pending_rejected',tier:3,result:'거절',why:'오너가 거절하여 예약금을 돌려놓음'},
 {event:'pending_expired',tier:3,result:'거절',why:'시간 초과 — 지급되지 않음'},
 {event:'decision',tier:1,result:'거절',why:'오너가 서명하지 않은 지시'},
 {event:'payout',tier:1,result:'통과',why:'승인한 결제를 지급함'}
].map((r,i)=>({...r,signed:{object:pendingDecisionObject(i+10,r.event==='pending_approved'||r.event==='payout',i%3===0?{...sampleRequest,target:'long-recipient-account-for-cloud-invoices.department.near'}:sampleRequest)},time:new Date(Date.now()-i*60000).toLocaleTimeString('ko-KR',{hour12:true})}));
