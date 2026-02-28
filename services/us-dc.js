/**
 * US 시장 전용 DC — overseas 데이터 독립 관리
 * 
 * 역할:
 *  1. overseas.json 파일에서 데이터 읽기/쓰기
 *  2. dc.overseas에 독립 기록 (5분마다)
 *  3. getOverseasData() — US 시장 데이터 제공
 *  4. saveOverseasData(data) — 외부에서 데이터 저장
 * 
 * 이전: context.js overseas 라우트 + updateClaudeSummary L1030
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');

// ── 경로 ──
const DATA_DIR = path.join(__dirname, '..', 'data');
const OVERSEAS_FILE = path.join(DATA_DIR, 'overseas.json');

// ── 상태 ──
let _app = null;
let lastUpdatedAt = null;

// ── 유틸리티 ──

/** JSON 파일 로드 (실패 시 기본값) */
function loadJSON(fallback) {
    try {
        return JSON.parse(fs.readFileSync(OVERSEAS_FILE, 'utf-8'));
    } catch (e) {
        return fallback;
    }
}

/** JSON 파일 저장 */
function saveJSON(data) {
    fs.writeFileSync(OVERSEAS_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

// ════════════════════════════════════════════════
// DC overseas 관리
// ════════════════════════════════════════════════

/** DC의 overseas 섹션 갱신 */
function updateOverseas() {
    if (!_app) return;

    if (!_app.locals.claudeDataCenter) {
        _app.locals.claudeDataCenter = { ok: true, news: [], reports: [], disclosures: [], _meta: {} };
    }
    const dc = _app.locals.claudeDataCenter;

    try {
        const data = loadJSON({ latest: null });
        dc.overseas = data.latest || null;
        lastUpdatedAt = new Date().toISOString();
    } catch (e) {
        console.warn(`[us-dc/DC] 갱신 실패: ${e.message}`);
    }
}

// ════════════════════════════════════════════════
// 외부 인터페이스
// ════════════════════════════════════════════════

/** US 시장 데이터 반환 (latest + history) */
function getOverseasData() {
    return loadJSON({ latest: null, history: [] });
}

/** US 시장 데이터 저장 (POST에서 호출) */
function saveOverseasData(data) {
    const existing = loadJSON({ history: [] });
    existing.latest = data;
    existing.history.unshift({ ...data, savedAt: new Date().toISOString() });
    if (existing.history.length > 30) existing.history.length = 30;
    saveJSON(existing);
    console.log(`[us-dc] 데이터 저장 완료 (${data.date || 'no-date'})`);

    // DC 즉시 갱신
    updateOverseas();
}

// ════════════════════════════════════════════════
// 초기화
// ════════════════════════════════════════════════

/** us-dc 초기화 */
function init(app) {
    _app = app;

    console.log('[us-dc] 초기화 시작');

    // DC 갱신 (15초 후 첫 실행, 이후 5분마다)
    setTimeout(() => updateOverseas(), 15000);
    setInterval(() => updateOverseas(), 300000);

    console.log('[us-dc] 초기화 완료');
}

/** 상태 조회 */
function getStatus() {
    return { lastUpdatedAt };
}

module.exports = { init, getOverseasData, saveOverseasData, getStatus, updateOverseas };
