/**
 * 뉴스 전용 DC — 수집 + 저장 + DC 관리 통합 모듈
 * 
 * 역할:
 *  1. storedNews 배열 소유 (news.json에서 로드)
 *  2. RSS 크롤러로 자동 수집 (10분마다)
 *  3. AI 분류 트리거 (Gemini)
 *  4. 24시간 보존규칙 + 200건 캡
 *  5. dc.news에 독립 기록 (5분마다)
 * 
 * 이전: server.js collectNewsAuto + storedNews + context.js DC 뉴스 누적
 */

const fs = require('fs');
const path = require('path');

// ── 경로 ──
const DATA_DIR = path.join(__dirname, '..', 'data');
const NEWS_FILE = path.join(DATA_DIR, 'news.json');
const DC_NEWS_CAP = 200;

// ── 상태 ──
let _app = null;
let storedNews = [];       // 뉴스 배열 (이 모듈이 소유)
let lastCollectedAt = null;
let lastDCUpdatedAt = null;
let sentNewsIds = new Set();  // DC에 이미 넣은 뉴스 ID 기억 (읽고 지움 대응)

// ── 유틸리티 ──

/** JSON 파일 로드 */
function loadJSON(fallback) {
    try {
        return JSON.parse(fs.readFileSync(NEWS_FILE, 'utf-8'));
    } catch (e) {
        return fallback;
    }
}

/** JSON 파일 저장 */
function saveToFile() {
    try {
        fs.writeFileSync(NEWS_FILE, JSON.stringify(storedNews, null, 2), 'utf-8');
    } catch (e) {
        console.warn(`[news-dc/저장] 실패: ${e.message}`);
    }
}

// ════════════════════════════════════════════════
// 1. 자동 수집 — RSS 크롤러 → storedNews
// ════════════════════════════════════════════════

