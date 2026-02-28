/**
 * DART 모니터 — 한국투자증권 API 크롤러
 * 
 * 기능:
 * - OAuth 토큰 자동 발급/갱신 (24시간 유효)
 * - 현재가·거래량 조회 (FHKST01010100)
 * - 시간외 현재가 조회 (장마감 후 15:30~16:00)
 * - 일봉 데이터 조회 (FHKST01010400)
 * - 종목코드 자동 조회 (네이버 금융 폴백)
 * - 장중/장외/시간외 스마트 스케줄링
 */

const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const config = require('../config');
const { saveJSON, loadJSON } = require('../utils/file-io');
const companyData = require('../utils/company-data');

// ============================================================
// 상수
// ============================================================
const BASE_URL = 'https://openapi.koreainvestment.com:9443';
const APP_KEY = config.HANTOO_APP_KEY;
const APP_SECRET = config.HANTOO_APP_SECRET;

// 토큰 상태
let accessToken = '';
let tokenExpiry = 0;

// 서버 시작 시 저장된 토큰 복원
(function loadSavedToken() {
    const saved = loadJSON('hantoo_token.json', null);
    if (saved && saved.token && saved.expiry && Date.now() < saved.expiry - 3600000) {
        accessToken = saved.token;
        tokenExpiry = saved.expiry;
        const remainH = Math.round((saved.expiry - Date.now()) / 3600000);
        console.log(`[한투] 저장된 토큰 복원 (잔여: ${remainH}시간)`);
    }
})();

// 데이터 저장소 — companies/{code}/price.json이 단일 원본
let stockPrices = {};
let watchlist = loadJSON('watchlist.json', []);

// 시장 지수 캐시 (KOSPI/KOSDAQ)
let indexPrices = { kospi: null, kosdaq: null };

// 시장 전체 투자자별 순매수 캐시 (네이버 크롤링)
let marketInvestor = null;

// 시작 시 companies/ 기반으로 가격 + 일봉 복원 (MA 계산용)
(function restorePricesFromCompanies() {
    const companyData = require('../utils/company-data');
    let dailyRestored = 0;
    for (const stock of watchlist) {
        if (!stock.code) continue;
        const priceData = companyData.getPrice(stock.code);
        if (priceData.current) {
            stockPrices[stock.code] = { current: priceData.current };
            // 일봉 데이터도 복원 (MA5/20/200 계산용)
            if (priceData.daily && priceData.daily.length > 0) {
                stockPrices[stock.code].daily = priceData.daily;
                dailyRestored++;
            }
        }
    }
    const restored = Object.keys(stockPrices).length;
    if (restored > 0) console.log(`[한투] 가격 복원: ${restored}종목 (일봉: ${dailyRestored}종목) (companies/ 기반)`);
})();

// 스케줄러
let fetchTimer = null;
let isRunning = false;

// API 호출 우선순위: 유저 조회 > 백그라운드 수집
let userPriority = false;
function acquireUserPriority() { userPriority = true; }
function releaseUserPriority() { userPriority = false; }
function waitForUserPriority() {
    // 유저가 조회 중이면 백그라운드 대기 (200ms 간격 체크)
    return new Promise(resolve => {
        function check() {
            if (!userPriority) return resolve();
            setTimeout(check, 200);
        }
        check();
    });
}

// 가격 변동 콜백 시스템
let priceAlertCallbacks = [];
function onPriceAlert(cb) { priceAlertCallbacks.push(cb); }
function emitPriceAlert(data) {
    for (const cb of priceAlertCallbacks) { try { cb(data); } catch (e) { } }
}

// ============================================================
// OAuth 토큰 관리 (파일 저장으로 재발급 최소화)
// ============================================================
async function getToken() {
    // 토큰이 유효하면 재사용 (만료 1시간 전 갱신)
    if (accessToken && Date.now() < tokenExpiry - 3600000) {
        return accessToken;
    }

    if (!APP_KEY || !APP_SECRET) {
        console.log('[한투] API 키 미설정 — 스킵');
        return null;
    }

    try {
        console.log('[한투] 토큰 발급 요청...');
        const resp = await axios.post(`${BASE_URL}/oauth2/tokenP`, {
            grant_type: 'client_credentials',
            appkey: APP_KEY,
            appsecret: APP_SECRET
        }, { timeout: 10000 });

        accessToken = resp.data.access_token;
        // 토큰 유효기간: 보통 24시간 (86400초)
        const expiresIn = resp.data.expires_in || 86400;
        tokenExpiry = Date.now() + expiresIn * 1000;

        // 파일에 토큰 저장 (재시작 시 재사용)
        saveJSON('hantoo_token.json', { token: accessToken, expiry: tokenExpiry });

        console.log('[한투] 토큰 발급 성공 (유효: ' + Math.round(expiresIn / 3600) + '시간)');
        return accessToken;
    } catch (e) {
        const msg = e.response?.data?.msg1 || e.response?.data?.message || e.message;
        console.error('[한투] 토큰 발급 실패:', msg);
        return null;
    }
}

