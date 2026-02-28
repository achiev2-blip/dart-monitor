/**
 * DART 모니터 — 매크로 경제 데이터 수집기
 * 
 * ============================================================
 * 목적: 글로벌 매크로 지표를 수집하여 한국 시장 분석의 맥락 데이터 제공
 * 
 * 수집 대상:
 *   G1. SOX (필라델피아 반도체 지수) — 반도체 섹터 선행지표
 *   G1. VIX (공포 지수) — 시장 변동성/심리 지표
 *   G2. USD/KRW 환율 — 외국인 매매 방향 핵심 변수
 *   G3. 미국 선물 야간 — 다음날 한국 시장 방향 암시
 * 
 * 데이터 소스:
 *   - Yahoo Finance (무료, API key 불필요)
 *   - 네이버 금융 (환율)
 * 
 * 디렉토리 구조:
 *   data/macro/
 *   ├── current.json     ← 실시간 최신 스냅샷 (preliminary/confirmed 상태)
 *   ├── closing.json     ← 확정 종가 (미장 마감 후 검증된 값)
 *   ├── daily/           ← 일별 히스토리 (YYYY-MM-DD.json)
 *   └── alerts.json      ← 급변 알림 이력 (±2% 이상 변동)
 * 
 * 연결:
 *   - server.js 타이머 → fetchAllMacro() 30분마다 실행
 *   - server.js /api/macro → 프론트엔드/Claude에 데이터 전달
 *   - utils/archive.js → 일별 스냅샷에 매크로 지표 포함
 *   - Claude API 응답 → macro 필드로 추가
 * ============================================================
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const config = require('../config');

const MACRO_DIR = path.join(config.DATA_DIR, 'macro');
const DAILY_DIR = path.join(MACRO_DIR, 'daily');

// 디렉토리 보장
if (!fs.existsSync(MACRO_DIR)) fs.mkdirSync(MACRO_DIR, { recursive: true });
if (!fs.existsSync(DAILY_DIR)) fs.mkdirSync(DAILY_DIR, { recursive: true });

// ============================================================
// 유틸리티
// ============================================================

function loadJSON(fp, fallback) {
    try {
        if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf-8'));
    } catch (e) { /* skip */ }
    return fallback;
}

