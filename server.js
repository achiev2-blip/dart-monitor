/**
 * DART 공시 모니터 — Node.js 로컬 서버 v3.5
 * 
 * 기능:
 *  - DART API 프록시 (CORS 해소)
 *  - 뉴스 RSS 수집 (직접 접근, 프록시 불필요)
 *  - 증권사 리포트 수집 (WiseReport + 미래에셋 직접 + 네이버 금융)
 *  - 텔레그램 전송
 *  - 데이터 자동 저장/복원 (서버 재시작 시 이어짐)
 * 
 * 실행: node server.js
 * 접속: http://localhost:3000
 */

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { saveJSON, loadJSON, ensureDataDir } = require('./utils/file-io');
const companyData = require('./utils/company-data');
// NEWS_FETCHERS는 news-dc.js가 직접 사용
const hantoo = require('./crawlers/hantoo');
const archive = require('./utils/archive');
const macro = require('./crawlers/macro');
const prediction = require('./utils/prediction');
const gemini = require('./services/gemini');

// Puppeteer (미래에셋 상세 JS렌더링용)
let puppeteer;
try {
  puppeteer = require('puppeteer-core');
  console.log('[Puppeteer] puppeteer-core 로드 성공');
} catch (e) {
  try {
    puppeteer = require('puppeteer');
    console.log('[Puppeteer] puppeteer 로드 성공');
  } catch (e2) {
    console.warn('[Puppeteer] 미설치 — 일부 크롤링 비활성. npm install puppeteer-core 실행 필요');
  }
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

const app = express();
const PORT = config.PORT;
const DATA_DIR = config.DATA_DIR;

// ============================================================
// Express 미들웨어
// ============================================================
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// API 인증 미들웨어 — GET(읽기)는 허용, POST/PUT/DELETE(쓰기)만 인증 필요
app.use('/api', (req, res, next) => {
  // GET 요청은 누구나 접근 가능 (읽기 전용)
  if (req.method === 'GET') return next();
  // localhost는 모든 메서드 허용
  const host = req.hostname || '';
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (isLocal) return next();
  // 같은 사이트에서 온 브라우저 요청 허용 (프론트엔드 페이지)
  const referer = req.headers.referer || req.headers.origin || '';
  if (referer.includes(host)) return next();
  // 외부 쓰기 요청은 x-api-key 헤더 또는 api_key 쿼리 파라미터 필요
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  if (!apiKey || apiKey !== config.INTERNAL_API_KEY) {
    return res.status(401).json({ ok: false, error: '인증 필요: x-api-key 헤더를 확인하세요.' });
  }
  next();
});

app.use(express.json({ limit: '10mb' }));

// Claude/봇 프론트엔드 접근 차단 (API는 허용)
app.use((req, res, next) => {
  const ua = (req.headers['user-agent'] || '').toLowerCase();
  if (req.path.endsWith('.html') || req.path === '/') {
    if (ua.includes('claude') || ua.includes('anthropic') || ua.includes('bot')) {
      return res.status(403).send('Blocked');
    }
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// 메모리 모니터링 (1분마다 기록, 최대 60건 = 1시간)
// ============================================================
app.locals.memHistory = [];
function recordMemory() {
  const mem = process.memoryUsage();
  const dc = app.locals.claudeDataCenter || {};
  const entry = {
    time: new Date(Date.now() + 9 * 3600000).toISOString().slice(11, 19),  // HH:MM:SS KST
    rss: Math.round(mem.rss / 1024 / 1024),          // MB
    heap: Math.round(mem.heapUsed / 1024 / 1024),     // MB
    heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
    external: Math.round(mem.external / 1024 / 1024),
    dc: {
      news: (dc.news || []).length,
      reports: (dc.reports || []).length,
      disclosures: (dc.disclosures || []).length,
      prices: (dc.prices || []).length,
      dcSize: Math.round(JSON.stringify(dc).length / 1024)  // KB
    }
  };
  app.locals.memHistory.push(entry);
  if (app.locals.memHistory.length > 60) app.locals.memHistory.shift();
}
setInterval(recordMemory, 60000);
setTimeout(recordMemory, 5000);  // 5초 후 첫 기록

// ============================================================
// 데이터 저장소 초기화
// ============================================================
// storedNews는 news-dc.js가 소유 (init에서 app.locals에 주입)
const sentItems = loadJSON('sent_items.json', {});
const reportCache = loadJSON('report_cache.json', {});
const reportAiCache = loadJSON('report_ai_cache.json', {});

const reportStores = {
  WiseReport: loadJSON('reports_wisereport.json', []),
  '미래에셋': loadJSON('reports_mirae.json', []),
  '하나증권': loadJSON('reports_hana.json', []),
  '네이버': loadJSON('reports_naver.json', [])
};

// 하위호환: 기존 reports.json → 소스별 분배
const legacyReports = loadJSON('reports.json', []);
if (legacyReports.length > 0 && Object.values(reportStores).every(s => s.length === 0)) {
  legacyReports.forEach(r => {
    const src = r.source || '네이버';
    if (reportStores[src]) reportStores[src].push(r);
  });
  Object.entries(reportStores).forEach(([src, items]) => {
    if (items.length > 0) {
      const fname = src === 'WiseReport' ? 'reports_wisereport.json' : src === '미래에셋' ? 'reports_mirae.json' : 'reports_naver.json';
      saveJSON(fname, items);
    }
  });
  console.log(`[마이그레이션] 기존 리포트 ${legacyReports.length}건 → 소스별 분배 완료`);
}

function totalReportCount() {
  return Object.values(reportStores).reduce((sum, arr) => sum + arr.length, 0);
}

// 전송이력 정리
function cleanSentItems() {
  const cutoff = Date.now() - 7 * 24 * 3600000;
  let removed = 0;
  for (const key of Object.keys(sentItems)) {
    const val = sentItems[key];
    if (val === true || (typeof val === 'number' && val < cutoff)) {
      delete sentItems[key];
      removed++;
    }
  }
  if (removed > 0) {
    saveJSON('sent_items.json', sentItems);
    console.log(`[전송이력] ${removed}건 정리 (7일 경과), 잔여 ${Object.keys(sentItems).length}건`);
  }
}

// ============================================================
// 데이터 보존 규칙 적용 (매일 0:05 KST 실행)
// ============================================================
function cleanOldData() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 3600000);
  let totalCleaned = 0;

  // 1. 뉴스 보존규칙 — news-dc가 관리
  const newsDC = require('./services/news-dc');
  totalCleaned += newsDC.cleanOldNews();

  // 2. report_ai_cache.json — 60일 이상 (키: "종목|제목|날짜")
  const aiCacheCutoff = new Date(kst);
  aiCacheCutoff.setDate(aiCacheCutoff.getDate() - 60);
  const aiCutoffStr = aiCacheCutoff.toISOString().slice(0, 10).replace(/-/g, '.');
  let aiRemoved = 0;
  for (const key of Object.keys(reportAiCache)) {
    const parts = key.split('|');
    const dateStr = parts[2] || '';
    // 날짜 형식: "2026.02.20" 또는 "2026-02-20"
    if (dateStr && dateStr.replace(/-/g, '.') < aiCutoffStr) {
      delete reportAiCache[key];
      aiRemoved++;
    }
  }
  if (aiRemoved > 0) {
    saveJSON('report_ai_cache.json', reportAiCache);
    totalCleaned += aiRemoved;
    console.log(`[보존규칙] 리포트AI캐시 ${aiRemoved}건 삭제 (60일 경과), 잔여 ${Object.keys(reportAiCache).length}건`);
  }

  // 3. report_cache.json — 90일 이상 (값에 date 필드 있을 경우)
  const rcCutoff = new Date(kst);
  rcCutoff.setDate(rcCutoff.getDate() - 90);
  const rcCutoffMs = rcCutoff.getTime();
  let rcRemoved = 0;
  for (const key of Object.keys(reportCache)) {
    const val = reportCache[key];
    // 타임스탬프 또는 날짜 필드 확인
    if (typeof val === 'number' && val < rcCutoffMs) {
      delete reportCache[key];
      rcRemoved++;
    } else if (val && val.date && new Date(val.date).getTime() < rcCutoffMs) {
      delete reportCache[key];
      rcRemoved++;
    }
  }
  if (rcRemoved > 0) {
    saveJSON('report_cache.json', reportCache);
    totalCleaned += rcRemoved;
    console.log(`[보존규칙] 리포트캐시 ${rcRemoved}건 삭제 (90일 경과), 잔여 ${Object.keys(reportCache).length}건`);
  }

  // 4. news_ai_cache — 30일 (서버 메모리 + 파일)
  const newsAiCache = gemini.newsAiCacheServer;
  const naCutoff = new Date(kst);
  naCutoff.setDate(naCutoff.getDate() - 30);
  const naCutoffMs = naCutoff.getTime();
  let naRemoved = 0;
  for (const key of Object.keys(newsAiCache)) {
    const val = newsAiCache[key];
    if (val && val.date && new Date(val.date).getTime() < naCutoffMs) {
      delete newsAiCache[key];
      naRemoved++;
    }
  }
  if (naRemoved > 0) {
    saveJSON('news_ai_cache.json', newsAiCache);
    totalCleaned += naRemoved;
    console.log(`[보존규칙] 뉴스AI캐시 ${naRemoved}건 삭제 (30일 경과), 잔여 ${Object.keys(newsAiCache).length}건`);
  }

  // 5. dart_*.json — dart-dc.js로 분리됨

  // 6. 소스별 리포트 — 30일 보존 (companies/{code}/reports.json이 장기 보관)
  const reportCutoff = new Date(kst);
  reportCutoff.setDate(reportCutoff.getDate() - 30);
  const reportCutoffStr = reportCutoff.toISOString().slice(0, 10).replace(/-/g, '.');
  const reportFiles = {
    'reports_wisereport.json': reportStores.WiseReport,
    'reports_mirae.json': reportStores['미래에셋'],
    'reports_hana.json': reportStores['하나증권'],
    'reports_naver.json': reportStores['네이버']
  };
  let reportRemoved = 0;
  for (const [fname, arr] of Object.entries(reportFiles)) {
    const before = arr.length;
    // 날짜 형식: "2026.02.20" 또는 "2026-02-20"
    for (let i = arr.length - 1; i >= 0; i--) {
      const d = (arr[i].date || '').replace(/-/g, '.');
      if (d && d < reportCutoffStr) {
        arr.splice(i, 1);
      }
    }
    if (arr.length < before) {
      saveJSON(fname, arr);
      reportRemoved += before - arr.length;
    }
  }
  if (reportRemoved > 0) {
    totalCleaned += reportRemoved;
    console.log(`[보존규칙] 소스별 리포트 ${reportRemoved}건 삭제 (30일 경과)`);
  }

  // 7. legacy reports.json 삭제 (마이그레이션 완료)
  try {
    const legacyFp = path.join(config.DATA_DIR, 'reports.json');
    if (fs.existsSync(legacyFp)) {
      const legacy = JSON.parse(fs.readFileSync(legacyFp, 'utf-8'));
      if (Array.isArray(legacy) && legacy.length > 0) {
        fs.unlinkSync(legacyFp);
        totalCleaned += legacy.length;
        console.log(`[보존규칙] legacy reports.json 삭제 (${legacy.length}건)`);
      }
    }
  } catch (e) { }

  if (totalCleaned > 0) {
    console.log(`[보존규칙] 총 ${totalCleaned}건 정리 완료`);
  }
}
cleanSentItems();
cleanOldData();  // 서버 시작 시 뉴스 24시간+200건캡 즉시 적용

// 일시정지 제어
let isPaused = false;
let pausedAt = null;

// 주가 알림 메모리
const priceAlerts = [];

// 종목명으로 코드 찾기
function findStockCode(corpName) {
  const watchlist = hantoo.getWatchlist();
  const found = watchlist.find(s => s.name === corpName || corpName.includes(s.name));
  return found ? found.code : null;
}

console.log(`[복원] 리포트 WR:${reportStores.WiseReport.length} 미래에셋:${reportStores['미래에셋'].length} 하나:${reportStores['하나증권'].length} 네이버:${reportStores['네이버'].length} (총${totalReportCount()}건), 전송이력 ${Object.keys(sentItems).length}건`);

// ============================================================
// Gemini 서비스 초기화
// ============================================================
gemini.init({
  reportAiCache,
  companyData,
  findStockCode,
});

// ============================================================
// DART 공시 전용 DC (수집 + 분류 + DC 관리 통합 모듈)
// ============================================================
const dartDC = require('./services/dart-dc');
const reportsDC = require('./services/reports-dc');
const usDC = require('./services/us-dc');
const newsDC = require('./services/news-dc');
const claudeDC = require('./services/claude-dc');
// ============================================================
// Gemini API (프록시)
// ============================================================
app.post('/api/gemini', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt 필수' });

  if (gemini.isCooldownActive()) {
    const remain = Math.max(0, Math.round((gemini.cooldownUntil - Date.now()) / 60000));
    return res.status(429).json({ error: `쿨다운 중 (${remain}분 후 해제)`, cooldown: true });
  }

  const model = gemini.getCurrentModel();
  const url = `${gemini.GEMINI_BASE}${model.id}:generateContent?key=${gemini.GEMINI_KEY}`;

  try {
    const resp = await axios.post(url, {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 500 }
    }, { timeout: 30000, headers: { 'Content-Type': 'application/json' } });

    const text = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text || text.trim().length === 0) {
      gemini.demoteModel();
      return res.status(500).json({ error: '빈 응답', model: model.label });
    }

    gemini.markGeminiWork();
    resp.data._model = model.label;
    res.json(resp.data);
  } catch (e) {
    console.error(`[Gemini][${model.label}] ${e.message}`);
    gemini.demoteModel();
    res.status(e.response?.status || 500).json({ error: e.message, model: model.label });
  }
});

