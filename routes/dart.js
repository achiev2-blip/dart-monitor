/**
 * DART 공시 API 라우트 — dart-dc 전용 채널 연결
 * 
 * GET /api/dart?date=YYYYMMDD&page=N
 *  → dart-dc.getDartData(date)에서 데이터 가져옴
 *  → DC 우선, 없으면 파일에서 읽기
 */
const express = require('express');
const router = express.Router();
const dartDC = require('../services/dart-dc');

// GET /api/dart — 공시 조회
router.get('/dart', (req, res) => {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: 'date 필수' });

    // dart-dc에서 데이터 가져오기 (DC → 파일 자동 폴백)
    const result = dartDC.getDartData(date);
    console.log(`[DART] ${date} → ${result._source || 'unknown'} (${result.list?.length || 0}건)`);
    res.json(result);
});

module.exports = router;
