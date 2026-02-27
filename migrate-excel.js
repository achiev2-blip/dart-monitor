/**
 * 엑셀 데이터 → 시스템 JSON 일괄 이식 스크립트
 * 실행: node migrate-excel.js
 */
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const COMPANIES_DIR = path.join(DATA_DIR, 'companies');
const MACRO_DIR = path.join(DATA_DIR, 'macro');
const CONTEXT_DIR = path.join(DATA_DIR, 'context');

const EXCEL_FILE = path.join(__dirname, '주식_1_15_3_2.xlsx');

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function saveJSON(fp, data) {
    ensureDir(path.dirname(fp));
    fs.writeFileSync(fp, JSON.stringify(data, null, 2), 'utf-8');
}

function loadJSON(fp, fallback) {
    try {
        if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf-8'));
    } catch (e) { }
    return fallback;
}

// 엑셀 읽기
const wb = XLSX.readFile(EXCEL_FILE);
function getSheet(name) {
    return XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1 });
}

let totalMigrated = 0;

// ============================================================
// 1. 종목마스터 → watchlist.json + companies/{code}/info.json
// ============================================================
console.log('\n=== 1. 종목마스터 이식 ===');
{
    const rows = getSheet('종목마스터');
    const headers = rows[0]; // No, 섹터, 종목명, 종목코드, 시장, 액면가, 상장주식수, 대주주지분율...
    const existing = loadJSON(path.join(DATA_DIR, 'watchlist.json'), []);
    const existingCodes = new Set(existing.map(s => s.code));

    let added = 0, updated = 0;
    for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        if (!r || !r[3]) continue; // 종목코드 없으면 스킵

        const code = String(r[3]).padStart(6, '0');
        const name = r[2] || '';
        const sector = r[1] || '';
        const market = r[4] || '';

        // companies/{code}/info.json 업데이트
        const compDir = path.join(COMPANIES_DIR, code);
        ensureDir(compDir);
        const info = loadJSON(path.join(compDir, 'info.json'), {});
        info.code = code;
        info.name = name;
        info.sector = sector;
        info.market = market;
        if (r[5]) info.faceValue = r[5];
        if (r[6]) info.shares = r[6];
        if (r[7]) info.majorShareholderRatio = r[7];
        // 추가 컬럼이 있으면 저장
        for (let c = 8; c < (headers?.length || 0); c++) {
            if (r[c] && headers[c]) info[headers[c]] = r[c];
        }
        saveJSON(path.join(compDir, 'info.json'), info);
        updated++;

        // watchlist에 없으면 추가
        if (!existingCodes.has(code)) {
            existing.push({ code, name, sector, market });
            existingCodes.add(code);
            added++;
        }
    }
    saveJSON(path.join(DATA_DIR, 'watchlist.json'), existing);
    console.log(`  info.json 업데이트: ${updated}종목, watchlist 신규: ${added}종목`);
    totalMigrated += updated;
}

// ============================================================
// 2. D0/D1 확정종가 → companies/{code}/price.json
// ============================================================
console.log('\n=== 2. 확정종가 이식 ===');
['D0_20260213', 'D1_20260212'].forEach(sheetName => {
    const rows = getSheet(sheetName);
    if (!rows || rows.length < 2) return;

    const headers = rows[0]; // No, 종목명, 최종가, 등락률(%), ...
    let count = 0;

    // 종목마스터에서 코드 매핑
    const masterRows = getSheet('종목마스터');
    const nameToCode = {};
    for (let i = 1; i < masterRows.length; i++) {
        if (masterRows[i] && masterRows[i][2] && masterRows[i][3]) {
            nameToCode[masterRows[i][2]] = String(masterRows[i][3]).padStart(6, '0');
        }
    }

    for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        if (!r || !r[1]) continue;

        const name = r[1];
        const code = nameToCode[name];
        if (!code) continue;

        const price = r[2];
        if (!price) continue;

        const compDir = path.join(COMPANIES_DIR, code);
        ensureDir(compDir);
        const priceData = loadJSON(path.join(compDir, 'price.json'), { current: {}, daily: [] });

        // 날짜 추출 (시트명에서)
        const dateMatch = sheetName.match(/(\d{8})/);
        const dateStr = dateMatch ? dateMatch[1] : '';

        // daily에 추가 (중복 체크)
        if (dateStr && !priceData.daily.find(d => d.date === dateStr)) {
            const entry = { date: dateStr, close: price };
            if (r[3]) entry.change = r[3]; // 등락률
            priceData.daily.unshift(entry);
            // 60일 유지
            if (priceData.daily.length > 60) priceData.daily = priceData.daily.slice(0, 60);
            saveJSON(path.join(compDir, 'price.json'), priceData);
            count++;
        }
    }
    console.log(`  ${sheetName}: ${count}종목 종가 추가`);
    totalMigrated += count;
});

