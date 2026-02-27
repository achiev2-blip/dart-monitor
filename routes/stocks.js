const express = require('express');
const gemini = require('../services/gemini');
const hantoo = require('../crawlers/hantoo');
const companyData = require('../utils/company-data');
const router = express.Router();

// 시장 지수 (KOSPI/KOSDAQ) + 투자자별 순매수 — 캐시된 데이터 반환
router.get('/market-index', (req, res) => {
    const idx = hantoo.getIndexPrices();
    const inv = hantoo.getMarketInvestor();
    res.json({
        ok: true,
        kospi: idx.kospi || { price: 0, change: 0, changePct: 0, volume: 0 },
        kosdaq: idx.kosdaq || { price: 0, change: 0, changePct: 0, volume: 0 },
        investor: inv || null
    });
});

// 전 종목 현재가 + MA + 투자자동향 (워치리스트 API)
router.get('/stocks', (req, res) => {
    const watchlist = hantoo.getWatchlist();
    const result = watchlist.map(s => {
        // 기술적 분석 데이터 (MA + 외국인 + 지지/저항)
        const analysis = hantoo.getStockAnalysis(s.code);
        const c = analysis?.current || {};
        return {
            name: s.name,
            code: s.code,
            ...c,
            // MA 이동평균선
            ma5: analysis?.ma5 || null,
            ma20: analysis?.ma20 || null,
            ma60: analysis?.ma60 || null,
            ma200: analysis?.ma200 || null,
        };
    }).filter(s => s.code);
    res.json(result);
});

// 워치리스트 (stocks.html용 alias) — ⚠️ /stocks/:code 위에 배치 필수 (라우트 순서)
router.get('/stocks/watchlist', (req, res) => {
    res.json(hantoo.getWatchlist());
});

// 기업 주가 (현재가 + 일봉) — ⚠️ /stocks/company 먼저, :code 와일드카드는 마지막
router.get('/stocks/company/:code/price', (req, res) => {
    try {
        const data = companyData.getPrice(req.params.code);
        res.json(data);
    } catch (e) {
        res.json({ current: null, daily: [] });
    }
});

// 기업 레이어 (AI분석, 뉴스, 리포트, 공시, 메모)
router.get('/stocks/company/:code/layers', (req, res) => {
    try {
        const data = companyData.getLayers(req.params.code);
        res.json(data);
    } catch (e) {
        res.json({});
    }
});

// 특정 종목 상세 (현재가 + 일봉) — ⚠️ 와일드카드 라우트: 고정 경로(/stocks/watchlist, /stocks/company 등) 아래 배치
router.get('/stocks/:code', (req, res) => {
    const prices = hantoo.getStockPrices();
    const data = prices[req.params.code];
    if (!data) return res.status(404).json({ error: '종목 없음' });
    res.json(data);
});

