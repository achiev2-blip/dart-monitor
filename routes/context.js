const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const config = require('../config');
const { saveJSON, loadJSON } = require('../utils/file-io');
const gemini = require('../services/gemini');
const { fetchConsensus } = require('../crawlers/consensus');  // 컨센서스 크롤러 (독립 모듈)
const companyData = require('../utils/company-data');
const hantoo = require('../crawlers/hantoo');
const macro = require('../crawlers/macro');         // 매크로 지표 (getCurrent, getMarketImpactSummary)
const prediction = require('../utils/prediction'); // 예측 통계 (getStats)
const router = express.Router();

const DATA_DIR = config.DATA_DIR;
const DART_API_KEY = config.DART_API_KEY;

// ============================================================
// 컨텍스트 디렉토리 설정
// ============================================================
const CONTEXT_DIR = path.join(DATA_DIR, 'context');
const CONTEXT_STOCKS_DIR = path.join(CONTEXT_DIR, 'stocks');
[CONTEXT_DIR, CONTEXT_STOCKS_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ============================================================
// 컨텍스트 유틸리티 함수
// ============================================================
// 컨텍스트 파일 로드 (market.json, commands.json 등)
// @param file - 파일명 (예: 'market.json')
// @returns 파싱된 JSON 객체 또는 null
function loadContext(file) {
    const fp = path.join(CONTEXT_DIR, file);
    if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf-8'));
    return null;
}

// 컨텍스트 파일 저장
function saveContext(file, data) {
    fs.writeFileSync(path.join(CONTEXT_DIR, file), JSON.stringify(data, null, 2), 'utf-8');
}

// 개별 종목 컨텍스트 로드 — companies/{code}/context.json
// @param code - 종목코드 (예: '005930')
// @returns 종목 컨텍스트 객체 또는 null
function loadStockContext(code) {
    const fp = path.join(companyData.getCompanyDir(code), 'context.json');
    if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf-8'));
    return null;
}

// 개별 종목 컨텍스트 저장 — 디렉토리 자동 생성
function saveStockContext(code, data) {
    const dir = companyData.getCompanyDir(code);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'context.json'), JSON.stringify(data, null, 2), 'utf-8');
}

// 전체 종목 컨텍스트 요약 목록 (GET /context 용)
// companies/ 디렉토리를 순회하여 context.json이 있는 종목만 요약 정보 반환
// @returns [{code, name, pinned, lastDate, price, change}, ...]
function getAllStockContextsSummary() {
    const companiesDir = path.join(DATA_DIR, 'companies');
    if (!fs.existsSync(companiesDir)) return [];
    return fs.readdirSync(companiesDir).filter(code => {
        return fs.existsSync(path.join(companiesDir, code, 'context.json'));
    }).map(code => {
        try {
            const d = JSON.parse(fs.readFileSync(path.join(companiesDir, code, 'context.json'), 'utf-8'));
            return { code: d.code || code, name: d.name, pinned: d.pinned, lastDate: d.lastDate, price: d.price, change: d.change };
        } catch (e) { return null; }
    }).filter(Boolean);
}

// 전체 종목 컨텍스트 풀데이터 (GET /claude 전체모드 용)
// companies/ 디렉토리를 순회하여 context.json 전체 내용 반환
// @returns [전체 context.json 객체, ...]
function getAllStockContextsFull() {
    const companiesDir = path.join(DATA_DIR, 'companies');
    if (!fs.existsSync(companiesDir)) return [];
    return fs.readdirSync(companiesDir).filter(code => {
        return fs.existsSync(path.join(companiesDir, code, 'context.json'));
    }).map(code => {
        try { return JSON.parse(fs.readFileSync(path.join(companiesDir, code, 'context.json'), 'utf-8')); } catch (e) { return null; }
    }).filter(Boolean);
}

// ============================================================
// KST 날짜 유틸리티
// ============================================================
function getKSTDate(offset = 0) {
    const d = new Date(Date.now() + 9 * 3600000 + offset * 86400000);
    return d.toISOString().slice(0, 10);
}

