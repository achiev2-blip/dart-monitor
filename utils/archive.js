/**
 * DART 모니터 — 계층별 아카이브 시스템
 * 
 * ============================================================
 * 목적: 시간이 지남에 따라 데이터를 압축·요약하여 저장 공간 절약 + 빠른 조회
 * 
 * 계층 구조:
 *   data/context/archive/
 *   ├── daily/     ← 일별 스냅샷 (7일 보관, 이후 weekly로 압축)
 *   ├── weekly/    ← 주간 요약 (4주 보관, 이후 monthly로 압축)
 *   ├── monthly/   ← 월간 요약 (12개월 보관, 이후 quarterly로 압축)
 *   ├── quarterly/ ← 분기 요약 (3년 보관) [C1]
 *   ├── yearly/    ← 연간 요약 (영구 보관)
 *   └── events/    ← 변곡점 이벤트 영구 보존 [C3]
 * 
 * 섹터별 분류:
 *   data/context/sectors/   ← 섹터별 그룹 데이터 [C2]
 *   ├── 반도체.json
 *   ├── 바이오.json
 *   └── ...
 * 
 * 연결:
 *   - server.js의 1분 타이머 → runArchiveCycle() 매일 02:00 KST 실행
 *   - company-data.js → 기업별 price.json, reports.json, layers.json 참조
 *   - watchlist.json → 섹터 정보 참조
 * 
 * 데이터 흐름:
 *   일별 데이터 → [7일 후] 주간 요약 → [4주 후] 월간 요약
 *   → [3개월 후] 분기 요약 → [12개월 후] 연간 요약
 *   변곡점 이벤트 → events/ 영구 보존
 *   3년 초과 분기 데이터 → 폐기
 * ============================================================
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');

const ARCHIVE_DIR = path.join(config.DATA_DIR, 'context', 'archive');
const SECTORS_DIR = path.join(config.DATA_DIR, 'context', 'sectors');

// 디렉토리 보장
function ensureDirs() {
    const dirs = [
        ARCHIVE_DIR,
        path.join(ARCHIVE_DIR, 'daily'),
        path.join(ARCHIVE_DIR, 'weekly'),
        path.join(ARCHIVE_DIR, 'monthly'),
        path.join(ARCHIVE_DIR, 'quarterly'),
        path.join(ARCHIVE_DIR, 'yearly'),
        path.join(ARCHIVE_DIR, 'events'),
        SECTORS_DIR
    ];
    for (const d of dirs) {
        if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    }
}
ensureDirs();

// ============================================================
// 유틸리티
// ============================================================
function loadJSON(fp, fallback) {
    try {
        if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf-8'));
    } catch (e) { console.error(`[아카이브] JSON 읽기 실패: ${fp}`); }
    return fallback;
}

function saveJSON(fp, data) {
    try {
        fs.writeFileSync(fp, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) { console.error(`[아카이브] JSON 저장 실패: ${fp}: ${e.message}`); }
}

function getKSTDate(daysOffset = 0) {
    const d = new Date();
    d.setHours(d.getHours() + 9); // UTC → KST
    d.setDate(d.getDate() + daysOffset);
    return d.toISOString().slice(0, 10);
}

function getKSTWeek(dateStr) {
    const d = new Date(dateStr + 'T00:00:00+09:00');
    const oneJan = new Date(d.getFullYear(), 0, 1);
    const week = Math.ceil(((d - oneJan) / 86400000 + oneJan.getDay() + 1) / 7);
    return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

function getKSTMonth(dateStr) {
    return dateStr.slice(0, 7); // "2026-02"
}

function getKSTQuarter(dateStr) {
    const month = parseInt(dateStr.slice(5, 7));
    const q = Math.ceil(month / 3);
    return `${dateStr.slice(0, 4)}-Q${q}`;
}

function getKSTYear(dateStr) {
    return dateStr.slice(0, 4);
}

// ============================================================
// C1: 일별 스냅샷 생성
// ============================================================
// 목적: 당일의 주가, 뉴스, 공시, 리포트를 하나의 파일로 스냅샷
// 호출원: runArchiveCycle() → 매일 02:00 KST
// 저장: data/context/archive/daily/{YYYY-MM-DD}.json
// ============================================================

/**
 * 일별 스냅샷 생성
 * @param {Function} getCollectedData - 수집된 뉴스/리포트/공시 데이터를 반환하는 콜백
 * @param {Array} watchlist - watchlist.json 종목 배열
 */
