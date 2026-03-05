/**
 * 뉴스 분류기 — 독립 매크로
 * 
 * 분류 흐름:
 *   1. 규칙 필터 — 키워드로 자동 분류 (즉시, AI 호출 0)
 *   2. Quick AI — 제목+출처만으로 Gemini 분류 (2초/건)
 *   3. Search AI — 검색 포함 정밀 분류 (확인필요 재시도, 30초/건)
 * 
 * 분류 결과: 강력호재 / 호재 / 악재 / 일반 / 확인필요
 * 
 * 저장 구조:
 *   - 읽기: data/pending/ (수집 원본)
 *   - 쓰기: data/output/ (분류 완료 항목만)
 *
 * node news-classifier.js          → Quick AI 분류
 * node news-classifier.js --search → Search AI 재분류
 */

const path = require('path');
const fs = require('fs');
const axios = require('axios');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const GEMINI_KEY = process.env.GEMINI_KEY || '';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const RETRY_WAIT_MS = 3600000;   // 확인필요 재시도 대기 (1시간)
const PENDING_DIR = path.join(__dirname, 'data', 'pending');
const OUTPUT_DIR = path.join(__dirname, 'data', 'output');

// ── 상태 ──
let isRunning = false;
let lastRunAt = null;
let stats = { rule: 0, quickAI: 0, searchAI: 0, total: 0 };

// ════════════════════════════════════════════════
// 규칙 필터 — 키워드 기반 자동 분류
// ════════════════════════════════════════════════

// 강력호재 — 시세 급등 가능 (한국어 + 영문)
const RULE_STRONG_POSITIVE = [
    '급등', '상한가', '신고가', '52주 최고', '사상최고',
    '대규모 수주', '텐배거', '실적 서프라이즈', '어닝 서프라이즈',
    'record high', 'all-time high', 'surge', 'soar', 'skyrocket',
    'earnings surprise', 'beat estimates', 'blowout',
];

// 호재 — 긍정적 시세 영향 (한국어 + 영문)
const RULE_POSITIVE = [
    '수주', '계약 체결', '실적 개선', '매출 증가', '영업이익 증가',
    '목표가 상향', '투자의견 상향', '배당', '자사주', 'IPO',
    '금리 인하', '완화', '수출 호조', '흑자 전환', '반등',
    'rally', 'rebound', 'upgrade', 'invest', 'deal', 'growth',
    'profit', 'revenue rise', 'rate cut', 'easing', 'buyback',
    'dividend', 'breakthrough', 'expansion', 'boom',
];

// 악재 — 부정적 시세 영향 (한국어 + 영문)
const RULE_NEGATIVE = [
    '급락', '하한가', '폭락', '하락', '52주 최저',
    '상폐', '상장폐지', '거래정지', '실적 쇼크', '적자',
    '관세 부과', '제재', '규제 강화', '금리 인상', '긴축',
    '감자', '횡령', '분식', '소송', '리콜',
    'plunge', 'crash', 'tumble', 'slump', 'selloff', 'sell-off',
    'tariff', 'sanction', 'recession', 'downgrade', 'deficit',
    'loss', 'layoff', 'lawsuit', 'recall', 'rate hike',
    'tightening', 'risk', 'warning', 'fraud', 'scandal',
];

// 일반 — 시세 영향 낮은 정형 뉴스 (한국어 + 영문)
const RULE_NORMAL = [
    '인사', '부고', '동정', '기고', '칼럼', '사설',
    '일기예보', '날씨', '스포츠', '연예',
    'obituary', 'opinion', 'editorial', 'weather', 'sports',
];

// 규칙 기반 분류 — 뉴스 제목 키워드 매칭 (대소문자 무시)
function classifyByRule(title) {
    if (!title) return null;
    const t = title.toLowerCase();

    for (const kw of RULE_NORMAL) {
        if (t.includes(kw.toLowerCase())) return '일반';
    }
    for (const kw of RULE_STRONG_POSITIVE) {
        if (t.includes(kw.toLowerCase())) return '강력호재';
    }
    for (const kw of RULE_NEGATIVE) {
        if (t.includes(kw.toLowerCase())) return '악재';
    }
    for (const kw of RULE_POSITIVE) {
        if (t.includes(kw.toLowerCase())) return '호재';
    }

    return null; // 규칙으로 분류 불가 → AI로 넘김
}

