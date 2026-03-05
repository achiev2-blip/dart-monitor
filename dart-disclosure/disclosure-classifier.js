/**
 * DART 공시 분류기 — 독립 모듈 (v2)
 * 
 * 분류 흐름:
 *   1. 규칙 필터 — 키워드로 자동 분류 (즉시, AI 호출 0)
 *   2. Quick AI — 검색 없이 제목만 분류 (2초/건)
 *   3. "확인필요" 건 → 1시간 후 Search AI (뉴스 검색 포함, 30초/건)
 *   4. 그래도 "확인필요" → 그대로 DC에 넘김
 * 
 * 장애 대응:
 *   - 연속 3회 실패 → AI 중단, 미분류 유지 (다음 사이클 재시도)
 *   - 파일 저장: 분류 후 즉시 저장
 *   - 날짜 변경 감지 시 중단
 * 
 * 분류 체계: 강력호재 / 호재 / 악재 / 일반 / 확인필요
 * DC 저장 규칙: "일반"과 미분류는 DC에 안 넣음
 * API: Gemini KEY4 전용 (독립 쿼터)
 */

const axios = require('axios');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// ── 설정 ──
const GEMINI_KEY = process.env.GEMINI_KEY || '';
// 정확도 최우선: 2.5-flash (thinking model, 최고 성능)
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const QUICK_DELAY_MS = 5000;   // Quick AI 호출 간 대기 (5초)
const SEARCH_DELAY_MS = 5000;  // Search AI 호출 간 대기
const MAX_CONSECUTIVE_FAILS = 3; // 연속 실패 허용 횟수
const RETRY_WAIT_MS = 3600000;   // 확인필요 재시도 대기 (1시간)
const DATA_DIR = path.join(__dirname, 'data');

// ── 상태 ──
let isRunning = false;
let lastRunAt = null;
let stats = { rule: 0, quickAI: 0, searchAI: 0, total: 0 };

// ════════════════════════════════════════════════
// 규칙 필터 — 키워드 기반 자동 분류
// ════════════════════════════════════════════════

// 강력호재 — 시세 급등 가능
const RULE_STRONG_POS = [
    '자기주식취득', '자사주매입', '공개매수', '무상증자',
    '주식배당', '액면분할',
];

// 호재 — 시세 상승 가능
const RULE_POSITIVE = [
    '자기주식', '자사주',
    '주식매수선택권', '전환사채권발행',
];

// 악재 — 시세 하락 가능
const RULE_NEGATIVE = [
    '횡령', '배임', '상장폐지', '거래정지', '관리종목',
    '회생절차', '파산', '영업정지', '감자', '유상증자',
    '자기주식처분',
];

// 일반 — 정형적, 시세 영향 낮음
const RULE_NORMAL = [
    '기재정정', '첨부정정', '정정신고서', '정정보고서',
    '임원·주요주주특정증권등소유상황',
    '주식등의대량보유상황보고서',
];

// 규칙 기반 분류 — 공시 제목 키워드 매칭
function classifyByRule(reportNm) {
    const title = reportNm || '';

    for (const kw of RULE_NORMAL) {
        if (title.includes(kw)) return '일반';
    }
    // 악재를 먼저 (상폐/횡령 놓치면 위험)
    for (const kw of RULE_NEGATIVE) {
        if (title.includes(kw)) return '악재';
    }
    for (const kw of RULE_STRONG_POS) {
        if (title.includes(kw)) return '강력호재';
    }
    for (const kw of RULE_POSITIVE) {
        if (title.includes(kw)) return '호재';
    }

    return null; // AI 분류 필요
}

// ════════════════════════════════════════════════
// Quick AI — 검색 없이 제목만으로 빠른 분류
// ════════════════════════════════════════════════

// Quick AI — 검색 없이 제목+회사명만으로 분류 (2초/건)
async function classifyQuick(item) {
    if (!GEMINI_KEY) return null; // 키 없으면 미분류 유지

    const prompt = `다음 DART 공시가 주식 시세에 미치는 영향을 판단해주세요.

회사: ${item.corp_name}
공시제목: ${item.report_nm}
유형: ${item.corp_cls === 'Y' ? '유가증권' : item.corp_cls === 'K' ? '코스닥' : '기타'}

아래 5가지 중 하나만 답하세요 (다른 말 없이 딱 한 단어):
강력호재 — 주가 급등 가능 (자사주 매입, 무상증자, 공개매수 등)
호재 — 주가 상승 가능
악재 — 주가 하락 가능 (상폐, 감자, 횡령 등)
일반 — 시세 무관
확인필요 — 공시 제목만으로 판단 불가`;

    try {
        const resp = await axios.post(
            `${GEMINI_URL}?key=${GEMINI_KEY}`,
            {
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.1, maxOutputTokens: 20 },
            },
            { timeout: 15000, headers: { 'Content-Type': 'application/json' } }
        );

        const text = (resp.data?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
        return parseClsResponse(text);

    } catch (e) {
        console.error(`[Quick AI] 실패: ${e.message}`);
        return null; // 실패 → 미분류 유지 (다음 사이클 재시도)
    }
}