function createDailySnapshot(getCollectedData, watchlist) {
    const today = getKSTDate();
    const fp = path.join(ARCHIVE_DIR, 'daily', `${today}.json`);

    const { news, reports, disclosures, prices } = getCollectedData();

    // 뉴스 요약 (원문 제거, 핵심만)
    const newsSummary = (news || []).slice(0, 50).map(n => ({
        title: n.title,
        source: n.source,
        cls: n.aiCls || n.cls || 'normal',
        category: n.aiCategory || '',
        importance: n.aiImportance || '중',
        stocks: n.aiStocks || '',
        summary: n.aiSummary || '',
        pubDate: n.pubDate
    }));

    // 리포트 요약
    const reportSummary = (reports || []).slice(0, 30).map(r => ({
        corp: r.corp,
        broker: r.broker,
        title: r.title,
        targetPrice: r.targetPrice,
        opinion: r.opinion,
        cls: r.cls || 'normal',
        aiSummary: r.aiResult?.summary || '',
        date: r.date
    }));

    // 종목별 종가
    const priceSnapshot = {};
    if (prices) {
        for (const [name, data] of Object.entries(prices)) {
            priceSnapshot[name] = {
                price: data.price || null,
                change: data.change || null,
                volume: data.volume || null
            };
        }
    }

    const snapshot = {
        date: today,
        market: {
            newsCount: newsSummary.length,
            reportCount: reportSummary.length,
            keyInsights: extractKeyInsights(newsSummary, reportSummary)
        },
        stocks: priceSnapshot,
        newsDigest: newsSummary,
        reportDigest: reportSummary,
        savedAt: new Date().toISOString()
    };

    saveJSON(fp, snapshot);
    console.log(`[아카이브] 일별 스냅샷 저장: ${today} (뉴스:${newsSummary.length}, 리포트:${reportSummary.length})`);
    return snapshot;
}

/**
 * 핵심 인사이트 자동 추출
 * 호재/악재 + 중요도 상 항목을 자동으로 추려냄
 */
function extractKeyInsights(news, reports) {
    const insights = [];

    // 중요 뉴스 (호재/악재 + 중요도 상)
    for (const n of news) {
        if ((n.cls === 'good' || n.cls === 'bad' || n.cls === 'strong_good') &&
            n.importance === '상') {
            insights.push({
                type: 'news',
                title: n.title,
                cls: n.cls,
                stocks: n.stocks,
                summary: n.summary
            });
        }
    }

    // 주요 리포트 (목표가 변동 or 의견 변경)
    for (const r of reports) {
        if (r.cls !== 'normal') {
            insights.push({
                type: 'report',
                corp: r.corp,
                broker: r.broker,
                cls: r.cls,
                targetPrice: r.targetPrice,
                opinion: r.opinion,
                summary: r.aiSummary
            });
        }
    }

    return insights.slice(0, 20); // 최대 20건
}