// ============================================================
// API 공통 호출
// ============================================================
async function kisRequest(endpoint, trId, params, _retried) {
    const token = await getToken();
    if (!token) return null;

    try {
        const resp = await axios.get(`${BASE_URL}${endpoint}`, {
            headers: {
                'content-type': 'application/json; charset=utf-8',
                'authorization': `Bearer ${token}`,
                'appkey': APP_KEY,
                'appsecret': APP_SECRET,
                'tr_id': trId,
                'custtype': 'P'
            },
            params: params,
            timeout: 10000
        });

        if (resp.data.rt_cd !== '0') {
            const msg = resp.data.msg1 || '';
            // 토큰 만료 감지 → 강제 갱신 후 1회 재시도
            if (!_retried && msg.includes('만료')) {
                console.warn(`[한투] 토큰 만료 감지 — 강제 갱신 시도`);
                accessToken = null;
                tokenExpiry = 0;
                return kisRequest(endpoint, trId, params, true);
            }
            console.error(`[한투] API 오류 (${trId}): ${msg}`);
            return null;
        }
        return resp.data;
    } catch (e) {
        const msg = e.response?.data?.msg1 || e.message;
        // HTTP 에러에서도 토큰 만료 감지
        if (!_retried && msg.includes('만료')) {
            console.warn(`[한투] 토큰 만료 감지 (HTTP) — 강제 갱신 시도`);
            accessToken = null;
            tokenExpiry = 0;
            return kisRequest(endpoint, trId, params, true);
        }
        console.error(`[한투] 요청 실패 (${trId}):`, msg);
        return null;
    }
}

// ============================================================
// 지수 현재가 조회 (KOSPI/KOSDAQ)
// ============================================================
async function fetchIndexPrice(iscd) {
    // iscd: '0001'(KOSPI), '1001'(KOSDAQ)
    const data = await kisRequest(
        '/uapi/domestic-stock/v1/quotations/inquire-index-price',
        'FHPUP02100000',
        {
            FID_COND_MRKT_DIV_CODE: 'U',
            FID_INPUT_ISCD: iscd
        }
    );

    if (!data || !data.output) return null;

    const o = data.output;
    return {
        price: parseFloat(o.bstp_nmix_prpr) || 0,        // 현재 지수
        change: parseFloat(o.bstp_nmix_prdy_vrss) || 0,   // 전일 대비
        changePct: parseFloat(o.bstp_nmix_prdy_ctrt) || 0, // 등락률
        volume: parseInt(o.acml_vol) || 0,                  // 거래량
        tradeAmt: parseInt(o.acml_tr_pbmn) || 0             // 거래대금
    };
}

// ============================================================
// 종목별 투자자 매매동향 (외국인/기관) — FHKST01010900
// ============================================================
async function fetchInvestorData(stockCode) {
    const data = await kisRequest(
        '/uapi/domestic-stock/v1/quotations/inquire-investor',
        'FHKST01010900',
        {
            FID_COND_MRKT_DIV_CODE: 'J',
            FID_INPUT_ISCD: stockCode
        }
    );

    if (!data || !data.output || !data.output[0]) return null;

    const o = data.output[0];
    return {
        date: o.stck_bsop_date || '',           // 날짜
        frgnNetQty: parseInt(o.frgn_ntby_qty) || 0,   // 외국인 순매수 수량
        frgnNetAmt: parseInt(o.frgn_ntby_tr_pbmn) || 0, // 외국인 순매수 금액(백만)
        orgnNetQty: parseInt(o.orgn_ntby_qty) || 0,   // 기관 순매수 수량
        orgnNetAmt: parseInt(o.orgn_ntby_tr_pbmn) || 0, // 기관 순매수 금액(백만)
        prsnNetQty: parseInt(o.prsn_ntby_qty) || 0,   // 개인 순매수 수량
        prsnNetAmt: parseInt(o.prsn_ntby_tr_pbmn) || 0  // 개인 순매수 금액(백만)
    };
}

// ============================================================
// 종목별 투자자 매매동향 — 최근 7일 (독립 함수, fetchInvestorData 수정 없음)
// ============================================================
async function fetchInvestorWeekly(stockCode) {
    const data = await kisRequest(
        '/uapi/domestic-stock/v1/quotations/inquire-investor',
        'FHKST01010900',
        {
            FID_COND_MRKT_DIV_CODE: 'J',
            FID_INPUT_ISCD: stockCode
        }
    );

    if (!data || !data.output || data.output.length === 0) return [];

    return data.output.slice(0, 7).map(o => ({
        date: o.stck_bsop_date || '',
        foreignNet: parseInt(o.frgn_ntby_tr_pbmn) || 0,  // 외국인 순매수 (백만)
        instNet: parseInt(o.orgn_ntby_tr_pbmn) || 0,      // 기관 순매수 (백만)
        retailNet: parseInt(o.prsn_ntby_tr_pbmn) || 0,    // 개인 순매수 (백만)
    }));
}

// ============================================================
// 시장 전체 외국인/기관 순매수 — 네이버 크롤링 (단위: 억원)
// KOSPI + KOSDAQ 둘 다 수집, 기존 반환 구조 유지 (하위호환)
// ============================================================

