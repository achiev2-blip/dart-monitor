/**
 * DART 공시 스케줄러 — server.js에서 분리된 공시 전용 모듈
 * 
 * 담당:
 *  1. dart-analyzer 초기화 (KEY2 Gemini 분류)
 *  2. DC 갱신 타이머 (updateClaudeSummary)
 *  3. dart_*.json 7일 보존규칙 정리
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');
const dartAnalyzer = require('./dart-analyzer');

/**
 * dart_*.json 7일 보존규칙
 */
function cleanOldDart() {
    const now = new Date();
    const kst = new Date(now.getTime() + 9 * 3600000);
    const cutoff = new Date(kst);
    cutoff.setDate(cutoff.getDate() - 7);
    const cutoffStr = cutoff.getUTCFullYear().toString() +
        String(cutoff.getUTCMonth() + 1).padStart(2, '0') +
        String(cutoff.getUTCDate()).padStart(2, '0');

    try {
        const files = fs.readdirSync(config.DATA_DIR).filter(f => f.startsWith('dart_') && f.endsWith('.json'));
        let removed = 0;
        for (const f of files) {
            const match = f.match(/dart_(\d{8})_/);
            if (match && match[1] < cutoffStr) {
                fs.unlinkSync(path.join(config.DATA_DIR, f));
                removed++;
            }
        }
        if (removed > 0) {
            console.log(`[DART보존] ${removed}파일 삭제 (7일 경과)`);
        }
        return removed;
    } catch (e) {
        console.warn(`[DART보존] 정리 실패: ${e.message}`);
        return 0;
    }
}

/**
 * DART 스케줄러 시작
 * @param {object} app - Express app (DC 갱신에 필요)
 * @param {object} contextModule - routes/context 모듈
 */
function start(app, contextModule) {
    // 1. dart-analyzer 초기화 (KEY2 공시분석)
    dartAnalyzer.init({
        geminiKeyNews: config.GEMINI_KEY_NEWS || process.env.GEMINI_KEY_NEWS,
        intervalMs: 600000  // 10분 간격
    });
    console.log('  📋 DART 스케줄러 초기화 완료');

    // 2. DC 갱신 타이머 (첫 실행 15초 딜레이, 이후 5분마다)
    setTimeout(() => {
        contextModule.updateClaudeSummary(app);
        setInterval(() => contextModule.updateClaudeSummary(app), 300000);
    }, 15000);

    // 3. dart_*.json 보존규칙 (서버 시작 시 1회)
    cleanOldDart();
}

module.exports = { start, cleanOldDart };