// ============================================================
// crawlers/reports 초기화
// ============================================================
const {
  init: initReports,
  fetchReportPage, fetchNaverReportDetail, fetchMiraeReportDetail,
  fetchSourceReports, getSmartInterval,
  REPORT_SOURCES, scheduleNextFetch, startReportTimers,
  filterNaverDuplicates, CHROME_PATH: REPORT_CHROME_PATH,
  puppeteer: reportPuppeteer
} = require('./crawlers/reports');

const aiQueue = require('./services/ai-queue');
aiQueue.init({ apiKey: process.env.GEMINI_KEY_NEWS });

const reportTimers = {};

initReports({
  reportStores,
  reportCache,
  getIsPaused: () => isPaused,
  onReportAnalyzed: (report, result) => {
    // 리포트 라인으로 결과 저장
    const cacheKey = `${report.corp}|${report.title}|${report.date}`;
    reportAiCache[cacheKey] = result;
    report.aiResult = result;
    // 워치리스트 종목이면 company-data에도 저장
    if (report.corp && companyData) {
      const code = findStockCode(report.corp);
      if (code) {
        companyData.addReport(code, { ...report, aiResult: result });
        companyData.addReportToLayer(code, { ...report, aiResult: result });
        if (result.summary) companyData.updateAiLayer(code, result.summary, result.cls);
      }
    }
    const { saveJSON } = require('./utils/file-io');
    saveJSON('report_ai_cache.json', reportAiCache);
  }
});

