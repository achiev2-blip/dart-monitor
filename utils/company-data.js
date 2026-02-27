/**
 * DART 모니터 — 기업별 데이터 관리
 * 
 * data/companies/{코드}/ 폴더 구조 관리
 * - info.json    : 기본 정보 (name, code, sector)
 * - price.json   : 현재가 + 일봉
 * - reports.json : 관련 리포트 배열
 * - layers.json  : 7레이어 누적 데이터
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');

const COMPANIES_DIR = path.join(config.DATA_DIR, 'companies');

// ============================================================
// 디렉토리 관리
// ============================================================
function ensureCompanyDir(code) {
    const dir = path.join(COMPANIES_DIR, code);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

function getCompanyDir(code) {
    return path.join(COMPANIES_DIR, code);
}

function companyExists(code) {
    return fs.existsSync(path.join(COMPANIES_DIR, code));
}

// ============================================================
// 파일 읽기/쓰기 (기업별)
// ============================================================
function loadCompanyJSON(code, filename, fallback) {
    try {
        const fp = path.join(COMPANIES_DIR, code, filename);
        if (fs.existsSync(fp)) {
            return JSON.parse(fs.readFileSync(fp, 'utf-8'));
        }
    } catch (e) {
        console.error(`[기업데이터] ${code}/${filename} 읽기 실패: ${e.message}`);
    }
    return fallback;
}

function saveCompanyJSON(code, filename, data) {
    try {
        const dir = ensureCompanyDir(code);
        fs.writeFileSync(path.join(dir, filename), JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) {
        console.error(`[기업데이터] ${code}/${filename} 저장 실패: ${e.message}`);
    }
}

// ============================================================
// info.json — 기본 정보
// ============================================================
function getInfo(code) {
    return loadCompanyJSON(code, 'info.json', null);
}

function saveInfo(code, info) {
    saveCompanyJSON(code, 'info.json', info);
}

// 종목 기본정보 보장 — sector가 비어있으면 갱신
function ensureInfo(code, name, sector) {
    const existing = getInfo(code);
    if (!existing) {
        saveInfo(code, { name, code, sector: sector || '', createdAt: new Date().toISOString() });
    } else if (sector && !existing.sector) {
        // 기존 info에 sector가 비어있으면 갱신
        existing.sector = sector;
        saveInfo(code, existing);
    }
}

// ============================================================
// price.json — 현재가 + 일봉
// ============================================================
function getPrice(code) {
    return loadCompanyJSON(code, 'price.json', { current: null, daily: [] });
}

// 현재가 저장 — sector 옵션으로 info.json 동기화
function saveCurrentPrice(code, name, priceData, sector) {
    ensureCompanyDir(code);
    ensureInfo(code, name, sector);
    const existing = getPrice(code);
    existing.current = priceData;
    existing.updatedAt = new Date().toISOString();
    saveCompanyJSON(code, 'price.json', existing);
    // layers.json 시세 레이어 자동 동기화
    try {
        const layers = getLayers(code);
        layers.기본정보 = { name, code };
        layers.시세.current = priceData;
        layers.시세.updatedAt = existing.updatedAt;
        saveCompanyJSON(code, 'layers.json', layers);
    } catch (e) {
        console.error(`[기업데이터] ${code} layers 시세 동기화 실패: ${e.message}`);
    }
}

function saveDailyPrices(code, name, dailyData) {
    ensureCompanyDir(code);
    ensureInfo(code, name);
    const existing = getPrice(code);
    existing.daily = dailyData;
    existing.dailyUpdatedAt = new Date().toISOString();
    saveCompanyJSON(code, 'price.json', existing);
    // layers.json 시세 레이어 자동 동기화
    try {
        const layers = getLayers(code);
        layers.기본정보 = { name, code };
        layers.시세.daily = dailyData;
        layers.시세.updatedAt = existing.dailyUpdatedAt;
        saveCompanyJSON(code, 'layers.json', layers);
    } catch (e) {
        console.error(`[기업데이터] ${code} layers 일봉 동기화 실패: ${e.message}`);
    }
}

// ============================================================
// reports.json — 기업별 리포트
// ============================================================
function getReports(code) {
    return loadCompanyJSON(code, 'reports.json', []);
}

function addReport(code, report) {
    const reports = getReports(code);
    // 중복 체크 (title + date)
    const exists = reports.some(r => r.title === report.title && r.date === report.date);
    if (exists) return false;
    reports.unshift(report);
    // 최대 100건 유지
    if (reports.length > 100) reports.length = 100;
    saveCompanyJSON(code, 'reports.json', reports);
    return true;
}

// ============================================================
// layers.json — 7 레이어 누적 구조
// ============================================================
const DEFAULT_LAYERS = {
    기본정보: {},
    시세: { current: null, daily: [], updatedAt: '' },
    공시: [],
    리포트: [],
    뉴스: [],
    AI분석: { latestSummary: '', sentiment: '', updatedAt: '' },
    메모: { notes: '', tags: [], updatedAt: '' }
};

function getLayers(code) {
    const layers = loadCompanyJSON(code, 'layers.json', null);
    if (!layers) return JSON.parse(JSON.stringify(DEFAULT_LAYERS));
    // 누락된 레이어 보충
    for (const key of Object.keys(DEFAULT_LAYERS)) {
        if (!(key in layers)) {
            layers[key] = JSON.parse(JSON.stringify(DEFAULT_LAYERS[key]));
        }
    }
    return layers;
}

function updateLayer(code, layerName, data) {
    const layers = getLayers(code);
    layers[layerName] = data;
    saveCompanyJSON(code, 'layers.json', layers);
}

function updatePriceLayer(code, name, priceData) {
    const layers = getLayers(code);
    layers.기본정보 = { name, code };
    if (priceData.current) layers.시세.current = priceData.current;
    if (priceData.daily) layers.시세.daily = priceData.daily;
    layers.시세.updatedAt = new Date().toISOString();
    saveCompanyJSON(code, 'layers.json', layers);
}

function addReportToLayer(code, report) {
    const layers = getLayers(code);
    const exists = layers.리포트.some(r => r.title === report.title && r.date === report.date);
    if (exists) return;
    layers.리포트.unshift(report);
    if (layers.리포트.length > 50) layers.리포트.length = 50;
    saveCompanyJSON(code, 'layers.json', layers);
}

/**
 * 뉴스 → layers.json 뉴스 레이어에 추가
 * 호출원: server.js classifyNewsBatch() — Gemini 뉴스 분류 결과 저장 시
 * 연결: B1(카테고리)+B2(종목태깅)+B3(중요도) 분류 결과가 이 함수를 통해 기업별 폴더에 저장됨
 * 데이터: data/companies/{code}/layers.json → 뉴스 배열
 */
