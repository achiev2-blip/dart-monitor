/**
 * DART 모니터 — 증권사 리포트 크롤러 (독립 모듈)
 * 
 * server.js에서 그대로 추출 (로직 변경 없음)
 * fetchReportPage: WiseReport, 미래에셋, 하나증권, 네이버 파싱
 * fetchNaverReportDetail: 네이버 상세 페이지 크롤링
 * fetchMiraeReportDetail: 미래에셋 상세 Puppeteer 크롤링
 * fetchHyundaiWithPuppeteer: 현대차증권 전체 Puppeteer 크롤링
 * fetchSourceReports: 소스별 수집 오케스트레이터
 * getSmartInterval: 시간대별 수집 간격
 * REPORT_SOURCES: 소스 설정
 */
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../config');
const { saveJSON, loadJSON } = require('../utils/file-io');

// === 공유 상태 (server.js에서 init()으로 주입) ===
let reportStores = {};
let reportCache = {};
let _getIsPaused = () => false;
let analyzeReportBatch = async () => { };

/**
 * 모듈 초기화 — server.js에서 공유 상태 주입
 * @param {object} deps 의존성 객체
 */
function init(deps) {
  if (deps.reportStores) reportStores = deps.reportStores;
  if (deps.reportCache) reportCache = deps.reportCache;
  if (deps.getIsPaused) _getIsPaused = deps.getIsPaused;
  if (deps.analyzeReportBatch) analyzeReportBatch = deps.analyzeReportBatch;
  console.log('[reports] 모듈 초기화 완료');
}

// Puppeteer (현대차증권 JS렌더링용)
let puppeteer;
try {
  puppeteer = require('puppeteer-core');
} catch (e) {
  try {
    puppeteer = require('puppeteer');
  } catch (e2) { }
}

// Chrome/Edge 실행 경로 자동 탐지
function findChromePath() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium'
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch (e) { }
  }
  return null;
}
const CHROME_PATH = findChromePath();

