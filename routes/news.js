const express = require('express');
const { NEWS_FETCHERS, isStockRelevant } = require('../crawlers/news');
const { saveJSON } = require('../utils/file-io');
const gemini = require('../services/gemini');
const hantoo = require('../crawlers/hantoo');
const router = express.Router();

router.get('/news', async (req, res) => {
    const storedNews = req.app.locals.storedNews;

    try {
        const results = await Promise.allSettled(
            NEWS_FETCHERS.map(f => f.fn())
        );

        let allItems = [];
        const perSource = {};
        let errors = 0;
        let domesticFresh = 0;
        let filtered = 0;
        results.forEach((r, i) => {
            const name = NEWS_FETCHERS[i].name;
            if (r.status === 'fulfilled') {
                allItems = allItems.concat(r.value);
                perSource[name] = r.value.length;
                if (['매경', '연합뉴스', '한경', 'Google국내'].includes(name)) {
                    domesticFresh += r.value.length;
                }
            } else {
                errors++;
                perSource[name] = `에러: ${r.reason?.message || '알수없음'}`;
                console.error(`[뉴스] ${name} 실패: ${r.reason?.message || '알수없음'}`);
            }
        });

        // 주식/경제 관련성 필터링
        const relevant = [];
        for (const item of allItems) {
            if (isStockRelevant(item.title)) {
                relevant.push(item);
            } else {
                filtered++;
            }
        }

        // 중복 제거 (link 기준)
        const seen = new Set();
        const unique = [];
        for (const item of relevant) {
            if (!seen.has(item.link)) {
                seen.add(item.link);
                unique.push(item);
            }
        }

        // 국내뉴스가 0건이면 storedNews에서 보충 (최대 100건)
        if (domesticFresh === 0 && storedNews.length > 0) {
            let supplemented = 0;
            for (const item of storedNews) {
                if (item.type !== 'foreign' && !seen.has(item.link)) {
                    seen.add(item.link);
                    unique.push(item);
                    supplemented++;
                    if (supplemented >= 100) break;
                }
            }
            if (supplemented > 0) {
                perSource['저장분보충'] = supplemented;
                console.log(`[뉴스] 국내RSS 전부 실패 → storedNews에서 ${supplemented}건 보충`);
            }
        }

        // 저장 (최대 200건 — cleanOldData와 동일 기준)
        const existingLinks = new Set(storedNews.map(n => n.link));
        let added = 0;
        for (const item of unique) {
            if (!existingLinks.has(item.link)) {
                storedNews.unshift(item);
                added++;
            }
        }
        if (storedNews.length > 200) {
            // 200건 캡 — 배열 참조 유지를 위해 splice 사용
            storedNews.splice(200);
        }
        if (added > 0) saveJSON('news.json', storedNews);

        console.log(`[뉴스] 응답: ${unique.length}건 (국내fresh:${domesticFresh} 필터제거:${filtered} 에러:${errors} 신규:${added})`);
        res.json({ items: unique, total: unique.length, errors, added, filtered, perSource });

        // 신규 뉴스가 있으면 Gemini 자동분류 트리거
        if (added > 0) {
            const unclassified = storedNews.filter(n => !n.aiClassified).slice(0, 20);
            if (unclassified.length > 0) {
                gemini.classifyNewsBatch(unclassified, () => hantoo.getWatchlist()).catch(e =>
                    console.error(`[뉴스AI] 자동분류 실패: ${e.message}`)
                );
            }
        }
    } catch (e) {
        console.error(`[News] ${e.message}`);
        res.json({ items: storedNews.slice(0, 100), total: storedNews.length, errors: 1, cached: true });
    }
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
