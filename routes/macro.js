const express = require('express');
const axios = require('axios');
const macro = require('../crawlers/macro');
const router = express.Router();

// 현재 매크로 데이터 조회
router.get('/macro', (req, res) => {
    const current = macro.getCurrent();
    const impact = macro.getMarketImpactSummary();
    res.json({
        ok: true,
        data: current,
        impact,
        alerts: macro.getAlerts().slice(-10),
        meta: {
            dataStatus: current.dataStatus || 'unknown',
            closingVerified: !!current.closingVerifiedAt,
            updatedAt: current.updatedAt
        }
    });
});

// 매크로 알림 이력
router.get('/macro/alerts', (req, res) => {
    res.json({ alerts: macro.getAlerts(), total: macro.getAlerts().length });
});

// 수동 확정 종가 검증
router.post('/macro/verify', async (req, res) => {
    try {
        const result = await macro.verifyClosingPrices();
        res.json({ ok: true, result });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 수동 매크로 수집
router.post('/macro/fetch', async (req, res) => {
    try {
        const result = await macro.fetchAllMacro();
        res.json({ ok: true, data: result });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ============================================================
// Yahoo Finance 프록시 — 브라우저 CORS 우회
// GET /api/macro/quote?symbols=NVDA,AMD,%5EGSPC
// ============================================================
router.get('/macro/quote', async (req, res) => {
    const symbolsParam = req.query.symbols || '';
    const symbols = symbolsParam.split(',').filter(Boolean).slice(0, 20); // 최대 20개

    if (symbols.length === 0) {
        return res.json({ ok: false, error: 'symbols 파라미터 필요' });
    }

    const results = {};
    const BATCH_SIZE = 3;

    for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
        const batch = symbols.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(async (symbol) => {
            try {
                const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2d`;
                const resp = await axios.get(url, {
                    headers: { 'User-Agent': 'Mozilla/5.0' },
                    timeout: 8000
                });
                const meta = resp.data.chart.result[0].meta;
                const closes = resp.data.chart.result[0].indicators.quote[0].close;
                const prevClose = closes[closes.length - 2] || meta.previousClose;
                const lastClose = meta.regularMarketPrice || closes[closes.length - 1];
                const chgPct = prevClose ? ((lastClose - prevClose) / prevClose * 100) : 0;

                results[symbol] = {
                    price: lastClose,
                    chgPct: parseFloat(chgPct.toFixed(4)),
                    prevClose,
                    timestamp: meta.regularMarketTime,
                    marketState: meta.marketState || 'UNKNOWN'
                };
            } catch (e) {
                results[symbol] = null;
            }
        }));
    }

    // ============================================================
    // VIX 하이브리드 추정: 장마감 시 VIXY 변동률로 예상 VIX 계산
    // ============================================================
    const vixSymbols = symbols.filter(s => decodeURIComponent(s).toUpperCase() === '^VIX' || s.toUpperCase() === '^VIX');
    if (vixSymbols.length > 0) {
        const vixKey = vixSymbols[0];
        const vixData = results[vixKey] || results[decodeURIComponent(vixKey)];

        // VIX가 장중(REGULAR)이 아닐 때 → VIXY ETF로 추정
        if (vixData && vixData.marketState !== 'REGULAR') {
            try {
                const vixyUrl = `https://query1.finance.yahoo.com/v8/finance/chart/VIXY?interval=1d&range=2d`;
                const vixyResp = await axios.get(vixyUrl, {
                    headers: { 'User-Agent': 'Mozilla/5.0' },
                    timeout: 8000
                });
                const vixyMeta = vixyResp.data.chart.result[0].meta;
                const vixyCloses = vixyResp.data.chart.result[0].indicators.quote[0].close;
                const vixyPrev = vixyCloses[vixyCloses.length - 2] || vixyMeta.previousClose;
                const vixyCurrent = vixyMeta.regularMarketPrice || vixyCloses[vixyCloses.length - 1];

                if (vixyPrev && vixyCurrent && vixyPrev > 0) {
                    const vixyChgPct = (vixyCurrent - vixyPrev) / vixyPrev;
                    const estimatedVix = vixData.prevClose * (1 + vixyChgPct);
                    const resolvedKey = results[vixKey] ? vixKey : decodeURIComponent(vixKey);
                    results[resolvedKey] = {
                        ...results[resolvedKey],
                        price: parseFloat(estimatedVix.toFixed(2)),
                        chgPct: parseFloat((vixyChgPct * 100).toFixed(4)),
                        estimated: true,
                        estimateSource: 'VIXY',
                        vixyPrice: vixyCurrent,
                        vixyChgPct: parseFloat((vixyChgPct * 100).toFixed(4)),
                        actualVix: vixData.price  // 원본 VIX 종가 보존
                    };
                }
            } catch (e) {
                // VIXY 조회 실패 시 원본 VIX 유지
            }
        }
    }

    res.json({ ok: true, data: results, fetchedAt: new Date().toISOString() });
});

module.exports = router;

