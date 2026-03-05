/**
 * 증권사 리포트 분류기 — 독립 모듈
 * 
 * 분류 흐름:
 *   1. 규칙 필터 — 키워드로 자동 분류 (즉시, AI 호출 0)
 *   2. Quick AI — 제목+종목명으로 분류 (2초/건)
 *   3. "확인필요" 건 → 1시간 후 Search AI (뉴스 검색 포함, 30초/건)
 *   4. 그래도 "확인필요" → 그대로 유지
 * 
 * 장애 대응:
 *   - 연속 3회 실패 → AI 중단, 미분류 유지 (다음 사이클 재시도)
 *   - 파일 저장: 분류 후 즉시 저장
 * 
 * 분류 체계: 매수 / 중립 / 매도 / 산업분석 / 확인필요
 * API: Gemini KEY 전용 (독립 쿼터)
 */

const axios = require('axios');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// ── 설정 ──
const GEMINI_KEY = process.env.GEMINI_KEY || '';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const QUICK_DELAY_MS = 5000;   // Quick AI 호출 간 대기 (thinking 모델 여유)
const SEARCH_DELAY_MS = 5000;  // Search AI 호출 간 대기
const MAX_CONSECUTIVE_FAILS = 3; // 연속 실패 허용 횟수
const RETRY_WAIT_MS = 3600000;   // 확인필요 재시도 대기 (1시간)
const DATA_DIR = path.join(__dirname, 'data');
const PENDING_DIR = path.join(__dirname, 'pending');

// ── 상태 ──
let isRunning = false;
let lastRunAt = null;
let stats = { rule: 0, quickAI: 0, searchAI: 0, total: 0 };
let _aiPausedUntil = 0; // AI 쿨다운 타임스탬프
const MAX_RETRY_COUNT = 3; // 아이템별 최대 재시도 횟수
const AI_COOLDOWN_MS = 1800000; // AI 연속실패 시 30분 쿨다운

// ════════════════════════════════════════════════
// 규칙 필터 — 키워드 기반 자동 분류
// ════════════════════════════════════════════════

// 매수 — 긍정적 투자의견 키워드
const RULE_BUY = [
    '매수', 'Buy', 'BUY', 'Outperform', '비중확대', 'Trading Buy',
    '목표주가 상향', '목표가 상향', '실적 호조', '실적 서프라이즈',
    '어닝 서프라이즈',
];

// 매도 — 부정적 투자의견 키워드
const RULE_SELL = [
    '매도', 'Sell', 'SELL', 'Underperform', '비중축소',
    '목표주가 하향', '목표가 하향', '실적 부진', '어닝 쇼크',
    '실적 미스',
];

// 중립 — 관망 키워드
const RULE_NEUTRAL = [
    '중립', 'Hold', 'HOLD', 'Neutral', '시장수익률',
    'Not Rated', 'N/R', 'NR',
];

// 산업분석 — 산업/섹터 리포트 키워드
const RULE_INDUSTRY = [
    '산업분석', '산업동향', '섹터', 'Sector', '업종',
    'Industry', '시장전망', '경제전망',
];

// 규칙 기반 분류 — 리포트 제목 + 의견 키워드 매칭
function classifyByRule(title, opinion) {
    const combined = `${title || ''} ${opinion || ''}`;

    // 산업분석 먼저 (제목에서)
    for (const kw of RULE_INDUSTRY) {
        if (combined.includes(kw)) return '산업분석';
    }
    // 매도를 먼저 (놓치면 위험)
    for (const kw of RULE_SELL) {
        if (combined.includes(kw)) return '매도';
    }
    for (const kw of RULE_BUY) {
        if (combined.includes(kw)) return '매수';
    }
    for (const kw of RULE_NEUTRAL) {
        if (combined.includes(kw)) return '중립';
    }

    return null; // AI 분류 필요
}

// ════════════════════════════════════════════════
// Quick AI — 검색 없이 제목만으로 빠른 분류
// ════════════════════════════════════════════════

