/**
 * Claude 전용 DC — stocksDetail + realtimePrices + archive + context 사전 캐시
 * 
 * 역할:
 *  1. stocksDetail — 73종목 × (getPrice + getLayers) 사전 조립 (5분마다)
 *  2. realtimePrices — 73종목 현재가 + afterHours 사전 조립 (5분마다)
 *  3. archive — weekly/monthly/quarterly JSON 사전 로드 (5분마다)
 *  4. contextFiles — market.json, commands.json, news_digest.json 사전 로드 (5분마다)
 * 
 * 목적: /api/claude GET 요청 시 파일 읽기 ~150회 → 0회 (캐시만 반환)
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');

const DATA_DIR = config.DATA_DIR;
const CONTEXT_DIR = path.join(DATA_DIR, 'context');
const ARCHIVE_DIR = path.join(CONTEXT_DIR, 'archive');

// ── 상태 ──
let _app = null;
let lastUpdatedAt = null;

// ── 캐시 ──
let cachedStocksDetail = {};
let cachedRealtimePrices = [];
let cachedArchive = { weekly: [], monthly: [], quarterly: [] };
let cachedContextFiles = { market: null, commands: [], newsDigest: null };

// ════════════════════════════════════════════════
// 1. stocksDetail 사전 조립 — 73종목 × (getPrice + getLayers)
// ════════════════════════════════════════════════

/** 종목별 일봉 + 레이어 데이터 사전 조립 (context.js L891-910 대체) */
function updateStocksDetail() {
    if (!_app) return;

    try {
        const hantoo = _app.locals.hantoo;
        const companyData = _app.locals.companyData;
        if (!hantoo || !companyData) return;

        const watchlist = hantoo.getWatchlist();
        const stockPrices = hantoo.getStockPrices();

        // realtimePrices (context.js L856-872 대체)
        const newRealtimePrices = watchlist.map(s => {
            const p = stockPrices[s.code];
            let pd = {};
            try { pd = companyData.getPrice(s.code); } catch (e) { }
            return {
                code: s.code,
                name: s.name,
                sector: s.sector || '',
                price: p?.current?.price || p?.price || s.price || null,
                change: p?.current?.change || p?.change || null,
                changePct: p?.changePct || null,
                volume: p?.current?.volume || p?.volume || null,
                high: p?.current?.high || p?.high || null,
                low: p?.current?.low || p?.low || null,
                open: p?.current?.open || p?.open || null,
                afterHours: pd.afterHours || p?.afterHours || null
            };
        });

        // stocksDetail (context.js L891-910 대체)
        const newStocksDetail = {};
        watchlist.forEach(s => {
            try {
                const priceData = companyData.getPrice(s.code);
                const layersData = companyData.getLayers(s.code);
                newStocksDetail[s.code] = {
                    name: s.name,
                    daily: (priceData.daily || []).slice(-5),  // 5일 일봉
                    afterHours: priceData.afterHours || null,
                    recentReportsCount: (layersData.리포트 || []).length,
                    recentNews: (layersData.뉴스 || []).slice(-5).map(n => ({
                        title: n.title, cls: n.cls, category: n.category, date: n.date
                    })),
                    aiSummary: layersData.AI분석?.latestSummary || '',
                    sentiment: layersData.AI분석?.sentiment || '',
                    intradayCount: companyData.getTodayIntraday(s.code).length
                };
            } catch (e) { }
        });

        cachedRealtimePrices = newRealtimePrices;
        cachedStocksDetail = newStocksDetail;
        lastUpdatedAt = new Date().toISOString();
        console.log(`[claude-dc] stocksDetail 갱신 — ${Object.keys(newStocksDetail).length}종목`);
    } catch (e) {
        console.error(`[claude-dc] stocksDetail 갱신 실패: ${e.message}`);
    }
}

// ════════════════════════════════════════════════
// 2. archive 사전 로드 — weekly/monthly/quarterly
// ════════════════════════════════════════════════

