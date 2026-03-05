const express = require('express');
const router = express.Router();

// GET /news — 조건1: 오늘 뉴스 + 역산 100건 (DC에서 즉시)
//              조건1+code: 기업명 제목 검색 → relatedNews 추가
//              조건2: ?range=500 → 최신→이전 역산 500건 (storedNews에서)
//              조건3: ?company=삼성전자 → 섹터 파일에서 100일치
router.get('/news', (req, res) => {
    const storedNews = req.app.locals.storedNews;
    const { range, company, code } = req.query;

    // 조건3: 기업별 요청 → 섹터 파일에서 100일치
    if (company) {
        const newsDC = require('../services/news-dc');
        const sector = newsDC.getSectorByCompany(company);
        if (!sector) {
            return res.json({ ok: true, items: [], total: 0, msg: `'${company}' 섹터 매핑 없음` });
        }
        const sectorNews = newsDC.getNewsBySector(sector);
        // 해당 기업명이 제목에 포함된 것만 필터
        const filtered = sectorNews.filter(n => (n.title || '').includes(company));
        return res.json({ ok: true, items: filtered, total: filtered.length, company, sector });
    }

    // 조건2: range 파라미터 → 최신에서 역산 (최대 500건)
    if (range) {
        const limit = Math.min(parseInt(range) || 100, 500);
        return res.json({ ok: true, items: storedNews.slice(0, limit), total: storedNews.length });
    }

    // 조건1: DC에서 뉴스 (limit 파라미터 지원, 기본 50건)
    const dc = req.app.locals.claudeDataCenter;
    const dcNews = dc?.news || [];
    const limit = parseInt(req.query.limit) || 50;
    const limited = dcNews.slice(0, limit);

    const result = { ok: true, items: limited, total: dcNews.length, showing: limited.length };

    // 조건1 + code: 기업코드로 관련 뉴스 추가
    if (code) {
        const hantoo = require('../crawlers/hantoo');
        const watchlist = hantoo.getWatchlist();
        const stock = watchlist.find(s => s.code === code);
        if (stock) {
            result.relatedNews = dcNews.filter(n => (n.title || '').includes(stock.name));
            result.companyName = stock.name;
        }
    }

    res.json(result);
});

// AI 분류된 뉴스 현황
router.get('/news/classified', (req, res) => {
    const storedNews = req.app.locals.storedNews;
    const classified = storedNews.filter(n => n.aiClassified);
    const byCategory = {};
    const byImportance = { '상': 0, '중': 0, '하': 0 };

    for (const n of classified) {
        const cat = n.aiCategory || '기타';
        if (!byCategory[cat]) byCategory[cat] = [];
        byCategory[cat].push({
            title: n.title, link: n.link, cls: n.aiCls,
            importance: n.aiImportance, stocks: n.aiStocks,
            summary: n.aiSummary, source: n.source, pubDate: n.pubDate
        });
        if (n.aiImportance) byImportance[n.aiImportance] = (byImportance[n.aiImportance] || 0) + 1;
    }

    res.json({ total: classified.length, unclassified: storedNews.length - classified.length, byCategory, byImportance });
});

// 저장된 뉴스 전체
router.get('/stored-news', (req, res) => {
    const storedNews = req.app.locals.storedNews;
    res.json({ items: storedNews, total: storedNews.length });
});

module.exports = router;
