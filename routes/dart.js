const express = require('express');
const axios = require('axios');
const config = require('../config');
const { saveJSON, loadJSON } = require('../utils/file-io');
const router = express.Router();

const DART_API_KEY = config.DART_API_KEY;

// N일 전 날짜 반환 (KST 기준, YYYYMMDD)
function getDaysAgo(n) {
    const d = new Date();
    d.setHours(d.getHours() + 9);
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10).replace(/-/g, '');
}

// 캐시 또는 폴백에서 데이터 찾기
function findCachedData(date, p) {
    // 1) 해당 날짜 캐시 확인
    const cached = loadJSON(`dart_${date}_p${p}.json`, null);
    if (cached && cached.list && cached.list.length > 0) return cached;
    // 2) 최근 3일 폴백 (p1만)
    if (p == 1) {
        for (let i = 1; i <= 3; i++) {
            const prevDate = getDaysAgo(i);
            const prevData = loadJSON(`dart_${prevDate}_p1.json`, null);
            if (prevData && prevData.list && prevData.list.length > 0) {
                prevData._fallbackFrom = date;
                prevData._actualDate = prevDate;
                return prevData;
            }
        }
    }
    return null;
}

router.get('/dart', async (req, res) => {
    const { date, page } = req.query;
    if (!date) return res.status(400).json({ error: 'date 필수' });
    const p = page || 1;

    // ── 단일 터널: DC 메모리에서 즉시 반환 ──
    const dc = req.app.locals.claudeDataCenter;
    if (dc && dc.disclosures && dc.disclosures.length > 0) {
        // DC에 있는 공시를 요청 날짜로 필터
        const dateFiltered = dc.disclosures.filter(d => d.rcept_dt === date);
        if (dateFiltered.length > 0) {
            console.log(`[DART] DC 즉시반환: ${date} (${dateFiltered.length}건)`);
            return res.json({ status: '000', list: dateFiltered, total_count: dateFiltered.length, _source: 'dc' });
        }
        // 오늘 날짜인데 DC에 없으면 DC 전체 반환 (폴백 데이터)
        const kst = new Date(Date.now() + 9 * 3600000);
        const todayStr = kst.getUTCFullYear().toString() +
            String(kst.getUTCMonth() + 1).padStart(2, '0') +
            String(kst.getUTCDate()).padStart(2, '0');
        if (date === todayStr) {
            console.log(`[DART] DC 전체반환 (오늘 데이터 없음): ${dc.disclosures.length}건`);
            return res.json({ status: '000', list: dc.disclosures, total_count: dc.disclosures.length, _source: 'dc-fallback' });
        }
    }

    // ── DC에 없는 과거 날짜: 파일 폴백 ──
    const exactCache = loadJSON(`dart_${date}_p${p}.json`, null);
    if (exactCache && exactCache.list && exactCache.list.length > 0) {
        console.log(`[DART] 파일 캐시: ${date} p${p} (${exactCache.list.length}건)`);
        return res.json(exactCache);
    }

    // 파일도 없으면 API 호출
    const url = `https://opendart.fss.or.kr/api/list.json?crtfc_key=${DART_API_KEY}&bgn_de=${date}&end_de=${date}&page_no=${p}&page_count=100`;
    try {
        const resp = await axios.get(url, { timeout: 15000 });
        if (resp.data && resp.data.list && resp.data.list.length > 0) {
            resp.data._fetchedAt = new Date().toISOString();
            saveJSON(`dart_${date}_p${p}.json`, resp.data);
            return res.json(resp.data);
        }
        // API 빈 결과 → 폴백
        const fallback = findCachedData(date, p);
        if (fallback) {
            console.log(`[DART] API 빈결과 → 폴백: ${fallback._actualDate || date}`);
            return res.json(fallback);
        }
        res.json(resp.data);
    } catch (e) {
        console.error(`[DART] ${e.message}`);
        const fallback = findCachedData(date, p);
        if (fallback) {
            console.log(`[DART] 에러→폴백: ${fallback._actualDate || date}`);
            return res.json(fallback);
        }
        res.status(500).json({ error: e.message });
    }
});

// 백그라운드 API 갱신 (캐시가 이미 있을 때 최신으로 업데이트 시도)
async function refreshDartCache(date, p) {
    try {
        const url = `https://opendart.fss.or.kr/api/list.json?crtfc_key=${DART_API_KEY}&bgn_de=${date}&end_de=${date}&page_no=${p}&page_count=100`;
        const resp = await axios.get(url, { timeout: 15000 });
        if (resp.data && resp.data.list && resp.data.list.length > 0) {
            saveJSON(`dart_${date}_p${p}.json`, resp.data);
            console.log(`[DART] 백그라운드 갱신 성공: ${date} p${p}`);
        }
    } catch (e) {
        // 백그라운드 실패는 무시 (캐시 데이터가 이미 있으므로)
    }
}

module.exports = router;
