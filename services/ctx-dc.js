/**
 * CTX 전용 DC — 종목별 컨텍스트 데이터 독립 관리 (형식만 — 향후 구현)
 * 
 * 역할 (향후):
 *  1. 종목별 투자 컨텍스트 (시나리오, 메모, 관심사항) 관리
 *  2. dc.ctx에 독립 기록
 *  3. 챗봇/프론트엔드에서 종목 컨텍스트 조회
 * 
 * TODO: 실제 데이터 소스 연결 + 라우트 연결
 */

// ── 상태 ──
let _app = null;
let lastUpdatedAt = null;

// ════════════════════════════════════════════════
// DC ctx 관리 (향후 구현)
// ════════════════════════════════════════════════

/** DC의 ctx 섹션 갱신 */
function updateCtx() {
    if (!_app) return;
    // TODO: 컨텍스트 데이터 갱신 로직
    lastUpdatedAt = new Date().toISOString();
}

// ════════════════════════════════════════════════
// 외부 인터페이스
// ════════════════════════════════════════════════

/** 종목별 컨텍스트 반환 */
function getCtxData(code) {
    // TODO: 종목별 컨텍스트 반환
    return { code, ctx: null };
}

/** 컨텍스트 저장 */
function saveCtxData(code, data) {
    // TODO: 컨텍스트 저장
    console.log(`[ctx-dc] 저장 예정: ${code}`);
}

// ════════════════════════════════════════════════
// 초기화
// ════════════════════════════════════════════════

/** ctx-dc 초기화 */
function init(app) {
    _app = app;
    console.log('[ctx-dc] 초기화 완료 (형식만 — 향후 구현)');
}

/** 상태 조회 */
function getStatus() {
    return { lastUpdatedAt, status: 'skeleton' };
}

module.exports = { init, getCtxData, saveCtxData, getStatus, updateCtx };