/** 아카이브 JSON 사전 로드 (context.js L838-850 대체) */
function updateArchive() {
    try {
        const weeklyDir = path.join(ARCHIVE_DIR, 'weekly');
        const monthlyDir = path.join(ARCHIVE_DIR, 'monthly');
        const quarterlyDir = path.join(ARCHIVE_DIR, 'quarterly');

        // 헬퍼: 디렉토리에서 최신 JSON N개 로드
        const loadLatest = (dir, count) => {
            if (!fs.existsSync(dir)) return [];
            return fs.readdirSync(dir)
                .filter(f => f.endsWith('.json'))
                .sort().reverse().slice(0, count)
                .map(f => {
                    try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')); }
                    catch (e) { return null; }
                }).filter(Boolean);
        };

        cachedArchive = {
            weekly: loadLatest(weeklyDir, 2),
            monthly: loadLatest(monthlyDir, 1),
            quarterly: loadLatest(quarterlyDir, 1)
        };
        console.log(`[claude-dc] archive 갱신 — W:${cachedArchive.weekly.length} M:${cachedArchive.monthly.length} Q:${cachedArchive.quarterly.length}`);
    } catch (e) {
        console.error(`[claude-dc] archive 갱신 실패: ${e.message}`);
    }
}

// ════════════════════════════════════════════════
// 3. context 파일 사전 로드 — market, commands, newsDigest
// ════════════════════════════════════════════════

/** JSON 파일 안전 로드 */
function loadContextFile(file) {
    const fp = path.join(CONTEXT_DIR, file);
    try {
        if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf-8'));
    } catch (e) { }
    return null;
}

/** context 파일 사전 로드 (context.js L831-853 대체) */
function updateContextFiles() {
    try {
        cachedContextFiles = {
            market: loadContextFile('market.json'),
            commands: loadContextFile('commands.json') || [],
            newsDigest: (loadContextFile('news_digest.json') || { latest: null }).latest
        };
        console.log(`[claude-dc] context 갱신 — commands:${cachedContextFiles.commands.length}건`);
    } catch (e) {
        console.error(`[claude-dc] context 갱신 실패: ${e.message}`);
    }
}

// ════════════════════════════════════════════════
// 통합 갱신 — 5분마다 호출
// ════════════════════════════════════════════════

/** 전체 캐시 갱신 */
function updateAll() {
    updateStocksDetail();
    updateArchive();
    updateContextFiles();
}

// ════════════════════════════════════════════════
// 외부 인터페이스
// ════════════════════════════════════════════════

/** 캐시된 stocksDetail 반환 */
function getStocksDetail() { return cachedStocksDetail; }

/** 캐시된 realtimePrices 반환 */
function getRealtimePrices() { return cachedRealtimePrices; }

/** 캐시된 archive 반환 */
function getArchive() { return cachedArchive; }

/** 캐시된 context 파일 반환 */
function getContextFiles() { return cachedContextFiles; }

// ════════════════════════════════════════════════
// 초기화
// ════════════════════════════════════════════════

/** claude-dc 초기화 — server.js에서 호출 */
function init(app) {
    _app = app;
    console.log('[claude-dc] 초기화 시작');

    // 20초 후 첫 실행 (다른 DC 모듈 안정화 대기)
    setTimeout(() => updateAll(), 20000);
    // 5분마다 갱신
    setInterval(() => updateAll(), 300000);

    console.log('[claude-dc] 캐시 타이머 시작 (5분)');
    console.log('[claude-dc] 초기화 완료');
}

/** 상태 조회 */
function getStatus() {
    return {
        lastUpdatedAt,
        stocksDetailCount: Object.keys(cachedStocksDetail).length,
        realtimePricesCount: cachedRealtimePrices.length,
        archiveWeekly: cachedArchive.weekly.length,
        archiveMonthly: cachedArchive.monthly.length,
        contextCommands: cachedContextFiles.commands.length
    };
}

module.exports = {
    init,
    getStocksDetail,
    getRealtimePrices,
    getArchive,
    getContextFiles,
    getStatus
};
