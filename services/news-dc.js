/**
 * 뉴스 전용 DC — 수집 + 섹터별 저장 + DC 관리 통합 모듈
 * 
 * 역할:
 *  1. storedNews 배열 소유 (news.json에서 로드, 1000건 순환)
 *  2. RSS 크롤러로 자동 수집 (10분마다)
 *  3. AI 분류 트리거 (Gemini)
 *  4. 100일 보존규칙 + 1000건 캡
 *  5. 섹터별 파일 저장 (data/news/{섹터}/news.json)
 *  6. dc.news 매 1분 전체 재구성 (오늘 뉴스 + 역산 100건)
 */

const fs = require('fs');
const path = require('path');

// ── 경로 ──
const DATA_DIR = path.join(__dirname, '..', 'data');
const NEWS_FILE = path.join(DATA_DIR, 'news.json');
const NEWS_DIR = path.join(DATA_DIR, 'news');

// ── 설정 ──
const ALL_CAP = 1000;           // all.json 전체 뉴스 캡
const RETENTION_DAYS = 100;     // 보존 기간 (일)

// ── 상태 ──
let _app = null;
let storedNews = [];       // 뉴스 배열 (이 모듈이 소유)
let lastCollectedAt = null;
let lastDCUpdatedAt = null;
let _newsPending = false;   // 새 뉴스 분류 진행 중 플래그
let _retryRunning = false;  // 미분류 재분류 루프 실행 중 플래그

// ── 유틸리티 ──

/** JSON 파일 로드 */
function loadJSONFile(filePath, fallback) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (e) {
        return fallback;
    }
}

/** JSON 파일 저장 */
function saveJSONFile(filePath, data) {
    try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) {
        console.warn(`[news-dc/저장] ${filePath} 실패: ${e.message}`);
    }
}

/** all.json 저장 */
function saveToFile() {
    saveJSONFile(NEWS_FILE, storedNews);
}

// ════════════════════════════════════════════════
// 1. 자동 수집 — RSS 크롤러 → storedNews + 섹터별 저장
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
        const newItems = [];
        for (const item of relevant) {
            if (!existingLinks.has(item.link)) {
                item.collectedAt = new Date().toISOString();
                storedNews.unshift(item);
                existingLinks.add(item.link);
                newItems.push(item);
                added++;
            }
        }
        if (storedNews.length > ALL_CAP) storedNews.splice(ALL_CAP);
        if (added > 0) {
            saveToFile();
            // 새 뉴스를 섹터별 파일에 저장 (분류 전이라도 제목 기반)
            saveToSectorFiles(newItems);

            // AI 분류 — 새 뉴스 우선, 완료 후 미분류 재분류 트리거
            const unclassified = storedNews.filter(n => !n.aiClassified).slice(0, 20);
            if (unclassified.length > 0) {
                _newsPending = true;  // 재분류 중단 시그널
                try {
                    await gemini.classifyNewsBatch(unclassified, () => hantoo.getWatchlist());
                    saveToSectorFiles(unclassified);
                    saveToFile();
                } catch (e) {
                    console.error(`[news-dc/AI] 자동분류 실패: ${e.message}`);
                }
                _newsPending = false;  // 분류 완료 시그널
                retryUnclassified();   // 즉시 미분류 재분류 시작
            }
        } else {
            // 새 뉴스 없으면 미분류 재분류 시도
            if (!_retryRunning) retryUnclassified();
        }
        lastCollectedAt = new Date().toISOString();
        const kstNow = new Date(Date.now() + 9 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
        console.log(`[news-dc/수집] ${kstNow} KST 전체${allItems.length}건 필터${relevant.length}건 신규${added}건 에러${errors}건 (저장${storedNews.length}건)`);
    } catch (e) {
        console.error(`[news-dc/수집] 실패: ${e.message}`);
    }
}

// ════════════════════════════════════════════════
// 2. 섹터별 파일 저장
// ════════════════════════════════════════════════

