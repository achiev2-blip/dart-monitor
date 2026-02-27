/**
 * DART 모니터 — 예측 피드백 루프 시스템
 * 
 * ============================================================
 * 목적: 종목별 예측을 저장하고, 실제 결과와 비교하여
 *       정확도를 누적 측정 → AI 분석 신뢰도 개선
 * 
 * 흐름:
 *   1. 예측 생성 → active/ 에 저장
 *   2. 평가 기한 도래 → hantoo에서 실제 종가 수집
 *   3. 예측 vs 실제 비교 → 오차 계산
 *   4. 평가 완료 → evaluated/ 로 이동
 *   5. stats.json에 정확도 통계 누적
 * 
 * 디렉토리 구조:
 *   data/predictions/
 *   ├── active/          ← 진행중인 예측 (미평가)
 *   ├── evaluated/       ← 평가 완료된 예측
 *   └── stats.json       ← 종목별/전체 정확도 통계
 * 
 * 연결:
 *   - server.js POST /api/predictions        → createPrediction()
 *   - server.js GET  /api/predictions         → getActivePredictions()
 *   - server.js GET  /api/predictions/stats   → getStats()
 *   - server.js 타이머 (15:40 KST)           → evaluateDuePredictions()
 *   - Claude API 응답                         → 예측 정확도 통계 포함
 * 
 * 예측 구조 (prediction object):
 *   {
 *     id: "pred_005930_20260222_abc",
 *     code: "005930",              // 종목코드
 *     name: "삼성전자",            // 종목명
 *     createdAt: "2026-02-22T...", // 생성 시각
 *     source: "claude" | "user",   // 예측 출처
 *     
 *     // 예측 내용
 *     prediction: {
 *       direction: "up" | "down" | "flat", // 방향
 *       targetPrice: 72000,        // 목표가 (선택)
 *       priceAtPrediction: 70000,  // 예측 시점 주가
 *       confidence: "high"|"medium"|"low", // 확신도
 *       reasoning: "반도체 업황 개선...", // 근거
 *       timeframe: "1d" | "1w" | "1m"    // 평가 기간
 *     },
 *     
 *     // 평가 결과 (evaluated 후 채워짐)
 *     evaluation: null | {
 *       evaluatedAt: "2026-02-23T...",
 *       actualPrice: 71500,         // 실제 종가
 *       actualChange: +2.14,        // 실제 변동률
 *       directionCorrect: true,     // 방향 맞았는지
 *       priceError: 0.69,           // 목표가 오차율(%)
 *       score: 85                   // 0~100 점수
 *     }
 *   }
 * ============================================================
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');

const PRED_DIR = path.join(config.DATA_DIR, 'predictions');
const ACTIVE_DIR = path.join(PRED_DIR, 'active');
const EVALUATED_DIR = path.join(PRED_DIR, 'evaluated');
const STATS_FILE = path.join(PRED_DIR, 'stats.json');

// 디렉토리 보장
[PRED_DIR, ACTIVE_DIR, EVALUATED_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ============================================================
// 유틸리티
// ============================================================

function loadJSON(fp, fallback) {
    try {
        if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf-8'));
    } catch (e) { /* skip */ }
    return fallback;
}

