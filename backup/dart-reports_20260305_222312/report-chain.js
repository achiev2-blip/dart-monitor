/**
 * 증권사 리포트 파이프라인 체인 — 오케스트레이터
 * 
 * 역할: Collector와 Classifier를 연결하여 자동 파이프라인 구성
 *   수집 완료 → 즉시 분류 시작
 *   1시간 주기 → 확인필요 건 재시도 + 기타 변환
 * 
 * 실행: node report-chain.js
 * 독립성: collector, classifier는 각각 독립 실행도 가능
 */

const collector = require('./report-collector');
const classifier = require('./report-classifier');

const RETRY_INTERVAL = 3600000; // 1시간

console.log('[체인] ═══════════════════════════════════');
console.log('[체인] 리포트 파이프라인 시작');
console.log('[체인]   수집: Collector (10분 간격)');
console.log('[체인]   분류: Classifier (수집 후 즉시)');
console.log('[체인]   재시도: 1시간 주기');
console.log('[체인] ═══════════════════════════════════');

// ── 수집 완료 → 분류 자동 실행 ──
collector.onCollected(async () => {
    console.log('[체인] 수집 완료 → 분류 시작');
    try {
        await classifier.classifyPending();
    } catch (e) {
        console.error(`[체인] 분류 오류: ${e.message}`);
    }
});

// ── Collector 시작 (10분 간격 자동 수집) ──
collector.start();

// ── 1시간 주기: 확인필요 재시도 + 기타 변환 ──
setInterval(async () => {
    console.log('[체인] 확인필요 재시도 시작');
    try {
        await classifier.retryAndFinalize();
        classifier.cleanOldOutputFiles();
    } catch (e) {
        console.error(`[체인] 재시도 오류: ${e.message}`);
    }
}, RETRY_INTERVAL);

// 시작 15초 후 — 기존 미분류 항목 자동 처리
setTimeout(async () => {
    console.log('[체인] 기존 미분류 자동 분류 시작');
    try {
        await classifier.classifyPending();
    } catch (e) {
        console.error(`[체인] 초기 분류 오류: ${e.message}`);
    }
}, 15000);

// 첫 재시도는 1시간 후
console.log('[체인] 파이프라인 가동 중 — Ctrl+C로 종료');