/** 워치리스트에서 섹터 목록 로드 */
function getSectorMap() {
    try {
        const watchlist = loadJSONFile(path.join(DATA_DIR, 'watchlist.json'), []);
        const map = {};  // { 기업명: 섹터 }
        for (const s of watchlist) {
            if (s.name && s.sector) map[s.name] = s.sector;
        }
        return map;
    } catch (e) {
        return {};
    }
}

/** 뉴스를 섹터별 파일에 저장 */
function saveToSectorFiles(newsItems) {
    if (!newsItems || newsItems.length === 0) return;
    const sectorMap = getSectorMap();
    const companyNames = Object.keys(sectorMap);
    const sectorNews = {};  // { 섹터: [뉴스] }

    for (const item of newsItems) {
        const title = item.title || '';
        let matched = false;

        // 제목에서 기업명 검색 → 해당 섹터에 추가
        for (const name of companyNames) {
            if (title.includes(name)) {
                const sector = sectorMap[name];
                if (!sectorNews[sector]) sectorNews[sector] = [];
                sectorNews[sector].push(item);
                matched = true;
            }
        }

        // 매칭 안 된 뉴스 → '시장' 폴더
        if (!matched) {
            if (!sectorNews['시장']) sectorNews['시장'] = [];
            sectorNews['시장'].push(item);
        }
    }

    // 각 섹터 파일에 추가
    for (const [sector, items] of Object.entries(sectorNews)) {
        const sectorFile = path.join(NEWS_DIR, sector, 'news.json');
        const existing = loadJSONFile(sectorFile, []);
        const existingLinks = new Set(existing.map(n => n.link));
        let added = 0;
        for (const item of items) {
            if (!existingLinks.has(item.link)) {
                existing.unshift({
                    title: item.title, source: item.source,
                    date: item.date || item.pubDate || '',
                    link: item.link || '',
                    cls: item.aiCls || '', importance: item.aiImportance || '',
                    summary: item.aiSummary || '', stocks: item.aiStocks || '',
                    category: item.aiCategory || '',
                    collectedAt: item.collectedAt || ''
                });
                added++;
            }
        }
        if (added > 0) {
            saveJSONFile(sectorFile, existing);
        }
    }
}

/** 섹터 파일에서 뉴스 로드 */
function loadSectorNews(sector) {
    const sectorFile = path.join(NEWS_DIR, sector, 'news.json');
    return loadJSONFile(sectorFile, []);
}

// ════════════════════════════════════════════════
// 3. 보존규칙 — 100일 경과 삭제 + 1000건 캡
// ════════════════════════════════════════════════

/** 뉴스 보존규칙 적용 */
function cleanOldNews() {
    const now = new Date();
    const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 3600000);
    const cutoffStr = cutoff.toISOString();
    const before = storedNews.length;

    // 100일 경과 삭제
    for (let i = storedNews.length - 1; i >= 0; i--) {
        const d = storedNews[i].pubDate || storedNews[i].date;
        if (d && new Date(d).toISOString() < cutoffStr) {
            storedNews.splice(i, 1);
        }
    }
    // 1000건 캡
    if (storedNews.length > ALL_CAP) storedNews.length = ALL_CAP;

    if (storedNews.length < before) {
        saveToFile();
        const removed = before - storedNews.length;
        console.log(`[news-dc/보존] ${removed}건 삭제 (${RETENTION_DAYS}일+${ALL_CAP}건캡), 잔여 ${storedNews.length}건`);
        return removed;
    }

    // 섹터 파일도 100일 보존규칙 적용
    cleanSectorFiles(cutoffStr);
    return 0;
}