// ============================================================
// C1: 주간 요약 생성
// ============================================================
// 목적: 1주간의 일별 스냅샷을 압축하여 주간 트렌드로 요약
// 호출원: runArchiveCycle() → 매주 월요일 02:00 KST
// 입력: daily/ 폴더의 최근 7일 파일
// 저장: data/context/archive/weekly/{YYYY-Wnn}.json
// ============================================================
function createWeeklySummary() {
    const dailyDir = path.join(ARCHIVE_DIR, 'daily');
    const files = fs.readdirSync(dailyDir).filter(f => f.endsWith('.json')).sort();

    if (files.length < 2) return null; // 최소 2일 데이터 필요

    // 최근 7일 파일
    const weekFiles = files.slice(-7);
    const weekData = weekFiles.map(f => loadJSON(path.join(dailyDir, f), null)).filter(Boolean);

    if (weekData.length === 0) return null;

    const firstDate = weekData[0].date;
    const lastDate = weekData[weekData.length - 1].date;
    const weekKey = getKSTWeek(lastDate);

    // 주간 뉴스 트렌드: 카테고리별 집계
    const categoryCount = {};
    const importantNews = [];
    for (const day of weekData) {
        for (const n of (day.newsDigest || [])) {
            categoryCount[n.category] = (categoryCount[n.category] || 0) + 1;
            if (n.importance === '상' && (n.cls === 'good' || n.cls === 'bad' || n.cls === 'strong_good')) {
                importantNews.push(n);
            }
        }
    }

    // 주간 리포트 요약: 종목별 그룹
    const corpReports = {};
    for (const day of weekData) {
        for (const r of (day.reportDigest || [])) {
            if (!corpReports[r.corp]) corpReports[r.corp] = [];
            corpReports[r.corp].push(r);
        }
    }

    // 주간 가격 변동 (첫날 vs 마지막날)
    const priceChanges = {};
    const firstPrices = weekData[0].stocks || {};
    const lastPrices = weekData[weekData.length - 1].stocks || {};
    for (const [name, last] of Object.entries(lastPrices)) {
        const first = firstPrices[name];
        if (first && first.price && last.price) {
            const change = ((last.price - first.price) / first.price * 100).toFixed(2);
            priceChanges[name] = { from: first.price, to: last.price, change: parseFloat(change) };
        }
    }

    const summary = {
        week: weekKey,
        period: `${firstDate} ~ ${lastDate}`,
        daysCount: weekData.length,
        trends: {
            newsCategories: categoryCount,
            importantNews: importantNews.slice(0, 15),
            reportsByStock: Object.fromEntries(
                Object.entries(corpReports).map(([k, v]) => [k, v.slice(0, 3)])
            ),
            priceChanges
        },
        keyInsights: weekData.flatMap(d => d.market?.keyInsights || []).slice(0, 15),
        savedAt: new Date().toISOString()
    };

    const fp = path.join(ARCHIVE_DIR, 'weekly', `${weekKey}.json`);
    saveJSON(fp, summary);
    console.log(`[아카이브] 주간 요약 저장: ${weekKey} (${firstDate}~${lastDate})`);
    return summary;
}

// ============================================================
// C1: 월간 요약 생성
// ============================================================
function createMonthlySummary() {
    const weeklyDir = path.join(ARCHIVE_DIR, 'weekly');
    const files = fs.readdirSync(weeklyDir).filter(f => f.endsWith('.json')).sort();

    if (files.length < 2) return null;

    // 이전 달의 주간 파일들 집계
    const prevMonth = getKSTMonth(getKSTDate(-30));
    const monthFiles = files.filter(f => {
        const data = loadJSON(path.join(weeklyDir, f), null);
        return data && data.period && data.period.startsWith(prevMonth);
    });

    if (monthFiles.length === 0) {
        // 주간 데이터에서 이전 달에 해당하는 것들 찾기
        const allWeekly = files.map(f => loadJSON(path.join(weeklyDir, f), null)).filter(Boolean);
        const prevMonthWeeks = allWeekly.filter(w => w.period && w.period.includes(prevMonth));
        if (prevMonthWeeks.length === 0) return null;
    }

    const weeklyData = files.map(f => loadJSON(path.join(weeklyDir, f), null)).filter(Boolean);
    if (weeklyData.length === 0) return null;

    // 월간 통합
    const allInsights = weeklyData.flatMap(w => w.keyInsights || []);
    const allPriceChanges = {};
    for (const w of weeklyData) {
        for (const [name, pc] of Object.entries(w.trends?.priceChanges || {})) {
            if (!allPriceChanges[name]) allPriceChanges[name] = [];
            allPriceChanges[name].push(pc);
        }
    }

    // 월간 가격 종합 (첫 주 시작가 vs 마지막 주 종가)
    const monthlyPriceChange = {};
    for (const [name, changes] of Object.entries(allPriceChanges)) {
        if (changes.length > 0) {
            const first = changes[0].from;
            const last = changes[changes.length - 1].to;
            monthlyPriceChange[name] = {
                from: first,
                to: last,
                change: parseFloat(((last - first) / first * 100).toFixed(2))
            };
        }
    }

    const summary = {
        month: prevMonth,
        weeksCount: weeklyData.length,
        trends: {
            monthlyPriceChange,
            topInsights: allInsights.slice(0, 20)
        },
        savedAt: new Date().toISOString()
    };

    const fp = path.join(ARCHIVE_DIR, 'monthly', `${prevMonth}.json`);
    saveJSON(fp, summary);
    console.log(`[아카이브] 월간 요약 저장: ${prevMonth}`);
    return summary;
}