// ============================================================
// API: 증권사 리포트 (WiseReport + 미래에셋 직접 + 네이버 금융)
// ============================================================
async function fetchReportPage(urlObj) {
  const url = urlObj.url;
  const source = urlObj.source || '네이버';
  const encoding = urlObj.encoding || 'utf-8';

  try {
    const resp = await axios.get(url, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ko-KR,ko;q=0.9'
      },
      responseType: 'arraybuffer'
    });

    let html;
    try {
      if (encoding === 'euc-kr') {
        const decoder = new TextDecoder('euc-kr');
        html = decoder.decode(resp.data);
      } else {
        html = resp.data.toString('utf-8');
      }
    } catch (e) {
      html = resp.data.toString('utf-8');
    }

    const $ = cheerio.load(html);
    const items = [];

    // ========================================
    // WiseReport (FnGuide) 파싱 — 원본 데이터
    // 컬럼: 기업명(코드), 기관명/작성자, 투자의견, 목표주가, 전일수정주가, 제목, 요약
    // ========================================
    if (source === 'WiseReport') {
      $('table').each(function () {
        $(this).find('tr').each(function () {
          const cells = $(this).find('th, td');
          if (cells.length < 5) return;

          const firstCell = cells.eq(0).html() || '';
          if (firstCell.indexOf('font-weight:bold') < 0) return;

          const corpMatch = firstCell.match(/font-weight:bold[^>]*>([^<]+)/);
          const codeMatch = firstCell.match(/\((\d{6})\)/);
          const corp = corpMatch ? corpMatch[1].trim() : '';
          const stockCode = codeMatch ? codeMatch[1] : '';

          const brokerCell = cells.eq(1).html() || '';
          const brokerMatch = brokerCell.match(/>([^<]*(?:증권|투자|캐피탈|리서치|자산운용)[^<]*)/);
          const analystMatch = brokerCell.match(/\[([^\]]+)\]/);
          const broker = brokerMatch ? brokerMatch[1].trim() : cells.eq(1).text().trim().split('\n')[0].trim();
          const analyst = analystMatch ? analystMatch[1] : '';

          const opinionCell = cells.eq(2).html() || '';
          const opMatch = opinionCell.match(/content02[^>]*>([^<]*)/);
          const opinion = opMatch ? opMatch[1].trim() : cells.eq(2).text().trim();

          const targetCell = cells.eq(3).html() || '';
          const tpMatch = targetCell.match(/content04[^>]*>([^<]+)/);
          const targetRaw = tpMatch ? tpMatch[1].trim() : '';
          const targetPrice = parseInt(targetRaw.replace(/[,\s&nbsp;]/g, '')) || 0;

          const dirMatch = targetCell.match(/typ(\d)/);
          let direction = '';
          if (dirMatch) {
            if (dirMatch[1] === '1') direction = '▲상향';
            else if (dirMatch[1] === '3') direction = '▼하향';
            else if (dirMatch[1] === '2') direction = '유지';
          }

          const currentPrice = parseInt(cells.eq(4).text().trim().replace(/[,\s]/g, '')) || 0;
          const title = cells.eq(5) ? cells.eq(5).text().trim() : '';
          const summary = cells.eq(6) ? cells.eq(6).text().trim().substring(0, 200) : '';

          if (corp) {
            items.push({
              corp: stockCode ? `${corp}(${stockCode})` : corp,
              title: title || `${corp} 리포트`,
              broker: broker ? `${broker}(WR)` : '(WR)',
              analyst,
              opinion: opinion + (direction ? ' ' + direction : ''),
              targetPrice,
              currentPrice,
              summary,
              date: new Date().toISOString().slice(0, 10).replace(/-/g, '.'),
              pdfLink: '',
              source: 'WiseReport'
            });
          }
        });
      });
    }

    // ========================================
    // 미래에셋증권 직접 파싱
    // 컬럼: 작성일, 제목(종목코드/투자의견 포함), 첨부, 작성자
    // ========================================
    else if (source === '미래에셋') {
      $('table tr').each(function () {
        const cells = $(this).find('td');
        if (cells.length < 3) return;

        const dateText = cells.eq(0).text().trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText)) return;

        const titleFull = cells.eq(1).text().trim();
        const author = cells.eq(3) ? cells.eq(3).text().trim() : '';
        let pdfHref = cells.eq(1).find('a').attr('href') || '';

        // messageId 추출: href="/bbs/board/message/view.do?messageId=2338047&..."
        let messageId = '';
        const msgMatch = pdfHref.match(/messageId=(\d+)/);
        if (msgMatch) messageId = msgMatch[1];

        if (pdfHref && !pdfHref.startsWith('http')) {
          pdfHref = 'https://securities.miraeasset.com' + pdfHref;
        }

        let corp = '', stockCode = '', opinion = '', title = titleFull;
        // 패턴: "씨에스윈드 (112610/매수)타이틀..."
        const m1 = titleFull.match(/^(.+?)\s*\((\d{6})\/(매수|매도|중립|Buy|Hold|Sell|Not Rated|Outperform|비중확대|비중축소|Trading Buy)\)(.*)$/i);
        if (m1) {
          corp = m1[1].trim(); stockCode = m1[2]; opinion = m1[3]; title = m1[4].trim() || titleFull;
        } else {
          // 패턴: "종목명 (코드)타이틀"
          const m2 = titleFull.match(/^(.+?)\s*\((\d{6})\)(.*)$/);
          if (m2) { corp = m2[1].trim(); stockCode = m2[2]; title = m2[3].trim() || titleFull; }
        }
        // 해외 종목(US) 스킵
        if (/[A-Z]+ US/i.test(titleFull)) return;

        if (corp || title) {
          items.push({
            corp: corp || title.substring(0, 10),
            title,
            broker: '미래에셋증권(직접)',
            analyst: author,
            opinion,
            targetPrice: 0,
            currentPrice: 0,
            date: dateText.replace(/-/g, '.'),
            pdfLink: pdfHref,
            detailLink: pdfHref,
            messageId,
            source: '미래에셋'
          });
        }
      });
    }

    // ========================================
    // 하나증권 직접 파싱 (li 리스트 구조)
    // h3>a.title: "종목명(코드.KS/의견): 리포트제목"
    // span.m-name: 작성자, span.txtbasic: 날짜
    // li.j_bbsContn: 요약 (목표주가 추출용)
    // ========================================
    else if (source === '하나증권') {
      const entries = [];
      // 각 리포트는 h3 > a.title 로 시작
      $('h3 a.title, h3 a.more_btn').each(function () {
        const titleFull = $(this).text().trim();
        const id = $(this).attr('id') || '';
        if (!titleFull || titleFull.length < 5) return;

        // h3의 부모 li → 다음 형제 li에서 메타정보 추출
        const parentLi = $(this).closest('li').length ? $(this).closest('li') : $(this).closest('h3').parent();
        const infoLi = parentLi.next('li.m-info, li.info').length ? parentLi.next('li.m-info, li.info') : parentLi.siblings('li.m-info').first();
        const contLi = parentLi.nextAll('li.j_bbsContn, li.contn').first();

        // 작성자
        const author = infoLi.find('span.m-name, .m-name').text().trim();
        // 날짜
        const dateText = infoLi.find('span.txtbasic').first().text().trim();
        // 카테고리 (산업/기업 > 기업분석)
        const infoText = infoLi.text();
        const isCompanyReport = /기업분석/.test(infoText);
        // 요약
        const summary = contLi.text().trim().substring(0, 1000);

        // 제목 파싱: "종목명(코드.KS/의견): 리포트 제목" 또는 "섹터(의견): 제목"
        let corp = '', stockCode = '', opinion = '', title = titleFull;

        // 패턴1: 종목명(코드.KS/의견): 제목 또는 종목명(코드.KQ/의견): 제목
        const m1 = titleFull.match(/^(.+?)\s*[\(（](\d{6})[.\s]*(?:KS|KQ|KOSPI|KOSDAQ)?[/\s]*(매수|매도|중립|Buy|Hold|Sell|BUY|HOLD|SELL|Outperform|비중확대|비중축소|Trading Buy|Not Rated)?[\)）]\s*[:\s]?\s*(.*)$/i);
        if (m1) {
          corp = m1[1].trim();
          stockCode = m1[2];
          opinion = m1[3] || '';
          title = m1[4].trim() || titleFull;
        } else {
          // 패턴2: 종목명(코드): 제목 (의견 없음)
          const m2 = titleFull.match(/^(.+?)\s*[\(（](\d{6})[^)）]*[\)）]\s*[:\s]?\s*(.*)$/);
          if (m2) {
            corp = m2[1].trim();
            stockCode = m2[2];
            title = m2[3].trim() || titleFull;
          } else {
            // 패턴3: 섹터명(의견): 제목 (산업분석)
            const m3 = titleFull.match(/^(.+?)\s*[\(（](Overweight|Underweight|Neutral|비중확대|비중축소|중립)[\)）]\s*[:\s]?\s*(.*)$/i);
            if (m3) {
              corp = m3[1].trim();
              opinion = m3[2];
              title = m3[3].trim() || titleFull;
            }
          }
        }

        // 제목에서 TP 패턴: "TP 440,000원" 또는 "목표주가 68,000원"
        let targetPrice = 0;
        const tpFromTitle = titleFull.match(/(?:TP|목표주?가?)\s*[:\s]?\s*([\d,]+)\s*원?/i);
        if (tpFromTitle) targetPrice = parseInt(tpFromTitle[1].replace(/,/g, '')) || 0;

        // 요약에서 목표주가 추출 (제목에 없을 경우)
        if (!targetPrice && summary) {
          const tpFromSummary = summary.match(/목표주가\s*([\d,]+)\s*원/);
          if (tpFromSummary) targetPrice = parseInt(tpFromSummary[1].replace(/,/g, '')) || 0;
        }

        if (corp || title) {
          entries.push({
            corp: stockCode ? `${corp}(${stockCode})` : corp,
            title: title || titleFull,
            broker: '하나증권(직접)',
            analyst: author,
            opinion,
            targetPrice,
            currentPrice: 0,
            summary: summary.substring(0, 1000),
            date: dateText || new Date().toISOString().slice(0, 10).replace(/-/g, '.'),
            pdfLink: '',
            source: '하나증권',
            category: isCompanyReport ? '기업분석' : '산업분석'
          });
        }
      });
      items.push(...entries);
    }

    // ========================================
    // 현대차증권 — Puppeteer로 별도 처리 (여기선 skip)
    // fetchHyundaiWithPuppeteer() 에서 처리
    // ========================================
    else if (source === '현대차증권') {
      // Puppeteer 전용 함수에서 처리하므로 여기선 빈 배열 반환
      // (fetchReportPage가 axios로 호출되므로 JS렌더링 불가)
      return [];
    }

    // ========================================
    // 네이버 금융 파싱
    // 컬럼: 종목명, 제목, 증권사, 첨부, 작성일, 조회수
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

        // nid 추출: href="company_read.naver?nid=90541&page=1"
        let nid = '';
        const nidMatch = titleHref.match(/nid=(\d+)/);
        if (nidMatch) nid = nidMatch[1];

        // 상세 페이지 링크
        if (titleHref && !titleHref.startsWith('http')) {
          titleHref = 'https://finance.naver.com/research/' + titleHref;
        }

        // PDF 첨부 링크
        const attachLink = cells.eq(3).find('a').attr('href') || '';
        if (attachLink) pdfHref = attachLink.startsWith('http') ? attachLink : 'https://finance.naver.com/research/' + attachLink;
        if (!pdfHref) pdfHref = titleHref;

        const brokerRaw = cells.eq(colMap.broker).text().trim();
        const dateText = cells.eq(colMap.date).text().trim();

        let targetPrice = 0, opinion = '';
        const tpMatch = title.match(/(?:목표가|목표주가|TP|target)\s*[:\s]?\s*([\d,]+)\s*원?/i);
        if (tpMatch) targetPrice = parseInt(tpMatch[1].replace(/,/g, '')) || 0;
        const opMatch = title.match(/(매수|매도|중립|Buy|Hold|Sell|Outperform|비중확대|비중축소|시장수익률)/i);
        if (opMatch) opinion = opMatch[1];

        if (corp && title) {
          items.push({
            corp, title,
            broker: brokerRaw ? `${brokerRaw}(네이버)` : '(네이버)',
            opinion, targetPrice, date: dateText, pdfLink: pdfHref,
            detailLink: titleHref,
            nid,
            source: '네이버'
          });
        }
      });
    }

    return items;
  } catch (e) {
    console.error(`[Report][${source}] ${url} 실패: ${e.message}`);
    return [];
  }
}