/** 섹터 파일 보존규칙 */
function cleanSectorFiles(cutoffStr) {
    try {
        if (!fs.existsSync(NEWS_DIR)) return;
        const sectors = fs.readdirSync(NEWS_DIR).filter(f =>
            fs.statSync(path.join(NEWS_DIR, f)).isDirectory()
        );
        for (const sector of sectors) {
            const sectorFile = path.join(NEWS_DIR, sector, 'news.json');
            const items = loadJSONFile(sectorFile, []);
            const before = items.length;
            const filtered = items.filter(n => {
                const d = n.date || n.collectedAt;
                return !d || new Date(d).toISOString() >= cutoffStr;
            });
            if (filtered.length < before) {
                saveJSONFile(sectorFile, filtered);
            }
        }
    } catch (e) {
        console.warn(`[news-dc/섹터정리] ${e.message}`);
    }
}

// ════════════════════════════════════════════════
// 3.5 미분류 뉴스 재분류 — 1건씩 순차, 새 뉴스 오면 즉시 중단
// ════════════════════════════════════════════════

/** 미분류 뉴스 1건씩 순차 재분류 — 새 뉴스 도착 시 즉시 중단, 쿨다운 해제 시 자동 재시도 */
async function retryUnclassified() {
    // 이미 실행 중이거나 새 뉴스 분류 중이면 스킵
    if (_retryRunning || _newsPending) return;
    if (!_app || _app.locals.isPaused) return;
    const gemini = require('./gemini');

    // 쿨다운 중이면 해제 시점에 자동 재시도 예약
    if (gemini.isCooldownActive()) {
        const wait = gemini.cooldownUntil() - Date.now();
        if (wait > 0) {
            setTimeout(() => retryUnclassified(), wait);
            console.log(`[news-dc/재분류] 쿨다운 중 — ${Math.round(wait / 60000)}분 후 자동 재시도 예약`);
        }
        return;
    }

    const unclassified = storedNews.filter(n => !n.aiClassified);
    if (unclassified.length === 0) return;

    _retryRunning = true;
    const hantoo = require('../crawlers/hantoo');
    let retried = 0;

    for (const news of unclassified) {
        if (_newsPending) break;  // 새 뉴스 우선 → 즉시 중단
        if (news.aiClassified) continue;  // 이미 분류됨 스킵

        // 루프 도중 쿨다운 걸리면 해제 후 재시도 예약하고 중단
        if (gemini.isCooldownActive()) {
            const wait = gemini.cooldownUntil() - Date.now();
            if (wait > 0) {
                setTimeout(() => retryUnclassified(), wait);
                console.log(`[news-dc/재분류] 쿨다운 발동 — ${Math.round(wait / 60000)}분 후 자동 재시도 예약`);
            }
            break;
        }

        try {
            await gemini.classifyNewsBatch([news], () => hantoo.getWatchlist());
            saveToFile();
            retried++;
        } catch (e) {
            console.error(`[news-dc/재분류] 실패: ${e.message}`);
            break;  // 에러 시 루프 중단
        }
    }

    _retryRunning = false;
    if (retried > 0) {
        console.log(`[news-dc/재분류] ${retried}건 재분류 완료, 미분류 잔여 ${storedNews.filter(n => !n.aiClassified).length}건`);
    }
}

// ════════════════════════════════════════════════
// 4. DC 뉴스 관리 — 매 1분 전체 재구성
// ════════════════════════════════════════════════