// ============================================================
// 3. 예측기록 → predictions/
// ============================================================
console.log('\n=== 3. 예측기록 이식 ===');
{
    const rows = getSheet('예측기록');
    const headers = rows[0]; // 예측일, 대상일, 종목명, 종목코드, 전일종가, 예측방향, 예측등락%, 예측종가...
    const predDir = path.join(DATA_DIR, 'predictions');
    ensureDir(predDir);

    // 기존 예측 파일 확인
    const existingFiles = new Set();
    try {
        ['active', 'evaluated'].forEach(sub => {
            const d = path.join(predDir, sub);
            if (fs.existsSync(d)) {
                fs.readdirSync(d).forEach(f => existingFiles.add(f));
            }
        });
    } catch (e) { }

    let count = 0;
    for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        if (!r || !r[0]) continue;

        const predDate = String(r[0]);
        const targetDate = String(r[1] || '');
        const name = r[2] || '';
        const code = r[3] ? String(r[3]).padStart(6, '0') : '';
        const prevClose = r[4] || 0;
        const direction = r[5] || '';
        const changePct = r[6] || 0;
        const predPrice = r[7] || 0;

        const pred = {
            predictionDate: predDate,
            targetDate: targetDate,
            stockName: name,
            stockCode: code,
            previousClose: prevClose,
            direction: direction,
            predictedChangePct: changePct,
            predictedPrice: predPrice,
            source: 'excel_migration'
        };

        // 추가 컬럼 (확정종가, 실제등락, 정확도 등)
        for (let c = 8; c < (headers?.length || 0); c++) {
            if (r[c] !== undefined && r[c] !== '' && headers[c]) {
                pred[headers[c]] = r[c];
            }
        }

        // 파일명: pred_{date}_{code}.json
        const fname = `pred_${predDate}_${code}.json`;
        // evaluated 폴더에 저장 (과거 예측이므로)
        const evalDir = path.join(predDir, 'evaluated');
        ensureDir(evalDir);

        if (!existingFiles.has(fname)) {
            saveJSON(path.join(evalDir, fname), pred);
            count++;
        }
    }
    console.log(`  예측기록: ${count}건 이식`);
    totalMigrated += count;
}

// ============================================================
// 4. 이슈트래커 → context/archive/events/
// ============================================================
console.log('\n=== 4. 이슈트래커 이식 ===');
{
    const rows = getSheet('이슈트래커');
    const headers = rows[0]; // 날짜, 카테고리, 이슈, 호악재, 영향섹터, 영향종목, 예상영향, 실제반응...
    const eventsDir = path.join(CONTEXT_DIR, 'archive', 'events');
    ensureDir(eventsDir);

    const eventsByDate = {};
    for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        if (!r || !r[0]) continue;

        const date = String(r[0]);
        if (!eventsByDate[date]) eventsByDate[date] = [];

        const event = {
            category: r[1] || '',
            issue: r[2] || '',
            sentiment: r[3] || '', // 호악재
            affectedSectors: r[4] || '',
            affectedStocks: r[5] || '',
            expectedImpact: r[6] || '',
            actualReaction: r[7] || ''
        };
        // 추가 컬럼
        for (let c = 8; c < (headers?.length || 0); c++) {
            if (r[c] !== undefined && r[c] !== '' && headers[c]) {
                event[headers[c]] = r[c];
            }
        }
        eventsByDate[date].push(event);
    }

    let count = 0;
    for (const [date, events] of Object.entries(eventsByDate)) {
        const fp = path.join(eventsDir, `${date}.json`);
        const existing = loadJSON(fp, []);
        const merged = [...existing, ...events];
        saveJSON(fp, merged);
        count += events.length;
    }
    console.log(`  이슈트래커: ${count}건 (${Object.keys(eventsByDate).length}일)`);
    totalMigrated += count;
}