// ============================================================
// 아카이브 데이터 수집 헬퍼
// ============================================================
function getCollectedDataForArchive() {
  const watchlist = hantoo.getWatchlist();
  return {
    news: (app.locals.storedNews || []),
    reports: Object.values(reportStores).flat(),
    disclosures: [],
    prices: (() => {
      const result = {};
      for (const s of watchlist) {
        const p = companyData.getPrice(s.code);
        if (p.current) result[s.name] = p.current;
      }
      return result;
    })()
  };
}

// ============================================================
// app.locals에 공유 상태 주입
// ============================================================
// app.locals.storedNews는 news-dc.init()에서 설정됨
app.locals.sentItems = sentItems;
app.locals.reportCache = reportCache;
app.locals.reportAiCache = reportAiCache;
app.locals.reportStores = reportStores;
app.locals.hantoo = hantoo;
app.locals.companyData = companyData;
app.locals.archive = archive;
app.locals.macro = macro;
app.locals.prediction = prediction;
app.locals.puppeteer = puppeteer;
app.locals.CHROME_PATH = CHROME_PATH;
app.locals.priceAlerts = priceAlerts;
app.locals.isPaused = isPaused;
app.locals.pausedAt = pausedAt;
app.locals.memoryWarningCount = 0;
app.locals.getCollectedDataForArchive = getCollectedDataForArchive;

