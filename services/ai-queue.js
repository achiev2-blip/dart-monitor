/**
 * 공시+리포트 공유 AI 큐 — KEY2 전용 이벤트 기반 모듈
 * 
 * 역할:
 *  1. 공시/리포트를 1건씩 순차 Gemini 호출
 *  2. 이벤트 체인: 공시 → 리포트 → 미처리 재시도
 *  3. 쿨다운 감지 → 자동 복구
 *  4. 분석 결과는 콜백으로 각자 라인에 전달
 * 
 * 사용:
 *   const aiQueue = require('./services/ai-queue');
 *   aiQueue.init({ apiKey: process.env.GEMINI_KEY_NEWS });
 *   aiQueue.addDisclosure(item, onComplete);
 *   aiQueue.addReport(item, onComplete);
 */

const axios = require('axios');
const config = require('../config');

// ── Gemini 설정 ──
let GEMINI_BASE = config.GEMINI_BASE || 'https://generativelanguage.googleapis.com/v1beta/';
if (!GEMINI_BASE.endsWith('models/')) GEMINI_BASE += 'models/';
const MODEL = 'gemini-2.5-flash';

// ── 상태 ──
let _apiKey = null;
let _running = false;       // 현재 처리 중인지
let _cooldownUntil = 0;     // 쿨다운 해제 시각

// ── 3개 대기열 ──
const queue = {
    disclosure: [],   // { item, onComplete }
    report: [],       // { item, onComplete }
    retry: []         // { item, type, onComplete }
};

// ════════════════════════════════════════════════
// 초기화
// ════════════════════════════════════════════════

function init(opts = {}) {
    _apiKey = opts.apiKey || process.env.GEMINI_KEY_NEWS;
    if (!_apiKey) {
        console.log('[ai-queue] API 키 없음 — 비활성화');
        return;
    }
    console.log('[ai-queue] 초기화 완료 (KEY2, 이벤트 기반)');
}

// ════════════════════════════════════════════════
// 외부 인터페이스 — 큐에 추가
// ════════════════════════════════════════════════

/**
 * 공시 1건 큐에 추가
 * @param {Object} item - 공시 데이터
 * @param {Function} onComplete - (result) => void, 분석 결과를 공시 라인으로 전달
 */
function addDisclosure(item, onComplete) {
    queue.disclosure.push({ item, onComplete });
    processNext();
}

/**
 * 리포트 1건 큐에 추가
 * @param {Object} item - 리포트 데이터
 * @param {Function} onComplete - (result) => void, 분석 결과를 리포트 라인으로 전달
 */
function addReport(item, onComplete) {
    queue.report.push({ item, onComplete });
    processNext();
}

/**
 * 미처리 항목 재시도 큐에 추가
 * @param {Object} item - 미처리 데이터
 * @param {string} type - 'disclosure' 또는 'report'
 * @param {Function} onComplete - (result) => void
 */
function addRetry(item, type, onComplete) {
    queue.retry.push({ item, type, onComplete });
    processNext();
}

// ════════════════════════════════════════════════
// 이벤트 기반 체인 처리
// ════════════════════════════════════════════════

/**
 * 다음 항목 처리 — 이벤트 기반 체인
 * 우선순위: 공시 → 리포트 → 미처리
 */
async function processNext() {
    if (_running) return;           // 이미 처리 중
    if (!_apiKey) return;           // 키 없음

    // 쿨다운 체크
    if (_cooldownUntil > 0 && Date.now() < _cooldownUntil) {
        scheduleResume();
        return;
    }
    _cooldownUntil = 0;

    // 우선순위대로 꺼내기
    let entry = null;
    let type = '';

    if (queue.disclosure.length > 0) {
        entry = queue.disclosure.shift();
        type = 'disclosure';
    } else if (queue.report.length > 0) {
        entry = queue.report.shift();
        type = 'report';
    } else if (queue.retry.length > 0) {
        entry = queue.retry.shift();
        type = entry.type || 'retry';
    }

    if (!entry) return;  // 모든 큐 비어있음 → 대기

    _running = true;

    try {
        const prompt = buildPrompt(entry.item, type);
        const result = await callGemini(prompt);

        if (result === null) {
            // 쿨다운 or 실패 → 미처리 큐로
            queue.retry.push({ item: entry.item, type, onComplete: entry.onComplete });
            console.log(`[ai-queue] ${type} 실패 → 미처리 큐 (잔여: 공시${queue.disclosure.length} 리포트${queue.report.length} 미처리${queue.retry.length})`);
        } else {
            // 성공 → 각자 라인으로 결과 전달
            const parsed = parseResult(result, type);
            if (entry.onComplete) {
                try { entry.onComplete(parsed); } catch (e) {
                    console.error(`[ai-queue] ${type} 콜백 오류: ${e.message}`);
                }
            }
            console.log(`[ai-queue] ${type} 완료 (잔여: 공시${queue.disclosure.length} 리포트${queue.report.length} 미처리${queue.retry.length})`);
        }
    } catch (e) {
        console.error(`[ai-queue] ${type} 처리 오류: ${e.message}`);
        queue.retry.push({ item: entry.item, type, onComplete: entry.onComplete });
    } finally {
        _running = false;
    }

    // 2초 대기 후 다음 항목 처리 (체인)
    setTimeout(() => processNext(), 2000);
}

// ════════════════════════════════════════════════
// Gemini 호출
// ════════════════════════════════════════════════