// ════════════════════════════════════════════════
// Quick AI — 제목+출처만으로 빠른 분류
// ════════════════════════════════════════════════

// Quick AI — 제목+출처명으로 분류 (2초/건)
async function classifyQuick(item) {
    if (!GEMINI_KEY) return '확인필요';

    const prompt = `다음 뉴스 제목을 주식시장 영향도 기준으로 분류하세요.
반드시 다음 중 하나만 답하세요: 강력호재, 호재, 악재, 일반, 확인필요

제목: ${item.title}
출처: ${item.source || item.feedName || ''}

답변(한 단어만):`;

    try {
        const res = await axios.post(
            `${GEMINI_URL}?key=${GEMINI_KEY}`,
            {
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.1, maxOutputTokens: 100 },
            },
            { timeout: 15000, headers: { 'Content-Type': 'application/json' } }
        );

        const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        return parseClsResponse(text);
    } catch (e) {
        console.error(`[뉴스-분류] Quick AI 실패: ${e.message}`);
        return '확인필요';
    }
}

// ════════════════════════════════════════════════
// Search AI — 검색 포함 정밀 분류 (확인필요 재시도용)
// ════════════════════════════════════════════════

// Search AI — Google 검색 포함 정밀 분류 (30초/건, 확인필요 건만)
async function classifyWithSearch(item) {
    if (!GEMINI_KEY) return '확인필요';

    const prompt = `다음 뉴스의 주식시장 영향도를 정밀 분석하세요.
관련 정보를 웹에서 검색한 후 판단하세요.
반드시 다음 중 하나만 답하세요: 강력호재, 호재, 악재, 일반, 확인필요

제목: ${item.title}
출처: ${item.source || item.feedName || ''}
요약: ${item.desc || '없음'}
링크: ${item.link || ''}

답변(한 단어만):`;

    try {
        const res = await axios.post(
            `${GEMINI_URL}?key=${GEMINI_KEY}`,
            {
                contents: [{ parts: [{ text: prompt }] }],
                tools: [{ google_search: {} }],
                generationConfig: { temperature: 0.1, maxOutputTokens: 256 },
            },
            { timeout: 30000, headers: { 'Content-Type': 'application/json' } }
        );

        const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        return parseClsResponse(text);
    } catch (e) {
        console.error(`[뉴스-분류] Search AI 실패: ${e.message}`);
        return '확인필요';
    }
}

// ════════════════════════════════════════════════
// 응답 파싱 — 공통 키워드 추출
// ════════════════════════════════════════════════

// AI 응답에서 분류 키워드 추출
function parseClsResponse(text) {
    if (!text) return '확인필요';
    const t = text.trim();
    if (t.includes('강력호재')) return '강력호재';
    if (t.includes('호재')) return '호재';
    if (t.includes('악재')) return '악재';
    if (t.includes('일반')) return '일반';
    return '확인필요';
}

// ════════════════════════════════════════════════
// 메인: 전체 분류 실행
// ════════════════════════════════════════════════

