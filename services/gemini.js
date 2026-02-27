/**
 * Gemini AI 서비스 모듈
 * 
 * 역할: 모델 폴백 체인, 쿨다운 관리, AI 호출(callGeminiDirect),
 *       리포트 AI 분석, 뉴스 AI 분류, 급등락 분석
 * 
 * 사용: const gemini = require('./services/gemini');
 *       gemini.init({ reportAiCache, companyData, ... });
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { saveJSON, loadJSON } = require('../utils/file-io');

// ============================================================
// 설정
// ============================================================
const GEMINI_KEY = config.GEMINI_KEY;
const GEMINI_BASE = config.GEMINI_BASE;
const GEMINI_MODELS = config.GEMINI_MODELS;
const COOLDOWN_MS = config.COOLDOWN_MS;
const DATA_DIR = config.DATA_DIR;

// ============================================================
// 상태 변수
// ============================================================
let currentModelIndex = 0;
let fallbackRound = 1;
let cooldownUntil = 0;
let lastGeminiWorkTime = 0;
let isAnalyzing = false;

// 외부 의존성 (init()으로 주입)
let deps = {
    reportAiCache: {},
    companyData: null,
    findStockCode: null,
};

// ============================================================
// 초기화
// ============================================================
function init(dependencies) {
    deps = { ...deps, ...dependencies };
    loadServerState();
}

// ============================================================
// 서버 상태 저장/복원
// ============================================================
function saveServerState() {
    try {
        const state = {
            currentModelIndex,
            fallbackRound,
            cooldownUntil,
            lastGeminiWorkTime,
            savedAt: Date.now()
        };
        fs.writeFileSync(path.join(DATA_DIR, 'server_state.json'), JSON.stringify(state, null, 2), 'utf-8');
    } catch (e) {
        console.error(`[상태저장] 실패: ${e.message}`);
    }
}

function loadServerState() {
    try {
        const fp = path.join(DATA_DIR, 'server_state.json');
        if (fs.existsSync(fp)) {
            const state = JSON.parse(fs.readFileSync(fp, 'utf-8'));
            if (typeof state.currentModelIndex === 'number') currentModelIndex = state.currentModelIndex;
            if (typeof state.fallbackRound === 'number') fallbackRound = state.fallbackRound;
            if (typeof state.cooldownUntil === 'number') cooldownUntil = state.cooldownUntil;
            if (typeof state.lastGeminiWorkTime === 'number') lastGeminiWorkTime = state.lastGeminiWorkTime;
            console.log(`[상태복원] 모델:${GEMINI_MODELS[currentModelIndex]?.label} 회차:${fallbackRound} 쿨다운:${cooldownUntil > Date.now() ? '진행중' : '없음'}`);
        }
    } catch (e) {
        console.error(`[상태복원] 실패: ${e.message}`);
    }
}

// ============================================================
// 모델 폴백 로직
// ============================================================
function getKSTHour() {
    const now = new Date();
    const kst = new Date(now.getTime() + 9 * 3600000);
    return { h: kst.getUTCHours(), m: kst.getUTCMinutes() };
}

function isCooldownActive() {
    return cooldownUntil > 0 && Date.now() < cooldownUntil;
}

function resetToPro(reason) {
    console.log(`[Gemini] ${reason} → 프로(${GEMINI_MODELS[0].label}) 리셋`);
    currentModelIndex = 0;
    fallbackRound = 1;
    cooldownUntil = 0;
    saveServerState();
}

function getCurrentModel() {
    if (cooldownUntil > 0 && Date.now() >= cooldownUntil) {
        resetToPro('⏰ 쿨다운 해제');
    }
    return GEMINI_MODELS[currentModelIndex];
}

function demoteModel() {
    const failed = GEMINI_MODELS[currentModelIndex].label;

    if (currentModelIndex < GEMINI_MODELS.length - 1) {
        currentModelIndex++;
        console.log(`[Gemini] ⚠️ ${failed} 실패 → ${GEMINI_MODELS[currentModelIndex].label}로 강등 (${fallbackRound}회차)`);
    } else if (fallbackRound === 1) {
        fallbackRound = 2;
        currentModelIndex = 0;
        console.log(`[Gemini] 🔄 1회차 전부 실패 → 2회차 프로(${GEMINI_MODELS[0].label})부터 재시도`);
    } else {
        const { h } = getKSTHour();
        if (h < 17) {
            const now = new Date();
            const kstNow = new Date(now.getTime() + 9 * 3600000);
            const kst17 = new Date(kstNow);
            kst17.setUTCHours(17, 1, 0, 0);
            cooldownUntil = now.getTime() + (kst17.getTime() - kstNow.getTime());
            const waitMin = Math.round((cooldownUntil - Date.now()) / 60000);
            console.log(`[Gemini] ⛔ 2회차 전부 실패 → 17:01 KST까지 대기 (약 ${waitMin}분)`);
        } else {
            cooldownUntil = Date.now() + COOLDOWN_MS;
            const resumeTime = new Date(cooldownUntil).toLocaleString('ko-KR');
            console.log(`[Gemini] ⛔ 2회차 전부 실패 → 1시간 쿨다운 (${resumeTime} 해제)`);
        }
        fallbackRound = 1;
        currentModelIndex = GEMINI_MODELS.length - 1;
    }
    saveServerState();
}

function markGeminiWork() {
    lastGeminiWorkTime = Date.now();
}

// ============================================================
// Gemini 직접 호출
// ============================================================
async function callGeminiDirect(prompt) {
    if (isCooldownActive()) {
        return null;
    }

    const model = getCurrentModel();
    const url = `${GEMINI_BASE}${model.id}:generateContent?key=${GEMINI_KEY}`;

    try {
        const resp = await axios.post(url, {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.2, maxOutputTokens: 300 }
        }, { timeout: 20000, headers: { 'Content-Type': 'application/json' } });

        const text = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text || text.trim().length === 0) {
            demoteModel();
            return null;
        }
        markGeminiWork();
        return text;
    } catch (e) {
        console.error(`[Gemini-Direct][${model.label}] ${e.message}`);
        demoteModel();
        return null;
    }
}

// ============================================================
// 리포트 AI 분석
// ============================================================
function parseReportAiResult(text) {
    const result = { cls: 'normal', summary: '', direction: '' };
    if (!text) return result;
    try {
        const lines = text.split('\n');
        for (const line of lines) {
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
    } catch (e) { }
    return result;
}

async function analyzeReportWithGemini(report) {
    const cacheKey = `${report.corp}|${report.title}|${report.date}`;
    if (deps.reportAiCache[cacheKey]) return deps.reportAiCache[cacheKey];

    const bodyText = (report.summary || '').substring(0, 500);

    const prompt = '증권사 리포트 분석 전문가로서 다음 리포트를 분석해주세요.\n\n'
        + '종목: ' + (report.corp || '') + '\n'
        + '제목: ' + (report.title || '') + '\n'
        + '증권사: ' + (report.broker || '') + '\n'
        + (report.opinion ? '투자의견: ' + report.opinion + '\n' : '')
        + (report.targetPrice ? '목표주가: ' + report.targetPrice.toLocaleString() + '원\n' : '')
        + (bodyText ? '본문: ' + bodyText + '\n' : '')
        + '\n리포트 제목과 본문 내용에서 목표가 상향/하향, 투자의견 변경, 실적 전망 등을 파악하여 다음 형식으로 답변:\n'
        + '판단: [강력호재/호재/악재/중립] (한 단어)\n'
        + '  - 강력호재 기준: 목표가 20%이상 상향, 투자의견 상향(중립→매수 등), 실적 대폭 서프라이즈\n'
        + '  - 호재: 목표가 소폭 상향, 긍정 전망, 실적 부합 이상\n'
        + '  - 악재: 목표가 하향, 부정 전망, 실적 미달\n'
        + '방향: [상향/하향/유지/신규] (목표가 또는 투자의견 방향)\n'
        + '요약: (1줄 한국어 핵심 요약)';

    const text = await callGeminiDirect(prompt);
    const result = parseReportAiResult(text);

    deps.reportAiCache[cacheKey] = result;

    if (report.corp && deps.findStockCode && deps.companyData) {
        const code = deps.findStockCode(report.corp);
        if (code) {
            deps.companyData.addReport(code, { ...report, aiResult: result });
            deps.companyData.addReportToLayer(code, { ...report, aiResult: result });
            if (result.summary) {
                deps.companyData.updateAiLayer(code, result.summary, result.cls);
            }
        }
    }

    return result;
}

async function analyzeReportBatch(reports) {
    if (isAnalyzing) {
        console.log('[리포트AI] 이미 분석 중 — 스킵');
        return;
    }
    isAnalyzing = true;

    try {
        const unanalyzed = reports.filter(r => {
            const cacheKey = `${r.corp}|${r.title}|${r.date}`;
            if (deps.reportAiCache[cacheKey]) {
                r.aiResult = deps.reportAiCache[cacheKey];
                return false;
            }
            return true;
        });

        if (unanalyzed.length === 0) return;

        const BATCH_SIZE = 5;
        let analyzed = 0;

        for (let i = 0; i < unanalyzed.length; i += BATCH_SIZE) {
            const batch = unanalyzed.slice(i, i + BATCH_SIZE);

            if (batch.length === 1) {
                try {
                    const result = await analyzeReportWithGemini(batch[0]);
                    batch[0].aiResult = result;
                    analyzed++;
                } catch (e) {
                    console.error(`[리포트AI] ${batch[0].corp} 분석 실패: ${e.message}`);
                }
            } else {
                try {
                    const batchPrompt = '증권사 리포트 분석 전문가로서 아래 리포트들을 각각 분석해주세요.\n\n'
                        + batch.map((r, idx) => {
                            const bodyText = (r.summary || '').substring(0, 300);
                            return `[리포트${idx + 1}]\n종목: ${r.corp || ''}\n제목: ${r.title || ''}\n증권사: ${r.broker || ''}`
                                + (r.opinion ? `\n투자의견: ${r.opinion}` : '')
                                + (r.targetPrice ? `\n목표주가: ${r.targetPrice.toLocaleString()}원` : '')
                                + (bodyText ? `\n본문: ${bodyText}` : '');
                        }).join('\n\n')
                        + '\n\n각 리포트에 대해 다음 형식으로 답변 (리포트 번호별):\n'
                        + '[리포트N]\n판단: [강력호재/호재/악재/중립] (강력호재=목표가20%↑이상 또는 투자의견 상향)\n방향: [상향/하향/유지/신규]\n요약: (1줄 핵심 요약)';

                    const text = await callGeminiDirect(batchPrompt);
                    if (text) {
                        const sections = text.split(/\[리포트(\d+)\]/);
                        for (let s = 1; s < sections.length; s += 2) {
                            const idx = parseInt(sections[s]) - 1;
                            if (idx >= 0 && idx < batch.length) {
                                const result = parseReportAiResult(sections[s + 1]);
                                const cacheKey = `${batch[idx].corp}|${batch[idx].title}|${batch[idx].date}`;
                                deps.reportAiCache[cacheKey] = result;
                                batch[idx].aiResult = result;
                                analyzed++;

                                if (batch[idx].corp && deps.findStockCode && deps.companyData) {
                                    const stockCode = deps.findStockCode(batch[idx].corp);
                                    if (stockCode) {
                                        deps.companyData.addReport(stockCode, { ...batch[idx], aiResult: result });
                                        deps.companyData.addReportToLayer(stockCode, { ...batch[idx], aiResult: result });
                                        if (result.summary) {
                                            deps.companyData.updateAiLayer(stockCode, result.summary, result.cls);
                                        }
                                    }
                                }
                            }
                        }
                    }
                } catch (e) {
                    console.error(`[리포트AI] 배치(${batch.length}건) 분석 실패: ${e.message}`);
                    for (const r of batch) {
                        try {
                            const result = await analyzeReportWithGemini(r);
                            r.aiResult = result;
                            analyzed++;
                            await new Promise(res => setTimeout(res, 2500));
                        } catch (e2) { }
                    }
                }
            }

            if (i + BATCH_SIZE < unanalyzed.length) {
                await new Promise(res => setTimeout(res, 3000));
            }
        }

        if (analyzed > 0) {
            saveJSON('report_ai_cache.json', deps.reportAiCache);
            console.log(`[리포트AI] ${analyzed}건 분석 완료 (배치 최적화)`);
        }
    } finally {
        isAnalyzing = false;
    }
}

// ============================================================
// 뉴스 AI 분류
// ============================================================
const newsAiCacheServer = loadJSON('news_ai_cache.json', {});

async function classifyNewsBatch(newsItems, getWatchlistFn) {
    if (isCooldownActive()) {
        console.log('[뉴스AI] 쿨다운 중 — 분류 스킵');
        return;
    }

    const BATCH_SIZE = 5;
    let classified = 0;

    for (let i = 0; i < newsItems.length; i += BATCH_SIZE) {
        const batch = newsItems.slice(i, i + BATCH_SIZE);
        const needClassify = batch.filter(n => !newsAiCacheServer[n.link]);
        if (needClassify.length === 0) continue;

        const watchlistNames = getWatchlistFn().map(s => s.name).join(', ');

        const newsTexts = needClassify.map((n, idx) =>
            `[${idx + 1}] ${n.title} (${n.source || ''})`
        ).join('\n');

        const prompt = `한국 주식시장 뉴스 분류 전문가입니다. 아래 뉴스들을 분석해주세요.

모니터링 종목: ${watchlistNames}

뉴스 목록:
${newsTexts}

각 뉴스에 대해 번호별로 다음 형식으로 답변 (줄바꿈으로 구분):
[번호] 카테고리:OO | 판단:OO | 중요도:OO | 종목:OO | 요약:OO

카테고리: 국제정치/국내정치/경제정책/산업/기업/시장/법안/기타 중 택1
판단: 호재/악재/중립 중 택1
중요도: 상/중/하 중 택1
종목: 직접 관련되는 상장 종목명 (복수 가능, 없으면 "시장전체")
요약: 1줄 핵심 요약`;

        try {
            const text = await callGeminiDirect(prompt);
            if (!text) continue;

            const results = parseNewsClassification(text, needClassify.length);

            for (let j = 0; j < needClassify.length; j++) {
                const news = needClassify[j];
                const result = results[j] || { category: '기타', cls: 'normal', importance: '중', stocks: '시장전체', summary: '' };

                newsAiCacheServer[news.link] = result;

                news.aiClassified = true;
                news.aiCategory = result.category;
                news.aiCls = result.cls;
                news.aiImportance = result.importance;
                news.aiStocks = result.stocks;
                news.aiSummary = result.summary;

                if (result.stocks && result.stocks !== '시장전체' && deps.findStockCode && deps.companyData) {
                    const stockNames = result.stocks.split(',').map(s => s.trim());
                    for (const name of stockNames) {
                        const code = deps.findStockCode(name);
                        if (code) {
                            deps.companyData.addNewsToLayer(code, {
                                title: news.title,
                                link: news.link,
                                category: result.category,
                                cls: result.cls,
                                importance: result.importance,
                                summary: result.summary,
                                date: new Date().toISOString()
                            });
                        }
                    }
                }

                classified++;
            }

            await new Promise(r => setTimeout(r, 2500));
        } catch (e) {
            console.error(`[뉴스AI] 배치 분류 실패: ${e.message}`);
        }
    }

    if (classified > 0) {
        saveJSON('news_ai_cache.json', newsAiCacheServer);
        console.log(`[뉴스AI] ${classified}건 분류 완료`);
    }
}

function parseNewsClassification(text, expectedCount) {
    const results = [];
    if (!text) return results;

    const lines = text.split('\n').filter(l => l.trim());
    for (const line of lines) {
        const match = line.match(/^\[?\d+\]?\s*/);
        if (!match) continue;

        const result = { category: '기타', cls: 'normal', importance: '중', stocks: '시장전체', summary: '' };

        const catMatch = line.match(/카테고리[:：]\s*([^|]+)/);
        if (catMatch) result.category = catMatch[1].trim();

        const clsMatch = line.match(/판단[:：]\s*([^|]+)/);
        if (clsMatch) {
            const cls = clsMatch[1].trim();
            if (cls.includes('강력호재')) result.cls = 'strong_good';
            else if (cls.includes('호재')) result.cls = 'good';
            else if (cls.includes('악재')) result.cls = 'bad';
            else result.cls = 'normal';
        }

        const impMatch = line.match(/중요도[:：]\s*([^|]+)/);
        if (impMatch) result.importance = impMatch[1].trim().charAt(0);

        const stockMatch = line.match(/종목[:：]\s*([^|]+)/);
        if (stockMatch) result.stocks = stockMatch[1].trim();

        const sumMatch = line.match(/요약[:：]\s*(.+)/);
        if (sumMatch) result.summary = sumMatch[1].trim();

        results.push(result);
    }

    while (results.length < expectedCount) {
        results.push({ category: '기타', cls: 'normal', importance: '중', stocks: '시장전체', summary: '' });
    }

    return results;
}

