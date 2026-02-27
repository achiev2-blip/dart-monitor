const express = require('express');
const fs = require('fs');
const path = require('path');
const { saveJSON, loadJSON } = require('../utils/file-io');
const config = require('../config');
const router = express.Router();

const DATA_DIR = config.DATA_DIR;

// crawlers/reports 함수들은 init에서 주입
let reportFns = {};

function init(fns) {
    reportFns = fns;
}

// 리포트 조회 (AI 분석 결과 병합)
router.get('/reports', (req, res) => {
    const { reportStores, reportAiCache } = req.app.locals;
    const { filterNaverDuplicates } = reportFns;

    const all = [];
    Object.values(reportStores).forEach(items => all.push(...items));

    const filtered = filterNaverDuplicates(all);

    for (const item of filtered) {
        const cacheKey = `${item.corp}|${item.title}|${item.date}`;
        if (reportAiCache[cacheKey]) {
            item.aiResult = reportAiCache[cacheKey];
        }
    }

    filtered.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

    const stats = {};
    Object.entries(reportStores).forEach(([k, v]) => { stats[k] = v.length; });
    const naverRemoved = all.length - filtered.length;
    stats['네이버중복제거'] = naverRemoved;

    res.json({ items: filtered, total: filtered.length, stats });
});

// 리포트 디버그
router.get('/reports/debug', async (req, res) => {
    const { reportStores } = req.app.locals;
    const { REPORT_SOURCES, fetchReportPage, fetchHyundaiWithPuppeteer, getSmartInterval } = reportFns;
    const puppeteer = req.app.locals.puppeteer;
    const CHROME_PATH = req.app.locals.CHROME_PATH;
    const hyundaiBrowser = reportFns.getHyundaiBrowser ? reportFns.getHyundaiBrowser() : null;

    try {
        const debugResults = {
            puppeteer: {
                available: !!puppeteer,
                chromePath: CHROME_PATH || '미발견',
                browserConnected: hyundaiBrowser ? hyundaiBrowser.isConnected() : false
            }
        };
        for (const src of REPORT_SOURCES) {
            debugResults[src.key] = { stored: reportStores[src.key].length, interval: Math.round(getSmartInterval(src.key) / 1000) + 's (동적)', urls: [] };
            for (const urlObj of src.urls) {
                try {
                    let items;
                    if (src.key === '현대차증권') {
                        items = await fetchHyundaiWithPuppeteer(urlObj.url);
                    } else {
                        items = await fetchReportPage(urlObj);
                    }
                    debugResults[src.key].urls.push({
                        url: urlObj.url,
                        fetched: items.length,
                        sample: items.slice(0, 3).map(i => ({
                            corp: i.corp, broker: i.broker,
                            opinion: i.opinion || '(없음)',
                            targetPrice: i.targetPrice || 0,
                            title: (i.title || '').substring(0, 60),
                            date: i.date,
                            category: i.category || ''
                        }))
                    });
                } catch (e) {
                    debugResults[src.key].urls.push({ url: urlObj.url, error: e.message });
                }
            }
        }
        res.json({ sources: debugResults, timestamp: new Date().toISOString() });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 현대차증권 HTML 덤프 (디버그용)
router.get('/reports/debug/hyundai-html', (req, res) => {
    const debugPath = path.join(DATA_DIR, 'debug_hyundai_rendered.html');
    try {
        if (fs.existsSync(debugPath)) {
            const html = fs.readFileSync(debugPath, 'utf-8');
            res.type('html').send(html);
        } else {
            res.status(404).json({ error: '아직 현대차증권 HTML 덤프가 없습니다. /api/reports/debug 먼저 호출하세요.' });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 수동 새로고침
router.post('/reports/refresh', async (req, res) => {
    const { REPORT_SOURCES, fetchSourceReports } = reportFns;
    const source = req.body && req.body.source;
    const src = REPORT_SOURCES.find(s => s.key === source);
    if (!src) {
        const results = {};
        for (const s of REPORT_SOURCES) {
            try { results[s.key] = await fetchSourceReports(s); }
            catch (e) { results[s.key] = { error: e.message }; }
        }
        return res.json({ ok: true, results });
    }
    try {
        const result = await fetchSourceReports(src);
        res.json({ ok: true, ...result });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 저장된 리포트 전체
router.get('/stored-reports', (req, res) => {
    const { reportStores } = req.app.locals;
    const { filterNaverDuplicates } = reportFns;
    const all = [];
    Object.values(reportStores).forEach(items => all.push(...items));
    const filtered = filterNaverDuplicates(all);
    filtered.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    res.json({ items: filtered, total: filtered.length });
});

// 캐시 초기화
router.post('/reports/clear', (req, res) => {
    const { reportStores } = req.app.locals;
    let reportCache = req.app.locals.reportCache;
    const source = req.body && req.body.source;
    if (source && reportStores[source]) {
        reportStores[source].length = 0;
        const fileMap = {
            'WiseReport': 'reports_wisereport.json',
            '미래에셋': 'reports_mirae.json',
            '하나증권': 'reports_hana.json',
            '현대차증권': 'reports_hyundai.json',
            '네이버': 'reports_naver.json'
        };
        const fname = fileMap[source] || 'reports_unknown.json';
        saveJSON(fname, []);
        console.log(`[리포트] ${source} 캐시 초기화`);
        res.json({ ok: true, message: `${source} 리포트 캐시 초기화됨` });
    } else {
        Object.keys(reportStores).forEach(k => { reportStores[k].length = 0; });
        // reportCache 초기화
        Object.keys(reportCache).forEach(k => delete reportCache[k]);
        saveJSON('reports_wisereport.json', []);
        saveJSON('reports_mirae.json', []);
        saveJSON('reports_hana.json', []);
        saveJSON('reports_hyundai.json', []);
        saveJSON('reports_naver.json', []);
        saveJSON('report_cache.json', {});
        console.log('[리포트] 전체 캐시 초기화');
        res.json({ ok: true, message: '전체 리포트 캐시 초기화됨' });
    }
});

module.exports = { router, init };