// Quick AI — 제목+종목명+증권사명으로 분류 (2초/건)
async function classifyQuick(item) {
    if (!GEMINI_KEY) return null;

    const prompt = `다음 증권사 리포트의 투자 성격을 판단해주세요.

종목: ${item.corp}
제목: ${item.title}
증권사: ${item.broker}
${item.opinion ? `투자의견: ${item.opinion}` : ''}
${item.targetPrice ? `목표주가: ${item.targetPrice.toLocaleString()}원` : ''}

아래 5가지 중 하나만 답하세요 (다른 말 없이 딱 한 단어):
매수 — 긍정적 투자의견 (Buy, Outperform, 비중확대 등)
중립 — 관망 (Hold, Neutral, 시장수익률 등)
매도 — 부정적 투자의견 (Sell, Underperform, 비중축소 등)
산업분석 — 산업/섹터 전체 분석
확인필요 — 판단 불가`;

    try {
        const resp = await axios.post(
            `${GEMINI_URL}?key=${GEMINI_KEY}`,
            {
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.1, maxOutputTokens: 100 },
            },
            { timeout: 15000, headers: { 'Content-Type': 'application/json' } }
        );

        const text = (resp.data?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
        return parseClsResponse(text);

    } catch (e) {
        console.error(`[Quick AI] 실패: ${e.message}`);
        return null;
    }
}

// ════════════════════════════════════════════════
// Search AI — 뉴스 검색 포함 정밀 분류 (확인필요 재시도용)
// ════════════════════════════════════════════════

async function classifyWithSearch(item) {
    if (!GEMINI_KEY) return '확인필요';

    const prompt = `다음 증권사 리포트의 투자 성격을 판단해주세요.

종목: ${item.corp}
제목: ${item.title}
증권사: ${item.broker}
${item.opinion ? `투자의견: ${item.opinion}` : ''}
${item.targetPrice ? `목표주가: ${item.targetPrice.toLocaleString()}원` : ''}

리포트 제목과 종목 정보를 바탕으로 판단하세요.
방향을 알 수 없으면 "확인필요"로 답하세요.

아래 5가지 중 하나만 답하세요 (다른 말 없이 딱 한 단어):
매수 — 긍정적
중립 — 관망
매도 — 부정적
산업분석 — 산업/섹터 분석
확인필요 — 판단 불가`;

    try {
        const resp = await axios.post(
            `${GEMINI_URL}?key=${GEMINI_KEY}`,
            {
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.1, maxOutputTokens: 256 },
            },
            { timeout: 30000, headers: { 'Content-Type': 'application/json' } }
        );

        const text = (resp.data?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
        return parseClsResponse(text) || '확인필요';

    } catch (e) {
        console.error(`[Search AI] 실패: ${e.message}`);
        return '확인필요';
    }
}

// ════════════════════════════════════════════════
// 응답 파싱 — 공통 키워드 추출
// ════════════════════════════════════════════════

// AI 응답에서 분류 키워드 추출
function parseClsResponse(text) {
    if (!text) return null;
    if (text.includes('확인필요') || text.includes('확인')) return '확인필요';
    if (text.includes('산업분석') || text.includes('산업')) return '산업분석';
    if (text.includes('매도')) return '매도';
    if (text.includes('매수')) return '매수';
    if (text.includes('중립')) return '중립';
    return null;
}

// ════════════════════════════════════════════════
// 메인: 전체 분류 실행
// ════════════════════════════════════════════════

/**
 * 수집된 리포트 배열 분류 (규칙 → Quick AI)
 * 수집 사이클마다 호출됨
 * @param {Array} items - collector.getTodayItems()
 * @param {Function} saveFn - 파일 저장 함수 (분류 후 호출)
 */