// isPaused를 getter/setter로 설정 (라우트에서 변경 가능하도록)
Object.defineProperty(app.locals, 'isPaused', {
  get: () => isPaused,
  set: (val) => { isPaused = val; },
  enumerable: true
});
Object.defineProperty(app.locals, 'pausedAt', {
  get: () => pausedAt,
  set: (val) => { pausedAt = val; },
  enumerable: true
});

// 리포트 제어 함수 주입
app.locals.reportControl = {
  reportTimers,
  startReportTimers,
  REPORT_SOURCES,
  getSmartInterval,
};

// 컨텍스트 유틸 주입
const contextModule = require('./routes/context');
app.locals.contextHelpers = {
  loadContext: contextModule.loadContext,
  loadStockContext: contextModule.loadStockContext,
};
app.locals.hantoo = hantoo;

// ============================================================
// 라우트 등록
// ============================================================
app.use('/api', require('./routes/dart'));
app.use('/api', require('./routes/news'));

const reportsRoute = require('./routes/reports');
reportsRoute.init({
  filterNaverDuplicates,
  REPORT_SOURCES,
  fetchReportPage,
  fetchSourceReports,
  getSmartInterval,
});
app.use('/api', reportsRoute.router);

app.use('/api', require('./routes/stocks'));
app.use('/api', require('./routes/telegram'));