// ============================================================
// C1: 분기 요약 생성 (신규)
// ============================================================
// 목적: 3개월 단위로 시장 트렌드, 섹터 동향, 주요 이벤트 누적
// 저장: data/context/archive/quarterly/{YYYY-Qn}.json
// ============================================================
function createQuarterlySummary() {
    const monthlyDir = path.join(ARCHIVE_DIR, 'monthly');
    const files = fs.readdirSync(monthlyDir).filter(f => f.endsWith('.json')).sort();

    if (files.length < 3) return null; // 최소 3개월 데이터

    const prevQuarter = getKSTQuarter(getKSTDate(-90));
    const qYear = prevQuarter.slice(0, 4);
    const qNum = parseInt(prevQuarter.slice(-1));
    const qMonths = [];
    for (let m = (qNum - 1) * 3 + 1; m <= qNum * 3; m++) {
        qMonths.push(`${qYear}-${String(m).padStart(2, '0')}`);
    }

    const monthlyData = qMonths
        .map(m => loadJSON(path.join(monthlyDir, `${m}.json`), null))
        .filter(Boolean);

    if (monthlyData.length === 0) return null;

    // 분기 가격 범위
    const quarterPriceChange = {};
    for (const month of monthlyData) {
        for (const [name, pc] of Object.entries(month.trends?.monthlyPriceChange || {})) {
            if (!quarterPriceChange[name]) {
                quarterPriceChange[name] = { from: pc.from, to: pc.to };
            } else {
                quarterPriceChange[name].to = pc.to;
            }
        }
    }
    for (const [name, pc] of Object.entries(quarterPriceChange)) {
        pc.change = parseFloat(((pc.to - pc.from) / pc.from * 100).toFixed(2));
    }

    const summary = {
        quarter: prevQuarter,
        months: qMonths,
        monthsCount: monthlyData.length,
        trends: {
            quarterPriceChange,
            topInsights: monthlyData.flatMap(m => m.trends?.topInsights || []).slice(0, 30)
        },
        savedAt: new Date().toISOString()
    };

    const fp = path.join(ARCHIVE_DIR, 'quarterly', `${prevQuarter}.json`);
    saveJSON(fp, summary);
    console.log(`[아카이브] 분기 요약 저장: ${prevQuarter}`);
    return summary;
}

// ============================================================
// C1: 연간 요약 생성
// ============================================================
function createYearlySummary() {
    const quarterlyDir = path.join(ARCHIVE_DIR, 'quarterly');
    const files = fs.readdirSync(quarterlyDir).filter(f => f.endsWith('.json')).sort();

    if (files.length < 4) return null;

    const prevYear = String(parseInt(getKSTYear(getKSTDate())) - 1);
    const yearQuarters = files
        .filter(f => f.startsWith(prevYear))
        .map(f => loadJSON(path.join(quarterlyDir, f), null))
        .filter(Boolean);

    if (yearQuarters.length === 0) return null;

    const summary = {
        year: prevYear,
        quartersCount: yearQuarters.length,
        trends: {
            topInsights: yearQuarters.flatMap(q => q.trends?.topInsights || []).slice(0, 50)
        },
        savedAt: new Date().toISOString()
    };

    const fp = path.join(ARCHIVE_DIR, 'yearly', `${prevYear}.json`);
    saveJSON(fp, summary);
    console.log(`[아카이브] 연간 요약 저장: ${prevYear}`);
    return summary;
}

