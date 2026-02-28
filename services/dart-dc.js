/**
 * DART 공시 전용 DC — 수집 + 분류 + DC 관리 통합 모듈
 * 
 * 역할:
 *  1. DART API에서 오늘 공시 수집 → dart_*.json 저장 (10분마다)
 *  2. Gemini AI로 미분류 공시 분석 (수집 직후)
 *  3. DC의 disclosures 섹션 독립 관리 (5분마다)
 *  4. dart_*.json 7일 보존규칙 정리 (서버 시작 시 1회)
 *  5. getDartData(date) — 날짜별 공시 제공 (routes/dart.js에서 호출)
 * 
 * 이전 파일 대체: dart-analyzer.js + dart-scheduler.js + context.js 공시 로직
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const config = require('../config');

// ── 경로 + 설정 ──
const DATA_DIR = path.join(__dirname, '..', 'data');
let GEMINI_BASE = config.GEMINI_BASE || 'https://generativelanguage.googleapis.com/v1beta/';
if (!GEMINI_BASE.endsWith('models/')) GEMINI_BASE += 'models/';
const MODEL = 'gemini-2.5-flash';
const DART_API_KEY = config.DART_API_KEY;
const DART_API_BASE = 'https://opendart.fss.or.kr/api/list.json';
const MAX_PAGES = 5;
const DC_DISCLOSURE_CAP = 100;

// ── 상태 추적 ──
let _app = null;          // Express app 참조
let isAnalyzing = false;
let lastAnalyzedAt = null;
let lastCollectedAt = null;
let lastDCUpdatedAt = null;
let totalAnalyzed = 0;
let totalCollected = 0;

// ── 유틸리티 ──

/** KST 오늘 날짜 (YYYYMMDD) */
function getToday() {
    const d = new Date(Date.now() + 9 * 3600000);
    return d.getUTCFullYear().toString() +
        String(d.getUTCMonth() + 1).padStart(2, '0') +
        String(d.getUTCDate()).padStart(2, '0');
}

/** 대기 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ════════════════════════════════════════════════
// 1. DART API 수집 — 오늘 공시 → 파일 저장
// ════════════════════════════════════════════════

/** DART API에서 오늘 공시 수집 → dart_YYYYMMDD_pN.json 저장 */
async function collectDartToday() {
    if (!DART_API_KEY) return;

    const today = getToday();
    const kstNow = new Date(Date.now() + 9 * 3600000);
    const kstHour = kstNow.getUTCHours();

    // 영업시간 외엔 수집 안 함 (KST 08~19시만)
    if (kstHour < 8 || kstHour >= 19) return;

    // 주말엔 수집 안 함 (토=6, 일=0)
    const day = kstNow.getUTCDay();
    if (day === 0 || day === 6) return;

    let totalItems = 0;
    let newPages = 0;

    for (let p = 1; p <= MAX_PAGES; p++) {
        try {
            const url = `${DART_API_BASE}?crtfc_key=${DART_API_KEY}&bgn_de=${today}&end_de=${today}&page_no=${p}&page_count=100`;
            const resp = await axios.get(url, { timeout: 15000 });

            if (resp.data && resp.data.list && resp.data.list.length > 0) {
                resp.data._fetchedAt = new Date().toISOString();
                resp.data._collectedAt = new Date().toISOString();

                // 파일에 저장
                const fileName = `dart_${today}_p${p}.json`;
                const filePath = path.join(DATA_DIR, fileName);
                fs.writeFileSync(filePath, JSON.stringify(resp.data, null, 2), 'utf-8');

                totalItems += resp.data.list.length;
                newPages++;

                // 마지막 페이지면 중단
                if (resp.data.list.length < 100) break;
            } else {
                break; // 빈 결과 → 더 이상 페이지 없음
            }
        } catch (e) {
            console.error(`[dart-dc/수집] p${p} 실패: ${e.message}`);
            break;
        }
    }

    if (totalItems > 0) {
        totalCollected += totalItems;
        lastCollectedAt = new Date().toISOString();
        const kstStr = kstNow.toISOString().replace('T', ' ').slice(0, 19);
        console.log(`[dart-dc/수집] ${kstStr} KST ${today} ${totalItems}건 ${newPages}페이지`);
    }
}

// ════════════════════════════════════════════════
// 2. Gemini AI 분류 — 미분류 공시 → 4단계 분류
// ════════════════════════════════════════════════