const backupRoute = require('./routes/backup');
app.use('/api', backupRoute.router);

app.use('/api', require('./routes/system'));

// Permissions Gate — AI가 permissions 먼저 읽어야 다른 API 접근 가능
// context.js의 /claude/* 라우트도 포함하여 전역 적용
const { createAiRoutes, createGateMiddleware } = require('./routes/ai-space');
app.use('/api', createGateMiddleware('claude'));
app.use('/api', createGateMiddleware('gemini'));

app.use('/api', contextModule.router);
app.use('/api', require('./routes/macro'));
// AI 공간 라우트 등록
app.use('/api', createAiRoutes('claude'));
app.use('/api', createAiRoutes('gemini'));
// Claude/Gemini 공통: permissions에서 API 지도 제공
app.use('/api', require('./routes/predictions'));
app.use('/api', require('./routes/data-viewer'));
app.use('/api', require('./routes/archive'));  // 아카이브 조회 (독립 모듈)

// ============================================================
// 프로세스 이벤트 처리 — server.close()로 포트 해제 (EADDRINUSE 방지)
// ============================================================
let server; // app.listen() 리턴값 — 종료 시 포트 해제용

process.on('SIGINT', async () => {
  console.log('[종료] 상태 저장 중...');
  gemini.saveServerState();
  hantoo.stop();
  if (server) server.close();
  process.exit();
});

process.on('SIGTERM', () => {
  console.log('[종료-TERM] 상태 저장 + 포트 해제 중...');
  gemini.saveServerState();
  if (server) server.close();
  process.exit(0);
});

process.on('SIGBREAK', () => {
  console.log('[종료-BREAK] 상태 저장 중...');
  gemini.saveServerState();
});

process.on('exit', () => {
  try { gemini.saveServerState(); } catch (e) { }
});

// ============================================================
// 주가 알림 콜백
// ============================================================
// 한투 주가 수집 시작 (안정화 수정 완료 — 배치 수집 + 장마감 크롤링)
hantoo.start();

hantoo.onPriceAlert((data) => {
  priceAlerts.unshift({
    ...data,
    id: Date.now(),
    timestamp: new Date().toISOString()
  });
  if (priceAlerts.length > 50) priceAlerts.length = 50;
  console.log(`[주가알림] ${data.name} ${data.change > 0 ? '+' : ''}${data.change}%`);
});

// ============================================================
// 1분 타이머 (메모리 감시, 쿨다운 감지, 아카이브)
// ============================================================
let last1701Reset = '';
let lastSentClean = '';
let memoryWarningCount = 0;