// ════════════════════════════════════════════════
// Search AI — 뉴스 검색 포함 정밀 분류 (확인필요 재시도용)
// ════════════════════════════════════════════════

// Search AI — Google 검색 포함 정밀 분류 (30초/건, 확인필요 건만)
async function classifyWithSearch(item) {
    if (!GEMINI_KEY) return '확인필요';

    const prompt = `다음 DART 공시가 주식 시세에 미치는 영향을 판단해주세요.

회사: ${item.corp_name}
공시제목: ${item.report_nm}
유형: ${item.corp_cls === 'Y' ? '유가증권' : item.corp_cls === 'K' ? '코스닥' : '기타'}

오늘 관련 뉴스를 검색해서 참고하세요.
뉴스가 없으면 공시 제목만으로 판단하되,
호재/악재 방향을 알 수 없으면 "확인필요"로 답하세요.

아래 5가지 중 하나만 답하세요 (다른 말 없이 딱 한 단어):
강력호재 — 주가 급등 가능
호재 — 주가 상승 가능
악재 — 주가 하락 가능
일반 — 시세 무관
확인필요 — 뉴스 없고 판단 불가`;

    try {
        const resp = await axios.post(
            `${GEMINI_URL}?key=${GEMINI_KEY}`,
            {
                contents: [{ parts: [{ text: prompt }] }],
                tools: [{ google_search: {} }],
                generationConfig: { temperature: 0.1, maxOutputTokens: 100 },
            },
            { timeout: 30000, headers: { 'Content-Type': 'application/json' } }
        );

        const text = (resp.data?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
        return parseClsResponse(text) || '확인필요';

    } catch (e) {
        console.error(`[Search AI] 실패: ${e.message}`);
        return '확인필요'; // 실패해도 확인필요로 넘김 (더 이상 재시도 안 함)
    }
}

// ════════════════════════════════════════════════
// 응답 파싱 — 공통 키워드 추출
// ════════════════════════════════════════════════

// AI 응답에서 분류 키워드 추출
function parseClsResponse(text) {
    if (!text) return null;
    if (text.includes('강력호재')) return '강력호재';
    if (text.includes('확인필요') || text.includes('확인')) return '확인필요';
    if (text.includes('호재')) return '호재';
    if (text.includes('악재')) return '악재';
    if (text.includes('일반')) return '일반';
    return null; // 키워드 없음 → 미분류
}

// ════════════════════════════════════════════════
// 메인: 전체 분류 실행
// ════════════════════════════════════════════════

/**
 * 수집된 공시 배열 분류 (규칙 → Quick AI)
 * 10분 수집 사이클마다 호출됨
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
        // 미분류 항목 (= _cls가 없는 것)
        const unclassified = items.filter(item => !item._cls);
        if (unclassified.length === 0) return;

        console.log(`[분류] 미분류 ${unclassified.length}건 처리 시작`);

        // ── 1단계: 규칙 필터 (즉시) ──
        const needAI = [];
        for (const item of unclassified) {
            const cls = classifyByRule(item.report_nm);
            if (cls) {
                item._cls = cls;
                item._clsBy = 'rule';
                ruleCount++;
            } else {
                needAI.push(item);
            }
        }

        if (ruleCount > 0) {
            console.log(`[분류] 규칙: ${ruleCount}건 완료`);
            if (saveFn) saveFn(); // 규칙 분류 즉시 저장
        }

        // ── 2단계: Quick AI (검색 없이, 1건씩) ──
        if (needAI.length > 0 && GEMINI_KEY) {
            console.log(`[분류] Quick AI: ${needAI.length}건 시작`);

            for (let i = 0; i < needAI.length; i++) {
                const item = needAI[i];
                const cls = await classifyQuick(item);

                if (cls) {
                    // 분류 성공 → 즉시 저장
                    item._cls = cls;
                    item._clsBy = 'ai_quick';
                    if (cls === '확인필요') {
                        item._clsAt = Date.now();
                    }
                    aiCount++;
                    consecutiveFails = 0;
                    if (saveFn) saveFn(); // 건별 즉시 저장
                } else {
                    // 분류 실패 — _cls 안 붙임 (다음 사이클 재시도)
                    consecutiveFails++;
                    console.log(`[분류] 실패 ${consecutiveFails}/${MAX_CONSECUTIVE_FAILS}`);

                    if (consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
                        console.log(`[분류] 연속 ${MAX_CONSECUTIVE_FAILS}회 실패 → AI 중단, 나머지 ${needAI.length - i - 1}건 미분류 유지`);
                        break;
                    }
                }

                // 진행률 로그 (50건마다)
                if ((i + 1) % 50 === 0) {
                    console.log(`[분류] ${i + 1}/${needAI.length}건 완료`);
                }

                // 다음 호출 전 대기
                if (i < needAI.length - 1) await sleep(QUICK_DELAY_MS);
            }
        }

        // ── 통계 업데이트 ──
        stats.rule += ruleCount;
        stats.quickAI += aiCount;
        stats.total += ruleCount + aiCount;
        lastRunAt = new Date().toISOString();

        console.log(`[분류] 완료 — 규칙:${ruleCount} AI:${aiCount}`);

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
 * 별도 타이머(30분마다)로 호출됨
 * @param {Array} items - collector.getTodayItems()
 * @param {Function} saveFn - 파일 저장 함수
 */
async function retryPending(items, saveFn) {
    if (isRunning) return;

    const now = Date.now();
    // 확인필요 + 1시간 경과한 건만 골라냄
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

            // 결과 반영 (확인필요든 다른 것이든 최종 확정)
            item._cls = cls;
            item._clsBy = 'ai_search';
            delete item._clsAt; // 재시도 완료, 타이머 제거
            retried++;

            // 다음 호출 전 대기
            if (i < pending.length - 1) await sleep(SEARCH_DELAY_MS);
        }

        stats.searchAI += retried;
        console.log(`[Search AI] ${retried}건 재분류 완료`);

        // 파일 저장
        if (saveFn && retried > 0) {
            saveFn();
        }

    } catch (e) {
        console.error(`[Search AI] 오류: ${e.message}`);
    } finally {
        isRunning = false;
    }
}

