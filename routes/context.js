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

        // DART 공시
        let disclosures = [];
        try {
            const dartRes = await axios.get('https://opendart.fss.or.kr/api/list.json', {
                params: { crtfc_key: DART_API_KEY, bgn_de: yyyymmdd, end_de: yyyymmdd, page_count: 100 },
                timeout: 8000
            });
            disclosures = filterByPortfolio(dartRes.data?.list || [], ['corp_name', 'report_nm'], hantoo);
        } catch (e) { console.warn(`[Claude/market] DART 실패: ${e.message}`); }

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
router.get('/claude/summary', (req, res) => {
    const summary = req.app.locals.claudeSummary;
    if (!summary || !summary.ok) {
        return res.json({ ok: false, error: '아직 캐시가 생성되지 않았습니다' });
    }
    // full=true → 전체 뉴스/리포트, 기본 → 요약본
    if (req.query.full === 'true') {
        res.json(summary);
    } else {
        res.json({
            ...summary,
            news: summary.news.slice(0, 10),
            reports: summary.reports.slice(0, 15),
            _meta: {
                ...summary._meta,
                newsShown: Math.min(summary.news.length, 10),
                reportsShown: Math.min(summary.reports.length, 15),
                fullAvailable: true
            }
        });
    }
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

            // 2. 종목별 DART 공시
            let stockDisclosures = [];
            try {
                const dartRes = await axios.get(
                    'https://opendart.fss.or.kr/api/list.json',
                    {
                        params: {
                            crtfc_key: DART_API_KEY,
                            bgn_de: yyyymmdd,
                            end_de: yyyymmdd,
                            page_count: 100
                        }, timeout: 8000
                    }
                );
                const allDisc = dartRes.data?.list || [];
                stockDisclosures = allDisc.filter(d =>
                    d.corp_name === targetName || d.corp_name?.includes(targetName) || targetName.includes(d.corp_name)
                );
            } catch (e) {
                console.warn(`[Claude API] DART 조회 실패: ${e.message}`);
            }

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

        // 1. 오늘 DART 공시
        let disclosures = [];
        try {
            const dartRes = await axios.get(
                'https://opendart.fss.or.kr/api/list.json',
                {
                    params: {
                        crtfc_key: DART_API_KEY,
                        bgn_de: yyyymmdd,
                        end_de: yyyymmdd,
                        page_count: 100
                    }, timeout: 8000
                }
            );
            disclosures = dartRes.data?.list || [];
        } catch (e) {
            console.warn(`[Claude API] DART 조회 실패: ${e.message}`);
        }

        const filteredDisclosures = filterByPortfolio(disclosures, ['corp_name', 'report_nm'], hantoo);

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
                totalDisclosures: disclosures.length,
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
// ============================================================
// Claude 경량 서브라우트 — 개별 데이터 직접 접근 (독립 터널)
// ============================================================

// 뉴스 읽기 — 서버 메모리의 storedNews 접근
router.get('/claude/news', (req, res) => {
    const storedNews = req.app.locals.storedNews || [];
    const limit = parseInt(req.query.limit) || 30;
    // 최신 뉴스 역순 정렬
    const recent = storedNews.slice(-limit).reverse().map(n => ({
        title: n.title,
        source: n.source,
        date: n.date,
        link: n.link,
        cls: n.aiCls || '',
        importance: n.aiImportance || '',
        category: n.aiCategory || '',
        stocks: n.aiStocks || '',
        summary: n.aiSummary || ''
    }));
    const digest = loadContext('news_digest.json') || { latest: null };
    console.log(`[Claude] NEWS 읽기 — ${recent.length}건`);
    res.json({ ok: true, ai: 'claude', news: recent, digest: digest.latest, total: storedNews.length });
});

// 한투 토큰 읽기 — hantoo_token.json 파일 접근
router.get('/claude/token', (req, res) => {
    const tokenData = loadJSON('hantoo_token.json', null);
    console.log('[Claude] TOKEN 읽기');
    res.json({ ok: true, ai: 'claude', token: tokenData });
});

// 현재가 읽기 — 워치리스트 전체 종목 현재가
router.get('/claude/prices', (req, res) => {
    const watchlist = hantoo.getWatchlist();
    const stockPrices = hantoo.getStockPrices();
    const prices = watchlist.map(s => {
        const p = stockPrices[s.code];
        let afterHours = null;
        try { afterHours = companyData?.getPrice(s.code)?.afterHours || p?.afterHours || null; } catch (e) { }
        return {
            code: s.code,
            name: s.name,
            sector: s.sector || '',
            price: p?.current?.price || p?.price || s.price || null,
            change: p?.current?.change || p?.change || null,
            changePct: p?.changePct || null,
            volume: p?.current?.volume || p?.volume || null,
            high: p?.current?.high || null,
            low: p?.current?.low || null,
            open: p?.current?.open || null,
            afterHours
        };
    });
    console.log(`[Claude] PRICES 읽기 — ${prices.length}종목`);
    res.json({ ok: true, ai: 'claude', prices, count: prices.length });
});

// DART 공시 조회 — 오늘 공시 목록
router.get('/claude/dart', async (req, res) => {
    try {
        const now = new Date();
        const kst = new Date(now.getTime() + 9 * 3600000);
        const yyyymmdd = kst.getUTCFullYear().toString() +
            String(kst.getUTCMonth() + 1).padStart(2, '0') +
            String(kst.getUTCDate()).padStart(2, '0');
        const dartRes = await axios.get('https://opendart.fss.or.kr/api/list.json', {
            params: {
                crtfc_key: config.DART_API_KEY,
                bgn_de: req.query.date || yyyymmdd,
                end_de: req.query.date || yyyymmdd,
                page_count: 100
            }, timeout: 8000
        });
        const disclosures = dartRes.data?.list || [];
        // 포트폴리오 관련만 필터링 (선택)
        let filtered = disclosures;
        if (req.query.filter === 'portfolio') {
            const names = hantoo.getWatchlist().map(s => s.name);
            filtered = disclosures.filter(d =>
                names.some(n => d.corp_name === n || d.corp_name?.includes(n) || n.includes(d.corp_name))
            );
        }
        console.log(`[Claude] DART 읽기 — 전체:${disclosures.length}건 필터:${filtered.length}건`);
        res.json({ ok: true, ai: 'claude', disclosures: filtered, total: disclosures.length, date: yyyymmdd });
    } catch (e) {
        console.warn(`[Claude] DART 조회 실패: ${e.message}`);
        res.json({ ok: true, ai: 'claude', disclosures: [], error: e.message });
    }
});

// 매크로 경제 데이터 읽기
router.get('/claude/macro', (req, res) => {
    const overseas = loadJSON('overseas.json', { latest: null });
    const result = {
        current: macro?.getCurrent() || null,
        impact: macro?.getMarketImpactSummary() || null,
        overseas: overseas.latest
    };
    console.log('[Claude] MACRO 읽기');
    res.json({ ok: true, ai: 'claude', macro: result });
});

// 해외 시장 데이터 읽기
router.get('/claude/overseas', (req, res) => {
    const overseas = loadJSON('overseas.json', { latest: null, history: [] });
    console.log('[Claude] OVERSEAS 읽기');
    res.json({ ok: true, ai: 'claude', overseas: overseas.latest, history: (overseas.history || []).slice(0, 5) });
});

// ============================================================
// Claude Summary — 사전 캐시 (메모리 상주, 호출 시 즉시 반환)
// ============================================================

// 메모리 데이터만 읽어서 ~30KB 요약 갱신 (파일 I/O 없음)
function updateClaudeSummary(app) {
    try {
        const { storedNews, reportStores } = app.locals;
        const watchlist = hantoo.getWatchlist();
        const stockPrices = hantoo.getStockPrices();
        const indexPrices = hantoo.getIndexPrices();

        // 종목 시세 요약 (메모리 데이터만)
        const stocks = watchlist.map(s => {
            const p = stockPrices[s.code];
            return {
                code: s.code, name: s.name, sector: s.sector || '',
                price: p?.current?.price || p?.price || null,
                change: p?.current?.change || p?.change || null,
                changePct: p?.changePct || null,
                volume: p?.current?.volume || p?.volume || null
            };
        });

        // 뉴스 전체 (메모리 storedNews에서 — 캐시이므로 전부 저장해도 OK)
        const newsAll = (storedNews || []).map(n => ({
            title: n.title, source: n.source, date: n.date || n.pubDate || '',
            cls: n.aiCls || '', importance: n.aiImportance || '',
            summary: n.aiSummary || '', stocks: n.aiStocks || ''
        }));

        // 리포트 전체 (메모리 reportStores에서)
        const allReports = [];
        if (reportStores) {
            Object.values(reportStores).forEach(items => allReports.push(...items));
        }
        const reportsAll = allReports
            .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
            .map(r => ({
                title: r.title, broker: r.broker || r.source,
                date: r.date, opinion: r.opinion || '',
                stock: r.stockName || r.corp || ''
            }));

        // 캐시 갱신
        app.locals.claudeSummary = {
            ok: true, mode: 'summary',
            timestamp: new Date().toISOString(),
            index: indexPrices,
            investor: hantoo.getMarketInvestor(),
            stocks,
            news: newsAll,
            reports: reportsAll,
            macro: {
                current: macro.getCurrent(),
                impact: macro.getMarketImpactSummary()
            },
            hantooToken: hantoo.getTokenInfo(),
            _meta: {
                stockCount: stocks.length,
                newsCount: newsAll.length,
                reportCount: reportsAll.length
            }
        };

        const sizeKB = Math.round(JSON.stringify(app.locals.claudeSummary).length / 1024);
        console.log(`[Claude/summary] 캐시 갱신: ${stocks.length}종목 ${newsAll.length}뉴스 ${reportsAll.length}리포트 (${sizeKB}KB)`);
    } catch (e) {
        console.error(`[Claude/summary] 갱신 실패: ${e.message}`);
    }
}


// Export context helpers for telegram route
module.exports = { router, loadContext, loadStockContext, saveContext, saveStockContext, getKSTDate, getAllStockContextsSummary, getAllStockContextsFull, updateClaudeSummary };
