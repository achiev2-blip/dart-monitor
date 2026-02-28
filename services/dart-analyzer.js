/**
 * DART 공시 수집 + 분석기 — KEY2 독립 모듈
 * 역할: (1) DART API에서 오늘 공시 자동 수집 → dart_*.json 저장
 *       (2) 새 공시를 읽고 호재/악재/중립 분류 + 한줄 요약 생성
 * 키: GEMINI_KEY_NEWS (공시 분석 전용)
 * 트리거: 주기적 실행 (10분마다)
 * 읽기/쓰기: data/dart_*.json
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

// 데이터 디렉토리 경로
const DATA_DIR = path.join(__dirname, '..', 'data');

// Gemini API 설정 (config에서 읽기)
const config = require('../config');
// GEMINI_BASE가 /models/로 끝나지 않으면 추가
let base = config.GEMINI_BASE || 'https://generativelanguage.googleapis.com/v1beta/';
if (!base.endsWith('models/')) base += 'models/';
const GEMINI_BASE = base;
const MODEL = 'gemini-2.5-flash';

// DART API 설정
const DART_API_KEY = config.DART_API_KEY;
const DART_API_BASE = 'https://opendart.fss.or.kr/api/list.json';
const MAX_PAGES = 5;

// 상태 추적
let isAnalyzing = false;
let lastAnalyzedAt = null;
let lastCollectedAt = null;
let totalAnalyzed = 0;
let totalCollected = 0;

/**
 * 초기화 — server.js에서 호출
 * @param {Object} opts - { geminiKeyNews: string, intervalMs: number }
 */
function init(opts = {}) {
    // .env에서 직접 읽기 — KEY_NEWS가 이전 키라 3번(STOCK) 사용
    const apiKey = opts.geminiKeyNews || process.env.GEMINI_KEY_STOCK || process.env.GEMINI_KEY_NEWS;
    const intervalMs = opts.intervalMs || 600000; // 기본 10분

    if (!apiKey) {
        console.log('[공시분석] GEMINI_KEY_NEWS 없음 — 비활성화');
        return;
    }

    console.log(`[공시분석] KEY2 초기화 — ${intervalMs / 1000}초 간격`);

    // 초기 실행 (서버 시작 30초 후)
    setTimeout(() => analyzeDartFiles(apiKey), 30000);

    // 주기적 실행
    setInterval(() => analyzeDartFiles(apiKey), intervalMs);
}

/**
 * DART 파일에서 미분류 공시 찾아서 분석
 * @param {string} apiKey - Gemini API 키
 */
async function analyzeDartFiles(apiKey) {
    if (isAnalyzing) {
        console.log('[공시분석] 이미 분석 중 — 스킵');
        return;
    }

    isAnalyzing = true;

    try {
        // [STEP 1] 오늘 공시 자동 수집 (DART API → 파일 저장)
        await collectDartToday();

        // [STEP 2] 오늘 날짜의 dart 파일만 읽기
        const today = getToday();
        const dartFiles = fs.readdirSync(DATA_DIR)
            .filter(f => f.startsWith(`dart_${today}`) && f.endsWith('.json'))
            .sort();

        if (dartFiles.length === 0) {
            isAnalyzing = false;
            return;
        }

        let unclassified = [];

        // 미분류 공시 수집
        for (const fileName of dartFiles) {
            const filePath = path.join(DATA_DIR, fileName);
            try {
                const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                const items = data.list || [];
                items.forEach((item, idx) => {
                    if (!item._aiCls) {
                        unclassified.push({ fileName, idx, item });
                    }
                });
            } catch (e) { }
        }

        if (unclassified.length === 0) {
            isAnalyzing = false;
            return;
        }

        console.log(`[공시분석] 미분류 ${unclassified.length}건 발견 — 분석 시작`);

        // 배치 분석 (10건씩)
        const batchSize = 10;
        for (let i = 0; i < unclassified.length; i += batchSize) {
            const batch = unclassified.slice(i, i + batchSize);
            await classifyBatch(batch, apiKey);

            // API 과부하 방지 — 배치 간 2초 대기
            if (i + batchSize < unclassified.length) {
                await sleep(2000);
            }
        }

        // 분류 결과를 파일에 저장
        saveDartFiles(unclassified);

        lastAnalyzedAt = new Date().toISOString();
        console.log(`[공시분석] 완료 — ${unclassified.length}건 분류 (총 누적: ${totalAnalyzed}건)`);

    } catch (e) {
        console.error(`[공시분석] 오류: ${e.message}`);
    } finally {
        isAnalyzing = false;
    }
}

