/**
 * 증권사 리포트 수집기 — 독립 모듈
 * 
 * 역할: 4개 소스에서 리포트 크롤링 → data/reports_YYYYMMDD.json 저장
 * 수집 소스: WiseReport + 미래에셋 + 하나증권 + 네이버 금융
 * 특징:
 *   - 소스별 독립 수집 (cheerio 파싱)
 *   - 메모리 최소: todayItems 배열만 보관 (자정 자동 초기화)
 *   - 날짜별 1개 파일로 병합
 *   - 7일 보존규칙 자동 적용
 *   - 네이버 교차중복 제거
 *   - 네이버 상세 페이지 본문/목표가 보강
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// ── 설정 ──
const DATA_DIR = path.join(__dirname, 'data');
const PENDING_DIR = path.join(__dirname, 'pending');
const COLLECT_INTERVAL = 600000; // 10분 기본 (getSmartInterval로 동적 조절)
const RETENTION_DAYS = 7;        // 파일 보존 기간

// 1차 폐기 필터 — 헤더/푸터/테이블 제목 등 잘못 파싱된 행 제거
const GARBAGE_KEYWORDS = [
    '전일수정주가', '목표주가', '투자의견', '기관명', '기업명',
    '작성자', '종목명', '리포트제목', 'FnGuide', 'Copyright', '괴리율',
];

// 수집 소스 정의 — 4개 증권사/포털
const REPORT_SOURCES = [
    {
        key: 'WiseReport', file: 'reports_wisereport.json',
        urls: [{ url: 'https://comp.wisereport.co.kr/wiseReport/summary/ReportSummary.aspx', source: 'WiseReport', encoding: 'utf-8' }]
    },
    {
        key: '미래에셋', file: 'reports_mirae.json',
        urls: [{ url: 'https://securities.miraeasset.com/bbs/board/message/list.do?categoryId=1800', source: '미래에셋', encoding: 'euc-kr' }]
    },
    {
        key: '하나증권', file: 'reports_hana.json',
        urls: [{ url: 'https://www.hanaw.com/main/research/research/list.cmd?pid=3&cid=2', source: '하나증권', encoding: 'utf-8' }]
    },
    {
        key: '네이버', file: 'reports_naver.json',
        urls: [
            { url: 'https://finance.naver.com/research/company_list.naver', source: '네이버', encoding: 'euc-kr' },
            { url: 'https://finance.naver.com/research/company_list.naver?&page=2', source: '네이버', encoding: 'euc-kr' },
            { url: 'https://finance.naver.com/research/company_list.naver?&page=3', source: '네이버', encoding: 'euc-kr' }
        ]
    }
];

// ── 상태 ──
let todayItems = [];           // 오늘 리포트 배열 (메모리)
let todayDate = '';            // 현재 메모리에 있는 날짜
let lastCollectedAt = null;    // 마지막 수집 시각
let totalCollected = 0;        // 누적 수집 건수
let _timer = null;             // 수집 타이머
let _onCollected = null;       // 수집 완료 콜백 (chain에서 등록)
let _reportsKeys = new Set();  // reports 파일 중복방지용 키

// 소스별 저장소 — 소스별 분리 관리 (교차중복 제거용)
let reportStores = { 'WiseReport': [], '미래에셋': [], '하나증권': [], '네이버': [] };

// ── 유틸리티 ──

// KST 오늘 날짜 (YYYYMMDD)
function getToday() {
    const d = new Date(Date.now() + 9 * 3600000);
    return d.toISOString().slice(0, 10).replace(/-/g, '');
}

// KST 시간 정보
function getKST() {
    const d = new Date(Date.now() + 9 * 3600000);
    return {
        hour: d.getUTCHours(),
        min: d.getUTCMinutes(),
        day: d.getUTCDay(),  // 0=일, 6=토
        dateStr: d.toISOString().slice(0, 10),
    };
}

// 데이터 디렉토리 확인
function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
}

// 날짜 정규화 — '2026.02.21' or '2026-02-21' → '20260221'
function normDate(dateStr) {
    return (dateStr || '').replace(/[.\-\/]/g, '');
}

// 의견 판단은 AI 분류기(classifier)가 담당 — 크롤러는 수집만

// ════════════════════════════════════════════════
// 시간대별 동적 수집 간격 (피크/장중/장외)
// ════════════════════════════════════════════════

function getSmartInterval(sourceKey) {
    const kst = getKST();
    const isWeekend = (kst.day === 0 || kst.day === 6);

    // 주말: 전 소스 60분 간격
    if (isWeekend) return 60 * 60 * 1000;

    // 피크: 07~09시 (리포트 대량 발행)
    if (kst.hour >= 7 && kst.hour < 9) {
        switch (sourceKey) {
            case 'WiseReport': return 5 * 60 * 1000;   // 5분
            case '미래에셋': return 5 * 60 * 1000;
            case '하나증권': return 5 * 60 * 1000;
            case '네이버': return 10 * 60 * 1000;      // 10분
            default: return 5 * 60 * 1000;
        }
    }

    // 장중: 09~16시
    if (kst.hour >= 9 && kst.hour < 16) {
        switch (sourceKey) {
            case 'WiseReport': return 10 * 60 * 1000;  // 10분
            case '미래에셋': return 10 * 60 * 1000;
            case '하나증권': return 10 * 60 * 1000;
            case '네이버': return 15 * 60 * 1000;      // 15분
            default: return 10 * 60 * 1000;
        }
    }

    // 장외: 16~07시
    return 60 * 60 * 1000;  // 60분
}

// ════════════════════════════════════════════════
// 단일 URL 페이지 크롤링 — HTML 파싱으로 리포트 추출
// ════════════════════════════════════════════════

async function fetchReportPage(urlObj) {
    const { url, source, encoding } = urlObj;
    const items = [];

    try {
        const isEucKr = (encoding === 'euc-kr');
        const resp = await axios.get(url, {
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'ko-KR,ko;q=0.9',
            },
            responseType: isEucKr ? 'arraybuffer' : 'text',
        });

        let html;
        if (isEucKr) {
            try {
                const decoder = new TextDecoder('euc-kr');
                html = decoder.decode(resp.data);
            } catch (e) {
                html = resp.data.toString('utf-8');
            }
        } else {
            html = resp.data;
        }

        const $ = cheerio.load(html);

        // ========================================
        // WiseReport 파싱 (테이블 구조)
        // ========================================
        if (source === 'WiseReport') {
            // 헤더/푸터 키워드 블랙리스트 — 데이터가 아닌 행 필터링
            const SKIP_KEYWORDS = [
                '전일수정주가', '목표주가', '투자의견', '기관명', '기업명',
                '작성자', '종목명', '제목', '리포트제목', 'FnGuide',
                'Copyright', '전일대비', '괴리율',
            ];

            $('table tr').each(function () {
                const cells = $(this).find('td');
                if (cells.length < 5) return;

                const corp = cells.eq(0).text().trim();
                const title = cells.eq(1).text().trim();

                // 헤더/푸터 키워드 포함 시 스킵
                const combined = corp + ' ' + title;
                if (SKIP_KEYWORDS.some(kw => combined.includes(kw))) return;

                const broker = cells.eq(2).text().trim();
                const dateText = cells.eq(4).text().trim();

                // 목표가 추출 (의견은 AI가 판단 — 크롤러는 수집만)
                let targetPrice = 0;
                const opinionText = cells.eq(3).text().trim();
                const tpMatch = opinionText.match(/([0-9,]+)\s*원?/);
                if (tpMatch) targetPrice = parseInt(tpMatch[1].replace(/,/g, '')) || 0;

                // PDF 링크
                let pdfLink = '';
                const link = cells.eq(1).find('a').attr('href') || '';
                if (link) pdfLink = link.startsWith('http') ? link : 'https://comp.wisereport.co.kr' + link;

                if (corp && title) {
                    items.push({
                        corp, title, broker: broker || 'WiseReport',
                        opinion: '', targetPrice, currentPrice: 0,
                        date: dateText, pdfLink,
                        source: 'WiseReport',
                        _crawledAt: new Date(Date.now() + 9 * 3600000).toISOString().replace('T', ' ').slice(0, 19),
                    });
                }
            });
        }


        // ========================================
        // 미래에셋 파싱
        // ========================================
        else if (source === '미래에셋') {
            $('ul.board_list li, table.board_list tr, div.list_area li').each(function () {
                const titleEl = $(this).find('a.title, a.subject, a').first();
                const titleFull = titleEl.text().trim();
                if (!titleFull || titleFull.length < 5) return;

                // messageId 추출 (상세 링크용)
                const href = titleEl.attr('href') || '';
                const msgMatch = href.match(/messageId=(\d+)/);
                const messageId = msgMatch ? msgMatch[1] : '';

                // 제목 파싱: "종목명: 리포트제목" or "종목명(코드) - 제목"
                let corp = '', title = titleFull;
                const m = titleFull.match(/^(.+?)\s*[:\-–]\s*(.+)$/);
                if (m) { corp = m[1].trim(); title = m[2].trim(); }

                // 작성자/날짜 추출
                const dateText = $(this).find('.date, .txt_date, span.date').text().trim() || '';
                const author = $(this).find('.name, .writer').text().trim() || '';

                // PDF 링크
                const pdfHref = $(this).find('a[href*=".pdf"], a.pdf').attr('href') || href;

                // 해외 종목(US) 스킵
                if (/[A-Z]+ US/i.test(titleFull)) return;

                if (corp || title) {
                    items.push({
                        corp: corp || title.substring(0, 10),
                        title,
                        broker: '미래에셋증권(직접)',
                        analyst: author,
                        opinion: '',
                        targetPrice: 0,
                        currentPrice: 0,
                        date: dateText.replace(/-/g, '.'),
                        pdfLink: pdfHref,
                        detailLink: pdfHref,
                        messageId,
                        source: '미래에셋',
                        _crawledAt: new Date(Date.now() + 9 * 3600000).toISOString().replace('T', ' ').slice(0, 19),
                    });
                }
            });
        }

        // ========================================
        // 하나증권 파싱 (li 리스트 구조)
        // ========================================
        else if (source === '하나증권') {
            const entries = [];
            $('h3 a.title, h3 a.more_btn').each(function () {
                const titleFull = $(this).text().trim();
                if (!titleFull || titleFull.length < 5) return;

                const parentLi = $(this).closest('li').length ? $(this).closest('li') : $(this).closest('h3').parent();
                const infoLi = parentLi.next('li.m-info, li.info').length ? parentLi.next('li.m-info, li.info') : parentLi.siblings('li.m-info').first();
                const contLi = parentLi.nextAll('li.j_bbsContn, li.contn').first();

                const author = infoLi.find('span.m-name, .m-name').text().trim();
                const dateText = infoLi.find('span.txtbasic').first().text().trim();
                const infoText = infoLi.text();
                const isCompanyReport = /기업분석/.test(infoText);
                const summary = contLi.text().trim().substring(0, 1000);

                // 제목 파싱: "종목명(코드.KS/의견): 리포트 제목"
                let corp = '', stockCode = '', rawOpinion = '', title = titleFull;
                const m1 = titleFull.match(/^(.+?)\s*[\(（](\d{6})[.\s]*(?:KS|KQ|KOSPI|KOSDAQ)?[/\s]*(매수|매도|중립|Buy|Hold|Sell|BUY|HOLD|SELL|Outperform|비중확대|비중축소|Trading Buy|Not Rated)?[\)）]\s*[:\s]?\s*(.*)$/i);
                if (m1) {
                    corp = m1[1].trim();
                    stockCode = m1[2];
                    rawOpinion = m1[3] || '';
                    title = m1[4].trim() || titleFull;
                } else {
                    const m2 = titleFull.match(/^(.+?)\s*[\(（](\d{6})[^)）]*[\)）]\s*[:\s]?\s*(.*)$/);
                    if (m2) {
                        corp = m2[1].trim();
                        stockCode = m2[2];
                        title = m2[3].trim() || titleFull;
                    } else {
                        const m3 = titleFull.match(/^(.+?)\s*[\(（](Overweight|Underweight|Neutral|비중확대|비중축소|중립)[\)）]\s*[:\s]?\s*(.*)$/i);
                        if (m3) {
                            corp = m3[1].trim();
                            rawOpinion = m3[2];
                            title = m3[3].trim() || titleFull;
                        }
                    }
                }

                // 목표가 추출 — 제목/요약에서
                let targetPrice = 0;
                const tpFromTitle = titleFull.match(/(?:TP|목표주?가?)\s*[:\s]?\s*([\d,]+)\s*원?/i);
                if (tpFromTitle) targetPrice = parseInt(tpFromTitle[1].replace(/,/g, '')) || 0;
                if (!targetPrice && summary) {
                    const tpFromSummary = summary.match(/목표주가\s*([\d,]+)\s*원/);
                    if (tpFromSummary) targetPrice = parseInt(tpFromSummary[1].replace(/,/g, '')) || 0;
                }

                if (corp || title || titleFull) {
                    entries.push({
                        corp: stockCode ? `${corp}(${stockCode})` : corp,
                        title: title || titleFull,
                        broker: '하나증권(직접)',
                        analyst: author,
                        opinion: '',  // AI 분류기가 판단
                        targetPrice,
                        currentPrice: 0,
                        summary: summary.substring(0, 1000),
                        date: dateText || new Date().toISOString().slice(0, 10).replace(/-/g, '.'),
                        pdfLink: '',
                        source: '하나증권',
                        category: isCompanyReport ? '기업분석' : '산업분석',
                        _crawledAt: new Date(Date.now() + 9 * 3600000).toISOString().replace('T', ' ').slice(0, 19),
                    });
                }
            });
            items.push(...entries);
        }

        // ========================================
        // 네이버 금융 파싱
        // ========================================
        else {
            let colMap = { corp: 0, title: 1, broker: 2, date: 4 };
            const headerRow = $('table.type_1 tr').first();
            const thCells = headerRow.find('th');
            if (thCells.length >= 4) {
                thCells.each(function (i) {
                    const h = $(this).text().trim();
                    if (h.indexOf('종목') >= 0) colMap.corp = i;
                    else if (h.indexOf('제목') >= 0 || h.indexOf('리포트') >= 0) colMap.title = i;
                    else if (h.indexOf('증권사') >= 0 || h.indexOf('작성기관') >= 0) colMap.broker = i;
                    else if (h.indexOf('작성일') >= 0 || h.indexOf('날짜') >= 0 || h.indexOf('일자') >= 0) colMap.date = i;
                });
            }

            $('table.type_1 tr').each(function () {
                const cells = $(this).find('td');
                if (cells.length < 4) return;

                const corpEl = cells.eq(colMap.corp).find('a');
                const titleEl = cells.eq(colMap.title).find('a');
                if (!corpEl.length || !titleEl.length) return;

                const corp = corpEl.text().trim();
                const title = titleEl.text().trim();
                let titleHref = titleEl.attr('href') || '';
                let pdfHref = '';

                // nid 추출
                let nid = '';
                const nidMatch = titleHref.match(/nid=(\d+)/);
                if (nidMatch) nid = nidMatch[1];

                if (titleHref && !titleHref.startsWith('http')) {
                    titleHref = 'https://finance.naver.com/research/' + titleHref;
                }

                const attachLink = cells.eq(3).find('a').attr('href') || '';
                if (attachLink) pdfHref = attachLink.startsWith('http') ? attachLink : 'https://finance.naver.com/research/' + attachLink;
                if (!pdfHref) pdfHref = titleHref;

                const brokerRaw = cells.eq(colMap.broker).text().trim();
                let dateText = cells.eq(colMap.date).text().trim();
                // 네이버가 2자리 연도로 줌 (26.03.04 → 2026.03.04)
                if (/^\d{2}\.\d{2}\.\d{2}$/.test(dateText)) {
                    dateText = '20' + dateText;
                }

                let targetPrice = 0;
                const tpMatch = title.match(/(?:목표가|목표주가|TP|target)\s*[:\s]?\s*([\d,]+)\s*원?/i);
                if (tpMatch) targetPrice = parseInt(tpMatch[1].replace(/,/g, '')) || 0;

                if (corp && title) {
                    items.push({
                        corp, title,
                        broker: brokerRaw ? `${brokerRaw}(네이버)` : '(네이버)',
                        opinion: '', targetPrice, date: dateText, pdfLink: pdfHref,
                        detailLink: titleHref,
                        nid,
                        source: '네이버',
                        _crawledAt: new Date(Date.now() + 9 * 3600000).toISOString().replace('T', ' ').slice(0, 19),
                    });
                }
            });
        }

        return items;
    } catch (e) {
        console.error(`[리포트][${source}] ${url} 실패: ${e.message}`);
        return [];
    }
}

// ════════════════════════════════════════════════
// 네이버 상세 페이지 크롤링 — 본문/목표가/투자의견 보강
// ════════════════════════════════════════════════

async function fetchNaverReportDetail(nid) {
    if (!nid) return null;

    const url = `https://finance.naver.com/research/company_read.naver?nid=${nid}`;

    try {
        const resp = await axios.get(url, {
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'text/html',
                'Referer': 'https://finance.naver.com/research/company_list.naver'
            },
            responseType: 'arraybuffer'
        });

        let html;
        try {
            const decoder = new TextDecoder('euc-kr');
            html = decoder.decode(resp.data);
        } catch (e) {
            html = resp.data.toString('utf-8');
        }

        const $ = cheerio.load(html);
        const result = { targetPrice: 0, opinion: '', summary: '' };
        const allText = $('body').text();

        // 목표가 추출
        const tpMatch = allText.match(/목표(?:주?가?)\s*[:\s]?\s*([\d,]+)\s*원?/);
        if (tpMatch) result.targetPrice = parseInt(tpMatch[1].replace(/,/g, '')) || 0;

        // 투자의견은 AI 분류기가 판단 — 크롤러는 수집하지 않음

        // 본문 텍스트 추출
        let bodyText = '';
        const viewCnt = $('td.view_cnt, div.view_cnt');
        if (viewCnt.length) bodyText = viewCnt.text().trim();

        if (!bodyText || bodyText.length < 50) {
            $('td').each(function () {
                const t = $(this).text().trim();
                if (t.length > 100 && t.length > bodyText.length) {
                    if (!/^\s*(홈|투자정보|종목명|뉴스|공시|커뮤니티)/.test(t)) bodyText = t;
                }
            });
        }

        if (bodyText) {
            bodyText = bodyText.replace(/\s+/g, ' ').replace(/\n{2,}/g, '\n').trim().substring(0, 1000);
            result.summary = bodyText;
        }

        console.log(`[네이버상세] nid=${nid} → 목표가:${result.targetPrice} 의견:${result.opinion} 본문:${result.summary.length}자`);
        return result;

    } catch (e) {
        console.error(`[네이버상세] nid=${nid} 실패: ${e.message}`);
        return null;
    }
}

// ════════════════════════════════════════════════
// 네이버 교차중복 제거 — 직접 수집 소스에 이미 있는 리포트 제외
// ════════════════════════════════════════════════

function filterNaverDuplicates(allItems) {
    const directKeys = new Set();
    const directSources = ['WiseReport', '미래에셋', '하나증권'];

    for (const srcName of directSources) {
        const items = reportStores[srcName] || [];
        for (const r of items) {
            const pureCorp = (r.corp || '').replace(/[\(（]\d{6}[.\w]*[\)）]/g, '').trim();
            const pureDate = normDate(r.date);
            const pureBroker = (r.broker || '').replace(/[\(（][^)）]*[\)）]/g, '').replace(/증권$/, '').trim();
            if (pureCorp && pureDate) directKeys.add(`${pureCorp}|${pureDate}|${pureBroker}`);
        }
    }

    return allItems.filter(item => {
        if (item.source !== '네이버') return true;
        const pureCorp = (item.corp || '').replace(/[\(（]\d{6}[.\w]*[\)）]/g, '').trim();
        const pureDate = normDate(item.date);
        const pureBroker = (item.broker || '').replace(/[\(（][^)）]*[\)）]/g, '').replace(/증권$/, '').trim();
        return !directKeys.has(`${pureCorp}|${pureDate}|${pureBroker}`);
    });
}

// ════════════════════════════════════════════════
// 소스 1개 수집 — URL 크롤링 → 중복제거 → 저장
// ════════════════════════════════════════════════

async function fetchSourceReports(src) {
    const allItems = [];

    // axios+cheerio 수집
    for (const urlObj of src.urls) {
        try {
            const items = await fetchReportPage(urlObj);
            allItems.push(...items);
        } catch (e) {
            console.error(`[${src.key}] ${urlObj.url} 실패: ${e.message}`);
        }
    }

    // 중복 제거 (자기 소스 내)
    const seen = new Set();
    const unique = [];
    for (const item of allItems) {
        const key = `${item.corp}|${item.title}|${item.date}`;
        if (!seen.has(key)) { seen.add(key); unique.push(item); }
    }

    // 네이버: 다른 소스와 교차 중복 제거
    let crossFiltered = unique;
    if (src.key === '네이버') {
        const otherKeys = new Set();
        const directSources = ['WiseReport', '미래에셋', '하나증권'];
        for (const srcName of directSources) {
            const items = reportStores[srcName] || [];
            for (const r of items) {
                const pureCorp = (r.corp || '').replace(/[\(（]\d{6}[.\w]*[\)）]/g, '').trim();
                const pureDate = normDate(r.date);
                const pureBroker = (r.broker || '').replace(/[\(（][^)）]*[\)）]/g, '').replace(/증권$/, '').trim();
                if (pureCorp && pureDate) {
                    otherKeys.add(`${pureCorp}|${pureDate}`);
                    otherKeys.add(`${pureCorp}|${pureDate}|${pureBroker}`);
                }
            }
        }
        const before = crossFiltered.length;
        crossFiltered = crossFiltered.filter(item => {
            const pureCorp = (item.corp || '').replace(/[\(（]\d{6}[.\w]*[\)）]/g, '').trim();
            const pureDate = normDate(item.date);
            const pureBroker = (item.broker || '').replace(/[\(（][^)）]*[\)）]/g, '').replace(/증권$/, '').trim();
            if (otherKeys.has(`${pureCorp}|${pureDate}|${pureBroker}`)) return false;
            return true;
        });
        const removed = before - crossFiltered.length;
        if (removed > 0) console.log(`[네이버] 교차중복 ${removed}건 제거`);
    }

    // 기존 대비 새 항목 감지
    const existingKeys = new Set((reportStores[src.key] || []).map(r => `${r.corp}|${r.title}|${r.date}`));
    let added = 0;
    for (const item of crossFiltered) {
        const key = `${item.corp}|${item.title}|${item.date}`;
        if (!existingKeys.has(key)) {
            reportStores[src.key].unshift(item);
            added++;
        }
    }

    // 최대 200건 유지
    if (reportStores[src.key].length > 200) reportStores[src.key] = reportStores[src.key].slice(0, 200);

    if (added > 0) {
        console.log(`[${src.key}] +${added}건 신규 (총 ${reportStores[src.key].length}건)`);

        // 네이버: 신규 리포트 상세 페이지 크롤링 (본문/목표가/투자의견 보강)
        if (src.key === '네이버') {
            const newNaverItems = reportStores[src.key].slice(0, Math.min(added, 15));
            let detailCount = 0;
            for (const item of newNaverItems) {
                if (!item.nid) continue;
                try {
                    const detail = await fetchNaverReportDetail(item.nid);
                    if (detail) {
                        if (detail.targetPrice && !item.targetPrice) item.targetPrice = detail.targetPrice;
                        // opinion은 AI 분류기가 판단 — 크롤러는 저장하지 않음
                        if (detail.summary) item.summary = detail.summary;
                        detailCount++;
                    }
                    await sleep(1500); // 서버 부하 방지
                } catch (e) {
                    console.error(`[네이버상세] ${item.corp} 실패: ${e.message}`);
                }
            }
            if (detailCount > 0) console.log(`[네이버상세] ${detailCount}건 본문 보강 완료`);
        }
    } else {
        console.log(`[${src.key}] 변동 없음 (${(reportStores[src.key] || []).length}건)`);
    }

    return { source: src.key, fetched: crossFiltered.length, added };
}

// ════════════════════════════════════════════════
// 전체 수집 (1회) — 4개 소스 순차 호출 → 날짜별 파일 저장
// ════════════════════════════════════════════════

async function collectOnce() {
    const kst = getKST();

    // 24시간 수집 모드 (영업시간 제한 없음)

    const today = getToday();
    ensureDataDir();

    // 날짜 바뀌면 메모리 초기화
    if (todayDate !== today) {
        todayItems = [];
        todayDate = today;
        // reportStores도 리셋 (오늘 것만 유지)
        reportStores = { 'WiseReport': [], '미래에셋': [], '하나증권': [], '네이버': [] };
        console.log(`[수집] 날짜 변경 → 메모리 초기화 (${today})`);
    }

    // 기존 파일 로드 (서버 재시작 대응) — pending + reports 모두 로드
    if (!fs.existsSync(PENDING_DIR)) fs.mkdirSync(PENDING_DIR, { recursive: true });
    const pendingPath = path.join(PENDING_DIR, `pending_${today}.json`);
    const reportsPath = path.join(DATA_DIR, `reports_${today}.json`);

    if (todayItems.length === 0) {
        // 1) pending 파일 로드 (미분류 항목 — 계속 수집 대상)
        if (fs.existsSync(pendingPath)) {
            try {
                const data = JSON.parse(fs.readFileSync(pendingPath, 'utf-8'));
                const items = data.items || [];
                todayItems.push(...items);
                for (const item of items) {
                    const src = item.source || '기타';
                    if (reportStores[src]) reportStores[src].push(item);
                }
                console.log(`[수집] pending 로드: ${items.length}건`);
            } catch (e) {
                console.error(`[수집] pending 로드 실패: ${e.message}`);
            }
        }

        // 2) reports 파일 로드 (분류 완료 — 중복방지용, 저장 대상 아님)
        _reportsKeys = new Set();
        if (fs.existsSync(reportsPath)) {
            try {
                const data = JSON.parse(fs.readFileSync(reportsPath, 'utf-8'));
                const items = data.items || [];
                for (const item of items) {
                    const key = `${item.corp}|${item.title}|${item.date}`;
                    _reportsKeys.add(key);
                    // reportStores에도 추가 (교차중복 제거용)
                    const src = item.source || '기타';
                    if (reportStores[src]) reportStores[src].push(item);
                }
                console.log(`[수집] reports 로드 (중복방지): ${items.length}건`);
            } catch (e) {
                console.error(`[수집] reports 로드 실패: ${e.message}`);
            }
        }
    }

    // 4개 소스 순차 수집
    let totalAdded = 0;
    const sourceCounts = {};

    for (const src of REPORT_SOURCES) {
        try {
            const result = await fetchSourceReports(src);
            sourceCounts[src.key] = result.added;
            totalAdded += result.added;
        } catch (e) {
            console.error(`[${src.key}] 오류: ${e.message}`);
            sourceCounts[src.key] = 0;
        }
        // 소스 간 500ms 대기
        await sleep(500);
    }

    // todayItems 재구성 (모든 소스 병합)
    if (totalAdded > 0) {
        const allMerged = [];
        Object.values(reportStores).forEach(items => allMerged.push(...items));
        // 중복 제거 후 교차중복 필터
        const seen = new Set();
        const deduped = [];
        for (const item of allMerged) {
            const key = `${item.corp}|${item.title}|${item.date}`;
            if (!seen.has(key)) { seen.add(key); deduped.push(item); }
        }
        todayItems = filterNaverDuplicates(deduped);
        todayItems.sort((a, b) => (b._crawledAt || '').localeCompare(a._crawledAt || ''));

        totalCollected += totalAdded;
        lastCollectedAt = new Date().toISOString();

        // pending 파일 저장 (reports에 있는 항목 제외 + 쓰레기 필터)
        const pendingItems = todayItems.filter(item => {
            const key = `${item.corp}|${item.title}|${item.date}`;
            if (_reportsKeys.has(key)) return false;
            // 1차 폐기 필터 — 잘못 파싱된 데이터 제거
            const check = (item.corp || '') + ' ' + (item.title || '') + ' ' + (item.opinion || '');
            if (GARBAGE_KEYWORDS.some(kw => check.includes(kw))) return false;
            return true;
        });

        const saveData = {
            date: today,
            total: pendingItems.length,
            sources: REPORT_SOURCES.map(s => s.key).join('+'),
            _collectedAt: lastCollectedAt,
            items: pendingItems,
        };
        fs.writeFileSync(pendingPath, JSON.stringify(saveData, null, 2), 'utf-8');

        const counts = Object.entries(sourceCounts).filter(([, v]) => v > 0).map(([k, v]) => `${k}:${v}`).join(' ');
        console.log(`[수집] ${kst.dateStr} +${totalAdded}건 (${counts}) → pending ${pendingItems.length}건`);

        // 수집 완료 콜백 (chain에서 분류 트리거)
        if (_onCollected) {
            try {
                await _onCollected();
            } catch (e) {
                console.error(`[수집] 콜백 오류: ${e.message}`);
            }
        }
    }

    return { collected: totalAdded, total: todayItems.length, sourceCounts };
}

// ════════════════════════════════════════════════
// 보존규칙 — 7일 경과 파일 삭제
// ════════════════════════════════════════════════

function cleanOldFiles() {
    ensureDataDir();
    const cutoff = new Date(Date.now() + 9 * 3600000);
    cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
    const cutoffStr = cutoff.toISOString().slice(0, 10).replace(/-/g, '');

    let removed = 0;

    // data/ 폴더 — reports 파일 정리
    const dataFiles = fs.readdirSync(DATA_DIR).filter(f =>
        f.startsWith('reports_') && f.endsWith('.json')
    );
    for (const f of dataFiles) {
        const dateStr = f.replace('reports_', '').replace('.json', '');
        if (dateStr < cutoffStr) {
            fs.unlinkSync(path.join(DATA_DIR, f));
            removed++;
        }
    }

    // pending/ 폴더 — pending 파일 정리
    if (fs.existsSync(PENDING_DIR)) {
        const pendingFiles = fs.readdirSync(PENDING_DIR).filter(f =>
            f.startsWith('pending_') && f.endsWith('.json')
        );
        for (const f of pendingFiles) {
            const dateStr = f.replace('pending_', '').replace('.json', '');
            if (dateStr < cutoffStr) {
                fs.unlinkSync(path.join(PENDING_DIR, f));
                removed++;
            }
        }
    }

    if (removed > 0) {
        console.log(`[보존] ${removed}개 파일 삭제 (${RETENTION_DAYS}일 경과)`);
    }
}

// ════════════════════════════════════════════════
// 자동 수집 시작/중지
// ════════════════════════════════════════════════

function start() {
    console.log(`[수집] 자동 수집 시작 — ${COLLECT_INTERVAL / 1000}초 기본 간격 (${REPORT_SOURCES.map(s => s.key).join('+')})`)

    // 첫 수집 (5초 후)
    setTimeout(async () => {
        await collectOnce();
        cleanOldFiles();
    }, 5000);

    // 주기적 수집
    _timer = setInterval(async () => {
        await collectOnce();
    }, COLLECT_INTERVAL);

    // 매일 자정(KST) 보존규칙 실행
    setInterval(() => {
        const kst = getKST();
        if (kst.hour === 0 && kst.min <= 1) {
            cleanOldFiles();
        }
    }, 60000);
}

function stop() {
    if (_timer) {
        clearInterval(_timer);
        _timer = null;
        console.log('[수집] 자동 수집 중지');
    }
}

// ════════════════════════════════════════════════
// 외부 인터페이스
// ════════════════════════════════════════════════

// 오늘 수집된 리포트 배열 반환 (메모리 읽기만 — 부하 0)
function getTodayItems() {
    return todayItems;
}

// 상태 조회
function getStatus() {
    const mem = process.memoryUsage();
    const sourceSizes = {};
    Object.entries(reportStores).forEach(([k, v]) => { sourceSizes[k] = v.length; });
    return {
        todayDate,
        itemCount: todayItems.length,
        sources: REPORT_SOURCES.map(s => s.key).join(', '),
        sourceSizes,
        lastCollectedAt,
        totalCollected,
        memoryMB: Math.round(mem.rss / 1024 / 1024),
        heapMB: Math.round(mem.heapUsed / 1024 / 1024),
    };
}

// ── 내부 유틸 ──
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// 수집 완료 콜백 등록 (chain에서 사용)
function onCollected(fn) { _onCollected = fn; }

module.exports = {
    start,
    stop,
    collectOnce,
    cleanOldFiles,
    getTodayItems,
    getStatus,
    getToday,
    REPORT_SOURCES,
    filterNaverDuplicates,
    onCollected,
};

// ════════════════════════════════════════════════
// 독립 실행 모드 — node collector.js
// ════════════════════════════════════════════════

if (require.main === module) {
    (async () => {
        console.log('[수집] 독립 실행 시작');
        try {
            const result = await collectOnce();
            if (result.reason) {
                console.log(`[수집] 스킵: ${result.reason}`);
            } else {
                console.log(`[수집] 완료: +${result.collected}건, 총 ${result.total}건`);
            }
            cleanOldFiles();
        } catch (e) {
            console.error(`[수집] 오류: ${e.message}`);
            process.exit(1);
        }
        process.exit(0);
    })();
}