// ============================================================
// 네이버 금융 — 상세 페이지 크롤링 (독립 함수)
// 리스트에서 추출한 nid로 company_read.naver 페이지 접근
// 목표가, 투자의견, 본문 텍스트를 파싱하여 반환
// ============================================================
async function fetchNaverReportDetail(nid) {
  if (!nid) return null;

  const url = `https://finance.naver.com/research/company_read.naver?nid=${nid}`;

  try {
    const resp = await axios.get(url, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9',
        'Referer': 'https://finance.naver.com/research/company_list.naver'
      },
      responseType: 'arraybuffer'
    });

    // euc-kr 디코딩
    let html;
    try {
      const decoder = new TextDecoder('euc-kr');
      html = decoder.decode(resp.data);
    } catch (e) {
      html = resp.data.toString('utf-8');
    }

    const $ = cheerio.load(html);
    const result = { targetPrice: 0, opinion: '', summary: '' };

    // 1) 목표가 추출: "목표가 65,000" 또는 "목표주가 65,000원"
    const allText = $('body').text();
    const tpMatch = allText.match(/목표(?:주?가?)\s*[:\s]?\s*([\d,]+)\s*원?/);
    if (tpMatch) result.targetPrice = parseInt(tpMatch[1].replace(/,/g, '')) || 0;

    // 2) 투자의견 추출: "투자의견 매수" 등
    const opMatch = allText.match(/투자의견\s*[:\s]?\s*(매수|매도|중립|Buy|Hold|Sell|Outperform|비중확대|비중축소|시장수익률|Trading Buy|Not Rated)/i);
    if (opMatch) result.opinion = opMatch[1];

    // 3) 본문 텍스트 추출
    //    네이버 리포트 상세는 다양한 레이아웃이 있음
    //    - td.view_cnt 내부
    //    - div.view_cnt 내부
    //    - class가 포함된 본문 영역
    let bodyText = '';

    // 전략1: td.view_cnt (가장 흔한 구조)
    const viewCnt = $('td.view_cnt, div.view_cnt');
    if (viewCnt.length) {
      bodyText = viewCnt.text().trim();
    }

    // 전략2: 테이블 내 긴 텍스트 셀 찾기
    if (!bodyText || bodyText.length < 50) {
      $('td').each(function () {
        const t = $(this).text().trim();
        if (t.length > 100 && t.length > bodyText.length) {
          // 메뉴/네비게이션이 아닌 실제 본문인지 확인
          if (!/^\s*(홈|투자정보|종목명|뉴스|공시|커뮤니티)/.test(t)) {
            bodyText = t;
          }
        }
      });
    }

    // 전략3: div 안에서 가장 긴 텍스트 블록
    if (!bodyText || bodyText.length < 50) {
      $('div').each(function () {
        const t = $(this).text().trim();
        if (t.length > 200 && t.length < 5000 && t.length > bodyText.length) {
          if (!/^\s*(홈|투자정보|종목명|메뉴)/.test(t)) {
            bodyText = t;
          }
        }
      });
    }

    // 본문 정리: 공백/줄바꿈 정리, 1000자 제한
    if (bodyText) {
      bodyText = bodyText
        .replace(/\s+/g, ' ')
        .replace(/\n{2,}/g, '\n')
        .trim()
        .substring(0, 1000);
      result.summary = bodyText;
    }

    console.log(`[네이버상세] nid=${nid} → 목표가:${result.targetPrice} 의견:${result.opinion} 본문:${result.summary.length}자`);
    return result;

  } catch (e) {
    console.error(`[네이버상세] nid=${nid} 실패: ${e.message}`);
    return null;
  }
}

