/**
 * 토큰 전용 DC — 한투 인증 토큰 독립 관리
 * 
 * 역할:
 *  1. dc.token — 한투 API 토큰 상태
 *  2. 자체 5분 타이머로 독립 갱신
 * 
 * 이전: context.js updateClaudeSummary L1027
 */

// ── 상태 ──
let _app = null;
let lastUpdatedAt = null;

// ════════════════════════════════════════════════
// DC 토큰 관리
// ════════════════════════════════════════════════

/** DC의 token 섹션 갱신 */
function updateToken() {
    if (!_app) return;

    if (!_app.locals.claudeDataCenter) {
        _app.locals.claudeDataCenter = { ok: true, news: [], reports: [], disclosures: [], _meta: {} };
    }
    const dc = _app.locals.claudeDataCenter;

    try {
        const hantoo = _app.locals.hantoo;
        if (!hantoo) return;

        dc.token = hantoo.getTokenInfo();
        lastUpdatedAt = new Date().toISOString();
    } catch (e) {
        console.warn(`[token-dc/DC] 갱신 실패: ${e.message}`);
    }
}

// ════════════════════════════════════════════════
// 초기화
// ════════════════════════════════════════════════

/** token-dc 초기화 */
function init(app) {
    _app = app;
    console.log('[token-dc] 초기화 시작');

    // 5분마다 갱신
    setTimeout(() => updateToken(), 10000);
    setInterval(() => updateToken(), 300000);

    console.log('[token-dc] 초기화 완료');
}

/** 상태 조회 */
function getStatus() {
    return { lastUpdatedAt };
}

module.exports = { init, getStatus, updateToken };