async function classifyAll(items, saveFn) {
    if (isRunning) {
        console.log('[분류] 이미 실행 중 — 스킵');
        return;
    }

    isRunning = true;
    let ruleCount = 0;
    let aiCount = 0;
    let consecutiveFails = 0;

    try {
        // 미분류 항목 (= _cls가 없는 것, _retryCount 3회 이상은 기타로 확정)
        const unclassified = [];
        for (const item of items) {
            if (item._cls) continue;
            if ((item._retryCount || 0) >= MAX_RETRY_COUNT) {
                item._cls = '기타';
                item._clsBy = 'fallback';
                item.opinion = '기타';  // 뷰어 표시용
                console.log(`[분류] ${item.corp} "${item.title}" → 기타 (${MAX_RETRY_COUNT}회 실패)`);
                continue;
            }
            unclassified.push(item);
        }
        if (unclassified.length === 0) return;

        // AI 쿨다운 체크
        if (Date.now() < _aiPausedUntil) {
            const remaining = Math.ceil((_aiPausedUntil - Date.now()) / 60000);
            console.log(`[분류] AI 쿨다운 중 — ${remaining}분 후 재시도`);
            return;
        }

        console.log(`[분류] 미분류 ${unclassified.length}건 처리 시작`);

        // ── 1단계: 규칙 필터 (즉시) ──
        const needAI = [];
        for (const item of unclassified) {
            const cls = classifyByRule(item.title, item.opinion);
            if (cls) {
                item._cls = cls;
                item._clsBy = 'rule';
                item.opinion = cls;  // 뷰어 표시용
                ruleCount++;
            } else {
                needAI.push(item);
            }
        }

        if (ruleCount > 0) {
            console.log(`[분류] 규칙: ${ruleCount}건 완료`);
        }

        // ── 2단계: Quick AI (검색 없이, 1건씩) ──
        if (needAI.length > 0 && GEMINI_KEY) {
            console.log(`[분류] Quick AI: ${needAI.length}건 시작`);

            for (let i = 0; i < needAI.length; i++) {
                const item = needAI[i];
                const cls = await classifyQuick(item);

                if (cls) {
                    item._cls = cls;
                    item._clsBy = 'ai_quick';
                    item.opinion = cls;  // 뷰어 표시용
                    if (cls === '확인필요') {
                        item._clsAt = Date.now(); // 1시간 후 재시도용
                    }
                    aiCount++;
                    consecutiveFails = 0;
                } else {
                    consecutiveFails++;
                    item._retryCount = (item._retryCount || 0) + 1;
                    console.log(`[분류] 실패 ${consecutiveFails}/${MAX_CONSECUTIVE_FAILS} (아이템 재시도 ${item._retryCount}/${MAX_RETRY_COUNT})`);

                    if (consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
                        _aiPausedUntil = Date.now() + AI_COOLDOWN_MS;
                        console.log(`[분류] 연속 ${MAX_CONSECUTIVE_FAILS}회 실패 → AI 30분 쿨다운`);
                        break;
                    }
                }

                if ((i + 1) % 50 === 0) {
                    console.log(`[분류] ${i + 1}/${needAI.length}건 완료`);
                }

                if (i < needAI.length - 1) await sleep(QUICK_DELAY_MS);
            }
        }

        // ── 통계 업데이트 ──
        stats.rule += ruleCount;
        stats.quickAI += aiCount;
        stats.total += ruleCount + aiCount;
        lastRunAt = new Date().toISOString();

        console.log(`[분류] 완료 — 규칙:${ruleCount} AI:${aiCount}`);

        // ── 파일 저장 ──
        if (saveFn && (ruleCount + aiCount > 0)) {
            saveFn();
            console.log('[분류] 파일 저장 완료');
        }

    } catch (e) {
        console.error(`[분류] 오류: ${e.message}`);
    } finally {
        isRunning = false;
    }
}

// ════════════════════════════════════════════════
// Search AI 재시도 — 1시간 경과한 "확인필요" 건 처리
// ════════════════════════════════════════════════

/**
 * "확인필요" + 1시간 경과한 건만 Search AI로 재분류
 * @param {Array} items - collector.getTodayItems()
 * @param {Function} saveFn - 파일 저장 함수
 */
async function retryPending(items, saveFn) {
    if (isRunning) return;

    const now = Date.now();
    const pending = items.filter(item =>
        item._cls === '확인필요' &&
        item._clsBy === 'ai_quick' &&
        item._clsAt &&
        (now - item._clsAt) >= RETRY_WAIT_MS
    );

    if (pending.length === 0) return;

    isRunning = true;
    let retried = 0;

    try {
        console.log(`[Search AI] ${pending.length}건 재분류 시작 (1시간 경과)`);

        for (let i = 0; i < pending.length; i++) {
            const item = pending[i];
            const cls = await classifyWithSearch(item);

            item._cls = cls;
            item._clsBy = 'ai_search';
            item.opinion = cls;  // 뷰어 표시용
            delete item._clsAt;
            retried++;

            if (i < pending.length - 1) await sleep(SEARCH_DELAY_MS);
        }

        stats.searchAI += retried;
        console.log(`[Search AI] ${retried}건 재분류 완료`);

        if (saveFn && retried > 0) saveFn();

    } catch (e) {
        console.error(`[Search AI] 오류: ${e.message}`);
    } finally {
        isRunning = false;
    }
}

// 유틸: 파일 경로
function ensurePendingDir() {
    if (!fs.existsSync(PENDING_DIR)) fs.mkdirSync(PENDING_DIR, { recursive: true });
}
function getPendingPath(dateStr) {
    ensurePendingDir();
    return path.join(PENDING_DIR, `pending_${dateStr}.json`);
}
function getReportsPath(dateStr) {
    return path.join(DATA_DIR, `reports_${dateStr}.json`);
}
function getToday() {
    return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10).replace(/-/g, '');
}