// 수동 새로고침
router.post('/stocks/refresh', async (req, res) => {
    try {
        await hantoo.fetchAllStocks();
        res.json({ ok: true, count: hantoo.getWatchlist().length });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 일봉 수동 수집
router.post('/stocks/daily', async (req, res) => {
    try {
        await hantoo.fetchAllDailyPrices();
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});


// 기업 메모 저장
router.post('/stocks/company/:code/memo', (req, res) => {
    try {
        const { notes, tags } = req.body;
        companyData.updateLayer(req.params.code, '메모', {
            notes: notes || '',
            tags: tags || [],
            updatedAt: new Date().toISOString()
        });
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 워치리스트 CRUD
router.post('/watchlist', async (req, res) => {
    const { name, code } = req.body;
    if (!name) return res.status(400).json({ error: '종목명 필수' });
    try {
        const result = await hantoo.addStock(name, code);
        res.json(result);
    } catch (e) {
        console.error(`[워치리스트] 추가 실패: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

router.delete('/watchlist', (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: '종목명 필수' });
    res.json(hantoo.removeStock(name));
});

// ─── 컨센서스 조회 (네이버 금융 실시간 크롤링) ───
const consensus = require('../crawlers/consensus');

router.get('/consensus/:code', async (req, res) => {
    const { code } = req.params;
    if (!code || !/^\d{6}$/.test(code)) {
        return res.status(400).json({ ok: false, msg: '6자리 종목코드 필수' });
    }
    try {
        const data = await consensus.fetchConsensus(code);
        if (!data) {
            return res.json({ ok: false, msg: '접근불가 — 컨센서스 데이터를 가져올 수 없습니다' });
        }
        res.json({ ok: true, code, consensus: data });
    } catch (e) {
        console.error(`[컨센서스 API] ${code} 오류:`, e.message);
        res.json({ ok: false, msg: '접근불가 — ' + e.message });
    }
});

// 종목명/코드로 실시간 조회 (관심종목 외 종목도 가능)
// ⚡ 유저 우선순위: 백그라운드 수집(fetchAllStocks)보다 우선 실행
router.post('/lookup', async (req, res) => {
    const { query } = req.body;
    if (!query || !query.trim()) return res.status(400).json({ ok: false, msg: '검색어 필수' });

    const q = query.trim();

    // 유저 우선순위 획득 → 백그라운드 수집 일시정지
    hantoo.acquireUserPriority();
    try {
        // 1. 코드인지 이름인지 판별 (6자리 숫자 = 코드)
        const isCode = /^\d{6}$/.test(q);
        let code = isCode ? q : null;
        let name = isCode ? null : q;

        // 2. 이름이면 lookupStockCode로 코드 조회
        if (!code) {
            code = await hantoo.lookupStockCode(q);
            if (!code) return res.json({ ok: false, msg: `'${q}' 종목을 찾을 수 없습니다` });
        }

        let price, daily, investors;
        const exists = companyData.companyExists(code);

        if (exists) {
            // ─── 기존 기업: 저장된 데이터 활용, 현재가+수급만 새로 수집 ───
            const existing = companyData.getPrice(code);
            const hasDaily = existing && existing.daily && existing.daily.length > 0;

            // 일봉이 있으면 2개만 병렬, 없으면 3개 병렬
            const tasks = [
                hantoo.fetchCurrentPrice(code),
                hantoo.fetchInvestorWeekly(code)
            ];
            if (!hasDaily) tasks.push(hantoo.fetchDailyPrice(code, 30));

            const results = await Promise.all(tasks);
            price = results[0];
            investors = results[1];
            daily = hasDaily ? existing.daily : (results[2] || null);
            if (!name && existing && existing.current) name = existing.current.name;
        } else {
            // ─── 신규 기업: 전부 병렬 수집 (일봉 저장 안 함) ───
            const [freshPrice, freshDaily, freshInvestors] = await Promise.all([
                hantoo.fetchCurrentPrice(code),
                hantoo.fetchDailyPrice(code, 30),
                hantoo.fetchInvestorWeekly(code)
            ]);
            price = freshPrice;
            daily = freshDaily;
            investors = freshInvestors;
        }

        if (price && !name) name = price.name || code;

        // 현재가 저장 (기존과 동일)
        if (price) {
            companyData.saveCurrentPrice(code, name || code, price);
        }

        // 응답 조립 (기존 /api/companies/:code 형식 + 확장 필드)
        const info = companyData.getInfo(code) || { name: name || code, code };
        const priceData = companyData.getPrice(code) || {};
        // 일봉이 priceData에 없으면 수집한 것을 추가 (저장은 안 함)
        if (daily && (!priceData.daily || priceData.daily.length === 0)) {
            priceData.daily = daily;
        }
        const reports = companyData.getReports(code) || [];
        const layers = companyData.getLayers(code) || {};

        res.json({
            ok: true, code, name: name || code,
            data: { code, info, price: priceData, reports, layers },
            investors: investors || []
        });
    } catch (e) {
        console.error(`[Lookup] 조회 실패 (${q}):`, e.message);
        res.status(500).json({ ok: false, msg: '조회 중 오류: ' + e.message });
    } finally {
        // 유저 우선순위 해제 → 백그라운드 수집 재개
        hantoo.releaseUserPriority();
    }
});

router.get('/watchlist', (req, res) => {
    res.json(hantoo.getWatchlist());
});

// 주가 급변동 알림
router.get('/price-alerts', (req, res) => {
    const priceAlerts = req.app.locals.priceAlerts;
    const since = parseInt(req.query.since) || 0;
    const alerts = since ? priceAlerts.filter(a => a.id > since) : priceAlerts.slice(0, 20);
    res.json({ alerts });
});

// 전 종목 요약 목록
router.get('/companies', (req, res) => {
    const companies = companyData.listAllCompanies();
    const result = companies.map(c => {
        const price = companyData.getPrice(c.code);
        return {
            code: c.code,
            name: c.name,
            price: price.current?.price || null,
            change: price.current?.change || null,
            updatedAt: price.updatedAt || null
        };
    });
    res.json({ items: result, total: result.length });
});

// 기업별 전체 레이어
router.get('/companies/:code', (req, res) => {
    const { code } = req.params;
    if (!companyData.companyExists(code)) {
        return res.status(404).json({ error: '기업 데이터 없음' });
    }
    const layers = companyData.getLayers(code);
    const info = companyData.getInfo(code);
    const price = companyData.getPrice(code);
    const reports = companyData.getReports(code);
    res.json({ code, info, price, reports, layers });
});

// 급등락 원인 분석
router.post('/analyze-spike', async (req, res) => {
    const { code, name, changePercent } = req.body;
    if (!code || !name) return res.status(400).json({ error: 'code, name 필수' });

    const storedNews = req.app.locals.storedNews;
    const reportStores = req.app.locals.reportStores;

    try {
        const relatedNews = storedNews
            .filter(n => n.title && n.title.includes(name))
            .slice(0, 10)
            .map(n => `- ${n.title} (${n.source || ''})`)
            .join('\n');

        const allRpts = Object.values(reportStores).flat();
        const relatedReports = allRpts
            .filter(r => r.corp && r.corp.includes(name))
            .slice(0, 5)
            .map(r => `- [${r.broker}] ${r.title} (목표가:${r.targetPrice || '없음'}, 의견:${r.opinion || '없음'})`)
            .join('\n');

        const priceData = companyData.getPrice(code);
        const recentPrices = (priceData.daily || []).slice(-5)
            .map(d => `${d.date}: ${d.close || d.price}원`)
            .join(', ');

        const direction = changePercent > 0 ? '급등' : '급락';
        const prompt = `한국 주식시장 분석 전문가로서 ${name}(${code})의 ${direction} 원인을 분석해주세요.

변동폭: ${changePercent > 0 ? '+' : ''}${changePercent}%
최근 가격: ${recentPrices || '데이터 없음'}

관련 뉴스:
${relatedNews || '최근 관련 뉴스 없음'}

증권사 리포트:
${relatedReports || '최근 리포트 없음'}

다음 형식으로 답변:
원인: (핵심 원인 1-2줄)
전망: (향후 전망 1줄)
관련종목: (동반 영향 가능한 종목)
신뢰도: 상/중/하`;

        const text = await gemini.callGeminiDirect(prompt);
        if (!text) return res.status(503).json({ error: 'Gemini 응답 없음 (쿨다운 중일 수 있음)' });

        const analysis = gemini.parseSpikeAnalysis(text);
        analysis.changePercent = changePercent;
        analysis.analyzedAt = new Date().toISOString();

        companyData.updateAiLayer(code, `[${direction}분석] ${analysis.cause}`, analysis.cls || 'normal');

        res.json({ ok: true, analysis });
    } catch (e) {
        console.error(`[급등락분석] ${name} 실패: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
