/**
 * ai-queue 통합 테스트 — 공시 + 리포트 동시 투입
 * 다른 내용의 더미 데이터로 체인 처리 확인
 */
require('dotenv').config();
const aiQueue = require('./services/ai-queue');

// KEY2로 초기화
aiQueue.init({ apiKey: process.env.GEMINI_KEY_NEWS });

// 더미 공시 — 삼성전자 자사주 취득
const dummyDisclosure = {
    corp_name: '삼성전자',
    report_nm: '자기주식취득결정'
};

// 더미 리포트 — LG에너지솔루션 실적 전망
const dummyReport = {
    corp: 'LG에너지솔루션(373220)',
    title: '4Q 실적 프리뷰: 기대 이상의 수익성',
    broker: '한국투자증권(WiseReport)',
    opinion: '매수',
    targetPrice: 420000,
    summary: '4분기 매출액 8.2조원, 영업이익 4,100억원 예상. 북미 IRA 보조금 효과와 원형배터리 수율 개선이 수익성 견인.'
};

console.log('=== 공시+리포트 동시 투입 테스트 ===\n');
console.log('[투입] 공시: 삼성전자 자기주식취득결정');
console.log('[투입] 리포트: LG에너지솔루션 4Q 실적 프리뷰\n');

// 공시 추가
aiQueue.addDisclosure(dummyDisclosure, (result) => {
    console.log('\n✅ [공시 라인 콜백]');
    console.log('   판단:', result.cls);
    console.log('   요약:', result.summary);
});

// 리포트 추가 (공시 끝나면 자동 시작)
aiQueue.addReport(dummyReport, (result) => {
    console.log('\n✅ [리포트 라인 콜백]');
    console.log('   판단:', result.cls);
    console.log('   방향:', result.direction);
    console.log('   요약:', result.summary);
});

// 진행 상태 확인
setTimeout(() => {
    const s = aiQueue.getStatus();
    console.log(`\n[1초] 상태: running=${s.running} 큐=${JSON.stringify(s.queued)}`);
}, 1000);

// 최종 확인 (15초 후)
setTimeout(() => {
    const s = aiQueue.getStatus();
    console.log(`\n=== 최종 상태 ===`);
    console.log(`running: ${s.running}`);
    console.log(`큐: 공시=${s.queued.disclosure} 리포트=${s.queued.report} 미처리=${s.queued.retry}`);
    console.log('\n완료!');
}, 15000);