function addNewsToLayer(code, newsItem) {
    const layers = getLayers(code);
    // 중복 체크 (link 기준)
    const exists = layers.뉴스.some(n => n.link === newsItem.link);
    if (exists) return;
    layers.뉴스.unshift(newsItem);
    if (layers.뉴스.length > 100) layers.뉴스.length = 100;
    saveCompanyJSON(code, 'layers.json', layers);
}

function updateAiLayer(code, summary, sentiment) {
    const layers = getLayers(code);
    layers.AI분석 = { latestSummary: summary, sentiment, updatedAt: new Date().toISOString() };
    saveCompanyJSON(code, 'layers.json', layers);
}

// ============================================================
// 전체 기업 목록
// ============================================================
function listAllCompanies() {
    try {
        if (!fs.existsSync(COMPANIES_DIR)) return [];
        return fs.readdirSync(COMPANIES_DIR)
            .filter(d => fs.statSync(path.join(COMPANIES_DIR, d)).isDirectory())
            .map(code => {
                const info = getInfo(code);
                return { code, name: info?.name || code };
            });
    } catch (e) {
        return [];
    }
}

// ============================================================
// 인트라데이 5분 틱 데이터 (기업별 날짜별 파일)
// companies/{code}/intraday/{YYYYMMDD}.json
// ============================================================
function getIntradayDir(code) {
    return path.join(COMPANIES_DIR, code, 'intraday');
}

function getSummaryDir(code) {
    return path.join(COMPANIES_DIR, code, 'intraday_summary');
}

/**
 * 5분 틱 저장
 * @param {string} code 종목코드
 * @param {object} tick { t:'0905', p:85000, v:1200, h:85200, l:84800, chg:-0.5 }
 */