// 네이버 투자자별 순매수 페이지 크롤링 — sosok: '01'(KOSPI), '02'(KOSDAQ)
async function crawlInvestorPage(sosok) {
    const axios = require('axios');
    const iconv = require('iconv-lite');

    const url = `https://finance.naver.com/sise/investorDealTrendDay.naver?sosok=${sosok}`;
    const r = await axios.get(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            'Referer': 'https://finance.naver.com/'
        },
        timeout: 10000,
        responseType: 'arraybuffer'
    });

    const html = iconv.decode(r.data, 'euc-kr');
    const tableMatch = html.match(/<table[^>]*summary=["']일자별 순매수[\s\S]*?<\/table>/);
    if (!tableMatch) return null;

    const rows = tableMatch[0].match(/<tr[^>]*>[\s\S]*?<\/tr>/g);
    if (!rows) return null;

    // 첫 데이터 행 찾기 (날짜 패턴이 있는 행)
    for (const row of rows) {
        const cells = row.match(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi);
        if (!cells) continue;
        const texts = cells.map(c => c.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, '').replace(/,/g, '').trim());
        // 날짜 형식: 26.02.21
        if (/\d{2}\.\d{2}\.\d{2}/.test(texts[0])) {
            // 열: 날짜, 개인, 외국인, 기관계, 금융투자, 기타법인
            return {
                date: texts[0],                          // 날짜
                personal: parseInt(texts[1]) || 0,       // 개인 (억원)
                foreign: parseInt(texts[2]) || 0,         // 외국인 (억원)
                institution: parseInt(texts[3]) || 0,     // 기관계 (억원)
                finance: parseInt(texts[4]) || 0,         // 금융투자 (억원)
                other: parseInt(texts[5]) || 0,           // 기타법인 (억원)
            };
        }
    }
    return null;
}

// KOSPI + KOSDAQ 투자자 동향 통합 크롤링
async function fetchMarketInvestor() {
    try {
        // KOSPI 크롤링 (기존과 동일)
        const kospi = await crawlInvestorPage('01');
        if (!kospi) return null;

        // 기존 반환 구조 유지 (KOSPI 값 = 최상위 필드)
        const result = {
            ...kospi,
            updatedAt: new Date().toISOString()
        };

        // KOSDAQ 크롤링 추가
        try {
            const kosdaq = await crawlInvestorPage('02');
            if (kosdaq) {
                result.kosdaq = kosdaq;
            }
        } catch (e) {
            console.warn(`[한투] KOSDAQ 투자자 크롤링 실패 (KOSPI는 성공): ${e.message}`);
        }

        return result;
    } catch (e) {
        console.warn(`[한투] 시장 투자자 데이터 크롤링 실패: ${e.message}`);
        return null;
    }
}

// ============================================================
// 현재가 조회 (투자자동향 + 지지/저항 포함)
// ============================================================
async function fetchCurrentPrice(stockCode) {
    const data = await kisRequest(
        '/uapi/domestic-stock/v1/quotations/inquire-price',
        'FHKST01010100',
        {
            FID_COND_MRKT_DIV_CODE: 'J',
            FID_INPUT_ISCD: stockCode
        }
    );

    if (!data || !data.output) return null;

    const o = data.output;
    return {
        price: parseInt(o.stck_prpr) || 0,           // 현재가
        change: parseFloat(o.prdy_ctrt) || 0,         // 전일 대비 등락률
        changeAmt: parseInt(o.prdy_vrss) || 0,        // 전일 대비 금액
        volume: parseInt(o.acml_vol) || 0,             // 누적 거래량
        tradeAmt: parseInt(o.acml_tr_pbmn) || 0,      // 누적 거래대금
        high: parseInt(o.stck_hgpr) || 0,              // 당일 고가
        low: parseInt(o.stck_lwpr) || 0,               // 당일 저가
        open: parseInt(o.stck_oprc) || 0,              // 시가
        prevClose: parseInt(o.stck_sdpr) || 0,         // 전일 종가
        per: parseFloat(o.per) || 0,                   // PER
        pbr: parseFloat(o.pbr) || 0,                   // PBR
        marketCap: parseInt(o.hts_avls) || 0,          // 시가총액(억)
        foreignRatio: parseFloat(o.hts_frgn_ehrt) || 0, // 외국인보유비율(%)
        // 투자자 동향
        foreignNetBuy: parseInt(o.frgn_ntby_qty) || 0,  // 외국인 순매수(주)
        programNetBuy: parseInt(o.pgtr_ntby_qty) || 0,  // 프로그램 순매수(주)
        // 지지/저항 (피봇 기반)
        resistance: parseInt(o.dmrs_val) || 0,          // 저항선
        support: parseInt(o.dmsp_val) || 0,             // 지지선
        pivotPoint: parseInt(o.pvt_pont_val) || 0,      // 피봇값
        // 52주/250일 범위
        w52High: parseInt(o.w52_hgpr) || 0,             // 52주 최고가
        w52Low: parseInt(o.w52_lwpr) || 0,              // 52주 최저가
        time: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
    };
}