// ════════════════════════════════════════════════
// 분류된 항목을 reports 파일로 이동 (병합 + 중복제거)
// ════════════════════════════════════════════════

function moveToReports(dateStr, classifiedItems) {
    if (!classifiedItems || classifiedItems.length === 0) return;

    const reportsPath = getReportsPath(dateStr);
    let existing = [];

    // 기존 reports 파일 로드
    if (fs.existsSync(reportsPath)) {
        try {
            const data = JSON.parse(fs.readFileSync(reportsPath, 'utf-8'));
            existing = data.items || [];
        } catch (e) {
            console.error(`[분류] reports 로드 실패: ${e.message}`);
        }
    }

    // 중복 제거 후 병합
    const existingKeys = new Set(existing.map(r => `${r.corp}|${r.title}|${r.date}`));
    let added = 0;
    for (const item of classifiedItems) {
        const key = `${item.corp}|${item.title}|${item.date}`;
        if (!existingKeys.has(key)) {
            existing.push(item);
            existingKeys.add(key);
            added++;
        }
    }

    // _crawledAt 역순 정렬 후 저장 (viewer와 동일 기준)
    existing.sort((a, b) => (b._crawledAt || '').localeCompare(a._crawledAt || ''));

    const saveData = {
        date: dateStr,
        total: existing.length,
        _classifiedAt: new Date().toISOString(),
        items: existing,
    };
    fs.writeFileSync(reportsPath, JSON.stringify(saveData, null, 2), 'utf-8');
    console.log(`[분류] reports 저장: +${added}건 (총 ${existing.length}건)`);
}

// ════════════════════════════════════════════════
// pending 파일에서 분류 실행 (chain에서 호출)
// pending/ 폴더의 모든 파일 처리 — 오늘 먼저, 어제 이전은 그 후에
// ════════════════════════════════════════════════

async function classifyPending() {
    ensurePendingDir();

    // pending/ 폴더의 모든 pending_*.json 파일 목록
    const allFiles = fs.readdirSync(PENDING_DIR)
        .filter(f => f.startsWith('pending_') && f.endsWith('.json'))
        .sort(); // 날짜순 (오래된 것 먼저)

    if (allFiles.length === 0) {
        console.log('[분류] pending 파일 없음 — 스킵');
        return;
    }

    // 오늘 파일 먼저, 나머지는 그 후에
    const today = getToday();
    const todayFile = `pending_${today}.json`;
    const sortedFiles = [];
    if (allFiles.includes(todayFile)) sortedFiles.push(todayFile);
    for (const f of allFiles) {
        if (f !== todayFile) sortedFiles.push(f);
    }

    console.log(`[분류] pending 파일 ${sortedFiles.length}개 처리 시작`);

    for (const fileName of sortedFiles) {
        const fileDateStr = fileName.replace('pending_', '').replace('.json', '');
        const filePath = path.join(PENDING_DIR, fileName);

        let data;
        try {
            data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        } catch (e) {
            console.error(`[분류] ${fileName} 읽기 실패: ${e.message}`);
            continue;
        }

        const items = data.items || [];
        if (items.length === 0) {
            try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
            continue;
        }

        console.log(`[분류] ${fileName}: ${items.length}건 분류 시작`);

        // 분류 실행 (saveFn은 null — 우리가 직접 파일 관리)
        await classifyAll(items, null);

        // 분류된 항목 / 미분류 항목 분리
        const classified = [];   // reports로 이동
        const stillPending = []; // pending에 유지

        for (const item of items) {
            if (item._cls && item._cls !== '확인필요') {
                classified.push(item);
            } else if (item._cls === '확인필요' && item._clsBy === 'ai_quick') {
                stillPending.push(item);
            } else if (!item._cls) {
                stillPending.push(item);
            } else {
                item._cls = '기타';
                item._clsBy = 'fallback';
                item.opinion = '기타';
                classified.push(item);
            }
        }

        // 분류된 항목 → reports 파일로 이동 (해당 날짜 파일에)
        if (classified.length > 0) {
            moveToReports(fileDateStr, classified);
        }

        // 남은 항목 → pending 파일 업데이트
        if (stillPending.length > 0) {
            data.items = stillPending;
            data.total = stillPending.length;
            data._classifiedAt = new Date().toISOString();
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
            console.log(`[분류] ${fileName}: 잔여 ${stillPending.length}건`);
        } else {
            try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
            console.log(`[분류] ${fileName}: 완료 — 파일 삭제`);
        }

        console.log(`[분류] ${fileName}: 분류${classified.length}건 → reports, 대기${stillPending.length}건`);
    }
}