// ============================================================
// 미래에셋증권 — 상세 페이지 Puppeteer 크롤링 (독립 함수)
// 리스트에서 추출한 messageId로 view.do 페이지 접근
// axios는 로그인 리다이렉트되므로 Puppeteer 필수
// ============================================================
async function fetchMiraeReportDetail(messageId) {
  if (!messageId || !puppeteer || !CHROME_PATH) return null;

  const url = `https://securities.miraeasset.com/bbs/board/message/view.do?messageId=${messageId}`;
  let miraeBrowser = null;

  try {
    miraeBrowser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process', '--disable-extensions', '--js-flags=--max-old-space-size=128', '--disable-background-networking', '--disable-default-apps']
    });
    console.log(`[미래에셋상세] Puppeteer 브라우저 시작`);

    const page = await miraeBrowser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');

    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      // JS 렌더링 대기
      await new Promise(r => setTimeout(r, 3000));

      const html = await page.content();
      const $ = cheerio.load(html);
      const result = { targetPrice: 0, opinion: '', summary: '' };

      const allText = $('body').text();

      // 1) 목표주가 추출: "목표주가 5.2만원" or "목표주가 52,000원" or "TP 52,000원"
      const tpMatch1 = allText.match(/목표주가\s*[:\s]?\s*([\d.]+)\s*만\s*원/);
      const tpMatch2 = allText.match(/목표주가\s*[:\s]?\s*([\d,]+)\s*원/);
      const tpMatch3 = allText.match(/TP\s*[:\s]?\s*([\d,]+)\s*원?/i);
      if (tpMatch1) {
        result.targetPrice = Math.round(parseFloat(tpMatch1[1]) * 10000);
      } else if (tpMatch2) {
        result.targetPrice = parseInt(tpMatch2[1].replace(/,/g, '')) || 0;
      } else if (tpMatch3) {
        result.targetPrice = parseInt(tpMatch3[1].replace(/,/g, '')) || 0;
      }

      // 2) 투자의견 추출
      const opMatch = allText.match(/(?:투자의견|Rating)\s*[:\s]?\s*(매수|매도|중립|Buy|Hold|Sell|Outperform|비중확대|비중축소|Trading Buy|Not Rated)/i);
      if (opMatch) result.opinion = opMatch[1];

      // 3) 본문 추출: 리포트 본문 영역
      let bodyText = '';

      // 전략1: 본문 컨테이너 (.view_cnt, .board_view, .cont_area 등)
      const viewSelectors = ['.view_cnt', '.board_view', '.cont_area', '.read_cont', '#content'];
      for (const sel of viewSelectors) {
        const el = $(sel);
        if (el.length && el.text().trim().length > 100) {
          bodyText = el.text().trim();
          break;
        }
      }

      // 전략2: 가장 긴 div/td 텍스트 블록
      if (!bodyText || bodyText.length < 100) {
        $('div, td').each(function () {
          const t = $(this).text().trim();
          if (t.length > 200 && t.length < 8000 && t.length > bodyText.length) {
            // 네비게이션/헤더 제외
            if (!/^\s*(홈|로그인|회원가입|투자정보|리서치|종목명)/.test(t) && !/function\s*\(/.test(t)) {
              bodyText = t;
            }
          }
        });
      }

      // 본문 정리
      if (bodyText) {
        bodyText = bodyText
          .replace(/\s+/g, ' ')
          .replace(/\n{2,}/g, '\n')
          .trim()
          .substring(0, 1000);
        result.summary = bodyText;
      }

      console.log(`[미래에셋상세] msgId=${messageId} → 목표가:${result.targetPrice} 의견:${result.opinion} 본문:${result.summary.length}자`);
      return result;

    } finally {
      await page.close().catch(() => { });
      if (miraeBrowser) {
        try {
          await Promise.race([
            miraeBrowser.close(),
            new Promise(r => setTimeout(r, 10000))
          ]);
        } catch (e) { }
        try { miraeBrowser.process()?.kill('SIGKILL'); } catch (e) { }
      }
    }

  } catch (e) {
    console.error(`[미래에셋상세] msgId=${messageId} 실패: ${e.message}`);
    if (miraeBrowser) {
      try { await miraeBrowser.close(); } catch (e2) { }
      try { miraeBrowser.process()?.kill('SIGKILL'); } catch (e2) { }
    }
    return null;
  }
}