// ============================================================
// 시간외 현재가 조회
// 장 마감(15:30) 후에도 FHKST01010100 호출 시 시간외 단일가 반영됨
// 종가 대비 시간외 변동률을 별도 필드로 추출
// ============================================================
async function fetchAfterHoursPrice(stockCode) {
    const data = await kisRequest(
        '/uapi/domestic-stock/v1/quotations/inquire-price',
        'FHKST01010100',
        {
            FID_COND_MRKT_DIV_CODE: 'J',
            FID_INPUT_ISCD: stockCode
        }
    );

    if (!data || !data.output) return null;

    const o = data.output;
    const currentPrice = parseInt(o.stck_prpr) || 0;
    const closePrice = parseInt(o.stck_sdpr) || 0;  // 전일 종가 (장중에는 전일, 장후에는 당일 종가)
    const volume = parseInt(o.acml_vol) || 0;

    // 시간외 변동률 계산
    const afterChange = closePrice > 0 ? parseFloat(((currentPrice - closePrice) / closePrice * 100).toFixed(2)) : 0;

    return {
        price: currentPrice,
        closePrice: closePrice,
        change: afterChange,
        changeAmt: currentPrice - closePrice,
        volume: volume,
        updatedAt: new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })
    };
}

// ============================================================
// 이동평균 계산 (일봉 데이터 기반)
// ============================================================
function calculateMA(dailyData, period) {
    if (!dailyData || dailyData.length < period) return null;
    const closes = dailyData.slice(-period).map(d => d.close);
    return Math.round(closes.reduce((a, b) => a + b, 0) / period);
}

// 종목별 기술적 분석 데이터 반환 (챗봇/분석봇용)
function getStockAnalysis(code) {
    const p = stockPrices[code];
    if (!p || !p.current) return null;
    const daily = p.daily || [];
    const week = daily.slice(-7);  // 최근 1주일
    return {
        current: p.current,
        // 이동평균선
        ma5: calculateMA(daily, 5),
        ma20: calculateMA(daily, 20),
        ma60: calculateMA(daily, 60),
        ma200: calculateMA(daily, 200),
        // 최근 1주일 가격
        weeklyPrices: week.map(d => ({ date: d.date, close: d.close, volume: d.volume })),
        // 일봉 데이터 수
        dailyCount: daily.length
    };
}

// ============================================================
// 일봉 조회 (200일로 확장 — MA200 계산용)
// ============================================================
async function fetchDailyPrice(stockCode, days = 200) {
    const endDate = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const startDate = new Date(Date.now() - days * 24 * 3600000).toISOString().slice(0, 10).replace(/-/g, '');

    const data = await kisRequest(
        '/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice',
        'FHKST03010100',
        {
            FID_COND_MRKT_DIV_CODE: 'J',
            FID_INPUT_ISCD: stockCode,
            FID_INPUT_DATE_1: startDate,
            FID_INPUT_DATE_2: endDate,
            FID_PERIOD_DIV_CODE: 'D',
            FID_ORG_ADJ_PRC: '0'
        }
    );

    if (!data || !data.output2) return [];

    return data.output2
        .filter(d => d.stck_bsop_date)
        .map(d => ({
            date: d.stck_bsop_date.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'),
            open: parseInt(d.stck_oprc) || 0,
            high: parseInt(d.stck_hgpr) || 0,
            low: parseInt(d.stck_lwpr) || 0,
            close: parseInt(d.stck_clpr) || 0,
            volume: parseInt(d.acml_vol) || 0
        }))
        .reverse();  // 오래된 순서로
}