// ════════════════════════════════════════════════
// DC 갱신용 — 일반과 미분류 제외한 데이터만 반환
// ════════════════════════════════════════════════

// DC용 데이터 필터 — "일반", 미분류, Quick의 "확인필요"(Search AI 대기 중) 제외
function getItemsForDC(items) {
    return items.filter(item => {
        if (!item._cls) return false;                // 미분류 제외
        if (item._cls === '일반') return false;       // 일반 제외
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
    getItemsForDC,
    getStatus,
};

// ════════════════════════════════════════════════
// 독립 실행 모드 — node classifier.js [--search]
// ════════════════════════════════════════════════

if (require.main === module) {
    (async () => {
        const isSearch = process.argv.includes('--search');
        const mode = isSearch ? 'Search AI 재분류' : 'Quick AI 분류';
        console.log(`[분류] 독립 실행 시작 — ${mode}`);

        // 오늘 날짜 파일 찾기
        const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10).replace(/-/g, '');
        const filePath = path.join(DATA_DIR, `dart_${today}.json`);

        if (!fs.existsSync(filePath)) {
            console.log(`[분류] 파일 없음: ${filePath} — 수집 먼저 실행하세요`);
            process.exit(0);
        }

        // 파일에서 items 로드
        let data;
        try {
            data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        } catch (e) {
            console.error(`[분류] 파일 읽기 실패: ${e.message}`);
            process.exit(1);
        }

        const items = data.items || [];
        if (items.length === 0) {
            console.log('[분류] 항목 없음');
            process.exit(0);
        }

        // 저장 콜백 — 같은 파일에 덮어쓰기
        const saveFn = () => {
            data.items = items;
            data._classifiedAt = new Date().toISOString();
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
        };

        try {
            if (isSearch) {
                await retryPending(items, saveFn);
            } else {
                await classifyAll(items, saveFn);
            }

            // 결과 요약
            const clsCounts = {};
            items.forEach(i => {
                const cls = i._cls || '미분류';
                clsCounts[cls] = (clsCounts[cls] || 0) + 1;
            });
            console.log(`[분류] 결과:`, clsCounts);

        } catch (e) {
            console.error(`[분류] 오류: ${e.message}`);
            process.exit(1);
        }
        process.exit(0);
    })();
}