/** DC의 news 섹션 갱신 — 매번 전체 재구성 (AI 분류 항상 반영) */
function updateNews() {
    if (!_app) return;

    if (!_app.locals.claudeDataCenter) {
        _app.locals.claudeDataCenter = { ok: true, news: [], reports: [], disclosures: [], _meta: {} };
    }
    const dc = _app.locals.claudeDataCenter;

    try {
        // 오늘 날짜 (KST 기준)
        const kstNow = new Date(Date.now() + 9 * 3600000);
        const todayStr = kstNow.toISOString().slice(0, 10);

        // 오늘 뉴스 전체
        const todayNews = storedNews.filter(n => {
            const d = n.date || n.pubDate || n.collectedAt || '';
            return d.slice(0, 10) >= todayStr;
        });

        // 오늘 뉴스가 100건 미만이면 역산으로 채우기
        let result;
        if (todayNews.length >= 100) {
            result = todayNews;
        } else {
            // 오늘 뉴스 + 나머지를 역산으로 100건 채우기
            const remaining = 100 - todayNews.length;
            const olderNews = storedNews.filter(n => {
                const d = n.date || n.pubDate || n.collectedAt || '';
                return d.slice(0, 10) < todayStr;
            }).slice(0, remaining);
            result = [...todayNews, ...olderNews];
        }

        // DC.news 전체 재구성 (AI 분류값 항상 최신 반영)
        dc.news = result.map(n => ({
            title: n.title, source: n.source, date: n.date || n.pubDate || '',
            cls: n.aiCls || '', importance: n.aiImportance || '',
            summary: n.aiSummary || '', stocks: n.aiStocks || '',
            category: n.aiCategory || '', link: n.link || ''
        }));

        lastDCUpdatedAt = new Date().toISOString();
    } catch (e) {
        console.warn(`[news-dc/DC] 갱신 실패: ${e.message}`);
    }
}

// ════════════════════════════════════════════════
// 외부 인터페이스
// ════════════════════════════════════════════════

/** storedNews 배열 반환 */
function getStoredNews() {
    return storedNews;
}

/** 섹터별 뉴스 로드 (routes/news.js 조건3용) */
function getNewsBySector(sector) {
    return loadSectorNews(sector);
}

/** 기업명으로 섹터 조회 */
function getSectorByCompany(companyName) {
    const map = getSectorMap();
    return map[companyName] || null;
}

// ════════════════════════════════════════════════
// 초기화
// ════════════════════════════════════════════════

/** news-dc 초기화 */
function init(app) {
    _app = app;

    // news.json에서 로드
    storedNews = loadJSONFile(NEWS_FILE, []);
    console.log(`[news-dc] 초기화: ${storedNews.length}건 로드`);

    // 섹터 디렉토리 생성
    ensureSectorDirs();

    // app.locals에 참조 공유 (routes/news.js 호환)
    app.locals.storedNews = storedNews;

    // ① 자동 수집 (30초 후 첫 실행, 이후 10분마다)
    setTimeout(() => collectNewsAuto(), 30000);
    setInterval(() => collectNewsAuto(), 600000);
    console.log('[news-dc] 수집 타이머 시작 (10분)');

    // ② DC 갱신 (15초 후 첫 실행, 이후 1분마다)
    setTimeout(() => updateNews(), 15000);
    setInterval(() => updateNews(), 60000);
    console.log('[news-dc] DC 갱신 타이머 시작 (1분)');

    // ③ 미분류 재분류 — 초기 실행 (60초 후, 수집 완료 후에도 자동 트리거)
    setTimeout(() => retryUnclassified(), 60000);
    console.log('[news-dc] 미분류 재분류 활성화 (이벤트 기반)');

    // ④ 보존규칙은 server.js의 cleanOldData에서 호출
    console.log('[news-dc] 초기화 완료');
}

/** 섹터 디렉토리 미리 생성 */
function ensureSectorDirs() {
    const watchlist = loadJSONFile(path.join(DATA_DIR, 'watchlist.json'), []);
    const sectors = new Set(watchlist.map(s => s.sector).filter(Boolean));
    sectors.add('시장');  // 공통 뉴스 폴더

    for (const sector of sectors) {
        const dir = path.join(NEWS_DIR, sector);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
            console.log(`[news-dc] 섹터 디렉토리 생성: ${sector}`);
        }
    }
}

/** 상태 조회 */
function getStatus() {
    return {
        lastCollectedAt,
        lastDCUpdatedAt,
        newsCount: storedNews.length,
        dcNewsCount: _app?.locals?.claudeDataCenter?.news?.length || 0,
        retentionDays: RETENTION_DAYS,
        allCap: ALL_CAP
    };
}

module.exports = { init, getStoredNews, getNewsBySector, getSectorByCompany, collectNewsAuto, cleanOldNews, getStatus, updateNews, retryUnclassified };