// ============================================================
// 종목코드 자동 조회 (네이버 증권 자동완성 API)
// ============================================================
async function lookupStockCode(stockName) {
    try {
        const searchUrl = `https://ac.stock.naver.com/ac?q=${encodeURIComponent(stockName)}&target=stock`;
        const resp = await axios.get(searchUrl, {
            timeout: 10000,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const items = (resp.data && resp.data.items) || [];
        // 국내 주식 필터 (코스피 + 코스닥 모두 KOR)
        const domestic = items.filter(i => i.nationCode === 'KOR' && i.category === 'stock');
        if (domestic.length > 0) {
            // 정확히 일치하는 이름 우선, 없으면 첫 번째 결과
            const exact = domestic.find(i => i.name === stockName) || domestic[0];
            console.log(`[한투] 종목코드 조회: ${stockName} → ${exact.code} (${exact.typeName || ''})`);
            return exact.code;
        }
        console.log(`[한투] 종목코드 못 찾음: ${stockName}`);
        return null;
    } catch (e) {
        console.error(`[한투] 종목코드 조회 실패 (${stockName}):`, e.message);
        return null;
    }
}

// ============================================================
// 전 종목 수집
// ============================================================
async function fetchAllStocks() {
    if (isRunning) return;
    if (!APP_KEY || !APP_SECRET) return;

    isRunning = true;
    const startTime = Date.now();
    let success = 0, fail = 0, updated = 0;

    console.log(`[한투] ${watchlist.length}종목 현재가 수집 시작...`);

    // 지수 갱신 (KOSPI/KOSDAQ)
    try {
        const [kospi, kosdaq] = await Promise.all([
            fetchIndexPrice('0001'),
            fetchIndexPrice('1001')
        ]);
        if (kospi) indexPrices.kospi = kospi;
        if (kosdaq) indexPrices.kosdaq = kosdaq;
        console.log(`[한투] 지수 갱신: KOSPI ${kospi?.price || '-'} / KOSDAQ ${kosdaq?.price || '-'}`);

        // 시장 전체 투자자 순매수 크롤링 (네이버)
        const mktInv = await fetchMarketInvestor();
        if (mktInv) {
            marketInvestor = mktInv;
            // 파일로도 저장 (서버 재시작 시 복원용)
            saveJSON('macro/market_investor.json', mktInv);
            console.log(`[한투] 시장 투자자: 외국인 ${mktInv.foreign > 0 ? '+' : ''}${mktInv.foreign}억 / 기관 ${mktInv.institution > 0 ? '+' : ''}${mktInv.institution}억 (${mktInv.date})`);
        } else if (!marketInvestor) {
            // 캐시 없으면 파일에서 복원
            const saved = loadJSON('macro/market_investor.json', null);
            if (saved) marketInvestor = saved;
        }
    } catch (e) {
        console.warn(`[한투] 지수 조회 실패: ${e.message}`);
    }

    for (let i = 0; i < watchlist.length; i++) {
        const stock = watchlist[i];

        // 코드 없으면 크롤링 조회
        if (!stock.code) {
            stock.code = await lookupStockCode(stock.name);
            if (stock.code) {
                // watchlist에 코드 저장
                saveJSON('watchlist.json', watchlist);
            } else {
                fail++;
                continue;
            }
        }

        try {
            const price = await fetchCurrentPrice(stock.code);
            if (price) {
                // 저장소 업데이트 (기존 daily 데이터 보존)
                if (!stockPrices[stock.code]) {
                    stockPrices[stock.code] = { name: stock.name, current: null, daily: [] };
                }
                stockPrices[stock.code].name = stock.name;
                stockPrices[stock.code].current = price;
                success++;

                // 기업별 폴더에도 저장
                companyData.saveCurrentPrice(stock.code, stock.name, price, stock.sector);

                // 인트라데이 5분 틱 저장 (장중에만)
                if (isMarketHours()) {
                    const now2 = new Date();
                    const kst2 = new Date(now2.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
                    const timeStr = String(kst2.getHours()).padStart(2, '0') + String(kst2.getMinutes()).padStart(2, '0');
                    companyData.saveIntradayTick(stock.code, {
                        t: timeStr,
                        p: price.price,
                        v: price.volume || 0,
                        h: price.high || price.price,
                        l: price.low || price.price,
                        chg: price.change || 0
                    });
                }

                // 변동 감지 + 알림
                const prev = stockPrices[stock.code]._prevPrice;
                if (prev && prev !== price.price) {
                    updated++;
                    const changeRate = ((price.price - prev) / prev * 100).toFixed(2);
                    if (Math.abs(changeRate) >= 3) {
                        emitPriceAlert({
                            name: stock.name,
                            code: stock.code,
                            prevPrice: prev,
                            price: price.price,
                            change: parseFloat(changeRate),
                            time: new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })
                        });
                    }
                }
                stockPrices[stock.code]._prevPrice = price.price;
            } else {
                fail++;
            }
        } catch (e) {
            fail++;
        }

        // API 호출 제한 + 유저 우선순위 대기
        if (i < watchlist.length - 1) {
            await waitForUserPriority(); // 유저 조회 중이면 양보
            await new Promise(r => setTimeout(r, 100)); // 초당 10건 제한
        }
    }

    // 저장

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[한투] 완료: ${success}성공/${fail}실패 (${elapsed}초)${updated ? ` 변동 ${updated}건` : ''}`);
    isRunning = false;
}

// ============================================================
// 일봉 수집 (하루 1회)
// ============================================================
async function fetchAllDailyPrices() {
    if (!APP_KEY || !APP_SECRET) return;

    console.log(`[한투] ${watchlist.length}종목 일봉 수집 시작...`);
    let success = 0;

    for (let i = 0; i < watchlist.length; i++) {
        const stock = watchlist[i];
        if (!stock.code) continue;

        try {
            const daily = await fetchDailyPrice(stock.code, 60);
            if (daily.length > 0) {
                if (!stockPrices[stock.code]) {
                    stockPrices[stock.code] = { name: stock.name, current: null, daily: [] };
                }
                stockPrices[stock.code].daily = daily;
                success++;

                // 기업별 폴더에도 저장
                companyData.saveDailyPrices(stock.code, stock.name, daily);
            }
        } catch (e) {
            console.error(`[한투] 일봉 실패 (${stock.name}):`, e.message);
        }

        // 딜레이
        await new Promise(r => setTimeout(r, 150));
    }

    console.log(`[한투] 일봉 ${success}/${watchlist.length}종목 완료`);
}

// ============================================================
// 시간외 전종목 수집
// ============================================================
async function fetchAllAfterHours() {
    if (!APP_KEY || !APP_SECRET) return;
    if (!isAfterHours()) return;

    console.log(`[한투] ${watchlist.length}종목 시간외 수집 시작...`);
    let success = 0;

    for (let i = 0; i < watchlist.length; i++) {
        const stock = watchlist[i];
        if (!stock.code) continue;

        try {
            const afterHours = await fetchAfterHoursPrice(stock.code);
            if (afterHours) {
                // stockPrices에 afterHours 저장
                if (!stockPrices[stock.code]) {
                    stockPrices[stock.code] = { name: stock.name, current: null, daily: [] };
                }
                stockPrices[stock.code].afterHours = afterHours;

                // 기업별 폴더에도 afterHours 저장
                const priceData = companyData.getPrice(stock.code);
                priceData.afterHours = afterHours;
                companyData.saveCompanyJSON(stock.code, 'price.json', priceData);

                success++;
            }
        } catch (e) {
            // 무시
        }

        await new Promise(r => setTimeout(r, 100));
    }

    console.log(`[한투] 시간외 ${success}/${watchlist.length}종목 완료`);
}

// ============================================================
// 장 마감 후 인트라데이 분석 트리거
// ============================================================
let intradayAnalyzed = false; // 하루 1회 플래그

async function triggerIntradayAnalysis() {
    if (intradayAnalyzed) return;
    intradayAnalyzed = true;

    const now = new Date();
    const kst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
    const yyyymmdd = kst.getFullYear().toString() +
        String(kst.getMonth() + 1).padStart(2, '0') +
        String(kst.getDate()).padStart(2, '0');

    console.log(`[한투] 장마감 인트라데이 분석 시작 (${yyyymmdd})...`);
    let analyzed = 0;

    for (const stock of watchlist) {
        if (!stock.code) continue;
        const ticks = companyData.getIntraday(stock.code, yyyymmdd);
        if (ticks.length < 5) continue; // 데이터 부족

        try {
            // Gemini 분석 (onAnalyzeIntraday 콜백)
            if (onAnalyzeIntradayCb) {
                const summary = await onAnalyzeIntradayCb(stock.code, stock.name, ticks);
                if (summary) {
                    companyData.saveIntradaySummary(stock.code, yyyymmdd, summary);
                    analyzed++;
                }
            }
        } catch (e) {
            console.warn(`[한투] ${stock.name} 인트라데이 분석 실패: ${e.message}`);
        }
        await new Promise(r => setTimeout(r, 500)); // Gemini 제한
    }

    // 오래된 데이터 청소
    cleanAllIntraday();

    console.log(`[한투] 인트라데이 분석 완료: ${analyzed}종목`);
}

function cleanAllIntraday() {
    let totalDeleted = 0;
    for (const stock of watchlist) {
        if (!stock.code) continue;
        totalDeleted += companyData.cleanOldIntraday(stock.code, 7);
        totalDeleted += companyData.cleanOldSummaries(stock.code, 30);
    }
    if (totalDeleted > 0) console.log(`[한투] 인트라데이 청소: ${totalDeleted}파일 삭제`);
}

// 날짜 변경 감지 (청소용)
let lastDate = '';
let intradayCleaned = false;
function checkDateChange() {
    const now = new Date();
    const kst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
    const today = kst.getFullYear().toString() +
        String(kst.getMonth() + 1).padStart(2, '0') +
        String(kst.getDate()).padStart(2, '0');
    if (lastDate && lastDate !== today) {
        intradayCleaned = false;
    }
    lastDate = today;
}

// ============================================================
// 스마트 스케줄러
// ============================================================
function isMarketHours() {
    const now = new Date();
    const kst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
    const day = kst.getDay();
    const h = kst.getHours();
    const m = kst.getMinutes();
    const time = h * 100 + m;

    // 주말
    if (day === 0 || day === 6) return false;
    // 장중: 08:50 ~ 15:30
    if (time >= 850 && time <= 1530) return true;
    return false;
}

// 시간외 단일가: 15:30 ~ 16:00 (평일)
function isAfterHours() {
    const now = new Date();
    const kst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
    const day = kst.getDay();
    const h = kst.getHours();
    const m = kst.getMinutes();
    const time = h * 100 + m;

    if (day === 0 || day === 6) return false;
    // 시간외 단일가: 15:30 ~ 16:00
    if (time >= 1530 && time <= 1600) return true;
    return false;
}



// 배치 수집 설정 — 종목수의 1/10씩 나눠서 수집 (1시간에 전 종목 완료)
let currentBatchIndex = 0;   // 현재 배치 인덱스

function getBatchSize() {
    // 종목수 / 10 = 배치 크기 (종목 추가/삭제 시 자동 조절)
    return Math.max(1, Math.ceil(watchlist.length / 10));
}

function getInterval() {
    // 종목수/배치크기 = 총 배치 수, 60분/총배치수 = 배치 간격
    const totalBatches = Math.ceil(watchlist.length / getBatchSize());
    const intervalMin = Math.max(6, Math.floor(60 / totalBatches)); // 최소 6분
    return intervalMin * 60 * 1000;  // 약 6~8분 간격
}

// 배치 단위 현재가 수집 (전체 대신 일부만)
async function fetchBatchStocks() {
    if (isRunning) return;
    if (!APP_KEY || !APP_SECRET) return;

    isRunning = true;
    const startTime = Date.now();
    const totalBatches = Math.ceil(watchlist.length / getBatchSize());
    const start = currentBatchIndex * getBatchSize();
    const end = Math.min(start + getBatchSize(), watchlist.length);
    const batch = watchlist.slice(start, end);

    console.log(`[한투] 배치 ${currentBatchIndex + 1}/${totalBatches} (${batch.length}종목) 수집 시작...`);

    // 첫 배치일 때만 지수 갱신
    if (currentBatchIndex === 0) {
        try {
            const [kospi, kosdaq] = await Promise.all([
                fetchIndexPrice('0001'),
                fetchIndexPrice('1001')
            ]);
            if (kospi) indexPrices.kospi = kospi;
            if (kosdaq) indexPrices.kosdaq = kosdaq;
            console.log(`[한투] 지수: KOSPI ${kospi?.price || '-'} / KOSDAQ ${kosdaq?.price || '-'}`);

            // [변경] 네이버 투자자 크롤링 → 별도 장마감 타이머로 이관
            // 서버 시작 시 파일에서 복원만 수행
            if (!marketInvestor) {
                const saved = loadJSON('macro/market_investor.json', null);
                if (saved) {
                    // 누적 구조면 latest 사용, 단일 구조면 그대로
                    marketInvestor = saved.latest || saved;
                }
            }
        } catch (e) {
            console.warn(`[한투] 지수 조회 실패: ${e.message}`);
        }
    }

    let success = 0, fail = 0;
    for (const stock of batch) {
        if (!stock.code) {
            stock.code = await lookupStockCode(stock.name);
            if (stock.code) saveJSON('watchlist.json', watchlist);
            else { fail++; continue; }
        }

        try {
            const price = await fetchCurrentPrice(stock.code);
            if (price) {
                if (!stockPrices[stock.code]) {
                    stockPrices[stock.code] = { name: stock.name, current: null, daily: [] };
                }
                stockPrices[stock.code].name = stock.name;
                stockPrices[stock.code].current = price;
                success++;
                companyData.saveCurrentPrice(stock.code, stock.name, price, stock.sector);
                // [메모리 관리] 파일 저장 완료 — daily 배열 비우기 (한투 데이터만)
                if (stockPrices[stock.code].daily && stockPrices[stock.code].daily.length > 0) {
                    stockPrices[stock.code].daily = [];
                }
            } else { fail++; }
        } catch (e) { fail++; }

        await new Promise(r => setTimeout(r, 100));
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[한투] 배치 ${currentBatchIndex + 1}/${totalBatches} 완료: ${success}성공/${fail}실패 (${elapsed}초)`);




    // 다음 배치로 이동 (순환)
    currentBatchIndex = (currentBatchIndex + 1) % totalBatches;
    isRunning = false;
}