/** DART 파일에서 미분류 공시 찾아서 Gemini로 분류 */
async function analyzeDartFiles(apiKey) {
    if (isAnalyzing) return;
    isAnalyzing = true;

    try {
        // 먼저 수집
        await collectDartToday();

        // 오늘 날짜 dart 파일만 읽기
        const today = getToday();
        const dartFiles = fs.readdirSync(DATA_DIR)
            .filter(f => f.startsWith(`dart_${today}`) && f.endsWith('.json'))
            .sort();

        if (dartFiles.length === 0) { isAnalyzing = false; return; }

        // 미분류 공시 수집
        let unclassified = [];
        for (const fileName of dartFiles) {
            try {
                const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, fileName), 'utf-8'));
                (data.list || []).forEach((item, idx) => {
                    if (!item._aiCls) unclassified.push({ fileName, idx, item });
                });
            } catch (e) { }
        }

        if (unclassified.length === 0) { isAnalyzing = false; return; }

        console.log(`[dart-dc/분류] 미분류 ${unclassified.length}건 — 분석 시작`);

        // 배치 분석 (10건씩)
        for (let i = 0; i < unclassified.length; i += 10) {
            const batch = unclassified.slice(i, i + 10);
            await classifyBatch(batch, apiKey);
            if (i + 10 < unclassified.length) await sleep(2000);
        }

        // 분류 결과 파일 저장
        saveDartFiles(unclassified);
        lastAnalyzedAt = new Date().toISOString();
        console.log(`[dart-dc/분류] 완료 — ${unclassified.length}건 (누적 ${totalAnalyzed}건)`);

    } catch (e) {
        console.error(`[dart-dc/분류] 오류: ${e.message}`);
    } finally {
        isAnalyzing = false;
    }
}

/** Gemini에 10건 배치 분류 요청 */
async function classifyBatch(batch, apiKey) {
    const items = batch.map((b, i) =>
        `${i + 1}. [${b.item.corp_name || '?'}] ${b.item.report_nm || '?'}`
    ).join('\n');

    const prompt = `당신은 한국 주식시장 전문 애널리스트입니다.
아래 DART 공시 제목을 보고 주식 투자자 관점에서 분류해주세요. 반드시 JSON 배열로만 답하세요.

공시 목록:
${items}

분류 기준 (주식 투자 관점):
- 강력호재: 대규모 수주, 사상최대 실적, 대형 M&A, 자사주 대량 매입 등 주가 강한 상승
- 호재: 배당결정, 실적호전, 신규투자, 수주, 자사주 취득 등 주가 긍정적
- 악재: 유상증자, 감자, 적자전환, 횡령, 상장폐지, 소송 등 주가 부정적
- 일반: 정기보고서, 주총소집, 임원변동, 일상적 공시 등 주가 영향 없음

응답 형식 (JSON 배열만, 다른 텍스트 없이):
[
  { "idx": 1, "cls": "강력호재|호재|악재|일반", "summary": "15자 이내 핵심 요약" },
  ...
]`;

    try {
        const url = `${GEMINI_BASE}${MODEL}:generateContent?key=${apiKey}`;
        const resp = await axios.post(url, {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.2, maxOutputTokens: 800 }
        }, { timeout: 15000, headers: { 'Content-Type': 'application/json' } });

        const text = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '');
        const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
            const results = JSON.parse(jsonMatch[0]);
            results.forEach(r => {
                const target = batch[r.idx - 1];
                if (target) {
                    target.item._aiCls = r.cls || '일반';
                    target.item._aiSummary = r.summary || '';
                    totalAnalyzed++;
                }
            });
        }
    } catch (e) {
        console.error(`[dart-dc/분류] Gemini 호출 실패: ${e.message}`);
        // 실패 시 기본값
        batch.forEach(b => { b.item._aiCls = '일반'; b.item._aiSummary = ''; });
    }
}