// ============================================================
// 현대차증권 Puppeteer 기반 크롤링
// ============================================================
let hyundaiBrowser = null;

async function fetchHyundaiWithPuppeteer(url) {
  if (!puppeteer || !CHROME_PATH) {
    console.warn('[현대차증권] Puppeteer 또는 Chrome 미설치. npm install puppeteer-core 후 재시작 필요');
    return [];
  }

  try {
    // 매번 새 브라우저 (메모리 누수 방지)
    if (hyundaiBrowser) {
      try { await hyundaiBrowser.close(); } catch (e) { }
      try { hyundaiBrowser.process()?.kill('SIGKILL'); } catch (e) { }
      hyundaiBrowser = null;
    }
    hyundaiBrowser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process', '--disable-extensions', '--js-flags=--max-old-space-size=128', '--disable-background-networking', '--disable-default-apps']
    });
    console.log(`[현대차증권] Puppeteer 브라우저 시작 (${CHROME_PATH})`);

    const page = await hyundaiBrowser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      // JS 렌더링 대기 (리서치 데이터 로딩)
      await new Promise(r => setTimeout(r, 3000));

      // 추가 대기: 테이블이나 리스트가 나타날 때까지
      try {
        await page.waitForSelector('table tbody tr, .research_list li, .board_list li, .list_table tr', { timeout: 8000 });
      } catch (e) {
        // 셀렉터 못 찾아도 계속 진행
      }

      const html = await page.content();

      // 디버그: 렌더링된 HTML 저장
      const debugPath = path.join(DATA_DIR, 'debug_hyundai_rendered.html');
      try { fs.writeFileSync(debugPath, html, 'utf-8'); } catch (e) { }

      // cheerio로 파싱
      const $ = cheerio.load(html);
      const items = [];

      // 범용 파싱 전략: 날짜가 있는 행/항목 찾기
      // 전략1: 테이블 행
      $('table tr, table tbody tr').each(function () {
        const cells = $(this).find('td');
        if (cells.length < 3) return;

        const rowText = $(this).text();
        const dateMatch = rowText.match(/(20\d{2}[.\/-]\d{2}[.\/-]\d{2})/);
        if (!dateMatch) return;

        let corp = '', title = '', author = '', pdfLink = '';

        cells.each(function () {
          const txt = $(this).text().trim();
          const link = $(this).find('a');

          if (link.length && txt.length > 3) {
            // 종목코드 패턴: 종목명(코드/의견)
            const corpMatch = txt.match(/^(.+?)\s*[\(（](\d{6})/);
            const opMatch = txt.match(/\/(매수|매도|중립|Buy|Hold|Sell|BUY|HOLD|SELL|Not Rated|Outperform|비중확대|비중축소)[\)）]/i);

            if (corpMatch && !corp) {
              corp = corpMatch[1].trim();
              if (!pdfLink) pdfLink = link.attr('href') || '';
            } else if (txt.length > 5 && !title) {
              title = txt;
              if (!pdfLink) pdfLink = link.attr('href') || '';
            }
          }
          // 작성자 패턴
          if (/^[가-힣]{2,4}$/.test(txt) && !author) {
            author = txt;
          }
        });

        if (corp || title) {
          // 투자의견 추출
          const fullText = $(this).text();
          let opinion = '';
          const opM = fullText.match(/(매수|매도|중립|Buy|Hold|Sell|BUY|HOLD|SELL|Outperform|비중확대|비중축소|Not Rated)/i);
          if (opM) opinion = opM[1];

          // 목표주가 추출
          let targetPrice = 0;
          const tpM = fullText.match(/(?:목표주?가?|TP)\s*[:\s]?\s*([\d,]+)\s*원?/i);
          if (tpM) targetPrice = parseInt(tpM[1].replace(/,/g, '')) || 0;

          if (pdfLink && !pdfLink.startsWith('http')) {
            pdfLink = 'https://www.hmsec.com' + pdfLink;
          }

          items.push({
            corp: corp || title.substring(0, 15),
            title: title || corp,
            broker: '현대차증권(직접)',
            analyst: author,
            opinion,
            targetPrice,
            currentPrice: 0,
            date: dateMatch[1].replace(/[-\/]/g, '.'),
            pdfLink,
            source: '현대차증권'
          });
        }
      });

      // 전략2: li 리스트 기반 (하나증권과 유사한 구조일 수 있음)
      if (items.length === 0) {
        $('li, .research_item, .board_item, [class*=list]').each(function () {
          const text = $(this).text().trim();
          const dateMatch = text.match(/(20\d{2}[.\/-]\d{2}[.\/-]\d{2})/);
          if (!dateMatch || text.length < 20) return;

          const link = $(this).find('a').first();
          const titleText = link.text().trim() || text.substring(0, 60);
          if (titleText.length < 5) return;

          // 종목+코드 패턴
          const corpMatch = titleText.match(/^(.+?)\s*[\(（](\d{6})/);
          let corp = corpMatch ? corpMatch[1].trim() : '';
          let stockCode = corpMatch ? corpMatch[2] : '';

          let opinion = '';
          const opM = text.match(/(매수|매도|중립|Buy|Hold|Sell|Outperform|비중확대|비중축소)/i);
          if (opM) opinion = opM[1];

          let targetPrice = 0;
          const tpM = text.match(/목표주?가?\s*([\d,]+)\s*원/);
          if (tpM) targetPrice = parseInt(tpM[1].replace(/,/g, '')) || 0;

          let pdfLink = link.attr('href') || '';
          if (pdfLink && !pdfLink.startsWith('http')) pdfLink = 'https://www.hmsec.com' + pdfLink;

          items.push({
            corp: stockCode ? `${corp}(${stockCode})` : (corp || titleText.substring(0, 15)),
            title: titleText,
            broker: '현대차증권(직접)',
            analyst: '',
            opinion,
            targetPrice,
            currentPrice: 0,
            date: dateMatch[1].replace(/[-\/]/g, '.'),
            pdfLink,
            source: '현대차증권'
          });
        });
      }

      console.log(`[현대차증권] Puppeteer 파싱: ${items.length}건 추출 (HTML ${html.length}자)`);
      return items;

    } finally {
      await page.close().catch(() => { });
      // 크롤링 완료 후 브라우저 닫기 (타임아웃 10초)
      if (hyundaiBrowser) {
        try {
          await Promise.race([
            hyundaiBrowser.close(),
            new Promise(r => setTimeout(r, 10000))
          ]);
        } catch (e) { }
        // 강제 kill
        try { hyundaiBrowser.process()?.kill('SIGKILL'); } catch (e) { }
        hyundaiBrowser = null;
      }
    }

  } catch (e) {
    console.error(`[현대차증권] Puppeteer 오류: ${e.message}`);
    if (hyundaiBrowser) {
      try { await hyundaiBrowser.close(); } catch (e2) { }
      try { hyundaiBrowser.process()?.kill('SIGKILL'); } catch (e2) { }
      hyundaiBrowser = null;
    }
    return [];
  }
}