// ============================================================
// C2: 섹터별 분류 저장
// ============================================================
// 목적: 같은 업종의 종목들을 그룹화하여 섹터별 트렌드 분석이 가능하게 함
// 호출원: runArchiveCycle() → 매일 02:00 KST
// 의존: watchlist.json (sector 필드), company-data.js (가격/리포트)
// 저장: data/context/sectors/{섹터명}.json
// ============================================================
function updateSectorData(watchlist, companyData) {
    const sectorGroups = {};

    for (const stock of watchlist) {
        const sector = stock.sector || '기타';
        if (!sectorGroups[sector]) sectorGroups[sector] = [];

        const price = companyData.getPrice(stock.code);
        const reports = companyData.getReports(stock.code);
        const layers = companyData.getLayers(stock.code);

        sectorGroups[sector].push({
            code: stock.code,
            name: stock.name,
            price: price.current || null,
            recentReports: (reports || []).slice(0, 3).map(r => ({
                broker: r.broker,
                title: r.title,
                targetPrice: r.targetPrice,
                date: r.date
            })),
            aiSummary: layers.AI분석?.latestSummary || '',
            newsCount: (layers.뉴스 || []).length,
            updatedAt: price.updatedAt || null
        });
    }

    for (const [sector, stocks] of Object.entries(sectorGroups)) {
        const fp = path.join(SECTORS_DIR, `${sector}.json`);
        saveJSON(fp, {
            sector,
            stockCount: stocks.length,
            stocks,
            updatedAt: new Date().toISOString()
        });
    }

    console.log(`[아카이브] 섹터별 데이터 갱신: ${Object.keys(sectorGroups).length}개 섹터`);
}

// ============================================================
// C3: 변곡점 이벤트 영구 보존
// ============================================================
// 목적: ±5% 이상 급변동, 중요 정책발표, 대규모 M&A 등을 영구 보존
// 호출원: server.js에서 급등락 감지 시 또는 수동 호출
// 저장: data/context/archive/events/{YYYY-MM-DD}_{code}_{type}.json
// ============================================================
function saveEvent(eventData) {
    const { date, code, name, type, description, data } = eventData;
    const dateStr = date || getKSTDate();
    const filename = `${dateStr}_${code || 'market'}_${type || 'event'}.json`;
    const fp = path.join(ARCHIVE_DIR, 'events', filename);

    const event = {
        date: dateStr,
        code,
        name,
        type, // 'spike', 'policy', 'merger', 'regulation', 'custom'
        description,
        data,
        permanent: true, // 이 필드가 true면 폐기 대상에서 제외
        savedAt: new Date().toISOString()
    };

    saveJSON(fp, event);
    console.log(`[아카이브] 변곡점 이벤트 저장: ${filename}`);
    return event;
}

// ============================================================
// C4: 3년 초과 데이터 폐기
// ============================================================
// 목적: 저장 공간 관리 — 3년 초과 분기 데이터 삭제, 오래된 일별/주간 데이터 정리
// 호출원: runArchiveCycle() → 매월 1일 02:00 KST
// 기준:
//   - daily: 7일 초과 → 삭제
//   - weekly: 4주 초과 → 삭제
//   - monthly: 12개월 초과 → 삭제
//   - quarterly: 3년 초과 → 삭제
//   - yearly: 영구 보존
//   - events: permanent=true → 영구 보존, 그 외 3년 초과 삭제
// ============================================================
function cleanupOldData() {
    let deleted = 0;

    // daily: 7일 초과
    deleted += cleanDir(path.join(ARCHIVE_DIR, 'daily'), 7);

    // weekly: 30일 초과 (약 4주)
    deleted += cleanDir(path.join(ARCHIVE_DIR, 'weekly'), 30);

    // monthly: 365일 초과
    deleted += cleanDir(path.join(ARCHIVE_DIR, 'monthly'), 365);

    // quarterly: 1095일 초과 (3년)
    deleted += cleanDir(path.join(ARCHIVE_DIR, 'quarterly'), 1095);

    // events: permanent 아닌 것만 3년 초과 삭제
    const eventsDir = path.join(ARCHIVE_DIR, 'events');
    if (fs.existsSync(eventsDir)) {
        const cutoff = Date.now() - 1095 * 86400000;
        for (const f of fs.readdirSync(eventsDir).filter(f => f.endsWith('.json'))) {
            const fp = path.join(eventsDir, f);
            const data = loadJSON(fp, null);
            if (data && !data.permanent) {
                const stat = fs.statSync(fp);
                if (stat.mtimeMs < cutoff) {
                    fs.unlinkSync(fp);
                    deleted++;
                }
            }
        }
    }

    if (deleted > 0) {
        console.log(`[아카이브] 오래된 데이터 ${deleted}건 정리 완료`);
    }
    return deleted;
}