// ============================================================
// 급등락 분석 파싱
// ============================================================
function parseSpikeAnalysis(text) {
    const result = { cause: '', outlook: '', relatedStocks: '', confidence: '중', cls: 'normal' };
    if (!text) return result;
    try {
        for (const line of text.split('\n')) {
            const l = line.trim();
            if (l.match(/^원인[:：]/)) result.cause = l.replace(/^원인[:：]\s*/, '');
            if (l.match(/^전망[:：]/)) result.outlook = l.replace(/^전망[:：]\s*/, '');
            if (l.match(/^관련종목[:：]/)) result.relatedStocks = l.replace(/^관련종목[:：]\s*/, '');
            if (l.match(/^신뢰도[:：]/)) result.confidence = l.replace(/^신뢰도[:：]\s*/, '').trim().charAt(0);
        }
        if (!result.cause) result.cause = text.substring(0, 200);
    } catch (e) { result.cause = text.substring(0, 200); }
    return result;
}

// ============================================================
// 인트라데이 장중 흐름 분석
// ============================================================
async function analyzeIntraday(code, name, ticks) {
    if (isCooldownActive()) return null;
    if (!ticks || ticks.length < 5) return null;

    const ticksText = ticks.map(t => `${t.t} ${t.p}원 (거래량:${t.v})`).join('\n');

    const prompt = `한국 주식 장중 흐름 분석 전문가입니다.

종목: ${name} (${code})
오늘 5분봉 데이터:
${ticksText}

다음 형식으로 분석해주세요 (JSON):
{
  "open": 시가(숫자),
  "high": 고가(숫자),
  "low": 저가(숫자),
  "close": 종가(숫자),
  "summary": "1~2줄 장중 흐름 요약 (출발가→고가 시점→저가 시점→마감 흐름)",
  "keyEvents": ["주요 이벤트1", "주요 이벤트2"],
  "trend": "상승/하락/보합/급등/급락/반등/하락반등 중 택1",
  "volumeNote": "거래량 특징 한 줄"
}

JSON만 출력하세요.`;

    try {
        const text = await callGeminiDirect(prompt);
        if (!text) return null;

        // JSON 파싱 시도
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            parsed.analyzedAt = new Date().toISOString();
            parsed.tickCount = ticks.length;
            return parsed;
        }

        // JSON 파싱 실패 시 기본 요약
        return {
            open: ticks[0]?.p,
            high: Math.max(...ticks.map(t => t.p)),
            low: Math.min(...ticks.map(t => t.p)),
            close: ticks[ticks.length - 1]?.p,
            summary: text.substring(0, 200),
            keyEvents: [],
            trend: '분석불가',
            volumeNote: '',
            analyzedAt: new Date().toISOString(),
            tickCount: ticks.length
        };
    } catch (e) {
        console.error(`[Gemini] ${name} 인트라데이 분석 실패: ${e.message}`);
        return null;
    }
}

// ============================================================
// Exports
// ============================================================
module.exports = {
    init,
    // 상태 관리
    saveServerState,
    loadServerState,
    getKSTHour,
    isCooldownActive,
    resetToPro,
    getCurrentModel,
    demoteModel,
    markGeminiWork,
    // AI 호출
    callGeminiDirect,
    // 리포트 분석
    parseReportAiResult,
    analyzeReportWithGemini,
    analyzeReportBatch,
    // 뉴스 분류
    classifyNewsBatch,
    parseNewsClassification,
    newsAiCacheServer,
    // 급등락
    parseSpikeAnalysis,
    // 인트라데이
    analyzeIntraday,
    // 상태 접근자
    get currentModelIndex() { return currentModelIndex; },
    get fallbackRound() { return fallbackRound; },
    get cooldownUntil() { return cooldownUntil; },
    get lastGeminiWorkTime() { return lastGeminiWorkTime; },
    get isAnalyzing() { return isAnalyzing; },
    GEMINI_MODELS,
    GEMINI_KEY,
    GEMINI_BASE,
};