// 서버 종료 시 브라우저 정리

// ============================================================
// 소스별 독립 백그라운드 수집
// ============================================================
// ============================================================
// 시간대별 동적 수집 간격 (피크/장중/장외)
// ============================================================
function getSmartInterval(sourceKey) {
  const hour = new Date().getHours();
  const day = new Date().getDay(); // 0=일, 6=토
  const isWeekend = (day === 0 || day === 6);

  // 주말: 전 소스 60분 간격
  if (isWeekend) return 60 * 60 * 1000;

  // 피크: 07~09시 (리포트 대량 발행)
  if (hour >= 7 && hour < 9) {
    switch (sourceKey) {
      case 'WiseReport': return 5 * 60 * 1000;   // 5분
      case '미래에셋': return 5 * 60 * 1000;   // 5분
      case '하나증권': return 5 * 60 * 1000;   // 5분
      case '현대차증권': return 10 * 60 * 1000;  // 10분
      case '네이버': return 10 * 60 * 1000;  // 10분
      default: return 5 * 60 * 1000;
    }
  }

  // 장중: 09~16시
  if (hour >= 9 && hour < 16) {
    switch (sourceKey) {
      case 'WiseReport': return 10 * 60 * 1000;  // 10분
      case '미래에셋': return 10 * 60 * 1000;  // 10분
      case '하나증권': return 10 * 60 * 1000;  // 10분
      case '현대차증권': return 20 * 60 * 1000;  // 20분
      case '네이버': return 15 * 60 * 1000;  // 15분
      default: return 10 * 60 * 1000;
    }
  }

  // 장외: 16~07시
  switch (sourceKey) {
    case 'WiseReport': return 60 * 60 * 1000;  // 60분
    case '미래에셋': return 60 * 60 * 1000;  // 60분
    case '하나증권': return 60 * 60 * 1000;  // 60분
    case '현대차증권': return 0;               // 0 = 수집 안 함
    case '네이버': return 60 * 60 * 1000;  // 60분
    default: return 60 * 60 * 1000;
  }
}

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

// 소스별 마지막 수집 날짜 추적 (한국시간 기준)
let lastFetchDates = loadJSON('report_last_dates.json', {});

function getKSTDateStr(dateStr) {
  // '2026.02.21' or '2026-02-21' or '20260221' → '20260221' 정규화
  return (dateStr || '').replace(/[.\-\/]/g, '');
}