async function callGemini(prompt) {
    const url = `${GEMINI_BASE}${MODEL}:generateContent?key=${_apiKey}`;

    try {
        const resp = await axios.post(url, {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.2, maxOutputTokens: 300 }
        }, { timeout: 20000, headers: { 'Content-Type': 'application/json' } });

        const text = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text || text.trim().length === 0) {
            return null;
        }
        return text;
    } catch (e) {
        const status = e.response?.status;
        if (status === 429 || status === 503) {
            // 쿼터 초과 or 서비스 불가 → 쿨다운
            _cooldownUntil = Date.now() + 60 * 60 * 1000; // 1시간
            console.log(`[ai-queue] ⛔ 쿨다운 진입 (${status}) — 1시간 후 자동 재시도`);
            scheduleResume();
        }
        console.error(`[ai-queue] Gemini 호출 실패: ${e.message}`);
        return null;
    }
}

// ════════════════════════════════════════════════
// 프롬프트 생성 — 타입별
// ════════════════════════════════════════════════

function buildPrompt(item, type) {
    if (type === 'disclosure') {
        return `당신은 한국 주식시장 전문 애널리스트입니다.
아래 DART 공시를 주식 투자자 관점에서 분류해주세요.

기업: ${item.corp_name || '?'}
공시제목: ${item.report_nm || '?'}

분류 기준:
- 강력호재: 대규모 수주, 사상최대 실적, 대형 M&A, 자사주 대량 매입 등
- 호재: 배당결정, 실적호전, 신규투자, 수주 등
- 악재: 유상증자, 감자, 적자전환, 횡령, 상장폐지 등
- 일반: 정기보고서, 주총소집, 임원변동 등

다음 형식으로만 답변:
판단: [강력호재/호재/악재/일반]
요약: (15자 이내 핵심 요약)`;
    }

    // type === 'report'
    const bodyText = (item.summary || '').substring(0, 500);
    return '증권사 리포트 분석 전문가로서 다음 리포트를 분석해주세요.\n\n'
        + '종목: ' + (item.corp || '') + '\n'
        + '제목: ' + (item.title || '') + '\n'
        + '증권사: ' + (item.broker || '') + '\n'
        + (item.opinion ? '투자의견: ' + item.opinion + '\n' : '')
        + (item.targetPrice ? '목표주가: ' + item.targetPrice.toLocaleString() + '원\n' : '')
        + (bodyText ? '본문: ' + bodyText + '\n' : '')
        + '\n다음 형식으로 답변:\n'
        + '판단: [강력호재/호재/악재/중립] (한 단어)\n'
        + '방향: [상향/하향/유지/신규]\n'
        + '요약: (1줄 한국어 핵심 요약)';
}

// ════════════════════════════════════════════════
// 응답 파싱 — 타입별
// ════════════════════════════════════════════════

function parseResult(text, type) {
    if (type === 'disclosure') {
        const result = { cls: '일반', summary: '' };
        if (!text) return result;
        for (const line of text.split('\n')) {
            const l = line.trim();
            if (l.indexOf('판단') >= 0) {
                if (l.indexOf('강력호재') >= 0 || l.indexOf('강력 호재') >= 0) result.cls = '강력호재';
                else if (l.indexOf('호재') >= 0) result.cls = '호재';
                else if (l.indexOf('악재') >= 0) result.cls = '악재';
            }
            if (l.indexOf('요약') >= 0) {
                result.summary = l.replace(/^[^:：]*[:：]\s*/, '').trim();
            }
        }
        return result;
    }

    // type === 'report'
    const result = { cls: 'normal', summary: '', direction: '' };
    if (!text) return result;
    for (const line of text.split('\n')) {
        const l = line.trim();
        if (l.indexOf('판단') >= 0) {
            if (l.indexOf('강력호재') >= 0 || l.indexOf('강력 호재') >= 0) result.cls = 'strong_good';
            else if (l.indexOf('호재') >= 0) result.cls = 'good';
            else if (l.indexOf('악재') >= 0) result.cls = 'bad';
        }
        if (l.indexOf('방향') >= 0 || l.indexOf('변동') >= 0) {
            if (l.indexOf('상향') >= 0) result.direction = '상향';
            else if (l.indexOf('하향') >= 0) result.direction = '하향';
            else if (l.indexOf('유지') >= 0 || l.indexOf('변동없음') >= 0) result.direction = '유지';
        }
        if (l.indexOf('요약') >= 0) {
            result.summary = l.replace(/^[^:：]*[:：]\s*/, '').trim();
        }
    }
    return result;
}

// ════════════════════════════════════════════════
// 쿨다운 자동 복구
// ════════════════════════════════════════════════

let _resumeTimer = null;

function scheduleResume() {
    if (_resumeTimer) return;  // 이미 예약됨
    const wait = Math.max(0, _cooldownUntil - Date.now());
    console.log(`[ai-queue] 🔄 ${Math.round(wait / 60000)}분 후 자동 재시도 예약`);
    _resumeTimer = setTimeout(() => {
        _resumeTimer = null;
        _cooldownUntil = 0;
        console.log('[ai-queue] ⏰ 쿨다운 해제 — 체인 재시작');
        processNext();
    }, wait + 1000);
}

// ════════════════════════════════════════════════
// 상태 조회
// ════════════════════════════════════════════════

function getStatus() {
    return {
        running: _running,
        cooldown: _cooldownUntil > 0 && Date.now() < _cooldownUntil,
        cooldownUntil: _cooldownUntil,
        queued: {
            disclosure: queue.disclosure.length,
            report: queue.report.length,
            retry: queue.retry.length
        }
    };
}

// ════════════════════════════════════════════════
// Exports
// ════════════════════════════════════════════════

module.exports = {
    init,
    addDisclosure,
    addReport,
    addRetry,
    getStatus,
    // 테스트용
    get queue() { return queue; }
};
