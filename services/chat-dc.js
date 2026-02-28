/**
 * 챗봇 전용 DC — Gemini 챗봇 컨텍스트 독립 관리 (형식만 — 향후 구현)
 * 
 * 역할 (향후):
 *  1. 챗봇에 제공할 컨텍스트 데이터 조합
 *  2. dc에서 필요한 섹션만 뽑아 챗봇에 전달
 *  3. 대화 이력 관리
 * 
 * TODO: ai-space.js / gemini 서비스와 연결
 */

// ── 상태 ──
let _app = null;
let lastUpdatedAt = null;

// ════════════════════════════════════════════════
// 챗봇 컨텍스트 관리 (향후 구현)
// ════════════════════════════════════════════════

/** 챗봇 컨텍스트 갱신 */
function updateChatContext() {
    if (!_app) return;
    // TODO: 챗봇에 필요한 DC 데이터 조합
    lastUpdatedAt = new Date().toISOString();
}

// ════════════════════════════════════════════════
// 외부 인터페이스
// ════════════════════════════════════════════════

/** 챗봇 컨텍스트 반환 */
function getChatContext(page) {
    // TODO: 페이지별 맞춤 컨텍스트 반환
    return { page, context: null };
}

// ════════════════════════════════════════════════
// 초기화
// ════════════════════════════════════════════════

/** chat-dc 초기화 */
function init(app) {
    _app = app;
    console.log('[chat-dc] 초기화 완료 (형식만 — 향후 구현)');
}

/** 상태 조회 */
function getStatus() {
    return { lastUpdatedAt, status: 'skeleton' };
}

module.exports = { init, getChatContext, getStatus, updateChatContext };