function getTodayKST() {
  const now = new Date();
  const kst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const y = kst.getFullYear();
  const m = String(kst.getMonth() + 1).padStart(2, '0');
  const d = String(kst.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

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

  // 소스별 날짜 필터: 마지막 수집일 이후만 유지 (한국시간 기준)
  const lastDate = lastFetchDates[src.key] || '00000000';
  const dateFiltered = unique.filter(item => {
    const itemDate = getKSTDateStr(item.date);
    return itemDate >= lastDate;  // 마지막 수집일 이후
  });
  if (unique.length !== dateFiltered.length) {
    console.log(`[${src.key}] 날짜 필터: ${unique.length} → ${dateFiltered.length}건 (기준: ${lastDate})`);
  }

  // ========================================
  // 네이버: 다른 소스와 교차 중복 제거
  // 직접 수집한 소스(WR/미래에셋/하나/현대차)에 이미 있으면 네이버 것 제외
  // 판단 기준: 종목명(순수) + 날짜 + 증권사명(순수) 일치
  // ========================================
  let crossFiltered = dateFiltered;
  if (src.key === '네이버') {
    // 다른 소스의 리포트를 종목+날짜+증권사 키로 수집
    const otherKeys = new Set();
    const directSources = ['WiseReport', '미래에셋', '하나증권'];

    for (const srcName of directSources) {
      const items = reportStores[srcName] || [];
      for (const r of items) {
        // 종목명에서 코드 제거: "삼성전자(005930)" → "삼성전자"
        const pureCorp = (r.corp || '').replace(/[\(（]\d{6}[.\w]*[\)）]/g, '').trim();
        // 날짜 정규화: "2026.02.13" or "2026-02-13" → "20260213"
        const pureDate = (r.date || '').replace(/[.\-\/]/g, '');
        // 증권사명 정규화: "하나증권(직접)" → "하나증권", "미래에셋증권(직접)" → "미래에셋"
        const pureBroker = (r.broker || '')
          .replace(/[\(（][^)）]*[\)）]/g, '')  // 괄호 제거
          .replace(/증권$/, '')                  // "증권" 제거
          .trim();

        if (pureCorp && pureDate) {
          otherKeys.add(`${pureCorp}|${pureDate}`);
          otherKeys.add(`${pureCorp}|${pureDate}|${pureBroker}`);
        }
      }
    }

    const before = crossFiltered.length;
    crossFiltered = crossFiltered.filter(item => {
      const pureCorp = (item.corp || '').replace(/[\(（]\d{6}[.\w]*[\)）]/g, '').trim();
      const pureDate = (item.date || '').replace(/[.\-\/]/g, '');
      const pureBroker = (item.broker || '')
        .replace(/[\(（][^)）]*[\)）]/g, '')
        .replace(/증권$/, '')
        .trim();

      // 종목+날짜+증권사 3개 모두 일치하면 중복
      if (otherKeys.has(`${pureCorp}|${pureDate}|${pureBroker}`)) return false;
      // 종목+날짜만 일치해도 높은 확률로 중복 (같은 날 같은 종목 리포트)
      // → 단, 다른 증권사 리포트일 수 있으므로 이건 유지
      return true;
    });

    const removed = before - crossFiltered.length;
    if (removed > 0) {
      console.log(`[네이버] 교차중복 ${removed}건 제거 (${before}→${crossFiltered.length}건)`);
    }
  }

  // 기존 대비 새 항목 감지
  const existingKeys = new Set(reportStores[src.key].map(r => `${r.corp}|${r.title}|${r.date}`));
  let added = 0;
  let latestDate = lastFetchDates[src.key] || '00000000';
  for (const item of crossFiltered) {
    const key = `${item.corp}|${item.title}|${item.date}`;
    if (!existingKeys.has(key)) {
      reportStores[src.key].unshift(item);
      added++;
      // reportCache 업데이트
      if (item.targetPrice || item.opinion) {
        const cacheKey = `${item.corp}|${item.broker}`;
        reportCache[cacheKey] = { targetPrice: item.targetPrice, opinion: item.opinion, date: item.date };
      }
    }
    // 소스별 최신 날짜 갱신
    const itemDate = getKSTDateStr(item.date);
    if (itemDate > latestDate) latestDate = itemDate;
  }
  // 마지막 수집 날짜 저장
  if (latestDate > (lastFetchDates[src.key] || '00000000')) {
    lastFetchDates[src.key] = latestDate;
    saveJSON('report_last_dates.json', lastFetchDates);
  }

  // 최대 200건 유지
  if (reportStores[src.key].length > 200) reportStores[src.key] = reportStores[src.key].slice(0, 200);

  if (added > 0) {
    saveJSON(src.file, reportStores[src.key]);
    saveJSON('report_cache.json', reportCache);
    console.log(`[${src.key}] +${added}건 신규 (총 ${reportStores[src.key].length}건)`);

    // ★ 네이버: 신규 리포트 상세 페이지 크롤링 (본문/목표가/투자의견 보강)
    if (src.key === '네이버') {
      const newNaverItems = reportStores[src.key].slice(0, Math.min(added, 15));
      let detailCount = 0;
      for (const item of newNaverItems) {
        if (!item.nid) continue;
        try {
          const detail = await fetchNaverReportDetail(item.nid);
          if (detail) {
            // 목표가가 없던 항목에 보강
            if (detail.targetPrice && !item.targetPrice) {
              item.targetPrice = detail.targetPrice;
            }
            // 투자의견이 없던 항목에 보강
            if (detail.opinion && !item.opinion) {
              item.opinion = detail.opinion;
            }
            // 본문 요약 추가
            if (detail.summary) {
              item.summary = detail.summary;
            }
            detailCount++;
          }
          // 1.5초 간격 (서버 부하 방지)
          await new Promise(res => setTimeout(res, 1500));
        } catch (e) {
          console.error(`[네이버상세] ${item.corp} 실패: ${e.message}`);
        }
      }
      if (detailCount > 0) {
        saveJSON(src.file, reportStores[src.key]);
        saveJSON('report_cache.json', reportCache);
        console.log(`[네이버상세] ${detailCount}건 본문 보강 완료`);
      }
    }

    // ★ 미래에셋: 신규 리포트 Puppeteer 상세 크롤링 (본문/목표가/투자의견 보강)
    if (src.key === '미래에셋' && puppeteer && CHROME_PATH) {
      const newMiraeItems = reportStores[src.key].slice(0, Math.min(added, 10));
      let detailCount = 0;
      for (const item of newMiraeItems) {
        if (!item.messageId) continue;
        try {
          const detail = await fetchMiraeReportDetail(item.messageId);
          if (detail) {
            if (detail.targetPrice && !item.targetPrice) {
              item.targetPrice = detail.targetPrice;
            }
            if (detail.opinion && !item.opinion) {
              item.opinion = detail.opinion;
            }
            if (detail.summary) {
              item.summary = detail.summary;
            }
            detailCount++;
          }
          // 3초 간격 (Puppeteer 부하 고려)
          await new Promise(res => setTimeout(res, 3000));
        } catch (e) {
          console.error(`[미래에셋상세] ${item.corp} 실패: ${e.message}`);
        }
      }
      if (detailCount > 0) {
        saveJSON(src.file, reportStores[src.key]);
        saveJSON('report_cache.json', reportCache);
        console.log(`[미래에셋상세] ${detailCount}건 본문 보강 완료`);
      }
    }

    // 신규 리포트 Gemini AI 분석 (최대 10건)
    const newItems = reportStores[src.key].slice(0, Math.min(added, 10));
    analyzeReportBatch(newItems).catch(e => console.error(`[리포트AI] 배치 실패: ${e.message}`));
  } else {
    console.log(`[${src.key}] 변동 없음 (${reportStores[src.key].length}건)`);
  }

  return { source: src.key, fetched: crossFiltered.length, added };
}