/** 분류 결과를 dart 파일에 머지 저장 */
function saveDartFiles(classified) {
    const byFile = {};
    classified.forEach(c => {
        if (!byFile[c.fileName]) byFile[c.fileName] = [];
        byFile[c.fileName].push(c);
    });

    for (const [fileName, items] of Object.entries(byFile)) {
        try {
            const filePath = path.join(DATA_DIR, fileName);
            const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            items.forEach(item => {
                if (data.list && data.list[item.idx]) {
                    data.list[item.idx]._aiCls = item.item._aiCls;
                    data.list[item.idx]._aiSummary = item.item._aiSummary;
                }
            });
            data._analyzedAt = new Date().toISOString();
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
        } catch (e) {
            console.error(`[dart-dc/저장] ${fileName} 실패: ${e.message}`);
        }
    }
}

// ════════════════════════════════════════════════
// 3. DC 공시 관리 — app.locals.claudeDataCenter.disclosures
// ════════════════════════════════════════════════

/** DC의 disclosures 섹션 갱신 — 오늘 전부 + 20건 미만이면 역순 보충 */
function updateDisclosures() {
    if (!_app) return;

    // DC 초기화 보장
    if (!_app.locals.claudeDataCenter) {
        _app.locals.claudeDataCenter = { ok: true, news: [], reports: [], disclosures: [], _meta: {} };
    }
    const dc = _app.locals.claudeDataCenter;

    const today = getToday();

    try {
        // 날짜별로 그룹핑된 파일 목록
        const allDartFiles = fs.readdirSync(DATA_DIR)
            .filter(f => f.startsWith('dart_') && f.endsWith('.json'))
            .sort().reverse();  // 최신부터

        if (allDartFiles.length === 0) return;

        // 날짜별 분류
        const dateMap = {};
        allDartFiles.forEach(f => {
            const match = f.match(/dart_(\d{8})/);
            if (match) {
                if (!dateMap[match[1]]) dateMap[match[1]] = [];
                dateMap[match[1]].push(f);
            }
        });

        // 날짜 역순 정렬
        const dates = Object.keys(dateMap).sort().reverse();

        let allDisclosures = [];

        // 오늘 공시 전부 로딩
        const todayFiles = dateMap[today] || [];
        for (const f of todayFiles) {
            try {
                const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf-8'));
                if (data.list && Array.isArray(data.list)) {
                    allDisclosures.push(...data.list);
                }
            } catch (e) { /* 손상된 파일 무시 */ }
        }

        // 오늘 공시 20건 미만이면 이전 날짜에서 역순 보충
        if (allDisclosures.length < 20) {
            for (const date of dates) {
                if (date === today) continue; // 오늘은 이미 처리
                const files = dateMap[date];
                for (const f of files) {
                    try {
                        const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf-8'));
                        if (data.list && Array.isArray(data.list)) {
                            allDisclosures.push(...data.list);
                        }
                    } catch (e) { }
                    if (allDisclosures.length >= 30) break;
                }
                if (allDisclosures.length >= 30) break;
            }
        }

        // 중복 제거 (rcept_no 기준) + 캡 적용
        const seen = new Set();
        dc.disclosures = allDisclosures
            .filter(d => {
                if (!d.rcept_no || seen.has(d.rcept_no)) return false;
                seen.add(d.rcept_no);
                return true;
            })
            .slice(0, DC_DISCLOSURE_CAP)
            .map(d => ({
                rcept_no: d.rcept_no,
                corp_name: d.corp_name || '',
                corp_code: d.corp_code || '',
                report_nm: d.report_nm || '',
                rcept_dt: d.rcept_dt || '',
                flr_nm: d.flr_nm || '',
                rm: d.rm || '',
                _aiCls: d._aiCls || '',
                _aiSummary: d._aiSummary || ''
            }));

        lastDCUpdatedAt = new Date().toISOString();
        console.log(`[dart-dc/DC] 갱신: ${dc.disclosures.length}건 (오늘 ${todayFiles.length}파일)`);

    } catch (e) {
        console.warn(`[dart-dc/DC] 갱신 실패: ${e.message}`);
    }
}

// ════════════════════════════════════════════════
// 4. 7일 보존규칙 — 오래된 dart_*.json 삭제
// ════════════════════════════════════════════════