function scheduleNext() {
    if (fetchTimer) clearTimeout(fetchTimer);
    const interval = getInterval();
    fetchTimer = setTimeout(async () => {
        checkDateChange();

        // 장외 시간에 1일 1회 오래된 인트라데이 청소
        if (!isMarketHours() && !isAfterHours() && !intradayCleaned) {
            cleanAllIntraday();
            intradayCleaned = true;
        }

        if (isAfterHours()) {
            await fetchAllAfterHours();
        } else {
            // 배치 수집 (10개씩)
            await fetchBatchStocks();
        }
        scheduleNext();
    }, interval);
}

// ============================================================
// 초기화 및 시작
// ============================================================
let dailyTimer = null;

function start() {
    if (!APP_KEY || !APP_SECRET) {
        console.log('[한투] API 키 미설정 — 비활성화');
        return;
    }

    console.log(`[한투] 워치리스트 ${watchlist.length}종목 로드`);

    // 서버 시작 시 배치 수집으로 시작 (1/10씩, 과부하 방지)
    setTimeout(async () => {
        await fetchBatchStocks();
        scheduleNext();
    }, 3000);

    // 매일 06:00 일봉 수집
    scheduleDailyFetch();

    // 매일 장마감 후 15:40 네이버 투자자 크롤링 (1일 1회, 누적)
    scheduleMarketInvestorFetch();
}