// 소스별 독립 타이머 시작 (동적 간격 + 일시정지 지원)
const reportTimers = {}; // key → { timer, nextRun }

function scheduleNextFetch(src) {
  if (reportTimers[src.key]?.timer) {
    clearTimeout(reportTimers[src.key].timer);
  }

  const interval = getSmartInterval(src.key);

  // interval === 0 → 이 시간대에는 수집 안 함 (현대차증권 장외)
  if (interval === 0) {
    // 1시간 후 다시 확인 (시간대 변경 감지)
    reportTimers[src.key] = {
      timer: setTimeout(() => scheduleNextFetch(src), 60 * 60 * 1000),
      nextRun: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      interval: '정지(장외)',
      paused: false
    };
    return;
  }

  reportTimers[src.key] = {
    timer: setTimeout(async () => {
      if (!_getIsPaused()) {
        try {
          await fetchSourceReports(src);
        } catch (e) {
          console.error(`[${src.key}] 오류: ${e.message}`);
        }
      } else {
        console.log(`[${src.key}] ⏸️ 일시정지 중 — 스킵`);
      }
      // 다음 실행 예약 (매번 현재 시간대 기준 간격 재계산)
      scheduleNextFetch(src);
    }, interval),
    nextRun: new Date(Date.now() + interval).toISOString(),
    interval: Math.round(interval / 1000) + '초',
    paused: false
  };
}

function startReportTimers() {
  REPORT_SOURCES.forEach(src => {
    // 초기 실행 지연: 소스별로 분산
    const initialDelay = src.key === 'WiseReport' ? 3000 :
      src.key === '미래에셋' ? 6000 :
        src.key === '하나증권' ? 9000 :
          src.key === '현대차증권' ? 15000 : 12000;
    setTimeout(() => {
      if (!_getIsPaused()) {
        fetchSourceReports(src).catch(e => console.error(`[${src.key}] 오류: ${e.message}`));
      }
      scheduleNextFetch(src);
    }, initialDelay);

    const smartMs = getSmartInterval(src.key);
    const label = smartMs === 0 ? '정지(장외)' : Math.round(smartMs / 60000) + '분';
    console.log(`  ⏰ ${src.key}: 현재 ${label} 간격 (초기 ${initialDelay / 1000}초 후, 시간대별 자동 조절)`);
  });
}

// API: 리포트 조회 (모든 소스 merge)
// 네이버 교차중복 제거 헬퍼: 직접 수집 소스에 이미 있는 리포트를 네이버에서 제외
function filterNaverDuplicates(allItems) {
  // 직접 소스(네이버 제외)의 종목+날짜+증권사 키 수집
  const directKeys = new Set();
  const directSources = ['WiseReport', '미래에셋', '하나증권', '현대차증권'];

  for (const srcName of directSources) {
    const items = reportStores[srcName] || [];
    for (const r of items) {
      const pureCorp = (r.corp || '').replace(/[\(（]\d{6}[.\w]*[\)）]/g, '').trim();
      const pureDate = (r.date || '').replace(/[.\-\/]/g, '');
      const pureBroker = (r.broker || '')
        .replace(/[\(（][^)）]*[\)）]/g, '')
        .replace(/증권$/, '')
        .trim();
      if (pureCorp && pureDate) {
        directKeys.add(`${pureCorp}|${pureDate}|${pureBroker}`);
      }
    }
  }

  return allItems.filter(item => {
    if (item.source !== '네이버') return true; // 네이버 아닌 건 유지
    const pureCorp = (item.corp || '').replace(/[\(（]\d{6}[.\w]*[\)）]/g, '').trim();
    const pureDate = (item.date || '').replace(/[.\-\/]/g, '');
    const pureBroker = (item.broker || '')
      .replace(/[\(（][^)）]*[\)）]/g, '')
      .replace(/증권$/, '')
      .trim();
    return !directKeys.has(`${pureCorp}|${pureDate}|${pureBroker}`);
  });
}

function getHyundaiBrowser() { return hyundaiBrowser; }

function getIsPaused() { return isPaused; }

module.exports = {
  init,
  fetchReportPage,
  fetchNaverReportDetail,
  fetchMiraeReportDetail,
  fetchHyundaiWithPuppeteer,
  fetchSourceReports,
  getSmartInterval,
  REPORT_SOURCES,
  scheduleNextFetch,
  startReportTimers,
  filterNaverDuplicates,
  getHyundaiBrowser,
  CHROME_PATH,
  puppeteer,
  get reportTimers() { return reportTimers; }
};