setInterval(() => {
  const { h, m } = gemini.getKSTHour();
  const today = new Date().toISOString().slice(0, 10);

  // 메모리 감시
  const memUsage = process.memoryUsage();
  const rssMB = Math.round(memUsage.rss / 1024 / 1024);

  if (rssMB > config.MEMORY_LIMIT_MB) {
    memoryWarningCount++;
    app.locals.memoryWarningCount = memoryWarningCount;
    console.warn(`[메모리] ⚠️ ${rssMB}MB 사용 (한도 ${config.MEMORY_LIMIT_MB}MB) — 경고 ${memoryWarningCount}/3`);
    if (memoryWarningCount >= 3) {
      console.error(`[메모리] 🔄 ${rssMB}MB — 한도 초과 3회 연속. 상태 저장 후 자동 재시작`);
      gemini.saveServerState();
      try { require('child_process').execSync('taskkill /f /im chrome.exe /fi "WINDOWTITLE eq about:blank" 2>nul'); } catch (e) { }
      process.exit(1);
    }
  } else {
    memoryWarningCount = 0;
    app.locals.memoryWarningCount = 0;
  }

  // 17:01 KST 프로 강제 리셋
  if (h === 17 && m >= 1 && m <= 3 && last1701Reset !== today) {
    last1701Reset = today;
    if (gemini.currentModelIndex > 0 || gemini.cooldownUntil > 0) {
      gemini.resetToPro('⏰ 17:01 KST 일일 리셋');
      if (!gemini.isAnalyzing) {
        triggerUnprocessedAnalysis('17:01 리셋');
      }
    }
  }

  // 매일 0:05 KST 전송이력 + 데이터 보존 규칙 정리
  if (h === 0 && m >= 5 && m <= 7 && lastSentClean !== today) {
    lastSentClean = today;
    cleanSentItems();
    cleanOldData();
    prediction.cleanOldEvaluated();  // ������ �� ������ ���� (500�� �ʰ� ��)
  }

  // 매일 02:00 KST 아카이브 사이클
  if (h === 2 && m >= 0 && m <= 2) {
    const watchlist = hantoo.getWatchlist();
    archive.runArchiveCycle(getCollectedDataForArchive, watchlist, companyData);
  }

  // 쿨다운 해제 감지
  if (gemini.cooldownUntil > 0 && Date.now() >= gemini.cooldownUntil) {
    gemini.resetToPro('⏰ 쿨다운 해제');
    if (!gemini.isAnalyzing) {
      triggerUnprocessedAnalysis('쿨다운 해제');
    }
  }

  // Claude Summary 자동 갱신 (메모리 읽기만 — 부담 0)
  contextModule.updateClaudeSummary(app);
}, 60000);

// 5분마다 상태 저장
setInterval(() => gemini.saveServerState(), 5 * 60000);

function triggerUnprocessedAnalysis(reason) {
  console.log(`[리포트AI] ${reason} → 미분석건 처리 시작`);
  analyzeUnprocessedReportsSafe().catch(e => console.error(`[리포트AI] 자동 분석 실패: ${e.message}`));
}

async function analyzeUnprocessedReportsSafe() {
  const allReports = [];
  Object.values(reportStores).forEach(items => allReports.push(...items));

  const unprocessed = allReports.filter(r => {
    const cacheKey = `${r.corp}|${r.title}|${r.date}`;
    return !reportAiCache[cacheKey];
  });

  if (unprocessed.length === 0) {
    console.log('[리포트AI] 미분석 건 없음');
    return;
  }

  const batch = unprocessed.slice(0, 30);
  console.log(`[리포트AI] 미분석 ${unprocessed.length}건 중 ${batch.length}건 ai-queue 추가`);
  for (const report of batch) {
    aiQueue.addReport(report, (result) => {
      const cacheKey = `${report.corp}|${report.title}|${report.date}`;
      reportAiCache[cacheKey] = result;
      report.aiResult = result;
      if (report.corp && companyData) {
        const code = findStockCode(report.corp);
        if (code) {
          companyData.addReport(code, { ...report, aiResult: result });
          companyData.addReportToLayer(code, { ...report, aiResult: result });
          if (result.summary) companyData.updateAiLayer(code, result.summary, result.cls);
        }
      }
      const { saveJSON } = require('./utils/file-io');
      saveJSON('report_ai_cache.json', reportAiCache);
    });
  }
}

// collectNewsAuto는 news-dc.js로 이동됨