// 장마감 후 네이버 투자자 크롤링 스케줄러 — 1일 1회, 누적 저장
let marketInvestorTimer = null;
function scheduleMarketInvestorFetch() {
    const kst = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
    const target = new Date(kst);
    target.setHours(15, 40, 0, 0);  // 장마감 후 15:40 KST
    if (kst >= target) target.setDate(target.getDate() + 1);
    const delay = target - kst;

    console.log(`[한투] 투자자 크롤링 예약: ${target.toLocaleDateString('ko-KR')} 15:40 (${Math.round(delay / 3600000)}시간 후)`);

    marketInvestorTimer = setTimeout(async () => {
        console.log('[한투] 장마감 투자자 크롤링 시작...');
        const mktInv = await fetchMarketInvestor();
        if (mktInv) {
            marketInvestor = mktInv;
            // 누적 저장 — 기존 히스토리에 추가
            const existing = loadJSON('macro/market_investor.json', { latest: null, history: [] });
            // 단일 구조 → 누적 구조 마이그레이션
            if (!existing.history) {
                existing.history = existing.latest ? [existing.latest] : [];
            }
            existing.latest = mktInv;
            existing.history.push(mktInv);
            // 최대 365일 보관
            if (existing.history.length > 365) existing.history = existing.history.slice(-365);
            saveJSON('macro/market_investor.json', existing);
            console.log(`[한투] 투자자 저장 완료: KOSPI 외인 ${mktInv.foreign > 0 ? '+' : ''}${mktInv.foreign}억 / 기관 ${mktInv.institution > 0 ? '+' : ''}${mktInv.institution}억${mktInv.kosdaq ? ` | KOSDAQ 외인 ${mktInv.kosdaq.foreign > 0 ? '+' : ''}${mktInv.kosdaq.foreign}억 / 기관 ${mktInv.kosdaq.institution > 0 ? '+' : ''}${mktInv.kosdaq.institution}억` : ''} (누적 ${existing.history.length}일)`);
        } else {
            console.warn('[한투] 투자자 크롤링 실패 — 다음날 재시도');
        }
        scheduleMarketInvestorFetch();  // 다음날 예약
    }, delay);
}

