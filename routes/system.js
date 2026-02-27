const express = require('express');
const gemini = require('../services/gemini');
const config = require('../config');
const router = express.Router();

// 서버 상태
router.get('/status', (req, res) => {
    const { reportStores, storedNews, sentItems } = req.app.locals;
    const reportStats = {};
    Object.entries(reportStores).forEach(([k, v]) => { reportStats[k] = v.length; });
    const totalReports = Object.values(reportStores).reduce((sum, arr) => sum + arr.length, 0);
    res.json({
        uptime: process.uptime(),
        news: storedNews.length,
        reports: totalReports,
        reportsBySource: reportStats,
        sentItems: Object.keys(sentItems).length,
        memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
        isPaused: req.app.locals.isPaused,
        pausedAt: req.app.locals.pausedAt,
        timestamp: new Date().toISOString()
    });
});

// 메모리
router.get('/memory', (req, res) => {
    const mem = process.memoryUsage();
    res.json({
        rss: Math.round(mem.rss / 1024 / 1024) + 'MB',
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024) + 'MB',
        heapTotal: Math.round(mem.heapTotal / 1024 / 1024) + 'MB',
        limit: config.MEMORY_LIMIT_MB + 'MB',
        warningCount: req.app.locals.memoryWarningCount || 0,
        uptime: Math.round(process.uptime() / 60) + '분'
    });
});

// 수동 저장
router.get('/state/save', (req, res) => {
    gemini.saveServerState();
    res.json({
        ok: true,
        state: {
            model: gemini.getCurrentModel()?.label,
            round: gemini.fallbackRound,
            cooldown: gemini.isCooldownActive(),
            lastWork: gemini.lastGeminiWorkTime
        }
    });
});

// Gemini 상태
router.get('/gemini/status', (req, res) => {
    const model = gemini.getCurrentModel();
    let status = '현재 프로 사용 중';
    if (gemini.isCooldownActive()) {
        const remain = Math.max(0, Math.round((gemini.cooldownUntil - Date.now()) / 60000));
        status = `쿨다운 중 (${remain}분 후 해제)`;
    } else if (gemini.currentModelIndex > 0) {
        status = `${gemini.fallbackRound}회차 강등 중`;
    }
    res.json({
        current: model.label,
        round: gemini.fallbackRound,
        cooldown: gemini.isCooldownActive(),
        status,
        lastWork: gemini.lastGeminiWorkTime ? new Date(gemini.lastGeminiWorkTime).toLocaleString('ko-KR') : '없음',
        models: gemini.GEMINI_MODELS.map((m, i) => ({ label: m.label, id: m.id, active: i === gemini.currentModelIndex }))
    });
});

// 셧다운
router.post('/shutdown', (req, res) => {
    console.log('[서버] 🔄 리셋 요청 → 상태 저장 후 종료');
    gemini.saveServerState();
    res.json({ ok: true, message: '서버 종료 중...' });
    setTimeout(() => { process.exit(0); }, 1000);
});

// 일시정지 / 재개
router.post('/pause', (req, res) => {
    req.app.locals.isPaused = true;
    req.app.locals.pausedAt = new Date().toISOString();
    const { reportTimers, startReportTimers } = req.app.locals.reportControl;
    Object.keys(reportTimers).forEach(key => {
        if (reportTimers[key]?.timer) {
            clearTimeout(reportTimers[key].timer);
            reportTimers[key].timer = null;
            reportTimers[key].paused = true;
        }
    });
    console.log(`[시스템] ⏸️ 수집 일시정지 — 리포트 타이머 중지 (${req.app.locals.pausedAt})`);
    res.json({ ok: true, isPaused: true, pausedAt: req.app.locals.pausedAt });
});

router.post('/resume', (req, res) => {
    const wasPaused = req.app.locals.pausedAt;
    req.app.locals.isPaused = false;
    req.app.locals.pausedAt = null;
    const { startReportTimers } = req.app.locals.reportControl;
    startReportTimers();
    console.log(`[시스템] ▶️ 수집 재개 — 리포트 타이머 재시작 (정지기간: ${wasPaused || '없음'})`);
    res.json({ ok: true, isPaused: false, resumedAt: new Date().toISOString() });
});

// 수집 현황
router.get('/collection/status', (req, res) => {
    const { REPORT_SOURCES, getSmartInterval } = req.app.locals.reportControl;
    const hour = new Date().getHours();
    const timeSlot = (hour >= 7 && hour < 9) ? 'peak' : (hour >= 9 && hour < 16) ? 'market' : 'offhour';
    const timeSlotLabel = timeSlot === 'peak' ? '🔥 피크(07~09시)' : timeSlot === 'market' ? '📊 장중(09~16시)' : '🌙 장외(16~07시)';

    const intervals = {};
    REPORT_SOURCES.forEach(src => {
        intervals[src.key] = getSmartInterval(src.key) / 1000 + '초';
    });

    res.json({
        isPaused: req.app.locals.isPaused,
        pausedAt: req.app.locals.pausedAt,
        timeSlot, timeSlotLabel, intervals, hour
    });
});

module.exports = router;