// ============================================================
// 5. 시장요약 → macro/market_summary.json
// ============================================================
console.log('\n=== 5. 시장요약 이식 ===');
{
    const rows = getSheet('시장요약');
    const headers = rows[0]; // 기본, (공란), 국내지수, ...
    const subHeaders = rows[1]; // 날짜, 요일, KOSPI, KOSPI200, KOSDAQ, ...

    const summaries = [];
    for (let i = 2; i < rows.length; i++) {
        const r = rows[i];
        if (!r || !r[0]) continue;

        const entry = {};
        for (let c = 0; c < (subHeaders?.length || 0); c++) {
            const key = subHeaders[c];
            if (key && r[c] !== undefined && r[c] !== '') {
                entry[key] = r[c];
            }
        }
        if (Object.keys(entry).length > 0) summaries.push(entry);
    }

    saveJSON(path.join(MACRO_DIR, 'market_summary.json'), summaries);
    console.log(`  시장요약: ${summaries.length}일치`);
    totalMigrated += summaries.length;
}

// ============================================================
// 6. 해외시장 → macro/overseas_summary.json
// ============================================================
console.log('\n=== 6. 해외시장 이식 ===');
{
    const rows = getSheet('해외시장');
    const headers = rows[0];

    const data = [];
    for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        if (!r || !r[0]) continue;

        const entry = {};
        for (let c = 0; c < (headers?.length || 0); c++) {
            if (headers[c] && r[c] !== undefined && r[c] !== '') {
                entry[headers[c]] = r[c];
            }
        }
        if (Object.keys(entry).length > 0) data.push(entry);
    }

    saveJSON(path.join(MACRO_DIR, 'overseas_summary.json'), data);
    console.log(`  해외시장: ${data.length}행`);
    totalMigrated += data.length;
}

// ============================================================
// 7. 섹터수익률 → context/sector_returns.json
// ============================================================
console.log('\n=== 7. 섹터수익률 이식 ===');
{
    const rows = getSheet('섹터수익률');
    const headers = rows[0];

    const data = [];
    for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        if (!r || !r[0]) continue;

        const entry = {};
        for (let c = 0; c < (headers?.length || 0); c++) {
            if (headers[c] && r[c] !== undefined && r[c] !== '') {
                entry[headers[c]] = r[c];
            }
        }
        if (Object.keys(entry).length > 0) data.push(entry);
    }

    saveJSON(path.join(CONTEXT_DIR, 'sector_returns.json'), data);
    console.log(`  섹터수익률: ${data.length}행`);
    totalMigrated += data.length;
}

// ============================================================
// 8. 트럼프정책 → context/archive/trump_policy.json
// ============================================================
console.log('\n=== 8. 트럼프정책 이식 ===');
{
    const rows = getSheet('트럼프정책');
    const headers = rows[0];

    const data = [];
    for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        if (!r || !r[0]) continue;

        const entry = {};
        for (let c = 0; c < (headers?.length || 0); c++) {
            if (headers[c] && r[c] !== undefined && r[c] !== '') {
                entry[headers[c]] = r[c];
            }
        }
        if (Object.keys(entry).length > 0) data.push(entry);
    }

    const archiveDir = path.join(CONTEXT_DIR, 'archive');
    ensureDir(archiveDir);
    saveJSON(path.join(archiveDir, 'trump_policy.json'), data);
    console.log(`  트럼프정책: ${data.length}건`);
    totalMigrated += data.length;
}

console.log(`\n✅ 총 ${totalMigrated}건 이식 완료`);