function saveIntradayTick(code, tick) {
    try {
        const dir = getIntradayDir(code);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        const now = new Date();
        const kst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
        const yyyymmdd = kst.getFullYear().toString() +
            String(kst.getMonth() + 1).padStart(2, '0') +
            String(kst.getDate()).padStart(2, '0');

        const fp = path.join(dir, `${yyyymmdd}.json`);
        let ticks = [];
        if (fs.existsSync(fp)) {
            try { ticks = JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch (e) { ticks = []; }
        }

        // 같은 시간대 중복 방지
        if (!ticks.some(t => t.t === tick.t)) {
            ticks.push(tick);
            fs.writeFileSync(fp, JSON.stringify(ticks), 'utf-8');
        }
    } catch (e) {
        console.error(`[기업데이터] ${code} 인트라데이 틱 저장 실패: ${e.message}`);
    }
}

/**
 * 특정일 인트라데이 원본 조회
 */
function getIntraday(code, yyyymmdd) {
    try {
        const fp = path.join(getIntradayDir(code), `${yyyymmdd}.json`);
        if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf-8'));
    } catch (e) { }
    return [];
}

/**
 * 당일 인트라데이 조회 (편의)
 */
function getTodayIntraday(code) {
    const now = new Date();
    const kst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
    const yyyymmdd = kst.getFullYear().toString() +
        String(kst.getMonth() + 1).padStart(2, '0') +
        String(kst.getDate()).padStart(2, '0');
    return getIntraday(code, yyyymmdd);
}

/**
 * Gemini 인트라데이 요약 저장
 */
function saveIntradaySummary(code, yyyymmdd, summary) {
    try {
        const dir = getSummaryDir(code);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `${yyyymmdd}.json`), JSON.stringify(summary, null, 2), 'utf-8');
    } catch (e) {
        console.error(`[기업데이터] ${code} 인트라데이 요약 저장 실패: ${e.message}`);
    }
}

/**
 * 특정일 인트라데이 요약 조회
 */
function getIntradaySummary(code, yyyymmdd) {
    try {
        const fp = path.join(getSummaryDir(code), `${yyyymmdd}.json`);
        if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf-8'));
    } catch (e) { }
    return null;
}

/**
 * 최근 N일 요약 배열
 */
function getRecentSummaries(code, days = 7) {
    try {
        const dir = getSummaryDir(code);
        if (!fs.existsSync(dir)) return [];
        return fs.readdirSync(dir)
            .filter(f => f.endsWith('.json'))
            .sort().reverse().slice(0, days)
            .map(f => {
                try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')); } catch (e) { return null; }
            }).filter(Boolean);
    } catch (e) { return []; }
}

/**
 * 오래된 인트라데이 원본 삭제 (keepDays일 초과)
 */
function cleanOldIntraday(code, keepDays = 7) {
    try {
        const dir = getIntradayDir(code);
        if (!fs.existsSync(dir)) return 0;

        const now = new Date();
        const kst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
        const cutoff = new Date(kst);
        cutoff.setDate(cutoff.getDate() - keepDays);
        const cutoffStr = cutoff.getFullYear().toString() +
            String(cutoff.getMonth() + 1).padStart(2, '0') +
            String(cutoff.getDate()).padStart(2, '0');

        let deleted = 0;
        fs.readdirSync(dir).filter(f => f.endsWith('.json')).forEach(f => {
            const dateStr = f.replace('.json', '');
            if (dateStr < cutoffStr) {
                fs.unlinkSync(path.join(dir, f));
                deleted++;
            }
        });
        return deleted;
    } catch (e) { return 0; }
}

/**
 * 오래된 인트라데이 요약 삭제 (keepDays일 초과)
 */
function cleanOldSummaries(code, keepDays = 30) {
    try {
        const dir = getSummaryDir(code);
        if (!fs.existsSync(dir)) return 0;

        const now = new Date();
        const kst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
        const cutoff = new Date(kst);
        cutoff.setDate(cutoff.getDate() - keepDays);
        const cutoffStr = cutoff.getFullYear().toString() +
            String(cutoff.getMonth() + 1).padStart(2, '0') +
            String(cutoff.getDate()).padStart(2, '0');

        let deleted = 0;
        fs.readdirSync(dir).filter(f => f.endsWith('.json')).forEach(f => {
            const dateStr = f.replace('.json', '');
            if (dateStr < cutoffStr) {
                fs.unlinkSync(path.join(dir, f));
                deleted++;
            }
        });
        return deleted;
    } catch (e) { return 0; }
}

// ============================================================
// Exports
// ============================================================
module.exports = {
    COMPANIES_DIR,
    ensureCompanyDir,
    getCompanyDir,
    companyExists,
    loadCompanyJSON,
    saveCompanyJSON,
    getInfo,
    saveInfo,
    ensureInfo,
    getPrice,
    saveCurrentPrice,
    saveDailyPrices,
    getReports,
    addReport,
    getLayers,
    updateLayer,
    updatePriceLayer,
    addReportToLayer,
    addNewsToLayer,
    updateAiLayer,
    listAllCompanies,
    // 인트라데이
    saveIntradayTick,
    getIntraday,
    getTodayIntraday,
    saveIntradaySummary,
    getIntradaySummary,
    getRecentSummaries,
    cleanOldIntraday,
    cleanOldSummaries
};