// 수집된 뉴스 배열 분류 (규칙 → Quick AI)
// 수집 사이클마다 호출됨
// @param {Array} items - collector.getTodayItems()
// @param {Function} saveFn - 파일 저장 함수 (분류 후 호출)
async function classifyAll(items, saveFn) {
    if (isRunning) {
        console.log('[뉴스-분류] 이미 실행 중 — 스킵');
        return;
    }

    isRunning = true;
    const startTime = Date.now();
    let ruleCount = 0, aiCount = 0, skipCount = 0;

    try {
        // 미분류 건만 필터
        const unclassified = items.filter(i => !i._cls);
        if (unclassified.length === 0) {
            console.log('[뉴스-분류] 미분류 건 없음');
            return;
        }

        console.log(`[뉴스-분류] 시작 — 미분류 ${unclassified.length}건`);

        for (const item of unclassified) {
            // 1단계: 규칙 필터
            const ruleCls = classifyByRule(item.title);
            if (ruleCls) {
                item._cls = ruleCls;
                item._clsBy = 'rule';
                item._clsAt = new Date(Date.now() + 9 * 3600000).toISOString();
                ruleCount++;
                continue;
            }

            // 2단계: Quick AI
            const aiCls = await classifyQuick(item);
            item._cls = aiCls;
            item._clsBy = 'ai_quick';
            item._clsAt = new Date(Date.now() + 9 * 3600000).toISOString();
            aiCount++;

            // 저장 (10건마다)
            if ((ruleCount + aiCount) % 10 === 0 && saveFn) {
                saveFn();
            }

            // AI 요청 간격 (thinking 모델 여유)
            await sleep(5000);
        }

        // 최종 저장
        if (saveFn) saveFn();

        stats.rule += ruleCount;
        stats.quickAI += aiCount;
        stats.total += ruleCount + aiCount;
        lastRunAt = new Date(Date.now() + 9 * 3600000).toISOString();

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[뉴스-분류] 완료 — 규칙:${ruleCount} AI:${aiCount} (${elapsed}초)`);

    } finally {
        isRunning = false;
    }
}

// ════════════════════════════════════════════════
// Search AI 재시도 — 1시간 경과한 "확인필요" 건 처리
// ════════════════════════════════════════════════

// "확인필요" + 1시간 경과한 건만 Search AI로 재분류
// @param {Array} items - collector.getTodayItems()
// @param {Function} saveFn - 파일 저장 함수
async function retryPending(items, saveFn) {
    if (isRunning) return;

    const now = Date.now();
    const pending = items.filter(i =>
        i._cls === '확인필요' &&
        i._clsBy === 'ai_quick' &&
        i._clsAt &&
        (now - new Date(i._clsAt).getTime()) >= RETRY_WAIT_MS
    );

    if (pending.length === 0) return;

    isRunning = true;
    console.log(`[뉴스-분류] Search AI 재시도 — ${pending.length}건`);

    let changed = 0;
    try {
        for (const item of pending) {
            const newCls = await classifyWithSearch(item);

            if (newCls !== '확인필요') {
                item._cls = newCls;
                item._clsBy = 'ai_search';
                item._clsAt = new Date(Date.now() + 9 * 3600000).toISOString();
                changed++;
                console.log(`[뉴스-분류] 재분류: "${item.title.slice(0, 30)}..." → ${newCls}`);
            }

            // AI 요청 간격
            await sleep(2000);
        }

        if (changed > 0 && saveFn) saveFn();

        stats.searchAI += changed;
        console.log(`[뉴스-분류] Search AI 완료 — ${changed}/${pending.length}건 재분류`);

    } finally {
        isRunning = false;
    }
}

// ════════════════════════════════════════════════
// 뷰어용 — 일반과 미분류 제외한 데이터만 반환
// ════════════════════════════════════════════════

// 뷰어용 데이터 필터 — "일반", 미분류, Quick의 "확인필요"(Search AI 대기 중) 제외
function getNewsItemsForViewer(items) {
    return items.filter(i => {
        if (!i._cls) return false;
        if (i._cls === '일반') return false;
        if (i._cls === '확인필요' && i._clsBy === 'ai_quick') return false;
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
        stats: { ...stats },
    };
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

module.exports = {
    classifyByRule,
    classifyQuick,
    classifyWithSearch,
    classifyAll,
    retryPending,
    getNewsItemsForViewer,
    getStatus,
    moveToOutput,
};

// ════════════════════════════════════════════════
// output 폴더 저장 — 분류 완료 항목만 output 파일에 병합
// ════════════════════════════════════════════════

/**
 * 분류 완료 항목을 output 파일에 병합 저장
 * - 일반, 미분류, Quick AI의 확인필요(Search 대기 중) 제외
 * - 기존 output 파일이 있으면 병합 (중복 제거: _newsId 기준)
 * @param {string} dateStr - YYYYMMDD
 * @param {Array} items - 전체 항목 배열
 */
function moveToOutput(dateStr, items) {
    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    // output 대상: 분류 완료 항목만
    const classified = items.filter(item => {
        if (!item._cls) return false;                // 미분류 제외
        if (item._cls === '일반') return false;       // 일반 제외
        // Quick AI의 "확인필요"는 Search AI 대기 중이므로 제외
        if (item._cls === '확인필요' && item._clsBy === 'ai_quick') return false;
        return true;
    });

    if (classified.length === 0) return;

    const outputPath = path.join(OUTPUT_DIR, `news_${dateStr}.json`);

    // 기존 output 파일이 있으면 병합
    let existing = [];
    if (fs.existsSync(outputPath)) {
        try {
            const data = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
            existing = data.items || [];
        } catch (e) {
            console.error(`[output] 기존 파일 읽기 실패: ${e.message}`);
        }
    }

    // 중복 제거 — _newsId 기준
    const existingIds = new Set(existing.map(i => i._newsId));
    const newItems = classified.filter(i => !existingIds.has(i._newsId));

    // 기존 항목 중 재분류된 것 업데이트 (_newsId 일치 시 최신 분류 반영)
    const classifiedMap = new Map(classified.map(i => [i._newsId, i]));
    const updated = existing.map(item => {
        if (classifiedMap.has(item._newsId)) {
            return classifiedMap.get(item._newsId);
        }
        return item;
    });

    // 새 항목 추가
    updated.push(...newItems);

    const outputData = {
        date: dateStr,
        total: updated.length,
        _classifiedAt: new Date().toISOString(),
        items: updated,
    };

    fs.writeFileSync(outputPath, JSON.stringify(outputData, null, 2), 'utf-8');
    console.log(`[output] news_${dateStr}.json 저장: ${updated.length}건 (새 +${newItems.length}건)`);
}

// ════════════════════════════════════════════════
// 독립 실행 모드 — node news-classifier.js [--search]
// ════════════════════════════════════════════════

if (require.main === module) {
    (async () => {
        const isSearch = process.argv.includes('--search');
        const mode = isSearch ? 'Search AI 재분류' : 'Quick AI 분류';
        console.log(`[뉴스-분류] 독립 실행 시작 — ${mode}`);

        // 오늘 날짜 pending 파일 찾기
        const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10).replace(/-/g, '');
        const filePath = path.join(PENDING_DIR, `news_${today}.json`);

        if (!fs.existsSync(filePath)) {
            console.log(`[뉴스-분류] 파일 없음: ${filePath} — 수집 먼저 실행하세요`);
            process.exit(0);
        }

        // pending 파일에서 items 로드
        let data;
        try {
            data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        } catch (e) {
            console.error(`[뉴스-분류] 파일 읽기 실패: ${e.message}`);
            process.exit(1);
        }

        const items = data.items || [];
        if (items.length === 0) {
            console.log('[뉴스-분류] 항목 없음');
            process.exit(0);
        }

        // pending 저장 콜백 — 분류 상태를 pending 파일에 반영
        const saveFn = () => {
            data.items = items;
            data.updatedAt = new Date(Date.now() + 9 * 3600000).toISOString();
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
            console.log(`[뉴스-분류] pending 저장: ${filePath}`);
        };

        try {
            if (isSearch) {
                await retryPending(items, saveFn);
            } else {
                await classifyAll(items, saveFn);
            }

            // 분류 완료 항목 → output 저장
            moveToOutput(today, items);

            // 결과 요약
            const clsCounts = {};
            items.forEach(i => {
                const cls = i._cls || '미분류';
                clsCounts[cls] = (clsCounts[cls] || 0) + 1;
            });
            console.log(`[뉴스-분류] 결과:`, clsCounts);

        } catch (e) {
            console.error(`[뉴스-분류] 오류: ${e.message}`);
            process.exit(1);
        }
        process.exit(0);
    })();
}