function scheduleDailyFetch() {
    const now = new Date();
    const kst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
    const target = new Date(kst);
    target.setHours(6, 0, 0, 0);
    if (kst >= target) target.setDate(target.getDate() + 1);

    const delay = target - kst;
    console.log(`[한투] 일봉 수집 예약: ${target.toLocaleDateString('ko-KR')} 06:00 (${Math.round(delay / 3600000)}시간 후)`);

    dailyTimer = setTimeout(async () => {
        await fetchAllDailyPrices();
        scheduleDailyFetch();  // 다음날 예약
    }, delay);
}

function stop() {
    if (fetchTimer) { clearTimeout(fetchTimer); fetchTimer = null; }
    if (dailyTimer) { clearTimeout(dailyTimer); dailyTimer = null; }
    // 네이버 투자자 크롤링 타이머도 정리
    if (marketInvestorTimer) { clearTimeout(marketInvestorTimer); marketInvestorTimer = null; }
    console.log('[한투] 종료 — 데이터 저장 완료');
}

// 워치리스트에 종목 추가 (코드 없으면 자동 조회)
async function addStock(name, code) {
    const exists = watchlist.find(s => s.name === name || (code && s.code === code));
    if (exists) return { ok: false, msg: '이미 존재하는 종목입니다' };
    // 코드가 없으면 네이버 금융에서 자동 조회
    if (!code) {
        code = await lookupStockCode(name);
        if (!code) return { ok: false, msg: `종목코드를 찾을 수 없습니다: ${name}` };
    }
    watchlist.push({ name, code });
    saveJSON('watchlist.json', watchlist);
    console.log(`[한투] 워치리스트 추가: ${name} (${code})`);
    return { ok: true, msg: `${name}(${code}) 추가 완료` };
}

// 워치리스트에서 종목 제거
function removeStock(nameOrCode) {
    const idx = watchlist.findIndex(s => s.name === nameOrCode || s.code === nameOrCode);
    if (idx < 0) return { ok: false, msg: '종목을 찾을 수 없습니다' };
    const removed = watchlist.splice(idx, 1)[0];
    saveJSON('watchlist.json', watchlist);
    return { ok: true, msg: `${removed.name} 제거 완료` };
}

// ============================================================
// Exports
// ============================================================
module.exports = {
    start,
    stop,
    fetchAllStocks,
    fetchAllDailyPrices,
    fetchAllAfterHours,
    fetchCurrentPrice,
    fetchIndexPrice,
    fetchInvestorData,
    fetchInvestorWeekly,
    fetchMarketInvestor,
    fetchDailyPrice,
    fetchAfterHoursPrice,
    lookupStockCode,
    addStock,
    removeStock,
    isAfterHours,
    getStockPrices: () => stockPrices,
    getIndexPrices: () => indexPrices,
    getMarketInvestor: () => marketInvestor,
    getWatchlist: () => watchlist,
    getStockAnalysis,      // 종목별 MA + 1주일 가격 (챗봇/분석봇용)
    calculateMA,           // 이동평균 계산 유틸
    onPriceAlert,
    acquireUserPriority,
    releaseUserPriority,
    // 발급된 한투 토큰 정보 (토큰값 + 만료시간)
    getTokenInfo: () => ({ token: accessToken, expiry: tokenExpiry, valid: !!(accessToken && Date.now() < tokenExpiry) })
};