function cleanDir(dir, maxDays) {
    if (!fs.existsSync(dir)) return 0;
    const cutoff = Date.now() - maxDays * 86400000;
    let deleted = 0;
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
        const fp = path.join(dir, f);
        const stat = fs.statSync(fp);
        if (stat.mtimeMs < cutoff) {
            fs.unlinkSync(fp);
            deleted++;
        }
    }
    return deleted;
}

// ============================================================
// C5: 아카이브 사이클 실행 (매일 02:00 KST 자동)
// ============================================================
// 목적: 모든 아카이브 작업을 순차적으로 실행
// 연결: server.js의 1분 타이머에서 h===2 && m===0 일 때 호출
// ============================================================
let lastArchiveDate = '';

function runArchiveCycle(getCollectedData, watchlist, companyData) {
    const today = getKSTDate();
    if (lastArchiveDate === today) return; // 하루 1회만
    lastArchiveDate = today;

    console.log(`[아카이브] === 아카이브 사이클 시작 (${today}) ===`);

    try {
        // 1. 일별 스냅샷
        createDailySnapshot(getCollectedData, watchlist);

        // 2. 월요일이면 주간 요약
        const dayOfWeek = new Date().getDay();
        if (dayOfWeek === 1) { // 월요일
            createWeeklySummary();
        }

        // 3. 매월 1일이면 월간 요약
        if (today.endsWith('-01')) {
            createMonthlySummary();
        }

        // 4. 분기 시작월(1,4,7,10)의 1일이면 분기 요약
        const month = parseInt(today.slice(5, 7));
        if (today.endsWith('-01') && [1, 4, 7, 10].includes(month)) {
            createQuarterlySummary();
        }

        // 5. 1월 1일이면 연간 요약
        if (today.endsWith('01-01')) {
            createYearlySummary();
        }

        // 6. 섹터별 데이터 갱신
        if (watchlist && companyData) {
            updateSectorData(watchlist, companyData);
        }

        // 7. 오래된 데이터 정리 (매월 1일)
        if (today.endsWith('-01')) {
            cleanupOldData();
        }

        console.log(`[아카이브] === 아카이브 사이클 완료 ===`);
    } catch (e) {
        console.error(`[아카이브] 사이클 실패: ${e.message}`);
    }
}

// ============================================================
// API용: 아카이브 현황 조회
// ============================================================
function getArchiveStatus() {
    const countFiles = (dir) => {
        try {
            return fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')).length : 0;
        } catch { return 0; }
    };

    return {
        daily: countFiles(path.join(ARCHIVE_DIR, 'daily')),
        weekly: countFiles(path.join(ARCHIVE_DIR, 'weekly')),
        monthly: countFiles(path.join(ARCHIVE_DIR, 'monthly')),
        quarterly: countFiles(path.join(ARCHIVE_DIR, 'quarterly')),
        yearly: countFiles(path.join(ARCHIVE_DIR, 'yearly')),
        events: countFiles(path.join(ARCHIVE_DIR, 'events')),
        sectors: countFiles(SECTORS_DIR),
        lastArchiveDate
    };
}

// ============================================================
// Exports
// ============================================================
module.exports = {
    createDailySnapshot,
    createWeeklySummary,
    createMonthlySummary,
    createQuarterlySummary,
    createYearlySummary,
    updateSectorData,
    saveEvent,
    cleanupOldData,
    runArchiveCycle,
    getArchiveStatus,
    ARCHIVE_DIR,
    SECTORS_DIR
};
