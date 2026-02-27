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

    // 1) 해당 날짜 캐시가 있으면 즉시 반환 (API 호출 안 함)
    const exactCache = loadJSON(`dart_${date}_p${p}.json`, null);
    if (exactCache && exactCache.list && exactCache.list.length > 0) {
        console.log(`[DART] 캐시 즉시반환: ${date} p${p} (${exactCache.list.length}건)`);
        // 백그라운드에서 API 갱신 시도 (응답은 기다리지 않음)
        refreshDartCache(date, p).catch(() => { });
        return res.json(exactCache);
    }

    // 2) 캐시 없으면 API 호출
    const url = `https://opendart.fss.or.kr/api/list.json?crtfc_key=${DART_API_KEY}&bgn_de=${date}&end_de=${date}&page_no=${p}&page_count=100`;
    try {
        const resp = await axios.get(url, { timeout: 15000 });
        if (resp.data && resp.data.list && resp.data.list.length > 0) {
            // 수집 시각 타임스탬프 추가
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
        // 에러 시 폴백
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
