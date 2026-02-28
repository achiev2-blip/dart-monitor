/**
 * 시세 전용 DC — 가격/지수/수급/매크로 독립 관리
 * 
 * 역할:
 *  1. dc.prices — 워치리스트 현재가
 *  2. dc.index — KOSPI/KOSDAQ 지수
 *  3. dc.investor — 시장 수급
 *  4. dc.macro — 매크로 지표
 *  5. 자체 1분 타이머로 독립 갱신
 * 
 * 이전: context.js updateClaudeSummary L997-1024
 */

const path = require('path');

// ── 상태 ──
let _app = null;
let lastUpdatedAt = null;

// ════════════════════════════════════════════════
// DC 시세 관리
// ════════════════════════════════════════════════

/** DC의 시세 관련 섹션 갱신 */
function updatePrices() {
    if (!_app) return;

    // DC 초기화 보장
    if (!_app.locals.claudeDataCenter) {
        _app.locals.claudeDataCenter = { ok: true, news: [], reports: [], disclosures: [], _meta: {} };
    }
    const dc = _app.locals.claudeDataCenter;

    try {
        const hantoo = _app.locals.hantoo;
        const companyData = _app.locals.companyData;
        const macro = _app.locals.macro;
        if (!hantoo) return;

        const watchlist = hantoo.getWatchlist();
        const stockPrices = hantoo.getStockPrices();

        // 기본 상태
        dc.ok = true;
        dc.mode = 'datacenter';
        dc.timestamp = new Date().toISOString();

        // 지수
        dc.index = hantoo.getIndexPrices();

        // 수급
        dc.investor = hantoo.getMarketInvestor();

        // 현재가
        dc.prices = watchlist.map(s => {
            const p = stockPrices[s.code];
            const pd = companyData ? companyData.getPrice(s.code) : {};
            return {
                code: s.code, name: s.name, sector: s.sector || '',
                price: p?.current?.price || p?.price || null,
                change: p?.current?.change || p?.change || null,
                changePct: p?.changePct || null,
                volume: p?.current?.volume || p?.volume || null,
                afterHours: pd?.afterHours || p?.afterHours || null
            };
        });

        // 매크로
        if (macro) {
            const { loadJSON } = require('../utils/file-io');
            dc.macro = {
                current: macro.getCurrent(),
                impact: macro.getMarketImpactSummary(),
                history: loadJSON(path.join(macro.MACRO_DIR, 'history.json'), [])
            };
        }

        lastUpdatedAt = new Date().toISOString();
    } catch (e) {
        console.warn(`[prices-dc/DC] 갱신 실패: ${e.message}`);
    }
}

// ════════════════════════════════════════════════
// 초기화
// ════════════════════════════════════════════════

/** prices-dc 초기화 */
function init(app) {
    _app = app;
    console.log('[prices-dc] 초기화 시작');

    // 1분마다 갱신 (시세는 빠른 갱신 필요)
    setTimeout(() => updatePrices(), 10000);
    setInterval(() => updatePrices(), 60000);

    console.log('[prices-dc] DC 갱신 타이머 시작 (1분)');
    console.log('[prices-dc] 초기화 완료');
}

/** 상태 조회 */
function getStatus() {
    return {
        lastUpdatedAt,
        priceCount: _app?.locals?.claudeDataCenter?.prices?.length || 0
    };
}

module.exports = { init, getStatus, updatePrices };