function saveJSON(fp, data) {
    try {
        fs.writeFileSync(fp, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) { console.error(`[매크로] JSON 저장 실패: ${fp}: ${e.message}`); }
}

function getKSTDate() {
    const d = new Date();
    d.setHours(d.getHours() + 9);
    return d.toISOString().slice(0, 10);
}

// 현재 매크로 데이터
let currentMacro = loadJSON(path.join(MACRO_DIR, 'current.json'), {
    sox: null,    // 필라델피아 반도체
    vix: null,    // 공포지수
    usdkrw: null, // 환율
    futures: {},   // 미국 선물
    updatedAt: null
});

// 알림 이력
let alerts = loadJSON(path.join(MACRO_DIR, 'alerts.json'), []);

// ============================================================
// G1: Yahoo Finance에서 지수 데이터 수집
// ============================================================
// 소스: Yahoo Finance v8 API (무료, key 불필요)
// 대상: SOX (^SOX), VIX (^VIX), S&P500 (^GSPC), NASDAQ (^IXIC),
//        DOW (^DJI), 나스닥 선물 (NQ=F), S&P 선물 (ES=F)
// ============================================================

const YAHOO_SYMBOLS = {
    // ── 주요 지수 ──
    sox: { symbol: '^SOX', name: '필라델피아 반도체', category: 'index' },
    vix: { symbol: '^VIX', name: 'VIX 공포지수', category: 'index' },
    sp500: { symbol: '^GSPC', name: 'S&P 500', category: 'index' },
    nasdaq: { symbol: '^IXIC', name: 'NASDAQ', category: 'index' },
    dxy: { symbol: 'DX-Y.NYB', name: '달러 인덱스(DXY)', category: 'index' },
    // ── 채권 ──
    us10y: { symbol: '^TNX', name: '미국 10년물 금리', category: 'bond' },
    // ── 반도체 장비 (⭐ 포트폴리오 직결) ──
    lrcx: { symbol: 'LRCX', name: '램리서치', category: 'semi_equip' },
    klac: { symbol: 'KLAC', name: 'KLA Corp', category: 'semi_equip' },
    // ── AI/서버 테마 ──
    arm: { symbol: 'ARM', name: 'ARM Holdings', category: 'ai_theme' },
    smci: { symbol: 'SMCI', name: 'Super Micro', category: 'ai_theme' },
    // ── AI/반도체 대표주 (포트폴리오 핵심) ──
    nvda: { symbol: 'NVDA', name: 'NVIDIA', category: 'ai_semi' },
    amd: { symbol: 'AMD', name: 'AMD', category: 'ai_semi' },
    mu: { symbol: 'MU', name: '마이크론', category: 'ai_semi' },
    avgo: { symbol: 'AVGO', name: '브로드컴', category: 'ai_semi' },
    // ── 원자재 ──
    gold: { symbol: 'GC=F', name: '금 선물', category: 'commodity' }
};

/**
 * Yahoo Finance에서 여러 심볼의 실시간 데이터를 한번에 수집
 * API: Yahoo Finance v8 quote endpoint
 * 호출원: fetchAllMacro()
 */
async function fetchYahooQuotes() {
    const symbols = Object.values(YAHOO_SYMBOLS).map(s => s.symbol).join(',');
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(Object.values(YAHOO_SYMBOLS)[0].symbol)}`;

    // 개별 요청으로 변경 (v8 API는 단일 심볼만 지원)
    const results = {};

    for (const [key, info] of Object.entries(YAHOO_SYMBOLS)) {
        try {
            const resp = await axios.get(
                `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(info.symbol)}`,
                {
                    params: { interval: '1d', range: '2d' },
                    timeout: 10000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    }
                }
            );

            const chart = resp.data?.chart?.result?.[0];
            if (chart) {
                const meta = chart.meta;
                const price = meta.regularMarketPrice;
                const prevClose = meta.previousClose || meta.chartPreviousClose;
                const change = price && prevClose ? price - prevClose : null;
                const changePct = price && prevClose ? ((change / prevClose) * 100) : null;

                // marketState로 데이터 확정 여부 판단
                // REGULAR → 장중 (preliminary: 지연/분석 값일 수 있음)
                // CLOSED/POST → 마감 후 (confirmed: 실제 종가)
                const mState = meta.marketState || 'UNKNOWN';
                const isConfirmed = mState === 'CLOSED' || mState === 'POSTPOST';

                results[key] = {
                    name: info.name,
                    symbol: info.symbol,
                    category: info.category,
                    price: price ? parseFloat(price.toFixed(2)) : null,
                    prevClose: prevClose ? parseFloat(prevClose.toFixed(2)) : null,
                    change: change ? parseFloat(change.toFixed(2)) : null,
                    changePct: changePct ? parseFloat(changePct.toFixed(2)) : null,
                    marketState: mState,
                    status: isConfirmed ? 'confirmed' : 'preliminary',
                    currency: meta.currency || 'USD',
                    fetchedAt: new Date().toISOString()
                };
            }

            // Rate limit: 요청 간 300ms 대기
            await new Promise(r => setTimeout(r, 300));
        } catch (e) {
            console.error(`[매크로] Yahoo ${key}(${info.symbol}) 수집 실패: ${e.message}`);
            results[key] = { name: info.name, symbol: info.symbol, error: e.message, fetchedAt: new Date().toISOString() };
        }
    }

    return results;
}

// ============================================================
// G2: USD/KRW 환율 수집
// ============================================================
// 소스: 네이버 금융 (가장 빠르고 안정적)
// 호출원: fetchAllMacro()
// ============================================================

async function fetchUSDKRW() {
    try {
        // 방법 1: 네이버 금융 환율 페이지
        const resp = await axios.get('https://finance.naver.com/marketindex/exchangeDetail.naver?marketindexCd=FX_USDKRW', {
            timeout: 10000,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });

        const html = resp.data;
        // 환율 추출 (네이버 페이지 구조)
        const priceMatch = html.match(/class="no_today"[^>]*>[\s\S]*?<em[^>]*>([\d,.]+)<\/em>/);
        const changeMatch = html.match(/class="no_exday"[\s\S]*?<em[^>]*>([\d,.]+)<\/em>/);
        const directionMatch = html.match(/class="(point_dn|point_up)"/);

        if (priceMatch) {
            const price = parseFloat(priceMatch[1].replace(/,/g, ''));
            const change = changeMatch ? parseFloat(changeMatch[1].replace(/,/g, '')) : 0;
            const isUp = directionMatch ? directionMatch[1] === 'point_up' : change > 0;
            const signedChange = isUp ? change : -change;

            return {
                name: 'USD/KRW 환율',
                price,
                change: signedChange,
                changePct: price > 0 ? parseFloat((signedChange / (price - signedChange) * 100).toFixed(2)) : null,
                source: 'naver',
                fetchedAt: new Date().toISOString()
            };
        }
    } catch (e) {
        console.error(`[매크로] 환율(네이버) 수집 실패: ${e.message}`);
    }

    // 방법 2: Yahoo Finance 폴백
    try {
        const resp = await axios.get('https://query1.finance.yahoo.com/v8/finance/chart/KRW=X', {
            params: { interval: '1d', range: '2d' },
            timeout: 10000,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const meta = resp.data?.chart?.result?.[0]?.meta;
        if (meta) {
            const price = meta.regularMarketPrice;
            const prev = meta.previousClose || meta.chartPreviousClose;
            return {
                name: 'USD/KRW 환율',
                price: price ? parseFloat(price.toFixed(2)) : null,
                change: price && prev ? parseFloat((price - prev).toFixed(2)) : null,
                changePct: price && prev ? parseFloat(((price - prev) / prev * 100).toFixed(2)) : null,
                source: 'yahoo',
                fetchedAt: new Date().toISOString()
            };
        }
    } catch (e) {
        console.error(`[매크로] 환율(Yahoo) 수집 실패: ${e.message}`);
    }

    return { name: 'USD/KRW 환율', error: '수집 실패', fetchedAt: new Date().toISOString() };
}

// ============================================================
// 매크로 전체 수집 실행
// ============================================================
// 호출원: server.js 타이머 (30분 간격)
// 흐름: fetchYahooQuotes() + fetchUSDKRW() → current.json 저장
//       급변 감지 → alerts.json 추가
// ============================================================

async function fetchAllMacro() {
    console.log(`[매크로] 수집 시작...`);
    const startTime = Date.now();

    try {
        // 1. Yahoo Finance 지수 + 선물
        const yahooData = await fetchYahooQuotes();

        // 2. 환율
        const usdkrw = await fetchUSDKRW();

        // 3. 현재 데이터 구성
        const prevMacro = { ...currentMacro };

        currentMacro = {
            // 핵심 지표 (빠른 접근용)
            sox: yahooData.sox || null,
            vix: yahooData.vix || null,
            usdkrw: usdkrw,

            // 미국 지수 (sox는 최상위에 저장 — 중복 방지)
            indices: {
                sp500: yahooData.sp500 || null,
                nasdaq: yahooData.nasdaq || null,
                dxy: yahooData.dxy || null
            },

            // ⭐ 반도체 장비 (포트폴리오 직결 — 한미반도체·테크윙 선행지표)
            semiEquip: {
                lrcx: yahooData.lrcx || null,
                klac: yahooData.klac || null
            },

            // AI/서버 테마
            aiTheme: {
                arm: yahooData.arm || null,
                smci: yahooData.smci || null
            },

            // AI/반도체 대표주 (NVDA, AMD, MU, AVGO)
            aiSemi: {
                nvda: yahooData.nvda || null,
                amd: yahooData.amd || null,
                mu: yahooData.mu || null,
                avgo: yahooData.avgo || null
            },

            // 기타 (vixDetail 삭제 — vix와 중복)
            gold: yahooData.gold || null,
            us10y: yahooData.us10y || null,

            // 데이터 상태: 장중 수집은 preliminary, 마감 후는 confirmed
            // 사용자 요청: SOX 등은 장중에 분석값이므로 마감 후 확인 필요
            dataStatus: getOverallStatus(yahooData),

            // 메타
            updatedAt: new Date().toISOString(),
            fetchDuration: `${((Date.now() - startTime) / 1000).toFixed(1)}s`
        };

        // 4. 저장
        saveJSON(path.join(MACRO_DIR, 'current.json'), currentMacro);

        // 5. 급변 감지 (±2% 이상)
        checkAndAlertChanges(prevMacro, currentMacro);

        // 6. 일별 히스토리는 KST 06:10에만 저장 (saveDailyHistory)

        const symbols = Object.keys(yahooData).filter(k => !yahooData[k]?.error).length;
        console.log(`[매크로] 수집 완료: ${symbols}개 심볼 (${currentMacro.fetchDuration})`);

        return currentMacro;
    } catch (e) {
        console.error(`[매크로] 전체 수집 실패: ${e.message}`);
        return currentMacro;
    }
}

// ============================================================
// 급변 감지 & 알림
// ============================================================
// 목적: SOX ±3%, VIX ±10%, 환율 ±1% 등 급변 시 알림 기록
// 저장: data/macro/alerts.json
// ============================================================

const ALERT_THRESHOLDS = {
    sox: 3.0,      // SOX ±3% 이상
    vix: 10.0,     // VIX ±10% 이상 (VIX 자체가 변동성이 큼)
    usdkrw: 1.0,   // 환율 ±1% 이상
    sp500: 2.0,    // S&P ±2%
    nasdaq: 2.5,   // 나스닥 ±2.5%
};

function checkAndAlertChanges(prev, curr) {
    const newAlerts = [];

    for (const [key, threshold] of Object.entries(ALERT_THRESHOLDS)) {
        let currPct, name;

        if (key === 'usdkrw') {
            currPct = curr.usdkrw?.changePct;
            name = 'USD/KRW 환율';
        } else if (curr.indices?.[key]) {
            currPct = curr.indices[key]?.changePct;
            name = curr.indices[key]?.name;
        } else if (key === 'sox') {
            currPct = curr.sox?.changePct;
            name = 'SOX 반도체';
        } else if (key === 'vix') {
            currPct = curr.vix?.changePct;
            name = 'VIX 공포지수';
        }

        if (currPct && Math.abs(currPct) >= threshold) {
            const direction = currPct > 0 ? '급등' : '급락';
            newAlerts.push({
                indicator: key,
                name,
                changePct: currPct,
                direction,
                threshold,
                message: `⚠️ ${name} ${direction} ${currPct > 0 ? '+' : ''}${currPct}% (기준: ±${threshold}%)`,
                timestamp: new Date().toISOString()
            });
        }
    }

    if (newAlerts.length > 0) {
        alerts.push(...newAlerts);
        // 최근 100건만 유지
        if (alerts.length > 100) alerts = alerts.slice(-100);
        saveJSON(path.join(MACRO_DIR, 'alerts.json'), alerts);

        for (const a of newAlerts) {
            console.warn(`[매크로] ${a.message}`);
        }
    }
}

// ============================================================
// 일별 히스토리 저장 (KST 06:10에 1회만 호출)
// ============================================================
// 목적: 매일 확정 종가를 히스토리에 기록 (365일 FIFO)
// 파일: macro/history.json — 단일 파일에 날짜별 1건씩
// 항목: 유저 지정 16개만 (dow, oil, 선물 제외)
// ============================================================
function saveDailyHistory() {
    const today = getKSTDate();
    const fp = path.join(MACRO_DIR, 'history.json');

    // 기존 히스토리 로드
    const history = loadJSON(fp, []);

    // 같은 날짜가 이미 있으면 덮어쓰기
    const existingIdx = history.findIndex(h => h.date === today);
    const entry = {
        date: today,
        // 유저 지정 16개 항목
        sp500: currentMacro.indices?.sp500?.price || null,
        nasdaq: currentMacro.indices?.nasdaq?.price || null,
        sox: currentMacro.sox?.price || null,
        us10y: currentMacro.us10y?.price || null,
        dxy: currentMacro.indices?.dxy?.price || null,
        vix: currentMacro.vix?.price || null,
        nvda: currentMacro.aiSemi?.nvda?.price || null,
        amd: currentMacro.aiSemi?.amd?.price || null,
        mu: currentMacro.aiSemi?.mu?.price || null,
        lrcx: currentMacro.semiEquip?.lrcx?.price || null,
        klac: currentMacro.semiEquip?.klac?.price || null,
        arm: currentMacro.aiTheme?.arm?.price || null,
        smci: currentMacro.aiTheme?.smci?.price || null,
        avgo: currentMacro.aiSemi?.avgo?.price || null,
        usdkrw: currentMacro.usdkrw?.price || null,
        gold: currentMacro.gold?.price || null
    };

    if (existingIdx >= 0) {
        history[existingIdx] = entry;
    } else {
        history.push(entry);
    }

    // 365일 FIFO — 1년 초과 시 가장 오래된 것 삭제
    while (history.length > 365) {
        history.shift();
    }

    saveJSON(fp, history);
    console.log(`[매크로] 일별 히스토리 저장: ${today} (총 ${history.length}일)`);
}

// ============================================================
// 한국 시장 영향도 분석 (Claude 프롬프트용 요약)
// ============================================================
// 목적: 수집된 매크로 데이터를 한국 시장 관점으로 요약
// 호출원: Claude API에서 macro 필드 구성 시
// ============================================================

function getMarketImpactSummary() {
    if (!currentMacro.updatedAt) return null;

    const impact = {
        updatedAt: currentMacro.updatedAt,
        signals: [],
        sentiment: 'neutral' // bullish, bearish, neutral
    };

    let bullCount = 0, bearCount = 0;

    // SOX → 반도체 섹터 (삼성전자, SK하이닉스 등)
    if (currentMacro.sox?.changePct) {
        const pct = currentMacro.sox.changePct;
        if (Math.abs(pct) > 1) {
            impact.signals.push({
                indicator: 'SOX',
                value: `${pct > 0 ? '+' : ''}${pct}%`,
                impact: pct > 0 ? '반도체 섹터 긍정' : '반도체 섹터 부정',
                affectedSectors: ['반도체']
            });
            if (pct > 0) bullCount++; else bearCount++;
        }
    }

    // VIX → 시장 전체 심리
    if (currentMacro.vix?.price) {
        const vixPrice = currentMacro.vix.price;
        if (vixPrice > 25) {
            impact.signals.push({
                indicator: 'VIX',
                value: vixPrice.toFixed(1),
                impact: '시장 불안 심리 확대 — 외국인 매도 가능성',
                affectedSectors: ['전체']
            });
            bearCount++;
        } else if (vixPrice < 15) {
            impact.signals.push({
                indicator: 'VIX',
                value: vixPrice.toFixed(1),
                impact: '시장 안정 — 위험자산 선호',
                affectedSectors: ['전체']
            });
            bullCount++;
        }
    }

    // 환율 → 외국인 매매, 수출기업 실적
    if (currentMacro.usdkrw?.changePct) {
        const pct = currentMacro.usdkrw.changePct;
        if (Math.abs(pct) > 0.5) {
            impact.signals.push({
                indicator: 'USD/KRW',
                value: `${currentMacro.usdkrw.price}원 (${pct > 0 ? '+' : ''}${pct}%)`,
                impact: pct > 0 ? '원화 약세 — 수출기업 유리, 외국인 매도 우려' : '원화 강세 — 외국인 매수 기대',
                affectedSectors: pct > 0 ? ['자동차', '조선'] : ['내수']
            });
            // 원화 약세는 수출기업에 호재이나 외국인 매도에 악재 → 중립적
        }
    }

    // ⭐ US10Y → 외인 유출입 핵심 (금리↑ → 외인 이탈)
    if (currentMacro.us10y?.price) {
        const rate = currentMacro.us10y.price;
        const pct = currentMacro.us10y.changePct || 0;
        if (rate > 4.5) {
            impact.signals.push({
                indicator: 'US10Y',
                value: `${rate.toFixed(2)}% (${pct > 0 ? '+' : ''}${pct}%)`,
                impact: '고금리 지속 — 외국인 자금 유출 우려, 성장주 부담',
                affectedSectors: ['전체', 'IT', '바이오']
            });
            bearCount++;
        } else if (pct < -2) {
            impact.signals.push({
                indicator: 'US10Y',
                value: `${rate.toFixed(2)}% (${pct}%)`,
                impact: '금리 하락 — 외국인 매수 기대, 성장주 탄력',
                affectedSectors: ['전체', 'IT']
            });
            bullCount++;
        }
    }

    // ⭐ DXY → 달러 강세 방향 (USD/KRW과 함께 보는 상위 지표)
    if (currentMacro.indices?.dxy?.changePct) {
        const pct = currentMacro.indices.dxy.changePct;
        if (Math.abs(pct) > 0.5) {
            impact.signals.push({
                indicator: 'DXY',
                value: `${currentMacro.indices.dxy.price} (${pct > 0 ? '+' : ''}${pct}%)`,
                impact: pct > 0 ? '달러 강세 → 신흥국 자금 이탈 우려' : '달러 약세 → 신흥국 자금 유입 기대',
                affectedSectors: ['전체']
            });
            if (pct > 0) bearCount++; else bullCount++;
        }
    }

    // ⭐ 반도체 장비주 (LRCX/KLAC) → 한미반도체·테크윙 선행지표
    const lrcx = currentMacro.indices?.lrcx || Object.values(currentMacro).find(v => v?.symbol === 'LRCX');
    const klac = currentMacro.indices?.klac || Object.values(currentMacro).find(v => v?.symbol === 'KLAC');
    const equipAvg = [lrcx?.changePct, klac?.changePct].filter(Boolean);
    if (equipAvg.length > 0) {
        const avg = equipAvg.reduce((a, b) => a + b, 0) / equipAvg.length;
        if (Math.abs(avg) > 2) {
            impact.signals.push({
                indicator: '반도체장비(LRCX/KLAC)',
                value: `평균 ${avg > 0 ? '+' : ''}${avg.toFixed(1)}%`,
                impact: avg > 0 ? '장비 수주 기대 → 국내 장비주 긍정' : '장비 투자 둔화 → 국내 장비주 부정',
                affectedSectors: ['반도체장비', '한미반도체', '테크윙']
            });
            if (avg > 0) bullCount++; else bearCount++;
        }
    }

    // 종합 판단
    if (bullCount > bearCount + 1) impact.sentiment = 'bullish';
    else if (bearCount > bullCount + 1) impact.sentiment = 'bearish';
    else impact.sentiment = 'neutral';

    return impact;
}

// ============================================================
// 데이터 상태 판정 (preliminary / confirmed)
// ============================================================
// 목적: 장중 데이터(지연/분석값)와 마감 후 확정값을 구분
// SOX 등 지수는 장중에 실시간이 아닌 분석값일 수 있어
// 미장 마감 후(KST 06:00~07:00) 확정 종가로 교정 필요
// ============================================================

function getOverallStatus(yahooData) {
    const states = Object.values(yahooData)
        .filter(d => d && !d.error)
        .map(d => d.status || 'preliminary');
    // 모든 지수가 confirmed면 전체 confirmed
    if (states.length > 0 && states.every(s => s === 'confirmed')) return 'confirmed';
    return 'preliminary';
}

/**
 * 미장 마감 후 확정 종가 검증 & 저장
 * ─────────────────────────────────
 * 호출 시점: KST 06:30 (미장 마감 직후, server.js 타이머에서 호출)
 * 
 * 로직:
 *   1. Yahoo Finance에서 다시 수집 (marketState = CLOSED일 때)
 *   2. 기존 preliminary 값과 비교
 *   3. 차이가 있으면 수정 후 closing.json에 확정값 저장
 *   4. daily 스냅샷에도 confirmed 태그 추가
 * 
 * 왜 필요한가:
 *   SOX 등 일부 지수는 장중 데이터가 15~20분 지연되거나
 *   분석/추정값일 수 있음 → 마감 후 실제 종가 확인 필수
 */
async function verifyClosingPrices() {
    console.log(`[매크로] 확정 종가 검증 시작...`);

    try {
        const yahooData = await fetchYahooQuotes();
        const usdkrw = await fetchUSDKRW();

        // 확정 여부 확인
        const confirmedCount = Object.values(yahooData)
            .filter(d => d && !d.error && d.status === 'confirmed').length;

        if (confirmedCount === 0) {
            console.log(`[매크로] 아직 미장 마감 전 — 확정 종가 없음`);
            return null;
        }

        // 기존 preliminary 데이터와 비교
        const corrections = [];
        for (const [key, newData] of Object.entries(yahooData)) {
            if (!newData || newData.error || newData.status !== 'confirmed') continue;

            const oldData = currentMacro.indices?.[key] || currentMacro[key];
            if (oldData && oldData.price && newData.price) {
                const diff = Math.abs(newData.price - oldData.price);
                const diffPct = (diff / oldData.price * 100);
                if (diffPct > 0.01) { // 0.01% 이상 차이나면 기록
                    corrections.push({
                        symbol: key,
                        name: newData.name,
                        preliminary: oldData.price,
                        confirmed: newData.price,
                        diff: parseFloat(diff.toFixed(2)),
                        diffPct: parseFloat(diffPct.toFixed(3))
                    });
                }
            }
        }

        // 확정 종가 데이터 구성
        const closingData = {
            date: getKSTDate(),
            status: 'confirmed',
            verifiedAt: new Date().toISOString(),
            corrections: corrections,
            indices: {},
            futures: {},
            usdkrw: usdkrw
        };

        // 확정된 지수만 저장
        for (const [key, data] of Object.entries(yahooData)) {
            if (!data || data.error) continue;
            if (data.category === 'index') closingData.indices[key] = data;
            else if (data.category === 'futures') closingData.futures[key] = data;
            else closingData[key] = data;
        }

        // closing.json 저장
        saveJSON(path.join(MACRO_DIR, 'closing.json'), closingData);

        // current.json도 confirmed로 교체
        currentMacro.dataStatus = 'confirmed';
        currentMacro.sox = yahooData.sox || currentMacro.sox;
        currentMacro.vix = yahooData.vix || currentMacro.vix;
        // indices에서 sox/dow 제거 + dxy 누락 수정
        currentMacro.indices = {
            sp500: yahooData.sp500 || currentMacro.indices?.sp500,
            nasdaq: yahooData.nasdaq || currentMacro.indices?.nasdaq,
            dxy: yahooData.dxy || currentMacro.indices?.dxy
        };
        currentMacro.usdkrw = usdkrw || currentMacro.usdkrw;
        currentMacro.updatedAt = new Date().toISOString();
        currentMacro.closingVerifiedAt = new Date().toISOString();
        saveJSON(path.join(MACRO_DIR, 'current.json'), currentMacro);

        // 일별 히스토리는 별도 타이머 (KST 06:10)에서 저장

        if (corrections.length > 0) {
            console.log(`[매크로] ⚠️ 확정 종가 교정 ${corrections.length}건:`);
            for (const c of corrections) {
                console.log(`  ${c.name}: ${c.preliminary} → ${c.confirmed} (차이 ${c.diffPct}%)`);
            }
        } else {
            console.log(`[매크로] ✅ 확정 종가 검증 완료 — 교정 없음 (${confirmedCount}개 confirmed)`);
        }

        return closingData;
    } catch (e) {
        console.error(`[매크로] 확정 종가 검증 실패: ${e.message}`);
        return null;
    }
}

// ============================================================
// 현재 데이터 접근 (외부 노출)
// ============================================================
function getCurrent() { return currentMacro; }
function getAlerts() { return alerts; }

// ============================================================
// Exports
// ============================================================
module.exports = {
    fetchAllMacro,
    fetchYahooQuotes,
    fetchUSDKRW,
    verifyClosingPrices,   // 미장 마감 후 확정 종가 검증
    getCurrent,
    getAlerts,
    getMarketImpactSummary,
    cleanOldDaily: () => { },  // 하위호환 — 더 이상 사용하지 않음
    saveDailyHistory,         // KST 06:10 일별 히스토리 저장
    MACRO_DIR,
    DAILY_DIR
};