/**
 * 배치 분류 — Gemini에 10건씩 요청
 * @param {Array} batch - 분류할 공시 목록
 * @param {string} apiKey - Gemini API 키
 */
async function classifyBatch(batch, apiKey) {
    // 프롬프트 조립
    const items = batch.map((b, i) =>
        `${i + 1}. ${b.item.corp_name || '?'} — ${b.item.report_nm || '?'}`
    ).join('\n');

    const prompt = `한국 DART 공시를 분류해주세요. 반드시 JSON 배열로만 답하세요.

공시 목록:
${items}

각 공시에 대해 다음 JSON 배열 형식으로 응답:
[
  { "idx": 1, "cls": "호재|악재|중립", "summary": "10자 이내 한줄요약" },
  ...
]

분류 기준:
- 호재: 매출증가, 실적호전, 투자유치, 배당증가, 자사주매입 등
- 악재: 적자전환, 감자, 상폐위험, 소송, 횡령, 매출감소 등
- 중립: 정기공시, 주총소집, 임원변경, 일반 보고서 등`;

    try {
        const url = `${GEMINI_BASE}${MODEL}:generateContent?key=${apiKey}`;
        const resp = await axios.post(url, {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.2, maxOutputTokens: 500 }
        }, { timeout: 15000, headers: { 'Content-Type': 'application/json' } });

        const text = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

        // JSON 파싱
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
            const results = JSON.parse(jsonMatch[0]);
            results.forEach(r => {
                const target = batch[r.idx - 1];
                if (target) {
                    target.item._aiCls = r.cls || '중립';
                    target.item._aiSummary = r.summary || '';
                    totalAnalyzed++;
                }
            });
        }
    } catch (e) {
        console.error(`[공시분석] Gemini 호출 실패: ${e.message}`);
        // 실패 시 기본값 설정
        batch.forEach(b => {
            b.item._aiCls = '중립';
            b.item._aiSummary = '';
        });
    }
}

/**
 * 분류 결과를 dart 파일에 저장
 * @param {Array} classified - 분류 완료된 항목 목록
 */
function saveDartFiles(classified) {
    // 파일별로 그룹핑
    const byFile = {};
    classified.forEach(c => {
        if (!byFile[c.fileName]) byFile[c.fileName] = [];
        byFile[c.fileName].push(c);
    });

    // 각 파일 저장
    for (const [fileName, items] of Object.entries(byFile)) {
        const filePath = path.join(DATA_DIR, fileName);
        try {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            // 분류 결과 반영
            items.forEach(item => {
                if (data.list && data.list[item.idx]) {
                    data.list[item.idx]._aiCls = item.item._aiCls;
                    data.list[item.idx]._aiSummary = item.item._aiSummary;
                }
            });
            // 분석 시각 기록
            data._analyzedAt = new Date().toISOString();
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
        } catch (e) {
            console.error(`[공시분석] 파일 저장 실패 ${fileName}: ${e.message}`);
        }
    }
}

/**
 * 오늘 날짜 반환 (KST, YYYYMMDD)
 */
function getToday() {
    const d = new Date();
    d.setHours(d.getHours() + 9);
    return d.toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * 대기 유틸리티
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 분석 상태 조회
 */
/**
 * DART API에서 오늘 공시 수집 → dart_*.json 저장
 */
async function collectDartToday() {
    if (!DART_API_KEY) return;

    const today = getToday();
    const kstNow = new Date(Date.now() + 9 * 3600000);
    const kstHour = kstNow.getUTCHours();

    // 영업시간 외엔 수집 안 함 (KST 08~19시만)
    if (kstHour < 8 || kstHour >= 19) return;

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
            console.error(`[공시수집] p${p} 실패: ${e.message}`);
            break;
        }
    }

    if (totalItems > 0) {
        totalCollected += totalItems;
        lastCollectedAt = new Date().toISOString();
        const kstStr = kstNow.toISOString().replace('T', ' ').slice(0, 19);
        console.log(`[공시수집] ${kstStr} KST ${today} 수집완료: ${totalItems}건 ${newPages}페이지`);
    }
}

function getStatus() {
    return {
        isAnalyzing,
        lastAnalyzedAt,
        lastCollectedAt,
        totalAnalyzed,
        totalCollected
    };
}

module.exports = { init, getStatus };
