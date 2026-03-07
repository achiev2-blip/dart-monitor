/**
 * 뉴스 파이프라인 체인 — 오케스트레이터
 * 
 * 역할: Collector와 Classifier를 연결하여 자동 파이프라인 구성
 *   수집 완료 → 즉시 분류 시작
 *   분류 완료 → output 폴더에 저장
 *   1시간 주기 → 확인필요 건 Search AI 재시도
 * 
 * 저장 구조:
 *   data/pending/ — 수집 원본 + 분류 상태
 *   data/output/  — 분류 완료 항목만 (뷰어 → 캐시 → API)
 * 
 * 실행: node news-chain.js
 * 독립성: collector, classifier는 각각 독립 실행도 가능
 */

const path = require('path');
const fs = require('fs');
const collector = require('./news-collector');
const classifier = require('./news-classifier');

const PENDING_DIR = path.join(__dirname, 'data', 'pending');
const RETRY_INTERVAL = 3600000; // 1시간
const CHECK_INTERVAL = 30000;   // 30초마다 수집 완료 체크

console.log('[체인] ═══════════════════════════════════');
console.log('[체인] 뉴스 파이프라인 시작');
console.log('[체인]   수집: Collector (시간대별 동적 간격)');
console.log('[체인]   분류: Classifier (수집 후 즉시)');
console.log('[체인]   저장: pending/ → output/ 분리');
console.log('[체인]   재시도: 1시간 주기');
console.log('[체인] ═══════════════════════════════════');

// ── 파일 저장 함수 (classifier에 전달) ──
// pending 저장 + output 갱신 (10건마다 호출 → 뷰어에 실시간 반영)
function makeSaveFn() {
    const today = collector.getToday();
    const filePath = path.join(PENDING_DIR, `news_${today}.json`);

    return () => {
        const items = collector.getTodayItems();
        const data = {
            date: today,
            updatedAt: new Date(Date.now() + 9 * 3600000).toISOString(),
            totalItems: items.length,
            items,
        };
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');

        // output도 함께 갱신 → 뷰어가 분류 진행상황을 실시간으로 반영
        classifier.moveToOutput(today, items);
    };
}

// output 파일 갱신: 분류 완료 항목만 output 폴더에 저장
function saveToOutput() {
    const today = collector.getToday();
    const items = collector.getTodayItems();
    classifier.moveToOutput(today, items);
}

// ── 수집 후 분류 실행 ──
// 날짜 변경과 무관하게, 미분류 건이 있으면 항상 분류 실행
setInterval(async () => {
    const items = collector.getTodayItems();
    if (items.length === 0) return;

    const unclassified = items.filter(i => !i._cls).length;
    if (unclassified > 0) {
        console.log(`[체인] 미분류 ${unclassified}건 감지 → 분류 시작`);

        try {
            await classifier.classifyAll(items, makeSaveFn());
            saveToOutput(); // 분류 완료 → output 갱신
        } catch (e) {
            console.error(`[체인] 분류 오류: ${e.message}`);
        }
    }
}, CHECK_INTERVAL);

// ── Collector 시작 (동적 간격 자동 수집) ──
collector.start();

// ── 시작 시 기존 미분류 처리 (15초 후 — 파일 로드 대기) ──
setTimeout(async () => {
    const items = collector.getTodayItems();
    const unclassified = items.filter(i => !i._cls).length;
    if (unclassified > 0) {
        console.log(`[체인] 기존 미분류 ${unclassified}건 자동 분류 시작`);
        try {
            await classifier.classifyAll(items, makeSaveFn());
            saveToOutput(); // 분류 완료 → output 갱신
        } catch (e) {
            console.error(`[체인] 초기 분류 오류: ${e.message}`);
        }
    }
}, 15000);

console.log('[체인] 파이프라인 가동 중 — Ctrl+C로 종료');