function saveJSON(fp, data) {
    try {
        fs.writeFileSync(fp, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) { console.error(`[예측] JSON 저장 실패: ${e.message}`); }
}

function generateId() {
    return Math.random().toString(36).slice(2, 8);
}

function getKSTDate(offset = 0) {
    const d = new Date(Date.now() + 9 * 3600000 + offset * 86400000);
    return d.toISOString().slice(0, 10);
}

function getKSTNow() {
    return new Date(Date.now() + 9 * 3600000);
}

// 통계 로드
let stats = loadJSON(STATS_FILE, {
    total: { predictions: 0, evaluated: 0, correct: 0, avgScore: 0, scores: [] },
    byStock: {},    // { "005930": { predictions, evaluated, correct, avgScore, scores[] } }
    bySource: {},   // { "claude": {...}, "user": {...} }
    byTimeframe: {} // { "1d": {...}, "1w": {...}, "1m": {...} }
});

// ============================================================
// F1: 예측 생성 & 저장
// ============================================================
// 호출원: server.js POST /api/predictions
// Claude가 분석 결과와 함께 예측을 생성하거나, 사용자가 직접 예측 입력
// ============================================================

function createPrediction({ code, name, source = 'user', direction, targetPrice, priceAtPrediction, confidence = 'medium', reasoning = '', timeframe = '1d' }) {
    // 입력 검증
    if (!code || !name) throw new Error('종목코드와 종목명이 필요합니다');
    if (!['up', 'down', 'flat'].includes(direction)) throw new Error('direction은 up/down/flat 중 하나여야 합니다');
    if (!['1d', '1w', '1m'].includes(timeframe)) throw new Error('timeframe은 1d/1w/1m 중 하나여야 합니다');

    const id = `pred_${code}_${getKSTDate()}_${generateId()}`;

    // 평가 기한 계산
    const dueOffsets = { '1d': 1, '1w': 5, '1m': 22 }; // 영업일 기준
    const dueDate = getKSTDate(dueOffsets[timeframe]);

    const prediction = {
        id,
        code,
        name,
        createdAt: new Date().toISOString(),
        source,
        dueDate,
        status: 'active', // active → evaluated

        prediction: {
            direction,
            targetPrice: targetPrice ? parseFloat(targetPrice) : null,
            priceAtPrediction: priceAtPrediction ? parseFloat(priceAtPrediction) : null,
            confidence,
            reasoning,
            timeframe
        },

        evaluation: null
    };

    // 저장
    const fp = path.join(ACTIVE_DIR, `${id}.json`);
    saveJSON(fp, prediction);

    // 통계 갱신
    stats.total.predictions++;
    if (!stats.byStock[code]) stats.byStock[code] = { name, predictions: 0, evaluated: 0, correct: 0, avgScore: 0, scores: [] };
    stats.byStock[code].predictions++;
    if (!stats.bySource[source]) stats.bySource[source] = { predictions: 0, evaluated: 0, correct: 0, avgScore: 0, scores: [] };
    stats.bySource[source].predictions++;
    if (!stats.byTimeframe[timeframe]) stats.byTimeframe[timeframe] = { predictions: 0, evaluated: 0, correct: 0, avgScore: 0, scores: [] };
    stats.byTimeframe[timeframe].predictions++;
    saveJSON(STATS_FILE, stats);

    console.log(`[예측] 생성: ${name}(${code}) ${direction} ${timeframe} — ${id}`);
    return prediction;
}

// ============================================================
// F2: 실제 결과 자동 매칭 & 평가
// ============================================================
// 호출원: server.js 타이머 (KST 15:40, 장 마감 10분 후)
// 로직: active/ 에서 dueDate ≤ 오늘인 예측 → 실제 종가 확인 → 평가
// 연결: hantoo.getWatchlist() 또는 companyData.getPrice() 에서 현재가 조회
// ============================================================

function evaluateDuePredictions(getPriceFn) {
    const today = getKSTDate();
    const activeFiles = fs.readdirSync(ACTIVE_DIR).filter(f => f.endsWith('.json'));
    let evaluated = 0, errors = 0;

    for (const f of activeFiles) {
        try {
            const pred = loadJSON(path.join(ACTIVE_DIR, f), null);
            if (!pred || pred.status !== 'active') continue;
            if (pred.dueDate > today) continue; // 아직 기한 전

            // 현재가 조회
            const actualPrice = getPriceFn(pred.code);
            if (!actualPrice) {
                errors++;
                continue; // 주가를 못 가져오면 건너뜀
            }

            // 평가 수행
            const evaluation = evaluatePrediction(pred, actualPrice);
            pred.evaluation = evaluation;
            pred.status = 'evaluated';

            // evaluated/로 이동
            saveJSON(path.join(EVALUATED_DIR, f), pred);
            try { fs.unlinkSync(path.join(ACTIVE_DIR, f)); } catch (e) { /* skip */ }

            // 통계 갱신
            updateStats(pred);
            evaluated++;

            const emoji = evaluation.directionCorrect ? '✅' : '❌';
            console.log(`[예측] ${emoji} ${pred.name} ${pred.prediction.direction} → 실제 ${evaluation.actualChange > 0 ? '+' : ''}${evaluation.actualChange}% (점수: ${evaluation.score})`);
        } catch (e) {
            errors++;
            console.error(`[예측] 평가 오류 ${f}: ${e.message}`);
        }
    }

    if (evaluated > 0 || errors > 0) {
        console.log(`[예측] 평가 완료: ${evaluated}건 평가, ${errors}건 오류, 남은 활성: ${activeFiles.length - evaluated}건`);
    }

    return { evaluated, errors };
}

// ============================================================
// F3: 개별 예측 평가 로직
// ============================================================
// 점수 계산 기준:
//   - 방향 적중: 50점 (기본)
//   - 목표가 근접도: 0~30점
//   - 확신도 보정: high +20, medium +10, low +0 (맞으면 보너스, 틀리면 감점)
// ============================================================

function evaluatePrediction(pred, actualPrice) {
    const p = pred.prediction;
    const basePrice = p.priceAtPrediction;

    if (!basePrice || !actualPrice) {
        return {
            evaluatedAt: new Date().toISOString(),
            actualPrice,
            actualChange: null,
            directionCorrect: null,
            priceError: null,
            score: 0,
            note: '기준가 또는 실제가 없음'
        };
    }

    const actualChange = parseFloat(((actualPrice - basePrice) / basePrice * 100).toFixed(2));

    // 방향 판정
    let actualDirection;
    if (actualChange > 0.3) actualDirection = 'up';
    else if (actualChange < -0.3) actualDirection = 'down';
    else actualDirection = 'flat';

    const directionCorrect = p.direction === actualDirection;

    // 점수 계산
    let score = 0;

    // 1. 방향 적중 (50점)
    if (directionCorrect) score += 50;
    // 부분 점수: flat 예측 시 ±1% 이내면 부분 점수
    else if (p.direction === 'flat' && Math.abs(actualChange) < 1) score += 30;
    // up/down 예측 시 flat이면 부분 점수
    else if (actualDirection === 'flat') score += 20;

    // 2. 목표가 근접도 (0~30점)
    if (p.targetPrice && actualPrice) {
        const priceError = Math.abs((actualPrice - p.targetPrice) / p.targetPrice * 100);
        if (priceError < 1) score += 30;
        else if (priceError < 3) score += 20;
        else if (priceError < 5) score += 10;
        else if (priceError < 10) score += 5;
    } else {
        // 목표가 없으면 변동폭 기반 보너스
        if (directionCorrect && Math.abs(actualChange) > 2) score += 15;
        else if (directionCorrect) score += 10;
    }

    // 3. 확신도 보정 (맞으면 보너스, 틀리면 감점)
    const confBonus = { high: 20, medium: 10, low: 0 };
    if (directionCorrect) {
        score += confBonus[p.confidence] || 0;
    } else {
        // 높은 확신으로 틀리면 추가 감점
        if (p.confidence === 'high') score = Math.max(0, score - 10);
    }

    score = Math.min(100, Math.max(0, score));

    return {
        evaluatedAt: new Date().toISOString(),
        actualPrice: parseFloat(actualPrice.toFixed(0)),
        actualChange,
        actualDirection,
        directionCorrect,
        priceError: p.targetPrice ? parseFloat(Math.abs((actualPrice - p.targetPrice) / p.targetPrice * 100).toFixed(2)) : null,
        score
    };
}

// ============================================================
// 통계 갱신
// ============================================================
function updateStats(pred) {
    const e = pred.evaluation;
    if (!e) return;

    // 전체 통계
    stats.total.evaluated++;
    if (e.directionCorrect) stats.total.correct++;
    stats.total.scores.push(e.score);
    if (stats.total.scores.length > 500) stats.total.scores = stats.total.scores.slice(-500);
    stats.total.avgScore = parseFloat((stats.total.scores.reduce((a, b) => a + b, 0) / stats.total.scores.length).toFixed(1));

    // 종목별
    const code = pred.code;
    if (!stats.byStock[code]) stats.byStock[code] = { name: pred.name, predictions: 0, evaluated: 0, correct: 0, avgScore: 0, scores: [] };
    const stockStat = stats.byStock[code];
    stockStat.evaluated++;
    if (e.directionCorrect) stockStat.correct++;
    stockStat.scores.push(e.score);
    if (stockStat.scores.length > 100) stockStat.scores = stockStat.scores.slice(-100);
    stockStat.avgScore = parseFloat((stockStat.scores.reduce((a, b) => a + b, 0) / stockStat.scores.length).toFixed(1));

    // 출처별
    const src = pred.source;
    if (!stats.bySource[src]) stats.bySource[src] = { predictions: 0, evaluated: 0, correct: 0, avgScore: 0, scores: [] };
    const srcStat = stats.bySource[src];
    srcStat.evaluated++;
    if (e.directionCorrect) srcStat.correct++;
    srcStat.scores.push(e.score);
    if (srcStat.scores.length > 200) srcStat.scores = srcStat.scores.slice(-200);
    srcStat.avgScore = parseFloat((srcStat.scores.reduce((a, b) => a + b, 0) / srcStat.scores.length).toFixed(1));

    // 기간별
    const tf = pred.prediction.timeframe;
    if (!stats.byTimeframe[tf]) stats.byTimeframe[tf] = { predictions: 0, evaluated: 0, correct: 0, avgScore: 0, scores: [] };
    const tfStat = stats.byTimeframe[tf];
    tfStat.evaluated++;
    if (e.directionCorrect) tfStat.correct++;
    tfStat.scores.push(e.score);
    if (tfStat.scores.length > 200) tfStat.scores = tfStat.scores.slice(-200);
    tfStat.avgScore = parseFloat((tfStat.scores.reduce((a, b) => a + b, 0) / tfStat.scores.length).toFixed(1));

    saveJSON(STATS_FILE, stats);
}

// ============================================================
// 조회 함수들
// ============================================================

/** 활성 예측 목록 조회 */
function getActivePredictions(codeFilter = null) {
    const files = fs.readdirSync(ACTIVE_DIR).filter(f => f.endsWith('.json'));
    return files.map(f => loadJSON(path.join(ACTIVE_DIR, f), null))
        .filter(p => p && (!codeFilter || p.code === codeFilter))
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

/** 평가된 예측 목록 (최근 N건) */
function getEvaluatedPredictions(limit = 50, codeFilter = null) {
    const files = fs.readdirSync(EVALUATED_DIR).filter(f => f.endsWith('.json')).sort().reverse();
    const results = [];
    for (const f of files) {
        if (results.length >= limit) break;
        const p = loadJSON(path.join(EVALUATED_DIR, f), null);
        if (p && (!codeFilter || p.code === codeFilter)) results.push(p);
    }
    return results;
}

/** 통계 조회 */
function getStats() {
    // scores 배열은 API 응답에서 제외 (요약만)
    const clean = JSON.parse(JSON.stringify(stats));
    delete clean.total.scores;
    for (const k of Object.keys(clean.byStock)) delete clean.byStock[k].scores;
    for (const k of Object.keys(clean.bySource)) delete clean.bySource[k].scores;
    for (const k of Object.keys(clean.byTimeframe)) delete clean.byTimeframe[k].scores;

    // 정확률 추가
    if (clean.total.evaluated > 0) {
        clean.total.accuracy = parseFloat((clean.total.correct / clean.total.evaluated * 100).toFixed(1));
    }
    for (const [k, v] of Object.entries(clean.byStock)) {
        if (v.evaluated > 0) v.accuracy = parseFloat((v.correct / v.evaluated * 100).toFixed(1));
    }
    for (const [k, v] of Object.entries(clean.bySource)) {
        if (v.evaluated > 0) v.accuracy = parseFloat((v.correct / v.evaluated * 100).toFixed(1));
    }
    for (const [k, v] of Object.entries(clean.byTimeframe)) {
        if (v.evaluated > 0) v.accuracy = parseFloat((v.correct / v.evaluated * 100).toFixed(1));
    }

    return clean;
}

/** 오래된 evaluated 파일 정리 (90일) */
function cleanOldEvaluated() {
    try {
        const files = fs.readdirSync(EVALUATED_DIR).filter(f => f.endsWith('.json')).sort();
        if (files.length > 500) {
            const toDelete = files.slice(0, files.length - 500);
            for (const f of toDelete) {
                fs.unlinkSync(path.join(EVALUATED_DIR, f));
            }
            console.log(`[예측] 오래된 평가 데이터 ${toDelete.length}건 삭제`);
        }
    } catch (e) { /* skip */ }
}

// ============================================================
// Exports
// ============================================================
module.exports = {
    createPrediction,
    evaluateDuePredictions,
    getActivePredictions,
    getEvaluatedPredictions,
    getStats,
    cleanOldEvaluated,
    PRED_DIR,
    ACTIVE_DIR,
    EVALUATED_DIR
};