// ============================================================
// 서버 시작
// ============================================================
server = app.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║   📊 DART 공시 모니터 서버 v3.5     ║');
  console.log(`  ║   🌐 http://localhost:${PORT}            ║`);
  console.log('  ║   ⏹  종료: Ctrl+C                   ║');
  console.log('  ╚══════════════════════════════════════╝');
  console.log('');
  console.log(`  📁 데이터 경로: ${DATA_DIR}`);
  console.log(`  📰 저장된 뉴스: news-dc 관리`);
  console.log(`  📊 리포트: WR:${reportStores.WiseReport.length} 미래에셋:${reportStores['미래에셋'].length} 하나:${reportStores['하나증권'].length} 네이버:${reportStores['네이버'].length}`);
  console.log(`  🤖 리포트AI 캐시: ${Object.keys(reportAiCache).length}건`);
  console.log(`  🤖 Gemini: ${gemini.GEMINI_MODELS[gemini.currentModelIndex]?.label} (${gemini.fallbackRound}회차)${gemini.isCooldownActive() ? ' [쿨다운중]' : ''}`);
  console.log(`  🌐 Puppeteer: ${puppeteer ? '✅ 로드됨' : '❌ 미설치'} | Chrome: ${CHROME_PATH || '❌ 미발견'}`);
  console.log('');
  console.log('  🔄 리포트 독립 수집 타이머 시작:');
  startReportTimers();

  // 아카이브 초기화
  try {
    archive.createDailySnapshot(getCollectedDataForArchive, hantoo.getWatchlist());
  } catch (e) {
    console.error(`[아카이브] 초기 스냅샷 실패: ${e.message}`);
  }
  console.log('  📦 아카이브 시스템 초기화 완료');

  // 워치리스트 종목 Context Tracker 자동 등록
  try {
    const watchlist = hantoo.getWatchlist();
    let autoAdded = 0;
    watchlist.forEach(s => {
      if (!s.code) return;
      if (!contextModule.loadStockContext(s.code)) {
        contextModule.saveStockContext(s.code, {
          code: s.code, name: s.name, pinned: false,
          price: null, change: null, lastDate: new Date().toISOString().slice(0, 10),
          context: '', nextAction: '',
          events: [], scenarios: [], keyInsights: [], history: []
        });
        autoAdded++;
      }
    });
    if (autoAdded > 0) console.log(`  🧠 Context Tracker: ${autoAdded}개 종목 자동 등록 (총 ${watchlist.length}개)`);
    else console.log(`  🧠 Context Tracker: ${watchlist.length}개 종목 등록 완료`);
  } catch (e) {
    console.error(`  ❌ Context 자동 등록 실패: ${e.message}`);
  }

  // DART 공시 전용 DC 시작 (수집 + 분류 + DC 관리)
  dartDC.init(app);

  // 리포트 전용 DC 시작
  reportsDC.init(app);

  // US 시장 전용 DC 시작
  usDC.init(app);

  // 뉴스 전용 DC 시작 (수집 + AI분류 + DC 관리)
  newsDC.init(app);

  // Claude 전용 DC 시작 (stocksDetail + archive + context 캐시)
  claudeDC.init(app);

  // 매크로 데이터 수집
  console.log('  🌍 매크로 데이터 수집 시작...');
  macro.fetchAllMacro().catch(e => console.error(`[매크로] 초기 수집 실패: ${e.message}`));
  setInterval(() => {
    macro.fetchAllMacro().catch(e => console.error(`[매크로] 수집 실패: ${e.message}`));
    const kstHour = new Date(Date.now() + 9 * 3600000).getUTCHours();
    const kstMin = new Date(Date.now() + 9 * 3600000).getUTCMinutes();
    if (kstHour === 6) {
      macro.verifyClosingPrices().catch(e => console.error(`[매크로] 종가 검증 실패: ${e.message}`));
      // KST 06:10 — 일별 히스토리 저장 (365일 FIFO)
      if (kstMin >= 10 && kstMin < 40) {
        macro.saveDailyHistory();
      }
    }
  }, 1800000);

  // 예측 피드백 루프
  console.log('  🎯 예측 피드백 루프 활성화');
  setInterval(() => {
    const kstHour = new Date(Date.now() + 9 * 3600000).getUTCHours();
    const kstMin = new Date(Date.now() + 9 * 3600000).getUTCMinutes();
    if (kstHour === 15 && kstMin >= 35 && kstMin <= 45) {
      const getPriceFn = (code) => {
        // ���簡 ��ȸ - companyData.getPrice()�� price.json���� �б�
        const priceData = companyData.getPrice(code);
        return priceData?.current?.price || null;
      };
      prediction.evaluateDuePredictions(getPriceFn);
    }
  }, 600000);

  console.log('');

  // 서버 시작 20초 후 미분석 리포트 처리
  setTimeout(() => {
    analyzeUnprocessedReportsSafe().catch(e => console.error(`[리포트AI] 초기 분석 실패: ${e.message}`));
  }, 20000);

  // 자동 백업 시작
  if (backupRoute.backupConfig.enabled) {
    backupRoute.startAutoBackup(() => app.locals);
  }
});
