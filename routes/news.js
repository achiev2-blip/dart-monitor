const express = require('express');
const router = express.Router();

// GET /news — storedNews 읽기 전용 (수집은 news-dc.js 10분 타이머가 담당)
router.get('/news', (req, res) => {
    const storedNews = req.app.locals.storedNews;
    res.json({ items: storedNews.slice(0, 100), total: storedNews.length, cached: true });
});

// AI 분류된 뉴스 현황
router.get('/news/classified', (req, res) => {
    const storedNews = req.app.locals.storedNews;
    const classified = storedNews.filter(n => n.aiClassified);
    const byCategory = {};
    const byImportance = { '\uc0c1': 0, '\uc911': 0, '\ud558': 0 };

    for (const n of classified) {
        const cat = n.aiCategory || '\uae30\ud0c0';
        if (!byCategory[cat]) byCategory[cat] = [];
        byCategory[cat].push({
            title: n.title,
            link: n.link,
            cls: n.aiCls,
            importance: n.aiImportance,
            stocks: n.aiStocks,
            summary: n.aiSummary,
            source: n.source,
            pubDate: n.pubDate
        });
        if (n.aiImportance) byImportance[n.aiImportance] = (byImportance[n.aiImportance] || 0) + 1;
    }

    res.json({
        total: classified.length,
        unclassified: storedNews.length - classified.length,
        byCategory,
        byImportance
    });
});

// 저장된 뉴스 전체
router.get('/stored-news', (req, res) => {
    const storedNews = req.app.locals.storedNews;
    res.json({ items: storedNews, total: storedNews.length });
});

module.exports = router;
