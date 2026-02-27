#!/usr/bin/env node
/**
 * Phase 2 마이그레이션 스크립트
 * 
 * 기존 data/ 플랫 구조 → data/companies/{코드}/ 기업별 폴더 구조로 변환
 * 
 * 사용법:
 *   node migrate-phase2.js --dry-run   # 시뮬레이션만 (파일 미생성)
 *   node migrate-phase2.js             # 실제 마이그레이션 실행
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const COMPANIES_DIR = path.join(DATA_DIR, 'companies');
const DRY_RUN = process.argv.includes('--dry-run');

console.log('');
console.log('  ╔══════════════════════════════════════╗');
console.log('  ║  📦 Phase 2: 데이터 구조 마이그레이션  ║');
console.log(`  ║  ${DRY_RUN ? '🔍 DRY-RUN 모드 (변경 없음)' : '⚡ 실행 모드 (파일 생성)'}        ║`);
console.log('  ╚══════════════════════════════════════╝');
console.log('');

// ============================================================
// 유틸리티
// ============================================================
function loadJSON(filename) {
    try {
        const fp = path.join(DATA_DIR, filename);
        if (fs.existsSync(fp)) {
            return JSON.parse(fs.readFileSync(fp, 'utf-8'));
        }
    } catch (e) {
        console.error(`  ❌ ${filename} 읽기 실패: ${e.message}`);
    }
    return null;
}

function ensureDir(dir) {
    if (!DRY_RUN && !fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function writeJSON(filepath, data) {
    if (!DRY_RUN) {
        fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf-8');
    }
}

// ============================================================
// 1단계: watchlist 로드
// ============================================================
console.log('📋 1단계: watchlist 로드');
const watchlist = loadJSON('watchlist.json') || [];
console.log(`  ✅ ${watchlist.length}종목 로드`);
console.log('');

// ============================================================
// 2단계: companies 디렉토리 생성
// ============================================================
console.log('📁 2단계: 기업별 폴더 생성');
ensureDir(COMPANIES_DIR);
let dirsCreated = 0;

for (const stock of watchlist) {
    if (!stock.code) {
        console.log(`  ⚠️ ${stock.name}: 코드 없음 — 스킵`);
        continue;
    }
    const dir = path.join(COMPANIES_DIR, stock.code);
    const existed = fs.existsSync(dir);
    ensureDir(dir);
    if (!existed) dirsCreated++;
    console.log(`  ${existed ? '📂' : '📁'} ${stock.code}/ (${stock.name}) ${existed ? '이미 존재' : '생성'}`);
}
console.log(`  → ${dirsCreated}개 새 폴더 생성${DRY_RUN ? ' (dry-run)' : ''}`);
console.log('');

// ============================================================
// 3단계: info.json 생성
// ============================================================
console.log('📝 3단계: info.json 생성');
let infosCreated = 0;

for (const stock of watchlist) {
    if (!stock.code) continue;
    const infoPath = path.join(COMPANIES_DIR, stock.code, 'info.json');
    if (fs.existsSync(infoPath)) {
        console.log(`  ℹ️ ${stock.code} info.json 이미 존재`);
        continue;
    }
    const info = {
        name: stock.name,
        code: stock.code,
        sector: '',
        createdAt: new Date().toISOString()
    };
    writeJSON(infoPath, info);
    infosCreated++;
    console.log(`  ✅ ${stock.code} (${stock.name}) info.json 생성`);
}
console.log(`  → ${infosCreated}개 info.json 생성${DRY_RUN ? ' (dry-run)' : ''}`);
console.log('');

// ============================================================
// 4단계: stock_prices.json → 기업별 price.json
// ============================================================
console.log('💰 4단계: 주가 데이터 분배');
const stockPrices = loadJSON('stock_prices.json') || {};
let pricesCreated = 0;

for (const [code, data] of Object.entries(stockPrices)) {
    if (!code || code.length !== 6) continue;
    const dir = path.join(COMPANIES_DIR, code);
    ensureDir(dir);

    const priceData = {
        current: data.current || null,
        daily: data.daily || [],
        updatedAt: new Date().toISOString()
    };

    writeJSON(path.join(dir, 'price.json'), priceData);
    pricesCreated++;
    console.log(`  ✅ ${code} (${data.name || '?'}) price.json — 현재가:${data.current ? '✓' : '✗'} 일봉:${(data.daily || []).length}건`);
}
console.log(`  → ${pricesCreated}개 price.json 생성${DRY_RUN ? ' (dry-run)' : ''}`);
console.log('');

// ============================================================
// 5단계: 리포트 → 기업별 reports.json
// ============================================================
console.log('📊 5단계: 리포트 분배');

const reportFiles = [
    'reports_wisereport.json',
    'reports_mirae.json',
    'reports_hana.json',
    'reports_hyundai.json',
    'reports_naver.json'
];

// watchlist에서 종목명→코드 매핑
const nameToCode = {};
for (const stock of watchlist) {
    if (stock.code) nameToCode[stock.name] = stock.code;
}

function findCode(corpName) {
    // 정확 매칭
    if (nameToCode[corpName]) return nameToCode[corpName];
    // 부분 매칭
    for (const [name, code] of Object.entries(nameToCode)) {
        if (corpName.includes(name) || name.includes(corpName)) return code;
    }
    return null;
}

// AI 분석 캐시 로드
const aiCache = loadJSON('report_ai_cache.json') || {};

let totalReports = 0;
let matchedReports = 0;
let unmatchedCorps = new Set();
const companyReports = {}; // code → reports[]

for (const filename of reportFiles) {
    const reports = loadJSON(filename) || [];
    totalReports += reports.length;

    for (const report of reports) {
        if (!report.corp) continue;
        const code = findCode(report.corp);
        if (!code) {
            unmatchedCorps.add(report.corp);
            continue;
        }

        if (!companyReports[code]) companyReports[code] = [];

        // AI 분석 결과 병합
        const cacheKey = `${report.corp}|${report.title}|${report.date}`;
        if (aiCache[cacheKey]) {
            report.aiResult = aiCache[cacheKey];
        }

        // 중복 체크
        const exists = companyReports[code].some(r => r.title === report.title && r.date === report.date);
        if (!exists) {
            companyReports[code].push(report);
            matchedReports++;
        }
    }
}

// 기업별 파일 저장
let reportFilesCreated = 0;
for (const [code, reports] of Object.entries(companyReports)) {
    const dir = path.join(COMPANIES_DIR, code);
    ensureDir(dir);
    // 날짜 내림차순
    reports.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    // 최대 100건
    if (reports.length > 100) reports.length = 100;
    writeJSON(path.join(dir, 'reports.json'), reports);
    reportFilesCreated++;

    const stock = watchlist.find(s => s.code === code);
    console.log(`  ✅ ${code} (${stock?.name || '?'}) — ${reports.length}건`);
}

if (unmatchedCorps.size > 0) {
    console.log(`  ⚠️ 매칭 안 된 기업: ${[...unmatchedCorps].slice(0, 10).join(', ')}${unmatchedCorps.size > 10 ? ` 외 ${unmatchedCorps.size - 10}건` : ''}`);
}
console.log(`  → 전체 ${totalReports}건 중 ${matchedReports}건 매칭, ${reportFilesCreated}개 파일 생성${DRY_RUN ? ' (dry-run)' : ''}`);
console.log('');

// ============================================================
// 6단계: layers.json 초기화
// ============================================================
console.log('🧱 6단계: layers.json 생성 (7레이어)');
let layersCreated = 0;

for (const stock of watchlist) {
    if (!stock.code) continue;
    const dir = path.join(COMPANIES_DIR, stock.code);
    const layersPath = path.join(dir, 'layers.json');

    if (fs.existsSync(layersPath)) {
        console.log(`  ℹ️ ${stock.code} layers.json 이미 존재`);
        continue;
    }

    const priceData = stockPrices[stock.code] || {};
    const reports = companyReports[stock.code] || [];

    const layers = {
        기본정보: { name: stock.name, code: stock.code, sector: '' },
        시세: {
            current: priceData.current || null,
            daily: priceData.daily || [],
            updatedAt: priceData.current ? new Date().toISOString() : ''
        },
        공시: [],
        리포트: reports.slice(0, 50),
        뉴스: [],
        AI분석: { latestSummary: '', sentiment: '', updatedAt: '' },
        메모: { notes: '', tags: [], updatedAt: '' }
    };

    ensureDir(dir);
    writeJSON(layersPath, layers);
    layersCreated++;
    console.log(`  ✅ ${stock.code} (${stock.name}) — 시세:${layers.시세.current ? '✓' : '✗'} 리포트:${layers.리포트.length}건`);
}
console.log(`  → ${layersCreated}개 layers.json 생성${DRY_RUN ? ' (dry-run)' : ''}`);
console.log('');

// ============================================================
// 결과 요약
// ============================================================
console.log('  ╔══════════════════════════════════════╗');
console.log('  ║       📊 마이그레이션 결과 요약       ║');
console.log('  ╠══════════════════════════════════════╣');
console.log(`  ║  종목 수:       ${String(watchlist.length).padStart(4)}개            ║`);
console.log(`  ║  폴더 생성:     ${String(dirsCreated).padStart(4)}개            ║`);
console.log(`  ║  info.json:     ${String(infosCreated).padStart(4)}개            ║`);
console.log(`  ║  price.json:    ${String(pricesCreated).padStart(4)}개            ║`);
console.log(`  ║  reports.json:  ${String(reportFilesCreated).padStart(4)}개            ║`);
console.log(`  ║  layers.json:   ${String(layersCreated).padStart(4)}개            ║`);
console.log(`  ║  리포트 매칭:   ${String(matchedReports).padStart(4)}/${String(totalReports).padStart(4)}건       ║`);
console.log('  ╚══════════════════════════════════════╝');
if (DRY_RUN) {
    console.log('');
    console.log('  💡 실제 실행: node migrate-phase2.js');
}
console.log('');
