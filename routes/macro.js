const express = require('express');
const macro = require('../crawlers/macro');
const { loadJSON } = require('../utils/file-io');
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

// 해외 시세 — DC 기반 저장 데이터 반환 (Yahoo 크롤링 제거)
router.get('/macro/quote', (req, res) => {
    const overseas = loadJSON('overseas.json', { latest: null });
    res.json({ ok: true, data: overseas.latest, cached: true });
});

module.exports = router;
