/**
 * DART 공시 파이프라인 체인 — 오케스트레이터
 * 
 * 역할: Collector와 Classifier를 연결하여 자동 파이프라인 구성
 *   수집 완료 → 즉시 분류 시작
 *   1시간 주기 → 확인필요 건 Search AI 재시도
 * 
 * 실행: node disclosure-chain.js
 * 독립성: collector, classifier는 각각 독립 실행도 가능
 */

const path = require('path');
const fs = require('fs');
const collector = require('./disclosure-collector');
const classifier = require('./disclosure-classifier');

const DATA_DIR = path.join(__dirname, 'data');
const RETRY_INTERVAL = 3600000; // 1시간
const CHECK_INTERVAL = 30000;   // 30초마다 수집 완료 체크

console.log('[체인] ═══════════════════════════════════');
console.log('[체인] 공시 파이프라인 시작');
console.log('[체인]   수집: Collector (10분 간격, 평일 08~19시)');
console.log('[체인]   분류: Classifier (수집 후 즉시)');
console.log('[체인]   재시도: 1시간 주기');
console.log('[체인] ═══════════════════════════════════');

// ── 파일 저장 함수 (classifier에 전달) ──
function makeSaveFn() {
    const today = collector.getToday();
    const filePath = path.join(DATA_DIR, `dart_${today}.json`);

    return () => {
        const items = collector.getTodayItems();
        const data = {
            date: today,
            total: items.length,
            types: 'B+C+D+I',
            _collectedAt: new Date().toISOString(),
            items,
        };
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    };
}

// ── 수집 후 분류 실행 ──
let lastItemCount = 0;

setInterval(async () => {
    const items = collector.getTodayItems();
    const currentCount = items.length;

    // 새 데이터가 있으면 분류 실행
    if (currentCount > lastItemCount) {
        console.log(`[체인] 새 공시 감지 (+${currentCount - lastItemCount}건) → 분류 시작`);
        lastItemCount = currentCount;

        try {
            await classifier.classifyAll(items, makeSaveFn());
        } catch (e) {
            console.error(`[체인] 분류 오류: ${e.message}`);
        }
    }
}, CHECK_INTERVAL);

// ── Collector 시작 (10분 간격 자동 수집) ──
collector.start();

// ── 시작 시 기존 미분류 처리 (15초 후 — 파일 로드 대기) ──
setTimeout(async () => {
    const items = collector.getTodayItems();
    const unclassified = items.filter(i => !i._cls).length;
    if (unclassified > 0) {
        console.log(`[체인] 시작 시 미분류 ${unclassified}건 발견 → 분류 시작`);
        lastItemCount = items.length; // 중복 트리거 방지
        try {
            await classifier.classifyAll(items, makeSaveFn());
        } catch (e) {
            console.error(`[체인] 초기 분류 오류: ${e.message}`);
        }
    }
}, 15000);

// ── 1시간 주기: 확인필요 재시도 ──
setInterval(async () => {
    const items = collector.getTodayItems();
    if (items.length === 0) return;

    console.log('[체인] 확인필요 재시도 시작');
    try {
        await classifier.retryPending(items, makeSaveFn());
    } catch (e) {
        console.error(`[체인] 재시도 오류: ${e.message}`);
    }
}, RETRY_INTERVAL);

console.log('[체인] 파이프라인 가동 중 — Ctrl+C로 종료');
