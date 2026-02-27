const express = require('express');
const prediction = require('../utils/prediction');
const hantoo = require('../crawlers/hantoo');
const companyData = require('../utils/company-data');  // 현재가 조회용 (getPriceFn)
const router = express.Router();

// 예측 생성
router.post('/predictions', (req, res) => {

    try {
        const result = prediction.createPrediction(req.body);
        res.json({ ok: true, prediction: result });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// 활성 예측 조회
router.get('/predictions', (req, res) => {

    const code = req.query.code || null;
    const active = prediction.getActivePredictions(code);
    res.json({ ok: true, predictions: active, total: active.length });
});

// 평가된 예측 조회
router.get('/predictions/evaluated', (req, res) => {

    const limit = parseInt(req.query.limit) || 50;
    const code = req.query.code || null;
    const evaluated = prediction.getEvaluatedPredictions(limit, code);
    res.json({ ok: true, predictions: evaluated, total: evaluated.length });
});

// 정확도 통계
router.get('/predictions/stats', (req, res) => {

    res.json({ ok: true, stats: prediction.getStats() });
});

// 수동 평가 실행
router.post('/predictions/evaluate', (req, res) => {

    try {
        // 현재가 조회 — companyData.getPrice()로 price.json에서 읽기 (독립 사용)
        const getPriceFn = (code) => {
            const priceData = companyData.getPrice(code);
            return priceData?.current?.price || null;
        };
        const result = prediction.evaluateDuePredictions(getPriceFn);
        res.json({ ok: true, result });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