// ============================================================
// 해외 시장 데이터 API
// ============================================================
router.post('/overseas', (req, res) => {
    try {
        const data = req.body;
        const existing = loadJSON('overseas.json', { history: [] });
        existing.latest = data;
        existing.history.unshift({ ...data, savedAt: new Date().toISOString() });
        if (existing.history.length > 30) existing.history.length = 30;
        saveJSON('overseas.json', existing);
        console.log(`[해외시장] 데이터 저장 완료 (${data.date})`);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

router.get('/overseas', (req, res) => {
    res.json(loadJSON('overseas.json', { latest: null, history: [] }));
});

// ============================================================
// 아카이브 조회/실행 API
// ============================================================
router.get('/context/archive', (req, res) => {
    const archive = req.app.locals.archive;
    const status = archive.getArchiveStatus();
    const result = { status, daily: [], weekly: [], monthly: [], quarterly: [], yearly: [], events: [] };

    const dirs = {
        daily: path.join(archive.ARCHIVE_DIR, 'daily'),
        weekly: path.join(archive.ARCHIVE_DIR, 'weekly'),
        monthly: path.join(archive.ARCHIVE_DIR, 'monthly'),
        quarterly: path.join(archive.ARCHIVE_DIR, 'quarterly'),
        yearly: path.join(archive.ARCHIVE_DIR, 'yearly'),
        events: path.join(archive.ARCHIVE_DIR, 'events')
    };

    for (const [key, dir] of Object.entries(dirs)) {
        if (fs.existsSync(dir)) {
            result[key] = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().reverse().map(f => {
                try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')); } catch (e) { return null; }
            }).filter(Boolean);
        }
    }

    res.json(result);
});

// 섹터별 데이터
router.get('/context/sectors', (req, res) => {
    const archive = req.app.locals.archive;
    const sectorsDir = archive.SECTORS_DIR;
    if (!fs.existsSync(sectorsDir)) return res.json({ sectors: [] });

    const sectors = fs.readdirSync(sectorsDir)
        .filter(f => f.endsWith('.json'))
        .map(f => {
            try { return JSON.parse(fs.readFileSync(path.join(sectorsDir, f), 'utf-8')); } catch (e) { return null; }
        })
        .filter(Boolean);

    res.json({ sectors, total: sectors.length });
});

// 변곡점 이벤트 저장
router.post('/context/events', (req, res) => {
    const archive = req.app.locals.archive;
    try {
        const event = archive.saveEvent(req.body);
        res.json({ ok: true, event });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 수동 아카이브 실행
router.post('/context/archive/run', (req, res) => {
    const { archive, getCollectedDataForArchive } = req.app.locals;
    try {
        archive.runArchiveCycle(getCollectedDataForArchive, hantoo.getWatchlist(), companyData);
        res.json({ ok: true, status: archive.getArchiveStatus() });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ============================================================
// 뉴스 다이제스트 API
// ============================================================
router.get('/context/news-digest', (req, res) => {
    res.json(loadContext('news_digest.json') || { latest: null, history: [] });
});

router.post('/context/news-digest', (req, res) => {
    const digest = loadContext('news_digest.json') || { latest: null, history: [] };
    if (digest.latest) {
        digest.history.unshift(digest.latest);
        if (digest.history.length > 14) digest.history = digest.history.slice(0, 14);
    }
    digest.latest = {
        date: req.body.date || getKSTDate(),
        categories: req.body.categories || {},
        summary: req.body.summary || '',
        marketImpact: req.body.marketImpact || '',
        savedAt: new Date().toISOString()
    };
    saveContext('news_digest.json', digest);
    console.log(`[뉴스다이제스트] 업데이트 완료: ${digest.latest.date}`);
    res.json({ ok: true });
});

// ============================================================
// Claude 일괄 업데이트 API
// ============================================================
router.post('/context/claude-update', (req, res) => {
    const { market, stocks, newsDigest, insights } = req.body;
    const results = [];

    if (market) {
        const prev = loadContext('market.json') || {};
        const merged = { ...prev, ...market, keyInsights: market.keyInsights || prev.keyInsights || [] };
        if (prev.lastDate && market.lastDate && prev.lastDate !== market.lastDate) {
            merged.history = merged.history || [];
            merged.history.push({ date: prev.lastDate, note: `KOSPI:${prev.kospi || '-'} ${(prev.keyInsights || []).slice(0, 2).join('; ')}`, auto: true });
            if (merged.history.length > 30) merged.history = merged.history.slice(-30);
        }
        saveContext('market.json', merged);
        results.push('market updated');
    }

    if (stocks && Array.isArray(stocks)) {
        stocks.forEach(s => {
            if (!s.code) return;
            const prev = loadStockContext(s.code) || {};
            const merged = { ...prev, ...s, keyInsights: s.keyInsights || prev.keyInsights || [] };
            if (prev.lastDate && s.lastDate && prev.lastDate !== s.lastDate) {
                merged.history = merged.history || [];
                merged.history.push({ date: prev.lastDate, note: `가격:${prev.price || '-'} ${(prev.keyInsights || []).slice(0, 2).join('; ')}`, auto: true });
                if (merged.history.length > 30) merged.history = merged.history.slice(-30);
            }
            saveStockContext(s.code, merged);
            results.push(`stock ${s.code} updated`);
        });
    }

    if (newsDigest) {
        const digest = loadContext('news_digest.json') || { latest: null, history: [] };
        if (digest.latest) { digest.history.unshift(digest.latest); if (digest.history.length > 14) digest.history = digest.history.slice(0, 14); }
        digest.latest = { ...newsDigest, savedAt: new Date().toISOString() };
        saveContext('news_digest.json', digest);
        results.push('newsDigest updated');
    }

    if (insights && Array.isArray(insights)) {
        const market2 = loadContext('market.json') || {};
        market2.keyInsights = market2.keyInsights || [];
        insights.forEach(i => { if (!market2.keyInsights.includes(i)) market2.keyInsights.push(i); });
        if (market2.keyInsights.length > 10) market2.keyInsights = market2.keyInsights.slice(-10);
        saveContext('market.json', market2);
        results.push(`${insights.length} insights added`);
    }

    console.log(`[Claude Update] ${results.join(', ')}`);
    res.json({ ok: true, results });
});

// ============================================================
// 전체 컨텍스트 요약
// ============================================================
router.get('/context', (req, res) => {
    const market = loadContext('market.json') || { note: '', keyInsights: [], nextAction: '', history: [] };
    const stocks = getAllStockContextsSummary();
    const commands = loadContext('commands.json') || [];
    // commands를 맨 앞에 배치 — Claude가 가장 먼저 읽도록
    res.json({ commands, market, stocks });
});

// Claude POST /context — 일괄 업데이트 (market, stocks, newsDigest, insights 지원)
// claude-update와 동일한 동작이지만, 독립 핸들러로 구현 (coding-rules 준수)
router.post('/context', (req, res) => {
    const { market, stocks, newsDigest, insights } = req.body;
    const results = [];

    // 시장 컨텍스트 업데이트
    if (market) {
        const prev = loadContext('market.json') || {};
        const merged = { ...prev, ...market, keyInsights: market.keyInsights || prev.keyInsights || [] };
        if (prev.lastDate && market.lastDate && prev.lastDate !== market.lastDate) {
            merged.history = merged.history || [];
            merged.history.push({ date: prev.lastDate, note: `KOSPI:${prev.kospi || '-'} ${(prev.keyInsights || []).slice(0, 2).join('; ')}`, auto: true });
            if (merged.history.length > 30) merged.history = merged.history.slice(-30);
        }
        saveContext('market.json', merged);
        results.push('market updated');
    }

    // 종목별 컨텍스트 업데이트
    if (stocks && Array.isArray(stocks)) {
        stocks.forEach(s => {
            if (!s.code) return;
            const prev = loadStockContext(s.code) || {};
            const merged = { ...prev, ...s, keyInsights: s.keyInsights || prev.keyInsights || [] };
            if (prev.lastDate && s.lastDate && prev.lastDate !== s.lastDate) {
                merged.history = merged.history || [];
                merged.history.push({ date: prev.lastDate, note: `가격:${prev.price || '-'} ${(prev.keyInsights || []).slice(0, 2).join('; ')}`, auto: true });
                if (merged.history.length > 30) merged.history = merged.history.slice(-30);
            }
            saveStockContext(s.code, merged);
            results.push(`stock ${s.code} updated`);
        });
    }

    // 뉴스 다이제스트 업데이트
    if (newsDigest) {
        const digest = loadContext('news_digest.json') || { latest: null, history: [] };
        if (digest.latest) { digest.history.unshift(digest.latest); if (digest.history.length > 14) digest.history = digest.history.slice(0, 14); }
        digest.latest = { ...newsDigest, savedAt: new Date().toISOString() };
        saveContext('news_digest.json', digest);
        results.push('newsDigest updated');
    }

    // 인사이트 추가
    if (insights && Array.isArray(insights)) {
        const market2 = loadContext('market.json') || {};
        market2.keyInsights = market2.keyInsights || [];
        insights.forEach(i => { if (!market2.keyInsights.includes(i)) market2.keyInsights.push(i); });
        if (market2.keyInsights.length > 10) market2.keyInsights = market2.keyInsights.slice(-10);
        saveContext('market.json', market2);
        results.push(`${insights.length} insights added`);
    }

    console.log(`[Claude POST /context] ${results.join(', ')}`);
    res.json({ ok: true, results });
});

// Market 컨텍스트
router.get('/context/market', (req, res) => {
    res.json(loadContext('market.json') || { note: '', keyInsights: [], nextAction: '', history: [] });
});

router.put('/context/market', (req, res) => {
    const prev = loadContext('market.json');
    const newData = req.body;
    if (prev && prev.lastDate && prev.lastDate !== newData.lastDate) {
        newData.history = newData.history || [];
        newData.history.push({
            date: prev.lastDate,
            note: `KOSPI:${prev.kospi || '-'} ${(prev.keyInsights || []).slice(0, 2).join('; ')}`,
            auto: true
        });
        if (newData.history.length > 30) newData.history = newData.history.slice(-30);
    }
    saveContext('market.json', newData);
    res.json({ ok: true });
});

// 종목별 컨텍스트
router.get('/context/stock/:code', (req, res) => {
    const data = loadStockContext(req.params.code);
    if (!data) return res.status(404).json({ ok: false, msg: '종목 없음' });
    res.json(data);
});

router.put('/context/stock/:code', (req, res) => {
    const code = req.params.code;
    const prev = loadStockContext(code);
    const newData = req.body;
    if (prev && prev.lastDate && prev.lastDate !== newData.lastDate) {
        newData.history = newData.history || [];
        newData.history.push({
            date: prev.lastDate,
            note: `가격:${prev.price || '-'} 변동:${prev.change || 0}% | ${(prev.keyInsights || []).slice(0, 2).join('; ')}`,
            auto: true
        });
        if (newData.history.length > 30) newData.history = newData.history.slice(-30);
    }
    saveStockContext(code, newData);
    res.json({ ok: true });
});

// 워치리스트 종목 목록 (전체 + 등록여부)
router.get('/context/available-stocks', (req, res) => {
    const watchlist = hantoo.getWatchlist();
    const companiesDir = path.join(DATA_DIR, 'companies');

    // companies/{code}/context.json 존재 여부로 등록 판단
    const all = watchlist.filter(s => s.code).map(s => {
        const ctxPath = path.join(companiesDir, s.code, 'context.json');
        const registered = fs.existsSync(ctxPath);
        return { code: s.code, name: s.name, sector: s.sector, registered };
    });
    const available = all.filter(s => !s.registered);
    const existing = all.filter(s => s.registered).map(s => s.code);
    res.json({ available, existing, all });
});

// 워치리스트에서 종목을 context에 추가
router.post('/context/stock/:code/init', (req, res) => {
    const { code } = req.params;
    const existing = loadStockContext(code);
    if (existing) return res.json({ ok: true, msg: '이미 존재' });

    const watchlist = hantoo.getWatchlist();
    const stock = watchlist.find(s => s.code === code);
    const name = stock ? stock.name : req.body.name || code;

    const init = {
        code, name, pinned: false,
        price: null, change: null, lastDate: new Date().toISOString().slice(0, 10),
        context: '', nextAction: '',
        events: [], scenarios: [], keyInsights: [], history: []
    };
    saveStockContext(code, init);
    console.log(`[Context] 종목 추가: ${name} (${code})`);
    res.json({ ok: true, data: init });
});

// Context Tracker에서 종목 제거 (context.json만 삭제, 기업 데이터는 유지)
router.delete('/context/stock/:code', (req, res) => {
    const { code } = req.params;
    const ctxPath = path.join(companyData.getCompanyDir(code), 'context.json');
    if (fs.existsSync(ctxPath)) {
        fs.unlinkSync(ctxPath);
        console.log(`[Context] 종목 제거: ${code}`);
        return res.json({ ok: true, msg: '제거 완료' });
    }
    res.status(404).json({ ok: false, msg: '종목 없음' });
});

// 인사이트 추가/삭제
router.post('/context/stock/:code/insight', (req, res) => {
    const data = loadStockContext(req.params.code);
    if (!data) return res.status(404).json({ ok: false });
    data.keyInsights = data.keyInsights || [];
    data.keyInsights.push(req.body.text);
    saveStockContext(req.params.code, data);
    res.json({ ok: true });
});

router.delete('/context/stock/:code/insight/:idx', (req, res) => {
    const data = loadStockContext(req.params.code);
    if (!data) return res.status(404).json({ ok: false });
    const idx = parseInt(req.params.idx);
    if (data.keyInsights && idx >= 0 && idx < data.keyInsights.length) {
        data.keyInsights.splice(idx, 1);
        saveStockContext(req.params.code, data);
    }
    res.json({ ok: true });
});

// 클로드 명령어
router.get('/context/commands', (req, res) => {
    res.json(loadContext('commands.json') || []);
});

router.post('/context/commands', (req, res) => {
    const commands = loadContext('commands.json') || [];
    commands.push({
        text: req.body.text,
        createdAt: new Date().toISOString(),
        done: false
    });
    saveContext('commands.json', commands);
    res.json({ ok: true });
});

router.put('/context/commands/:idx', (req, res) => {
    const commands = loadContext('commands.json') || [];
    const idx = parseInt(req.params.idx);
    if (idx >= 0 && idx < commands.length) {
        Object.assign(commands[idx], req.body);
        saveContext('commands.json', commands);
    }
    res.json({ ok: true });
});

router.delete('/context/commands/:idx', (req, res) => {
    const commands = loadContext('commands.json') || [];
    const idx = parseInt(req.params.idx);
    if (idx >= 0 && idx < commands.length) {
        commands.splice(idx, 1);
        saveContext('commands.json', commands);
    }
    res.json({ ok: true });
});

// ============================================================
// Claude 통합 API
// ============================================================
const EXTRA_KEYWORDS = ['HBM', 'TC본더', '반도체', '장비', 'AI', '엔비디아', 'NVIDIA'];

function getPortfolioKeywords(hantoo) {
    const watchlistNames = hantoo.getWatchlist().map(s => s.name);
    return [...watchlistNames, ...EXTRA_KEYWORDS];
}

function filterByPortfolio(items, textFields, hantoo) {
    const keywords = getPortfolioKeywords(hantoo);
    return items.filter(item => {
        const text = textFields.map(f => item[f] || '').join(' ');
        return keywords.some(kw => text.includes(kw));
    });
}

// ============================================================
// Claude 분리 API — 경량 엔드포인트 (e2-micro 안전)
// ============================================================

// 1. 시장 전체 — 뉴스 + 매크로 + 공시 (~50KB)
router.get('/claude/market', async (req, res) => {
    const { storedNews } = req.app.locals;
    try {
        const kst = new Date(Date.now() + 9 * 3600000);
        const yyyymmdd = kst.getUTCFullYear().toString() +
            String(kst.getUTCMonth() + 1).padStart(2, '0') +
            String(kst.getUTCDate()).padStart(2, '0');

        // 포트폴리오 필터링 뉴스
        const recentNews = storedNews.slice(-100).reverse();
        const filteredNews = filterByPortfolio(recentNews, ['title', 'summary', 'corp'], hantoo).slice(0, 10);

        // DART 공시 — DC에서 읽기
        const dc = req.app.locals.claudeDataCenter;
        const disclosures = filterByPortfolio(dc?.disclosures || [], ['corp_name', 'report_nm'], hantoo);

        // 매크로 + 해외 + 컨텍스트
        const overseas = loadJSON('overseas.json', { latest: null });
        const ctxMarket = loadContext('market.json');
        const newsDigestData = loadContext('news_digest.json') || { latest: null };
        const pendingCmds = (loadContext('commands.json') || []).filter(c => !c.done);

        res.json({
            ok: true, mode: 'market',
            timestamp: new Date().toISOString(), date: yyyymmdd,
            commands: pendingCmds,
            news: filteredNews.map(n => ({
                title: n.title, source: n.source, date: n.date,
                cls: n.aiCls || '', importance: n.aiImportance || '',
                summary: n.aiSummary || '', stocks: n.aiStocks || ''
            })),
            disclosures,
            macro: { current: macro.getCurrent(), impact: macro.getMarketImpactSummary() },
            overseas: overseas.latest,
            market: ctxMarket,
            newsDigest: newsDigestData.latest,
            hantooToken: hantoo.getTokenInfo()
        });
        console.log(`[Claude/market] 뉴스:${filteredNews.length} 공시:${disclosures.length}`);
    } catch (e) {
        console.error(`[Claude/market] 오류: ${e.message}`);
        res.status(500).json({ ok: false, error: e.message });
    }
});

// 2. 종목 시세 — 전종목 현재가 + 5일 일봉 (~30KB)
router.get('/claude/stocks', (req, res) => {
    try {
        const watchlist = hantoo.getWatchlist();
        const stockPrices = hantoo.getStockPrices();
        const indexPrices = hantoo.getIndexPrices();

        const stocks = watchlist.map(s => {
            const p = stockPrices[s.code];
            const pd = companyData.getPrice(s.code);
            return {
                code: s.code, name: s.name, sector: s.sector || '',
                price: p?.current?.price || p?.price || null,
                change: p?.current?.change || p?.change || null,
                volume: p?.current?.volume || p?.volume || null,
                afterHours: pd.afterHours || p?.afterHours || null,
                daily: (pd.daily || []).slice(-5)
            };
        });

        res.json({
            ok: true, mode: 'stocks',
            timestamp: new Date().toISOString(),
            index: indexPrices,
            investor: hantoo.getMarketInvestor(),
            stocks,
            hantooToken: hantoo.getTokenInfo()
        });
        console.log(`[Claude/stocks] ${stocks.length}종목`);
    } catch (e) {
        console.error(`[Claude/stocks] 오류: ${e.message}`);
        res.status(500).json({ ok: false, error: e.message });
    }
});

// 3. 리포트 — 최신 20건 축약 (~30KB)
router.get('/claude/reports', (req, res) => {
    const { reportStores } = req.app.locals;
    try {
        const limit = parseInt(req.query.limit) || 20;
        const allReports = [];
        Object.values(reportStores).forEach(items => allReports.push(...items));
        const recentReports = allReports
            .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
            .slice(0, limit)
            .map(r => ({
                title: r.title, broker: r.broker || r.source, date: r.date,
                opinion: r.opinion || '', targetPrice: r.targetPrice || '',
                stock: r.stockName || r.corp || ''
            }));

        res.json({
            ok: true, mode: 'reports',
            timestamp: new Date().toISOString(),
            total: allReports.length,
            reports: recentReports
        });
        console.log(`[Claude/reports] ${recentReports.length}건`);
    } catch (e) {
        console.error(`[Claude/reports] 오류: ${e.message}`);
        res.status(500).json({ ok: false, error: e.message });
    }
});

// 사전 캐시된 요약 반환 — ?full=true 시 전체, 기본은 요약
// Claude 데이터센터 — 단일 엔드포인트 (전체/개별 조회 + 이벤트 읽고 지움)
router.get('/claude/summary', (req, res) => {
    const dc = req.app.locals.claudeDataCenter;
    if (!dc || !dc.ok) {
        return res.json({ ok: false, error: '아직 데이터센터 초기화 전입니다' });
    }

    const section = req.query.section;  // ?section=news/prices/macro/token/overseas/reports
    const code = req.query.code;        // ?code=005930 종목별 필터

    // 개별 섹션 조회
    if (section) {
        const sectionData = dc[section];
        if (sectionData === undefined) {
            return res.json({ ok: false, error: `알 수 없는 섹션: ${section}` });
        }
        // 이벤트 데이터는 읽으면 지움
        if (['news', 'reports'].includes(section)) {
            const result = { ok: true, ai: 'claude', section, data: sectionData, _meta: dc._meta };
            dc[section] = [];  // 읽고 지움
            dc._meta[section + 'Count'] = 0;
            dc._meta.lastReadAt = new Date().toISOString();
            return res.json(result);
        }
        return res.json({ ok: true, ai: 'claude', section, data: sectionData });
    }

    // 종목별 필터
    if (code) {
        const stockData = {
            ok: true, ai: 'claude', code,
            price: (dc.prices || []).find(s => s.code === code) || null,
            news: (dc.news || []).filter(n => (n.stocks || '').includes(code) || (n.title || '').includes(code)),
            reports: (dc.reports || []).filter(r => (r.stock || '').includes(code) || (r.title || '').includes(code)),
            disclosures: (dc.disclosures || []).filter(d => d.corp_code === code || (d.corp_name || '').includes(code))
        };
        return res.json(stockData);
    }

    // 전체 조회 — 이벤트 데이터 읽고 지움
    const response = JSON.parse(JSON.stringify(dc));  // 딥 카피
    dc.news = [];          // 읽고 지움
    dc.reports = [];       // 읽고 지움
    // dc.disclosures는 상태 데이터 — 유지
    dc._meta.newsCount = 0;
    dc._meta.reportCount = 0;
    dc._meta.lastReadAt = new Date().toISOString();
    console.log(`[Claude/DC] 전체 읽기 — 이벤트 초기화`);
    res.json(response);
});

router.get('/claude', async (req, res) => {
    const { storedNews, reportStores, archive } = req.app.locals;
    const targetCode = req.query.code || null;  // ?code=005930

    try {
        const now = new Date();
        const kst = new Date(now.getTime() + 9 * 3600000);
        const yyyymmdd = kst.getUTCFullYear().toString() +
            String(kst.getUTCMonth() + 1).padStart(2, '0') +
            String(kst.getUTCDate()).padStart(2, '0');

        const watchlist = hantoo.getWatchlist();
        const stockPrices = hantoo.getStockPrices();

        // =============================================
        // 종목 지정 모드: ?code=005930
        // =============================================
        if (targetCode) {
            const targetStock = watchlist.find(s => s.code === targetCode);
            const targetName = targetStock?.name || targetCode;
            const targetSector = targetStock?.sector || '';

            // 1. 대상 종목 상세
            const priceData = companyData.getPrice(targetCode);
            const layersData = companyData.getLayers(targetCode);
            const p = stockPrices[targetCode];
            const ctxData = loadStockContext(targetCode);

            const target = {
                code: targetCode,
                name: targetName,
                sector: targetSector,
                // 현재가
                price: p?.current?.price || p?.price || null,
                change: p?.current?.change || p?.change || null,
                volume: p?.current?.volume || p?.volume || null,
                high: p?.current?.high || null,
                low: p?.current?.low || null,
                open: p?.current?.open || null,
                per: p?.current?.per || null,
                pbr: p?.current?.pbr || null,
                marketCap: p?.current?.marketCap || null,
                // 시간외
                afterHours: priceData.afterHours || p?.afterHours || null,
                // 일봉 전체
                daily: priceData.daily || [],
                // 기업별 뉴스 (layers.json)
                news: (layersData.뉴스 || []).slice(-20).map(n => ({
                    title: n.title, cls: n.cls, category: n.category,
                    date: n.date, summary: n.summary || '', importance: n.importance || ''
                })),
                // 기업별 리포트
                reports: (layersData.리포트 || []).concat(companyData.getReports(targetCode) || []).slice(-15).map(r => ({
                    title: r.title, broker: r.broker || r.source, date: r.date,
                    opinion: r.opinion || '', targetPrice: r.targetPrice || ''
                })),
                // AI 분석
                aiSummary: layersData.AI분석?.latestSummary || '',
                sentiment: layersData.AI분석?.sentiment || '',
                // 인트라데이 원본 (당일 5분 틱)
                todayIntraday: companyData.getTodayIntraday(targetCode),
                // 컨텍스트 (히스토리 포함)
                context: ctxData || null
            };

            // 컨센서스 실시간 조회 (유/무 판단)
            try {
                const consensus = await fetchConsensus(targetCode);
                target.consensus = consensus || null;  // null = 컨센서스 없음
            } catch (e) {
                target.consensus = null;
                console.warn(`[Claude API] 컨센서스 조회 실패: ${e.message}`);
            }

            // 2. 종목별 DART 공시 — DC에서 필터
            const dcData = req.app.locals.claudeDataCenter;
            const stockDisclosures = (dcData?.disclosures || []).filter(d =>
                d.corp_name === targetName || d.corp_name?.includes(targetName) || targetName.includes(d.corp_name)
            );

            // 3. storedNews에서도 해당 종목 뉴스 검색 (layers에 없을 수 있는 최신 뉴스)
            const recentStockNews = storedNews.filter(n => {
                const text = [n.title, n.summary, n.corp, n.aiStocks].filter(Boolean).join(' ');
                return text.includes(targetName);
            }).slice(-10).map(n => ({
                title: n.title, source: n.source, date: n.date,
                cls: n.aiCls || '', importance: n.aiImportance || '',
                summary: n.aiSummary || ''
            }));

            // 4. 같은 섹터 연관 종목
            let sectorPeers = null;
            if (targetSector) {
                const peers = watchlist.filter(s => s.sector === targetSector && s.code !== targetCode);
                const peerPrices = peers.map(s => {
                    const pp = stockPrices[s.code];
                    const pd = companyData.getPrice(s.code);
                    return {
                        code: s.code,
                        name: s.name,
                        price: pp?.current?.price || pp?.price || null,
                        change: pp?.current?.change || pp?.change || null,
                        afterHours: pd.afterHours || pp?.afterHours || null
                    };
                });

                // 섹터 종목들의 뉴스
                const sectorNames = peers.map(s => s.name);
                const sectorNews = storedNews.filter(n => {
                    const text = [n.title, n.summary, n.corp, n.aiStocks].filter(Boolean).join(' ');
                    return sectorNames.some(name => text.includes(name));
                }).slice(-10).map(n => ({
                    title: n.title, source: n.source, date: n.date,
                    relatedStock: sectorNames.find(name => [n.title, n.summary, n.corp].join(' ').includes(name)) || '',
                    cls: n.aiCls || ''
                }));

                sectorPeers = {
                    sector: targetSector,
                    stocks: peerPrices,
                    sectorNews
                };
            }

            // 5. 매크로/해외 (공통)
            const overseas = loadJSON('overseas.json', { latest: null });

            const pendingCommands = (loadContext('commands.json') || []).filter(c => !c.done);
            const response = {
                _instructions: '⚠️ 최우선 지침: 1) 아래 commands 배열을 먼저 확인하고 미완료 명령을 처리할 것. 2) 종목 분석 시 target.consensus가 있으면 컨센서스 데이터(투자의견/목표주가) 참고, null이면 컨센서스 없음. 3) 작업 완료 후 POST /api/context/claude-update로 결과 저장.',
                commands: pendingCommands,
                ok: true,
                mode: 'stock-detail',
                timestamp: new Date().toISOString(),
                date: yyyymmdd,
                target,
                disclosures: stockDisclosures,
                recentNews: recentStockNews,
                sectorPeers,
                context: {
                    market: loadContext('market.json')
                },
                overseas: overseas.latest,
                macro: {
                    current: macro.getCurrent(),
                    impact: macro.getMarketImpactSummary()
                }
            };

            console.log(`[Claude API] 종목 상세: ${targetName}(${targetCode}) — 뉴스:${target.news.length}건 리포트:${target.reports.length}건 섹터:${sectorPeers?.stocks?.length || 0}종목`);
            return res.json(response);
        }

        // =============================================
        // 전체 모드 (기존): ?code 없이 호출
        // =============================================

        // 1. 오늘 DART 공시 — DC에서 읽기
        const dcFull = req.app.locals.claudeDataCenter;
        const filteredDisclosures = filterByPortfolio(dcFull?.disclosures || [], ['corp_name', 'report_nm'], hantoo);

        // 2. 저장된 뉴스 최근 20건
        const recentNews = storedNews.slice(-100).reverse();
        const filteredNews = filterByPortfolio(recentNews, ['title', 'summary', 'corp'], hantoo).slice(0, 20);

        // 3. 저장된 리포트 최근 20건 — 필드 축약 (토큰 절약)
        const allReports = [];
        Object.values(reportStores).forEach(items => allReports.push(...items));
        const recentReports = allReports
            .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
            .slice(0, 20)
            .map(r => ({ title: r.title, broker: r.broker || r.source, date: r.date, opinion: r.opinion || '', targetPrice: r.targetPrice || '' }));

        // 4. 컨텍스트 데이터
        const ctxMarket = loadContext('market.json');
        const ctxCommands = loadContext('commands.json') || [];
        const ctxStocks = getAllStockContextsFull();

        // 5. 해외 시장
        const overseas = loadJSON('overseas.json', { latest: null });

        // 6. 아카이브 요약
        const weeklyDir = path.join(archive.ARCHIVE_DIR, 'weekly');
        const monthlyDir = path.join(archive.ARCHIVE_DIR, 'monthly');
        const quarterlyDir = path.join(archive.ARCHIVE_DIR, 'quarterly');
        const archiveWeekly = fs.existsSync(weeklyDir) ? fs.readdirSync(weeklyDir).filter(f => f.endsWith('.json')).sort().reverse().slice(0, 2).map(f => {
            try { return JSON.parse(fs.readFileSync(path.join(weeklyDir, f), 'utf-8')); } catch (e) { return null; }
        }).filter(Boolean) : [];
        const archiveMonthly = fs.existsSync(monthlyDir) ? fs.readdirSync(monthlyDir).filter(f => f.endsWith('.json')).sort().reverse().slice(0, 1).map(f => {
            try { return JSON.parse(fs.readFileSync(path.join(monthlyDir, f), 'utf-8')); } catch (e) { return null; }
        }).filter(Boolean) : [];
        const archiveQuarterly = fs.existsSync(quarterlyDir) ? fs.readdirSync(quarterlyDir).filter(f => f.endsWith('.json')).sort().reverse().slice(0, 1).map(f => {
            try { return JSON.parse(fs.readFileSync(path.join(quarterlyDir, f), 'utf-8')); } catch (e) { return null; }
        }).filter(Boolean) : [];

        // 7. 뉴스 다이제스트
        const newsDigestData = loadContext('news_digest.json') || { latest: null };

        // D1: 한투 실시간 주가 (afterHours 포함)
        const realtimePrices = watchlist.map(s => {
            const p = stockPrices[s.code];
            const pd = companyData.getPrice(s.code);
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

        // D2: 카테고리별 뉴스
        const newsCategories = {};
        filteredNews.forEach(n => {
            const cat = n.aiCategory || '미분류';
            if (!newsCategories[cat]) newsCategories[cat] = [];
            newsCategories[cat].push({
                title: n.title,
                source: n.source,
                cls: n.aiCls || 'normal',
                importance: n.aiImportance || '중',
                stocks: n.aiStocks || '',
                summary: n.aiSummary || '',
                link: n.link
            });
        });

        // D3: 종목별 일봉 + 리포트
        const stocksDetail = {};
        watchlist.forEach(s => {
            try {
                const priceData = companyData.getPrice(s.code);
                const layersData = companyData.getLayers(s.code);
                stocksDetail[s.code] = {
                    name: s.name,
                    daily: (priceData.daily || []).slice(-5),  // 5일 일봉 (토큰 절약)
                    afterHours: priceData.afterHours || null,
                    recentReportsCount: (layersData.리포트 || []).length,
                    recentNews: (layersData.뉴스 || []).slice(-5).map(n => ({
                        title: n.title, cls: n.cls, category: n.category, date: n.date
                    })),
                    aiSummary: layersData.AI분석?.latestSummary || '',
                    sentiment: layersData.AI분석?.sentiment || '',
                    // 당일 인트라데이 틱 수
                    intradayCount: companyData.getTodayIntraday(s.code).length
                };
            } catch (e) { }
        });

        // 응답
        const pendingCmds = ctxCommands.filter(c => !c.done);
        res.json({
            _instructions: '⚠️ 최우선 지침: 1) 아래 commands 배열을 먼저 확인하고 미완료 명령을 처리할 것. 2) 종목별 컨센서스 조회가 필요하면 GET /api/consensus/:code 호출. 3) 작업 완료 후 POST /api/context/claude-update로 결과 저장.',
            commands: pendingCmds,
            ok: true,
            mode: 'overview',
            timestamp: new Date().toISOString(),
            date: yyyymmdd,
            summary: {
                totalDisclosures: dcFull?.disclosures?.length || 0,
                portfolioDisclosures: filteredDisclosures.length,
                totalNews: storedNews.length,
                filteredNews: filteredNews.length,
                totalReports: allReports.length,
                watchlistCount: watchlist.length
            },
            disclosures: filteredDisclosures,
            news: newsCategories,
            newsFlat: filteredNews.slice(0, 5),  // 10→5건 (토큰 절약)
            reports: recentReports,
            realtimePrices,
            stocksDetail,
            context: {
                market: ctxMarket
                // stocks는 stocksDetail에 포함 — 중복 제거
            },
            overseas: overseas.latest,
            archive: { weekly: archiveWeekly, monthly: archiveMonthly, quarterly: archiveQuarterly },
            newsDigest: newsDigestData.latest,
            macro: {
                current: macro.getCurrent(),
                impact: macro.getMarketImpactSummary(),
                dataStatus: macro.getCurrent()?.dataStatus || 'unknown'
            },
            predictionStats: prediction.getStats(),
            // 발급된 한투 토큰 정보
            hantooToken: hantoo.getTokenInfo()
        });

        console.log(`[Claude API] 전체 요약 — 공시:${filteredDisclosures.length}건 뉴스:${filteredNews.length}건 리포트:${recentReports.length}건`);

    } catch (e) {
        console.error(`[Claude API] 오류: ${e.message}`);
        res.status(500).json({ ok: false, error: e.message });
    }
});
// (서브라우트 제거됨 — /claude/summary 데이터센터에서 ?section 파라미터로 개별 조회 지원)


// ============================================================
// Claude 데이터센터 — 사전 수집 + 이벤트 누적 + 상태 갱신
// ============================================================

// 뉴스/리포트/공시 누적 캡 (메모리 보호)
const DC_NEWS_CAP = 100;
const DC_REPORT_CAP = 50;
const DC_DISCLOSURE_CAP = 100;

// 데이터센터 갱신 (1분마다 호출) — 이벤트는 누적, 상태는 덮어쓰기
function updateClaudeSummary(app) {
    try {
        const { storedNews, reportStores } = app.locals;
        const watchlist = hantoo.getWatchlist();
        const stockPrices = hantoo.getStockPrices();
        const indexPrices = hantoo.getIndexPrices();

        // 기존 데이터센터 (없으면 초기화)
        if (!app.locals.claudeDataCenter) {
            app.locals.claudeDataCenter = { ok: true, news: [], reports: [], disclosures: [], _meta: {} };
        }
        const dc = app.locals.claudeDataCenter;

        // ── 상태 데이터: 최신값 덮어쓰기 (지우지 않음) ──
        dc.ok = true;
        dc.mode = 'datacenter';
        dc.timestamp = new Date().toISOString();
        dc.index = indexPrices;
        dc.investor = hantoo.getMarketInvestor();

        // 현재가 (상태)
        dc.prices = watchlist.map(s => {
            const p = stockPrices[s.code];
            const pd = companyData.getPrice(s.code);
            return {
                code: s.code, name: s.name, sector: s.sector || '',
                price: p?.current?.price || p?.price || null,
                change: p?.current?.change || p?.change || null,
                changePct: p?.changePct || null,
                volume: p?.current?.volume || p?.volume || null,
                afterHours: pd?.afterHours || p?.afterHours || null
            };
        });

        // 매크로 (상태 + 히스토리)
        // 챗봇 엔드테이블 완성 시 ai-space.js:776의 직접 읽기 제거 가능 (방식A)
        dc.macro = {
            current: macro.getCurrent(),              // 실시간 16개 항목
            impact: macro.getMarketImpactSummary(),    // 시장 영향 분석
            history: loadJSON(path.join(macro.MACRO_DIR, 'history.json'), [])  // 일별 히스토리 (365일 FIFO)
        };

        // 토큰 (상태)
        dc.token = hantoo.getTokenInfo();

        // 해외 (상태)
        dc.overseas = loadJSON('overseas.json', { latest: null })?.latest || null;

        // ── 이벤트 데이터: 새로운 것만 누적 (캡 적용) ──
        const prevNewsIds = new Set((dc.news || []).map(n => n.title + n.date));
        const newNews = (storedNews || []).filter(n => {
            const id = (n.title || '') + (n.date || n.pubDate || '');
            return !prevNewsIds.has(id);
        }).map(n => ({
            title: n.title, source: n.source, date: n.date || n.pubDate || '',
            cls: n.aiCls || '', importance: n.aiImportance || '',
            summary: n.aiSummary || '', stocks: n.aiStocks || '',
            category: n.aiCategory || '', link: n.link || ''
        }));
        if (newNews.length > 0) {
            dc.news = [...(dc.news || []), ...newNews].slice(-DC_NEWS_CAP);
        }

        const prevReportIds = new Set((dc.reports || []).map(r => r.title + r.date));
        const allReports = [];
        if (reportStores) Object.values(reportStores).forEach(items => allReports.push(...items));
        const newReports = allReports.filter(r => {
            const id = (r.title || '') + (r.date || '');
            return !prevReportIds.has(id);
        }).map(r => ({
            title: r.title, broker: r.broker || r.source,
            date: r.date, opinion: r.opinion || '',
            stock: r.stockName || r.corp || ''
        }));
        if (newReports.length > 0) {
            dc.reports = [...(dc.reports || []), ...newReports]
                .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
                .slice(0, DC_REPORT_CAP);
        }

        // ── 공시 데이터: 오늘 전부 + 최소 20건 유지 (이전 날짜 폴백) ──
        const kstNow = new Date(new Date().getTime() + 9 * 3600000);
        const yyyymmdd = kstNow.getUTCFullYear().toString() +
            String(kstNow.getUTCMonth() + 1).padStart(2, '0') +
            String(kstNow.getUTCDate()).padStart(2, '0');
        const dartDir = path.join(config.DATA_DIR);
        const MIN_DISCLOSURES = 30;
        try {
            // 모든 dart 파일을 날짜 역순으로 정렬
            const allDartFiles = fs.readdirSync(dartDir)
                .filter(f => f.startsWith('dart_') && f.endsWith('.json'))
                .sort().reverse();  // 최신 날짜부터

            let allDisclosures = [];
            let todayCount = 0;

            for (const f of allDartFiles) {
                try {
                    const data = JSON.parse(fs.readFileSync(path.join(dartDir, f), 'utf-8'));
                    if (data.list && Array.isArray(data.list)) {
                        const isToday = f.startsWith(`dart_${yyyymmdd}`);
                        if (isToday) {
                            // 오늘 공시: 전부 추가
                            allDisclosures.push(...data.list);
                            todayCount += data.list.length;
                        } else if (allDisclosures.length < MIN_DISCLOSURES) {
                            // 이전 날짜: 20건 채울 때까지만
                            const need = MIN_DISCLOSURES - allDisclosures.length;
                            allDisclosures.push(...data.list.slice(0, need));
                        }
                    }
                } catch (e) { /* 손상된 파일 무시 */ }
                // 오늘 다 읽고 20건 이상이면 중단
                if (allDisclosures.length >= MIN_DISCLOSURES && todayCount > 0) break;
            }

            // 중복 제거 (rcept_no 기준) + 캡 적용
            const seen = new Set();
            dc.disclosures = allDisclosures
                .filter(d => {
                    if (!d.rcept_no || seen.has(d.rcept_no)) return false;
                    seen.add(d.rcept_no);
                    return true;
                })
                .slice(0, DC_DISCLOSURE_CAP)
                .map(d => ({
                    rcept_no: d.rcept_no,
                    corp_name: d.corp_name || '',
                    corp_code: d.corp_code || '',
                    report_nm: d.report_nm || '',
                    rcept_dt: d.rcept_dt || '',
                    flr_nm: d.flr_nm || '',
                    rm: d.rm || '',
                    _aiCls: d._aiCls || '',
                    _aiSummary: d._aiSummary || ''
                }));
        } catch (e) {
            console.warn(`[Claude/DC] dart 파일 읽기 실패: ${e.message}`);
        }

        // 메타 정보
        dc._meta = {
            stockCount: dc.prices.length,
            newsCount: (dc.news || []).length,
            reportCount: (dc.reports || []).length,
            disclosureCount: (dc.disclosures || []).length,
            disclosureDate: yyyymmdd,
            updatedAt: dc.timestamp,
            lastReadAt: dc._meta?.lastReadAt || null
        };

        // 하위 호환: claudeSummary도 동일 참조
        app.locals.claudeSummary = dc;

        // ── 서머리 파일 생성 (DC→서머리 구조) ──
        // DC에 모인 데이터에서 요약을 추출하여 hantoo_summary.json 저장
        // Claude 진입점: 서머리(개요) → 부족하면 DC(상세)
        try {
            const macroData = dc.macro?.current || {};
            const summary = {
                updatedAt: dc.timestamp,
                // 지수
                index: dc.index || null,
                // 투자자 동향
                investor: dc.investor || null,
                // 전체 종목 가격 요약
                stocks: (dc.prices || []).map(s => ({
                    name: s.name, code: s.code, sector: s.sector || '',
                    price: s.price, change: s.change, changePct: s.changePct || null,
                    volume: s.volume
                })),
                stockCount: (dc.prices || []).length,
                // 매크로 16개 요약 (getCurrent() 중첩 구조에 맞춤)
                macro: {
                    sp500: macroData.indices?.sp500?.price || null,
                    nasdaq: macroData.indices?.nasdaq?.price || null,
                    dxy: macroData.indices?.dxy?.price || null,
                    sox: macroData.sox?.price || null,
                    us10y: macroData.us10y?.price || null,
                    vix: macroData.vix?.price || null,
                    nvda: macroData.aiSemi?.nvda?.price || null,
                    amd: macroData.aiSemi?.amd?.price || null,
                    mu: macroData.aiSemi?.mu?.price || null,
                    avgo: macroData.aiSemi?.avgo?.price || null,
                    lrcx: macroData.semiEquip?.lrcx?.price || null,
                    klac: macroData.semiEquip?.klac?.price || null,
                    arm: macroData.aiTheme?.arm?.price || null,
                    smci: macroData.aiTheme?.smci?.price || null,
                    usdkrw: macroData.usdkrw?.price || null,
                    gold: macroData.gold?.price || null
                },
                // 공시 (최신 날짜 전부 + 30건 미만이면 이전 날짜 보충)
                disclosures: (dc.disclosures || []).map(d => ({
                    corp_name: d.corp_name, report_nm: d.report_nm,
                    rcept_dt: d.rcept_dt, _aiCls: d._aiCls || '', _aiSummary: d._aiSummary || ''
                }))
            };
            saveJSON('hantoo_summary.json', summary);
        } catch (e) {
            console.warn(`[Claude/DC] 서머리 파일 생성 실패: ${e.message}`);
        }

        const sizeKB = Math.round(JSON.stringify(dc).length / 1024);
        console.log(`[Claude/DC] 갱신: ${dc.prices.length}종목 ${(dc.news || []).length}뉴스 ${(dc.reports || []).length}리포트 ${(dc.disclosures || []).length}공시 (${sizeKB}KB)`);
    } catch (e) {
        console.error(`[Claude/DC] 갱신 실패: ${e.message}`);
        console.error(`[Claude/DC] 스택:`, e.stack);
    }
}


// Export context helpers for telegram route
module.exports = { router, loadContext, loadStockContext, saveContext, saveStockContext, getKSTDate, getAllStockContextsSummary, getAllStockContextsFull, updateClaudeSummary };