/** dart_*.json 7일 경과 파일 삭제 */
function cleanOldDart() {
    const kst = new Date(Date.now() + 9 * 3600000);
    const cutoff = new Date(kst);
    cutoff.setDate(cutoff.getDate() - 7);
    const cutoffStr = cutoff.getUTCFullYear().toString() +
        String(cutoff.getUTCMonth() + 1).padStart(2, '0') +
        String(cutoff.getUTCDate()).padStart(2, '0');

    try {
        const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('dart_') && f.endsWith('.json'));
        let removed = 0;
        for (const f of files) {
            const match = f.match(/dart_(\d{8})/);
            if (match && match[1] < cutoffStr) {
                fs.unlinkSync(path.join(DATA_DIR, f));
                removed++;
            }
        }
        if (removed > 0) console.log(`[dart-dc/보존] ${removed}파일 삭제 (7일 경과)`);
    } catch (e) {
        console.warn(`[dart-dc/보존] 정리 실패: ${e.message}`);
    }
}

// ════════════════════════════════════════════════
// 5. 외부 인터페이스 — getDartData(date)
// ════════════════════════════════════════════════

/**
 * 날짜별 공시 데이터 반환 (routes/dart.js에서 사용)
 * DC에서 가져오고, 없으면 파일에서 직접 읽기
 * @param {string} date - YYYYMMDD (없으면 오늘)
 * @returns {{ list: Array, status: string, total_count: number }}
 */
function getDartData(date) {
    date = date || getToday();

    // 1순위: DC에서 날짜 필터
    if (_app && _app.locals.claudeDataCenter) {
        const dc = _app.locals.claudeDataCenter;
        if (dc.disclosures && dc.disclosures.length > 0) {
            const filtered = dc.disclosures.filter(d => d.rcept_dt === date);
            // 날짜 지정 없거나 해당 날짜 데이터 있으면 반환
            if (filtered.length > 0) {
                return { status: '000', list: filtered, total_count: filtered.length, _source: 'dc' };
            }
            // 날짜 지정 없으면 DC 전체 반환
            if (date === getToday()) {
                return { status: '000', list: dc.disclosures, total_count: dc.disclosures.length, _source: 'dc' };
            }
        }
    }

    // 2순위: 파일에서 직접 읽기 (과거 날짜 등)
    try {
        const files = fs.readdirSync(DATA_DIR)
            .filter(f => f.startsWith(`dart_${date}`) && f.endsWith('.json'))
            .sort();

        if (files.length > 0) {
            let allItems = [];
            for (const f of files) {
                try {
                    const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf-8'));
                    if (data.list) allItems.push(...data.list);
                } catch (e) { }
            }
            return { status: '000', list: allItems, total_count: allItems.length, _source: 'file' };
        }
    } catch (e) { }

    // 데이터 없음
    return { status: '013', message: '조회된 데이터가 없습니다', list: [], total_count: 0 };
}

// ════════════════════════════════════════════════
// 초기화 — server.js에서 호출
// ════════════════════════════════════════════════

/**
 * dart-dc 초기화
 * @param {object} app - Express app
 */
function init(app) {
    _app = app;

    // Gemini 키 확인
    const apiKey = process.env.GEMINI_KEY_STOCK || process.env.GEMINI_KEY_NEWS || config.GEMINI_KEY_NEWS;

    console.log('[dart-dc] 초기화 시작');

    // ① 보존규칙 (서버 시작 시 1회)
    cleanOldDart();

    // ② 수집+분류 (30초 후 첫 실행, 이후 10분마다)
    if (apiKey) {
        setTimeout(() => analyzeDartFiles(apiKey), 30000);
        setInterval(() => analyzeDartFiles(apiKey), 600000);
        console.log('[dart-dc] 수집+분류 타이머 시작 (10분)');
    } else {
        console.log('[dart-dc] Gemini 키 없음 — 수집만 활성화');
        setTimeout(() => collectDartToday(), 30000);
        setInterval(() => collectDartToday(), 600000);
    }

    // ③ DC 갱신 (15초 후 첫 실행, 이후 5분마다)
    setTimeout(() => updateDisclosures(), 15000);
    setInterval(() => updateDisclosures(), 300000);
    console.log('[dart-dc] DC 갱신 타이머 시작 (5분)');

    console.log('[dart-dc] 초기화 완료');
}

/** 상태 조회 */
function getStatus() {
    return {
        isAnalyzing,
        lastAnalyzedAt,
        lastCollectedAt,
        lastDCUpdatedAt,
        totalAnalyzed,
        totalCollected,
        disclosureCount: _app?.locals?.claudeDataCenter?.disclosures?.length || 0
    };
}

module.exports = { init, getDartData, getStatus, updateDisclosures };