// ════════════════════════════════════════════════
// 확인필요 재시도 + 최종 기타 변환 (chain에서 1시간 주기로 호출)
// ════════════════════════════════════════════════

async function retryAndFinalize() {
    ensurePendingDir();

    const allFiles = fs.readdirSync(PENDING_DIR)
        .filter(f => f.startsWith('pending_') && f.endsWith('.json'))
        .sort();

    if (allFiles.length === 0) return;

    console.log(`[재시도] pending 파일 ${allFiles.length}개 재시도 시작`);

    for (const fileName of allFiles) {
        const fileDateStr = fileName.replace('pending_', '').replace('.json', '');
        const filePath = path.join(PENDING_DIR, fileName);

        let data;
        try {
            data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        } catch (e) {
            console.error(`[재시도] ${fileName} 읽기 실패: ${e.message}`);
            continue;
        }

        const items = data.items || [];
        if (items.length === 0) {
            try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
            continue;
        }

        // 1) Search AI 재시도 (1시간 경과한 확인필요 건)
        const saveFn = () => {
            data.items = items;
            data._retryAt = new Date().toISOString();
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
        };
        await retryPending(items, saveFn);

        // 2) 재시도 후에도 남은 항목 처리
        const classified = [];
        const stillPending = [];

        for (const item of items) {
            if (item._cls && item._cls !== '확인필요') {
                classified.push(item);
            } else if (item._cls === '확인필요' && item._clsBy === 'ai_search') {
                item._cls = '기타';
                item._clsBy = 'fallback';
                item.opinion = '기타';
                classified.push(item);
                console.log(`[재시도] ${item.corp} "${item.title}" → 기타`);
            } else if (item._cls === '확인필요' && item._clsBy === 'ai_quick' && item._clsAt) {
                const age = Date.now() - item._clsAt;
                if (age < RETRY_WAIT_MS) {
                    stillPending.push(item);
                } else {
                    item._cls = '기타';
                    item._clsBy = 'fallback';
                    item.opinion = '기타';
                    classified.push(item);
                    console.log(`[재시도] ${item.corp} "${item.title}" → 기타 (재시도 실패)`);
                }
            } else {
                stillPending.push(item);
            }
        }

        // 분류된 항목 → reports (해당 날짜 파일에)
        if (classified.length > 0) {
            moveToReports(fileDateStr, classified);
        }

        // pending 업데이트
        if (stillPending.length > 0) {
            data.items = stillPending;
            data.total = stillPending.length;
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
            console.log(`[재시도] ${fileName}: 잔여 ${stillPending.length}건`);
        } else {
            try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
            console.log(`[재시도] ${fileName}: 완료 — 파일 삭제`);
        }
    }
}

// ════════════════════════════════════════════════
// 뷰어용 — 미분류 제외한 데이터만 반환
// ════════════════════════════════════════════════

// 뷰어용 데이터 필터 — 미분류, Quick의 "확인필요"(Search AI 대기 중) 제외
function getItemsForViewer(items) {
    return items.filter(item => {
        if (!item._cls) return false;                // 미분류 제외
        // Quick AI의 "확인필요"는 Search AI 대기 중이므로 제외
        if (item._cls === '확인필요' && item._clsBy === 'ai_quick') return false;
        return true;
    });
}

// ════════════════════════════════════════════════
// 외부 인터페이스
// ════════════════════════════════════════════════

// 상태 조회
function getStatus() {
    return {
        isRunning,
        lastRunAt,
        stats,
    };
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
    classifyByRule,
    classifyQuick,
    classifyWithSearch,
    classifyAll,
    retryPending,
    classifyPending,
    retryAndFinalize,
    moveToReports,
    getItemsForViewer,
    getStatus,
};

// ════════════════════════════════════════════════
// 독립 실행 모드 — node report-classifier.js [--search]
// ════════════════════════════════════════════════

if (require.main === module) {
    (async () => {
        const isSearch = process.argv.includes('--search');
        const mode = isSearch ? 'Search AI 재분류' : 'Quick AI 분류';
        console.log(`[분류] 독립 실행 시작 — ${mode}`);

        if (isSearch) {
            // Search AI 재시도 + 기타 변환
            await retryAndFinalize();
        } else {
            // pending 파일에서 분류
            await classifyPending();
        }

        console.log('[분류] 독립 실행 완료');
        process.exit(0);
    })();
}