/** 뉴스 자동 수집 (10분마다) */
async function collectNewsAuto() {
    if (!_app) return;
    const isPaused = _app.locals.isPaused;
    if (isPaused) return;

    try {
        const { NEWS_FETCHERS, isStockRelevant } = require('../crawlers/news');
        const gemini = require('./gemini');
        const hantoo = require('../crawlers/hantoo');

        const results = await Promise.allSettled(
            NEWS_FETCHERS.map(f => f.fn())
        );

        let allItems = [];
        let errors = 0;
        results.forEach((r, i) => {
            if (r.status === 'fulfilled') {
                allItems = allItems.concat(r.value);
            } else {
                errors++;
                console.error(`[news-dc/수집] ${NEWS_FETCHERS[i].name} 실패: ${r.reason?.message}`);
            }
        });

        // 필터 + 중복제거
        const relevant = allItems.filter(item => isStockRelevant(item.title));
        const existingLinks = new Set(storedNews.map(n => n.link));
        let added = 0;
        for (const item of relevant) {
            if (!existingLinks.has(item.link)) {
                item.collectedAt = new Date().toISOString();
                storedNews.unshift(item);
                existingLinks.add(item.link);
                added++;
            }
        }
        if (storedNews.length > 200) storedNews.splice(200);
        if (added > 0) {
            saveToFile();
            // AI 분류 트리거
            const unclassified = storedNews.filter(n => !n.aiClassified).slice(0, 20);
            if (unclassified.length > 0) {
                gemini.classifyNewsBatch(unclassified, () => hantoo.getWatchlist()).catch(e =>
                    console.error(`[news-dc/AI] 자동분류 실패: ${e.message}`)
                );
            }
        }
        lastCollectedAt = new Date().toISOString();
        const kstNow = new Date(Date.now() + 9 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
        console.log(`[news-dc/수집] ${kstNow} KST 전체${allItems.length}건 필터${relevant.length}건 신규${added}건 에러${errors}건 (저장${storedNews.length}건)`);
    } catch (e) {
        console.error(`[news-dc/수집] 실패: ${e.message}`);
    }
}

// ════════════════════════════════════════════════
// 2. 보존규칙 — 24시간 경과 삭제 + 200건 캡
// ════════════════════════════════════════════════

/** 뉴스 보존규칙 적용 */
function cleanOldNews() {
    const kst = new Date(Date.now() + 9 * 3600000);
    const cutoff = new Date(kst);
    cutoff.setHours(cutoff.getHours() - 24);
    const cutoffStr = cutoff.toISOString();
    const before = storedNews.length;

    // 24시간 경과 삭제
    for (let i = storedNews.length - 1; i >= 0; i--) {
        const d = storedNews[i].pubDate || storedNews[i].date;
        if (d && new Date(d).toISOString() < cutoffStr) {
            storedNews.splice(i, 1);
        }
    }
    // 200건 캡
    if (storedNews.length > 200) storedNews.length = 200;

    if (storedNews.length < before) {
        saveToFile();
        const removed = before - storedNews.length;
        console.log(`[news-dc/보존] ${removed}건 삭제 (24시간+200건캡), 잔여 ${storedNews.length}건`);
        return removed;
    }
    return 0;
}

// ════════════════════════════════════════════════
// 3. DC 뉴스 관리 — dc.news 독립 갱신
// ════════════════════════════════════════════════

/** DC의 news 섹션 갱신 — 새 뉴스만 누적 (sentIds로 중복 방지) */
function updateNews() {
    if (!_app) return;

    if (!_app.locals.claudeDataCenter) {
        _app.locals.claudeDataCenter = { ok: true, news: [], reports: [], disclosures: [], _meta: {} };
    }
    const dc = _app.locals.claudeDataCenter;

    try {
        // sentNewsIds로 이미 DC에 넣은 뉴스 건너뜀 (dc.news가 비워져도 안전)
        const newNews = storedNews.filter(n => {
            const id = (n.title || '') + (n.date || n.pubDate || '');
            return !sentNewsIds.has(id);
        }).map(n => ({
            title: n.title, source: n.source, date: n.date || n.pubDate || '',
            cls: n.aiCls || '', importance: n.aiImportance || '',
            summary: n.aiSummary || '', stocks: n.aiStocks || '',
            category: n.aiCategory || '', link: n.link || ''
        }));

        if (newNews.length > 0) {
            dc.news = [...(dc.news || []), ...newNews].slice(-DC_NEWS_CAP);
            // 새로 넣은 ID 기억
            newNews.forEach(n => sentNewsIds.add(n.title + n.date));
        }

        // sentIds 메모리 관리: 1000개 초과 시 오래된 것 삭제
        if (sentNewsIds.size > 1000) {
            const arr = [...sentNewsIds];
            sentNewsIds = new Set(arr.slice(-500));
        }

        lastDCUpdatedAt = new Date().toISOString();
    } catch (e) {
        console.warn(`[news-dc/DC] 갱신 실패: ${e.message}`);
    }
}

// ════════════════════════════════════════════════
// 외부 인터페이스
// ════════════════════════════════════════════════

/** storedNews 배열 반환 (routes/news.js에서 사용) */
function getStoredNews() {
    return storedNews;
}

// ════════════════════════════════════════════════
// 초기화
// ════════════════════════════════════════════════

/** news-dc 초기화 */
function init(app) {
    _app = app;

    // news.json에서 로드
    storedNews = loadJSON([]);
    console.log(`[news-dc] 초기화: ${storedNews.length}건 로드`);

    // app.locals에 참조 공유 (routes/news.js 호환)
    app.locals.storedNews = storedNews;

    // ① 자동 수집 (30초 후 첫 실행, 이후 10분마다)
    setTimeout(() => collectNewsAuto(), 30000);
    setInterval(() => collectNewsAuto(), 600000);
    console.log('[news-dc] 수집 타이머 시작 (10분)');

    // ② DC 갱신 (15초 후 첫 실행, 이후 5분마다)
    setTimeout(() => updateNews(), 15000);
    setInterval(() => updateNews(), 300000);

    // ③ 보존규칙은 server.js의 cleanOldData에서 호출
    console.log('[news-dc] 초기화 완료');
}

/** 상태 조회 */
function getStatus() {
    return {
        lastCollectedAt,
        lastDCUpdatedAt,
        newsCount: storedNews.length,
        dcNewsCount: _app?.locals?.claudeDataCenter?.news?.length || 0
    };
}

module.exports = { init, getStoredNews, collectNewsAuto, cleanOldNews, getStatus, updateNews };
