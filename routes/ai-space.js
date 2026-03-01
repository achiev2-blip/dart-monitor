/**
 * AI 듀얼 공간 라우트 — 팩토리 패턴
 * 
 * 목적: Claude/Gemini 각 AI에 동일한 통로(라우트)를 제공
 * 데이터: 공유 (기존 data 디렉토리 그대로 사용)
 * 인증: 각 AI 전용 키 + 관리자 키 허용
 * 권한: 매 요청마다 permissions 체크 후 허용/차단
 * 
 * 의존: config.js, utils/permissions.js, utils/company-data.js, crawlers/hantoo.js, services/gemini.js
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const permissions = require('../utils/permissions');
const companyData = require('../utils/company-data');
const hantoo = require('../crawlers/hantoo');
const gemini = require('../services/gemini');

const DATA_DIR = config.DATA_DIR;
const CONTEXT_DIR = path.join(DATA_DIR, 'context');

// ============================================================
// Permissions Gate — AI 세션 추적 (permissions 먼저 읽기 강제)
// ============================================================
const GATE_SESSION_TTL = 60 * 60 * 1000; // 1시간 유효
const aiGateSessions = {};  // { 'apiKey': { readAt: timestamp, aiName: 'claude' } }

// 세션 상태 조회 헬퍼 (외부에서 확인용)
function getGateStatus() {
    const now = Date.now();
    const sessions = {};
    for (const [key, info] of Object.entries(aiGateSessions)) {
        const maskedKey = key.slice(0, 8) + '...';
        const elapsed = Math.round((now - info.readAt) / 60000);
        const remaining = Math.max(0, Math.round((info.readAt + GATE_SESSION_TTL - now) / 60000));
        sessions[maskedKey] = {
            ai: info.aiName,
            readAt: new Date(info.readAt).toISOString(),
            elapsed: `${elapsed}분 전`,
            remaining: remaining > 0 ? `${remaining}분 남음` : '만료됨',
            active: remaining > 0
        };
    }
    return { sessions, ttlMinutes: GATE_SESSION_TTL / 60000 };
}


// ============================================================
// AI 전용 인증 미들웨어 생성
// ============================================================
function createAiAuth(aiName) {
    // AI별 허용 키 결정
    const aiKeyMap = {
        claude: config.CLAUDE_API_KEY,
        gemini: config.GEMINI_API_KEY
    };
    const aiKey = aiKeyMap[aiName];

    return (req, res, next) => {
        // localhost는 허용 (개발 환경)
        const host = req.hostname || '';
        const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
        if (isLocal) {
            req.aiName = aiName;
            return next();
        }

        // 같은 사이트 브라우저 요청 허용 (뷰어 페이지)
        const referer = req.headers.referer || req.headers.origin || '';
        if (referer.includes(host)) {
            req.aiName = aiName;
            return next();
        }

        // API 키 검증
        const apiKey = req.headers['x-api-key'] || req.query.api_key;
        if (!apiKey) {
            return res.status(401).json({ ok: false, error: `${aiName} API 키 필요` });
        }

        // 관리자 키는 모든 AI 공간 접근 가능
        if (apiKey === config.INTERNAL_API_KEY) {
            req.aiName = aiName;
            req.isAdmin = true;
            return next();
        }

        // AI 전용 키 검증
        if (apiKey === aiKey) {
            req.aiName = aiName;
            return next();
        }

        return res.status(403).json({ ok: false, error: `${aiName} 공간 접근 거부` });
    };
}

// ============================================================
// 권한 체크 헬퍼 — 차단 시 로그만 남기고 무시
// ============================================================
function requirePermission(section, action) {
    return (req, res, next) => {
        const ai = req.aiName;
        if (permissions.checkPermission(ai, section, action)) {
            return next();
        }
        console.log(`[권한차단] ${ai} — ${section}.${action} OFF`);
        return res.status(403).json({
            ok: false,
            error: `권한 없음: ${section}.${action}`,
            ai,
            blocked: true
        });
    };
}

// ============================================================
// 컨텍스트 유틸 (독립 구현 — context.js에 의존하지 않음)
// ============================================================
function loadContextFile(file) {
    const fp = path.join(CONTEXT_DIR, file);
    try {
        if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf-8'));
    } catch (e) { }
    return null;
}

function saveContextFile(file, data) {
    if (!fs.existsSync(CONTEXT_DIR)) fs.mkdirSync(CONTEXT_DIR, { recursive: true });
    fs.writeFileSync(path.join(CONTEXT_DIR, file), JSON.stringify(data, null, 2), 'utf-8');
}

// 종목 컨텍스트 로드 — companies/{code}/context.json
function loadStockCtx(code) {
    const fp = path.join(DATA_DIR, 'companies', code, 'context.json');
    try {
        if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf-8'));
    } catch (e) { }
    return null;
}

// 종목 컨텍스트 저장
function saveStockCtx(code, data) {
    const dir = path.join(DATA_DIR, 'companies', code);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'context.json'), JSON.stringify(data, null, 2), 'utf-8');
}

// JSON 파일 안전 로드
function loadJSON(file, fallback) {
    const fp = path.join(DATA_DIR, file);
    try {
        if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf-8'));
    } catch (e) { }
    return fallback;
}

// ============================================================
// AI 라우트 팩토리 — claude/gemini 동일 구조 생성
// ============================================================
function createAiRoutes(aiName) {
    const router = express.Router();

    // 인증 미들웨어 적용
    router.use(createAiAuth(aiName));

    // ----------------------------------------------------------
    // Permissions Gate — permissions 먼저 안 읽으면 다른 API 차단
    // Nginx 리버스프록시 환경에서도 정확히 동작하도록
    // API 키를 보내는 요청(= 외부 AI)만 gate 대상으로 함
    // ----------------------------------------------------------
    router.use((req, res, next) => {
        // permissions 라우트 자체는 항상 통과
        if (req.path === `/${aiName}/permissions`) return next();

        // API 키가 없는 요청 = 브라우저/localhost → gate 제외
        // (createAiAuth에서 이미 인증 통과한 상태)
        const apiKey = req.headers['x-api-key'] || req.query.api_key || '';
        if (!apiKey) return next();

        // API 키가 있는 요청 = 외부 AI → 세션 체크
        const session = aiGateSessions[apiKey];
        const now = Date.now();

        if (!session || (now - session.readAt) > GATE_SESSION_TTL) {
            // 세션 없거나 만료 → 차단
            console.log(`[Gate:${aiName}] ⛔ 차단 — permissions 미확인. path=${req.path}`);
            return res.status(403).json({
                ok: false,
                error: `⚠️ 먼저 GET /api/${aiName}/permissions 를 호출하세요. 가이드를 읽어야 다른 API를 사용할 수 있습니다.`,
                gate: 'locked',
                action: `GET /api/${aiName}/permissions?api_key=YOUR_KEY`
            });
        }

        // 세션 유효 → 통과
        next();
    });

    // ----------------------------------------------------------
    // 권한 테이블 조회/변경
    // ----------------------------------------------------------

    // 권한 테이블 조회 — AI가 입장 시 먼저 읽는 API (전체 API 가이드 포함)
    // ⭐ 이 엔드포인트를 호출해야 gate가 해제됨
    router.get(`/${aiName}/permissions`, (req, res) => {
        // 세션 등록 — gate 해제
        const apiKey = req.headers['x-api-key'] || req.query.api_key || '';
        if (apiKey) {
            aiGateSessions[apiKey] = { readAt: Date.now(), aiName };
            console.log(`[Gate:${aiName}] ✅ 가이드 확인 완료 — gate 해제 (1시간 유효)`);
        }

        const data = permissions.loadPermissions(aiName);
        // API 가이드 — Claude가 입장 시 읽는 전체 지침 + API 지도
        const apiGuide = {
            _notice: '🚨 반드시 이 가이드를 읽고 아래 경로만 사용할 것.',
            _gate: '✅ 가이드를 읽었으므로 다른 API 접근이 1시간 동안 허용됩니다. 1시간 후 다시 이 엔드포인트를 호출해야 합니다.',
            access: '⚠️ web_fetch 차단됨. 반드시 bash curl 사용. 예: curl -s "http://34.22.94.45/api/claude/summary?api_key=dartmonitor-claude"',
            auth: '?api_key=dartmonitor-claude 또는 헤더 x-api-key: dartmonitor-claude',

            // ━━ 핵심 규칙 ━━
            rules: [
                '1) commands 배열 먼저 확인 → 미완료 명령 있으면 최우선 처리',
                '2) 종목 분석 시 consensus 있으면 참고, null이면 무시',
                '3) 데이터는 읽기만 가능 — 크롤러가 수집하므로 덮어쓰기 금지',
                '4) 502 에러 시 2~3회 재시도'
            ],

            // ━━ API 지도 (우선순위 순서) ━━
            step1_시작: {
                'GET /api/claude/permissions': '이 가이드 + 권한 확인 (가장 먼저 호출) ⭐ gate 해제됨',
                'GET /api/claude/commands': '미완료 사용자 명령 목록 → 있으면 우선 처리'
            },
            step2_데이터_읽기: {
                'GET /api/claude/summary': '전체 서머리 (뉴스+공시+리포트+주가+매크로 통합)',
                'GET /api/claude/summary?section=news': '뉴스만 (경량)',
                'GET /api/claude/summary?section=reports': '리포트만 (경량)',
                'GET /api/claude/summary?section=disclosures': '공시만 (경량)',
                'GET /api/claude/summary?section=prices': '종목 현재가만 (경량)',
                'GET /api/claude/summary?section=macro': '매크로 지표만 (경량)',
                'GET /api/claude/ctx': '시장 컨텍스트 + 종목 분석 이력 + commands'
            },
            step3_상세_조회: {
                'GET /api/news': 'DC 뉴스 전체 (오늘+100건)',
                'GET /api/news?company=기업명': '기업별 섹터 뉴스 (100일치)',
                'GET /api/news?code=종목코드': '종목 관련 뉴스 (relatedNews 포함)',
                'GET /api/reports': '리포트 전체 (DC 50건 이상, AI분석 포함)',
                'GET /api/consensus/:code': '종목별 컨센서스 (없으면 null)',
                'GET /api/stocks/company/:code/price': '종목 일별 차트 + 시간외 가격',
                'GET /api/claude/stocks/:code/analysis': '종목별 AI 분석 결과',
                'GET /api/claude/predictions': '예측 데이터',
                'GET /api/claude/overseas': '미국시장 지표'
            },
            step4_저장: {
                'POST /api/claude/ctx': { body: '{ market:{}, stocks:[{code,name,...}], insights:[], newsDigest:{} }', desc: '분석 결과 저장' },
                'POST /api/claude/predictions': { body: '{ predictions:[{code,name,...}] }', desc: '예측 저장 (종목코드+종목명 필수)' },
                'POST /api/claude/stocks/:code/memo': { body: '{ notes:"메모", tags:["태그"] }', desc: '종목별 메모 저장' },
                'POST /api/claude/stocks/:code/ai-analysis': { body: '{ summary:"요약", sentiment:"positive/negative/neutral" }', desc: '종목별 AI분석 저장' },
                'POST /api/claude/archive': { body: '{ type, data }', desc: '아카이브 저장' },
                'POST /api/claude/commands': { body: '{ text }', desc: '새 명령 추가' },
                'PATCH /api/claude/commands/:id': { body: '{ done:true, result }', desc: '명령 완료 처리' }
            },

            // ━━ 작업 흐름 ━━
            workflow: [
                '1. permissions → 이 가이드 읽기 (필수! gate 해제)',
                '2. commands → 미완료 명령 확인 (있으면 우선 처리)',
                '3. summary → 시장 전체 데이터 읽기 (또는 ?section= 개별)',
                '4. ctx → 컨텍스트 읽기',
                '5. 필요 시 step3 상세 조회',
                '6. 분석 완료 → POST ctx 로 결과 저장'
            ]
        };
        res.json({ ok: true, gateUnlocked: true, ttlMinutes: GATE_SESSION_TTL / 60000, apiGuide, ...data });
    });

    // 권한 테이블 변경 — 관리자 키만 가능
    router.post(`/${aiName}/permissions`, (req, res) => {
        const apiKey = req.headers['x-api-key'] || req.query.api_key;
        const host = req.hostname || '';
        const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
        // 관리자 키 또는 로컬호스트만 변경 가능
        if (!isLocal && apiKey !== config.INTERNAL_API_KEY) {
            return res.status(403).json({ ok: false, error: '관리자만 권한 변경 가능' });
        }
        const current = permissions.loadPermissions(aiName);
        const updates = req.body.permissions || req.body;
        // 기존 권한에 업데이트 병합
        if (updates && typeof updates === 'object') {
            for (const section of Object.keys(updates)) {
                if (current.permissions[section]) {
                    Object.assign(current.permissions[section], updates[section]);
                }
            }
        }
        permissions.savePermissions(aiName, current);
        res.json({ ok: true, ...current });
    });

    // ----------------------------------------------------------
    // CTX — 시장 컨텍스트 읽기/쓰기
    // ----------------------------------------------------------

    // 컨텍스트 읽기 (시장 + 종목 + 명령어)
    router.get(`/${aiName}/ctx`, requirePermission('ctx', 'read'), (req, res) => {
        const market = loadContextFile('market.json') || { note: '', keyInsights: [], history: [] };
        const commands = loadContextFile('commands.json') || [];
        // 종목 컨텍스트 요약 목록
        const companiesDir = path.join(DATA_DIR, 'companies');
        let stocks = [];
        try {
            if (fs.existsSync(companiesDir)) {
                stocks = fs.readdirSync(companiesDir)
                    .filter(code => fs.existsSync(path.join(companiesDir, code, 'context.json')))
                    .map(code => {
                        try {
                            const d = JSON.parse(fs.readFileSync(path.join(companiesDir, code, 'context.json'), 'utf-8'));
                            return { code: d.code || code, name: d.name, pinned: d.pinned, lastDate: d.lastDate, price: d.price, change: d.change };
                        } catch (e) { return null; }
                    }).filter(Boolean);
            }
        } catch (e) { }
        // lastReadAt 업데이트
        if (permissions.checkPermission(aiName, 'ctx', 'updateLastRead')) {
            const meta = loadContextFile(`lastRead_${aiName}.json`) || {};
            meta.lastReadAt = new Date().toISOString();
            saveContextFile(`lastRead_${aiName}.json`, meta);
        }
        console.log(`[AI:${aiName}] CTX 읽기 — 시장:${market.lastDate || '-'} 종목:${stocks.length}개`);
        res.json({ ok: true, ai: aiName, commands, market, stocks });
    });

    // 컨텍스트 쓰기/저장
    router.post(`/${aiName}/ctx`, requirePermission('ctx', 'write'), (req, res) => {
        const { market, stocks, newsDigest, insights } = req.body;
        const results = [];
        const canSave = permissions.checkPermission(aiName, 'ctx', 'save');

        // 시장 컨텍스트 업데이트
        if (market) {
            if (!canSave) {
                results.push('market write OK but save blocked');
            } else {
                const prev = loadContextFile('market.json') || {};
                const merged = { ...prev, ...market, keyInsights: market.keyInsights || prev.keyInsights || [] };
                if (prev.lastDate && market.lastDate && prev.lastDate !== market.lastDate) {
                    merged.history = merged.history || [];
                    merged.history.push({ date: prev.lastDate, note: `KOSPI:${prev.kospi || '-'} ${(prev.keyInsights || []).slice(0, 2).join('; ')}`, auto: true });
                    if (merged.history.length > 30) merged.history = merged.history.slice(-30);
                }
                saveContextFile('market.json', merged);
                results.push('market updated');
            }
        }

        // 종목별 컨텍스트 업데이트
        if (stocks && Array.isArray(stocks)) {
            stocks.forEach(s => {
                if (!s.code) return;
                if (!canSave) { results.push(`stock ${s.code} write OK but save blocked`); return; }
                const prev = loadStockCtx(s.code) || {};
                const merged = { ...prev, ...s, keyInsights: s.keyInsights || prev.keyInsights || [] };
                if (prev.lastDate && s.lastDate && prev.lastDate !== s.lastDate) {
                    merged.history = merged.history || [];
                    merged.history.push({ date: prev.lastDate, note: `가격:${prev.price || '-'} ${(prev.keyInsights || []).slice(0, 2).join('; ')}`, auto: true });
                    if (merged.history.length > 30) merged.history = merged.history.slice(-30);
                }
                saveStockCtx(s.code, merged);
                results.push(`stock ${s.code} updated`);
            });
        }

        // 뉴스 다이제스트
        if (newsDigest) {
            if (!canSave) { results.push('newsDigest write OK but save blocked'); }
            else {
                const digest = loadContextFile('news_digest.json') || { latest: null, history: [] };
                if (digest.latest) { digest.history.unshift(digest.latest); if (digest.history.length > 14) digest.history = digest.history.slice(0, 14); }
                digest.latest = { ...newsDigest, savedAt: new Date().toISOString() };
                saveContextFile('news_digest.json', digest);
                results.push('newsDigest updated');
            }
        }

        // 인사이트 추가
        if (insights && Array.isArray(insights)) {
            if (!canSave) { results.push('insights write OK but save blocked'); }
            else {
                const m = loadContextFile('market.json') || {};
                m.keyInsights = m.keyInsights || [];
                insights.forEach(i => { if (!m.keyInsights.includes(i)) m.keyInsights.push(i); });
                if (m.keyInsights.length > 10) m.keyInsights = m.keyInsights.slice(-10);
                saveContextFile('market.json', m);
                results.push(`${insights.length} insights added`);
            }
        }

        console.log(`[AI:${aiName}] CTX 쓰기 — ${results.join(', ')}`);
        res.json({ ok: true, ai: aiName, results });
    });

    // ----------------------------------------------------------
    // ARC — 아카이브 읽기/저장
    // ----------------------------------------------------------
    const ARCHIVE_DIR = path.join(CONTEXT_DIR, 'archive');
    const ARCHIVE_TYPES = ['daily', 'weekly', 'monthly', 'quarterly', 'yearly', 'events'];

    // 아카이브 읽기
    router.get(`/${aiName}/archive`, requirePermission('arc', 'read'), (req, res) => {
        const type = req.query.type;
        const result = {};
        const types = type && ARCHIVE_TYPES.includes(type) ? [type] : ARCHIVE_TYPES;
        types.forEach(t => {
            const dir = path.join(ARCHIVE_DIR, t);
            if (fs.existsSync(dir)) {
                result[t] = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().reverse().slice(0, 10).map(f => {
                    try { return { name: f, content: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) }; }
                    catch (e) { return null; }
                }).filter(Boolean);
            } else {
                result[t] = [];
            }
        });
        console.log(`[AI:${aiName}] ARC 읽기 — ${types.join(',')}`);
        res.json({ ok: true, ai: aiName, archive: result });
    });

    // 아카이브 저장
    router.post(`/${aiName}/archive`, (req, res) => {
        const { type, data } = req.body;
        if (!type || !ARCHIVE_TYPES.includes(type)) {
            return res.status(400).json({ ok: false, error: `허용 타입: ${ARCHIVE_TYPES.join(', ')}` });
        }
        // 타입별 권한 체크
        const permMap = { daily: 'daily_save', weekly: 'weekly_save', monthly: 'monthly_save', events: 'event_save' };
        const perm = permMap[type] || 'daily_save';
        if (!permissions.checkPermission(aiName, 'arc', perm)) {
            console.log(`[권한차단] ${aiName} — arc.${perm} OFF`);
            return res.status(403).json({ ok: false, error: `권한 없음: arc.${perm}`, blocked: true });
        }
        const dir = path.join(ARCHIVE_DIR, type);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const filename = req.body.filename || `${new Date().toISOString().slice(0, 10)}.json`;
        fs.writeFileSync(path.join(dir, filename), JSON.stringify(data, null, 2), 'utf-8');
        console.log(`[AI:${aiName}] ARC 저장 — ${type}/${filename}`);
        res.json({ ok: true, ai: aiName, type, filename });
    });

    // ----------------------------------------------------------
    // PRED — 예측 읽기/저장/평가
    // ----------------------------------------------------------

    // 예측 읽기
    router.get(`/${aiName}/predictions`, requirePermission('pred', 'read'), (req, res) => {
        const prediction = require('../utils/prediction');
        const code = req.query.code || null;
        const active = prediction.getActivePredictions(code);
        const stats = prediction.getStats();
        console.log(`[AI:${aiName}] PRED 읽기 — 활성:${active.length}건`);
        res.json({ ok: true, ai: aiName, predictions: active, stats });
    });

    // 예측 저장 — source를 AI 이름으로 강제 설정 (누가 만든 예측인지 자동 추적)
    router.post(`/${aiName}/predictions`, requirePermission('pred', 'save'), (req, res) => {
        const prediction = require('../utils/prediction');
        try {
            const body = { ...req.body, source: aiName };  // AI 이름 강제 주입
            const result = prediction.createPrediction(body);
            console.log(`[AI:${aiName}] PRED 저장 — ${result.name}(${result.code}) ${result.prediction.direction} ${result.prediction.timeframe}`);
            res.json({ ok: true, ai: aiName, prediction: result });
        } catch (e) {
            res.status(400).json({ ok: false, error: e.message });
        }
    });

    // 예측 평가 업데이트
    router.patch(`/${aiName}/predictions/:id`, requirePermission('pred', 'evaluate'), (req, res) => {
        // 예측 ID로 업데이트 (prediction 모듈에 위임)
        const prediction = require('../utils/prediction');
        try {
            // 현재가 조회 — companyData.getPrice()로 price.json에서 읽기 (독립 사용)
            const getPriceFn = (code) => {
                const priceData = companyData.getPrice(code);
                return priceData?.current?.price || null;
            };
            const result = prediction.evaluateDuePredictions(getPriceFn);
            console.log(`[AI:${aiName}] PRED 평가 — ${JSON.stringify(result)}`);
            res.json({ ok: true, ai: aiName, result });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // ----------------------------------------------------------
    // STOCK — 종목 분석 읽기/저장
    // ----------------------------------------------------------

    // 종목 분석 읽기
    router.get(`/${aiName}/stocks/:code/analysis`, requirePermission('stock', 'read'), (req, res) => {
        const { code } = req.params;
        const ctx = loadStockCtx(code);
        if (!ctx) return res.status(404).json({ ok: false, error: '종목 없음' });
        // 가격 데이터도 같이 제공
        let priceData = null;
        try {
            priceData = companyData.getPrice(code);
        } catch (e) { }
        console.log(`[AI:${aiName}] STOCK 읽기 — ${code}`);
        res.json({ ok: true, ai: aiName, code, context: ctx, price: priceData });
    });

    // 종목 분석 저장
    router.post(`/${aiName}/stocks/:code/analysis`, requirePermission('stock', 'save'), (req, res) => {
        const { code } = req.params;
        const prev = loadStockCtx(code) || {};
        const merged = { ...prev, ...req.body };
        // 히스토리 관리
        if (prev.lastDate && req.body.lastDate && prev.lastDate !== req.body.lastDate) {
            merged.history = merged.history || [];
            merged.history.push({
                date: prev.lastDate,
                note: `가격:${prev.price || '-'} ${(prev.keyInsights || []).slice(0, 2).join('; ')}`,
                auto: true
            });
            if (merged.history.length > 30) merged.history = merged.history.slice(-30);
        }
        saveStockCtx(code, merged);
        console.log(`[AI:${aiName}] STOCK 저장 — ${code}`);
        res.json({ ok: true, ai: aiName, code });
    });

    // ----------------------------------------------------------
    // ANALYZE — AI 실시간 종목 분석 (데이터 수집 → Gemini 호출 → 결과 저장)
    // ----------------------------------------------------------

    // 종목 분석 트리거 — 서버 내부 데이터를 수집한 후 Gemini에 분석 요청
    router.post(`/${aiName}/analyze/:code`, requirePermission('stock', 'analyze'), async (req, res) => {
        const { code } = req.params;

        try {
            // ── 1단계: 서버 내부 데이터 수집 ──
            const collected = {};

            // 가격 데이터 (company-data 독립 사용)
            try {
                collected.price = companyData.getPrice(code);
            } catch (e) { collected.price = null; }

            // 워치리스트에서 종목 기본정보 (hantoo 독립 사용)
            try {
                const watchlist = hantoo.getWatchlist();
                const stock = watchlist.find(s => s.code === code);
                collected.stock = stock || null;
            } catch (e) { collected.stock = null; }

            // 컨센서스 (consensus 데이터)
            try {
                const consFp = path.join(DATA_DIR, 'consensus', `${code}.json`);
                if (fs.existsSync(consFp)) {
                    collected.consensus = JSON.parse(fs.readFileSync(consFp, 'utf-8'));
                }
            } catch (e) { collected.consensus = null; }

            // 기존 종목 컨텍스트 (이전 분석 결과)
            collected.prevContext = loadStockCtx(code);

            // 종목명 결정
            const stockName = collected.stock?.name
                || collected.prevContext?.name
                || collected.price?.current?.name
                || code;

            // ── 2단계: 분석 프롬프트 조립 ──
            const priceInfo = collected.price?.current || {};
            const consInfo = collected.consensus || {};

            const prompt = `한국 주식 종목 분석 요청. 반드시 JSON으로만 응답하세요.

종목: ${stockName} (${code})
현재가: ${priceInfo.price || '정보없음'}원
등락률: ${priceInfo.changePercent || priceInfo.changePct || '?'}%
거래량: ${priceInfo.volume || '?'}

컨센서스:
- 투자의견: ${consInfo.opinion || '?'}
- 목표주가: ${consInfo.targetPrice || '?'}원
- 추정 PER: ${consInfo.estPER || '?'}

이전 AI 분석: ${collected.prevContext?.aiSummary || '없음'}

다음 JSON 형식으로만 응답:
{
  "direction": "up 또는 down 또는 flat",
  "confidence": "high 또는 medium 또는 low",
  "reasoning": "2줄 이내 한국어 요약",
  "headline": "10자 이내 핵심 요약",
  "cls": "positive 또는 negative 또는 neutral",
  "targetPrice": 숫자(원)
}`;

            // ── 3단계: Gemini 호출 ──
            const rawText = await gemini.callGeminiDirect(prompt, 'stock');

            if (!rawText) {
                return res.status(503).json({
                    ok: false,
                    error: 'Gemini 응답 없음 (쿨다운 또는 모델 오류)',
                    ai: aiName
                });
            }

            // JSON 파싱 (Gemini 응답에서 JSON 추출)
            let analysis;
            try {
                const jsonMatch = rawText.match(/\{[\s\S]*\}/);
                analysis = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
            } catch (e) {
                analysis = null;
            }

            if (!analysis || !analysis.direction) {
                return res.status(500).json({
                    ok: false,
                    error: 'Gemini 응답 파싱 실패',
                    rawText,
                    ai: aiName
                });
            }

            // ── 4단계: 결과 저장 ──

            // (A) stock context 업데이트 — UI에 바로 반영
            const prevCtx = collected.prevContext || {};
            const updatedCtx = {
                ...prevCtx,
                name: stockName,
                lastDate: new Date().toISOString().slice(0, 10),
                aiSummary: analysis.reasoning,
                aiHeadline: analysis.headline,
                aiCls: analysis.cls,
                aiDirection: analysis.direction,
                aiConfidence: analysis.confidence,
                aiAnalyzedAt: new Date().toISOString(),
                aiAnalyzedBy: aiName,
                price: priceInfo.price || prevCtx.price
            };
            saveStockCtx(code, updatedCtx);

            // (B) prediction 자동 생성 — 예측 정확도 추적
            let predResult = null;
            try {
                const prediction = require('../utils/prediction');
                predResult = prediction.createPrediction({
                    code,
                    name: stockName,
                    source: aiName,
                    direction: analysis.direction,
                    targetPrice: analysis.targetPrice || null,
                    priceAtPrediction: priceInfo.price || null,
                    confidence: analysis.confidence || 'medium',
                    reasoning: analysis.reasoning || '',
                    timeframe: req.body.timeframe || '1d'
                });
            } catch (e) {
                console.error(`[AI:${aiName}] PRED 자동생성 실패: ${e.message}`);
            }

            console.log(`[AI:${aiName}] ANALYZE 완료 — ${stockName}(${code}) → ${analysis.direction} (${analysis.confidence})`);

            res.json({
                ok: true,
                ai: aiName,
                code,
                name: stockName,
                analysis,
                prediction: predResult ? { id: predResult.id, direction: predResult.prediction.direction } : null,
                dataUsed: {
                    hasPrice: !!collected.price,
                    hasConsensus: !!collected.consensus,
                    hasPrevContext: !!collected.prevContext
                }
            });

        } catch (e) {
            console.error(`[AI:${aiName}] ANALYZE 오류 — ${code}: ${e.message}`);
            res.status(500).json({ ok: false, error: e.message, ai: aiName });
        }
    });

    // ----------------------------------------------------------
    // MEMO — 종목별 메모 쓰기 (layers.json 메모 레이어)
    // ----------------------------------------------------------

    // 종목별 메모 저장 — AI가 분석 메모를 기업 레이어에 기록
    router.post(`/${aiName}/stocks/:code/memo`, requirePermission('stock', 'write'), (req, res) => {
        const { code } = req.params;
        const { notes, tags } = req.body;

        // 필수값 검증
        if (!notes && (!tags || tags.length === 0)) {
            return res.status(400).json({ ok: false, error: 'notes 또는 tags 필수', ai: aiName });
        }

        try {
            if (!companyData.companyExists(code)) {
                return res.status(404).json({ ok: false, error: `종목 ${code} 데이터 없음`, ai: aiName });
            }

            // 메모 레이어 업데이트
            companyData.updateLayer(code, '메모', {
                notes: notes || '',
                tags: tags || [],
                updatedAt: new Date().toISOString(),
                updatedBy: aiName
            });

            console.log(`[AI:${aiName}] MEMO 저장 — ${code}`);
            res.json({ ok: true, ai: aiName, code, saved: '메모' });
        } catch (e) {
            console.error(`[AI:${aiName}] MEMO 저장 실패 — ${code}: ${e.message}`);
            res.status(500).json({ ok: false, error: e.message, ai: aiName });
        }
    });

    // ----------------------------------------------------------
    // AI-ANALYSIS — 종목별 AI분석 쓰기 (layers.json AI분석 레이어)
    // ----------------------------------------------------------

    // AI분석 결과 저장 — AI가 종합 분석 결과를 기업 레이어에 기록
    router.post(`/${aiName}/stocks/:code/ai-analysis`, requirePermission('stock', 'write'), (req, res) => {
        const { code } = req.params;
        const { summary, sentiment } = req.body;

        // 필수값 검증
        if (!summary) {
            return res.status(400).json({ ok: false, error: 'summary 필수', ai: aiName });
        }

        // sentiment 유효성 검증
        const validSentiments = ['positive', 'negative', 'neutral', ''];
        if (sentiment && !validSentiments.includes(sentiment)) {
            return res.status(400).json({ ok: false, error: `sentiment는 ${validSentiments.join('/')} 중 하나`, ai: aiName });
        }

        try {
            if (!companyData.companyExists(code)) {
                return res.status(404).json({ ok: false, error: `종목 ${code} 데이터 없음`, ai: aiName });
            }

            // AI분석 레이어 업데이트
            companyData.updateAiLayer(code, summary, sentiment || '');

            console.log(`[AI:${aiName}] AI-ANALYSIS 저장 — ${code} (${sentiment || 'no-sentiment'})`);
            res.json({ ok: true, ai: aiName, code, saved: 'AI분석' });
        } catch (e) {
            console.error(`[AI:${aiName}] AI-ANALYSIS 저장 실패 — ${code}: ${e.message}`);
            res.status(500).json({ ok: false, error: e.message, ai: aiName });
        }
    });

    // ----------------------------------------------------------
    // CHAT — Gemini 채팅 (쿨다운 무시, 직접 API 호출)
    // ----------------------------------------------------------

    // 채팅 메시지 전송 — 웹 UI에서 Gemini와 대화
    router.post(`/${aiName}/chat`, requirePermission('ctx', 'read'), async (req, res) => {
        const { message, context, history } = req.body;

        // 필수값 검증
        if (!message || !message.trim()) {
            return res.status(400).json({ ok: false, error: '메시지 필수', ai: aiName });
        }

        try {
            const axios = require('axios');

            // ── 서버 데이터 수집 (Gemini에 맥락 제공) ──
            let serverContext = '';

            // ── KEY1 챗봇: 질문 기반 스마트 데이터 검색 ──

            // 사용자 질문에서 기업명/키워드 추출 (가격/MA 로드 전에 먼저 실행)
            const userMsg = message || '';
            let watchNames = [];
            try {
                const h = req.app.locals.hantoo;
                if (h) watchNames = h.getWatchlist().map(s => s.name);
            } catch (e) { }

            // 1) 워치리스트 종목명 매칭
            const watchMatches = watchNames.filter(name => userMsg.includes(name));

            // 2) 사용자 메시지에서 한글 키워드 추출 (워치리스트에 없는 기업도 검색)
            const koreanWords = userMsg.match(/[가-힣]{2,}/g) || [];
            const stopWords = ['관련', '뉴스', '공시', '리포트', '알려줘', '분석', '최신', '오늘', '어제', '상황', '정보', '종목', '주가', '전망', '매수', '매도', '질문', '해줘', '보여줘', '검색', '이동평균선', '이동평균', '기술적', '외국인', '지지선', '저항선'];
            const userKeywords = koreanWords.filter(w => !stopWords.includes(w) && !watchMatches.includes(w));

            // 워치리스트 매칭 + 사용자 키워드 합산
            const mentionedCompanies = [...new Set([...watchMatches, ...userKeywords])];

            // [제거됨] 한투 데이터(지수/투자자/종목) — DC에서 읽던 코드 삭제
            // 추후 CTX 위치리스트에서 가져오도록 재구현 예정

            // 특정 종목 컨텍스트 (context 파라미터로 종목코드 전달 시)
            if (context && context.code) {
                try {
                    const stockCtx = loadStockCtx(context.code);
                    if (stockCtx) {
                        serverContext += `\n[현재 보고 있는 종목: ${stockCtx.name || context.code}]\n`;
                        serverContext += `AI분석: ${stockCtx.aiSummary || '없음'}\n`;
                        serverContext += `방향: ${stockCtx.aiDirection || '?'} 신뢰도: ${stockCtx.aiConfidence || '?'}\n`;
                    }
                    const priceData = companyData.getPrice(context.code);
                    if (priceData?.current) {
                        serverContext += `현재가: ${priceData.current.price}원 등락: ${priceData.current.changePercent || priceData.current.changePct || '?'}%\n`;
                    }
                } catch (e) { }
            }

            // 시장 컨텍스트
            try {
                const market = loadContextFile('market.json');
                if (market) {
                    serverContext += `\n[시장 상황]\nKOSPI: ${market.kospi || '?'} 날짜: ${market.lastDate || '?'}\n`;
                    if (market.keyInsights?.length) {
                        serverContext += `핵심: ${market.keyInsights.slice(0, 3).join(', ')}\n`;
                    }
                }
            } catch (e) { }

            // [제거됨] 공시/뉴스/매크로/리포트 — DC에서 읽던 코드 삭제
            // 추후 CTX 위치리스트에서 가져오도록 재구현 예정

            // ── 프롬프트 조립 ──
            const systemPrompt = `너는 한국 주식시장 전문 AI 어시스턴트 "${aiName}"이다.
DART 모니터 서버에 연결되어 있으며, 아래 실시간 데이터에 대한 전체 접근 권한이 있다.
제공된 데이터(DART 공시, 뉴스, 매크로 지표, 리포트)를 기반으로 분석하고 답변한다.
데이터가 있으면 "접근 권한 없음"이라고 하지 말고, 데이터를 활용해서 답변한다.
항상 한국어로 답하고, 간결하게 핵심만 전달한다.
${serverContext}`;

            // 대화 히스토리 구성
            const contents = [];

            // 시스템 프롬프트를 첫 번째 사용자 메시지로 주입
            contents.push({ role: 'user', parts: [{ text: systemPrompt }] });
            contents.push({ role: 'model', parts: [{ text: '네, 한국 주식시장 AI 어시스턴트입니다. 실시간 데이터를 참고해서 답변하겠습니다.' }] });

            // 이전 대화 히스토리 추가 (최대 10턴)
            if (history && Array.isArray(history)) {
                const recentHistory = history.slice(-10);
                for (const h of recentHistory) {
                    contents.push({ role: 'user', parts: [{ text: h.user }] });
                    if (h.ai) {
                        contents.push({ role: 'model', parts: [{ text: h.ai }] });
                    }
                }
            }

            // 현재 메시지
            contents.push({ role: 'user', parts: [{ text: message }] });

            // ── Gemini API 직접 호출 (쿨다운 무시) ──
            const GEMINI_KEY = config.GEMINI_KEY_CHAT || config.GEMINI_KEY;
            const model = 'gemini-2.5-flash';
            const url = `${config.GEMINI_BASE}${model}:generateContent?key=${GEMINI_KEY}`;

            const resp = await axios.post(url, {
                contents,
                generationConfig: { temperature: 0.7, maxOutputTokens: 4000 }
            }, { timeout: 30000, headers: { 'Content-Type': 'application/json' } });

            const reply = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text;

            if (!reply) {
                return res.status(503).json({ ok: false, error: 'Gemini 응답 없음', ai: aiName });
            }

            console.log(`[AI:${aiName}] CHAT — "${message.substring(0, 30)}..." → ${reply.length}자`);
            res.json({ ok: true, ai: aiName, reply });

        } catch (e) {
            console.error(`[AI:${aiName}] CHAT 오류: ${e.message}`);
            const status = e.response?.status || 500;
            res.status(status).json({ ok: false, error: e.message, ai: aiName });
        }
    });

    // ----------------------------------------------------------
    // TOKEN — 한투 토큰 (공유 읽기 전용, 항상 ON)
    // ----------------------------------------------------------

    // 한투 토큰 조회 — 항상 허용 (locked: true)
    router.get(`/${aiName}/token`, (req, res) => {
        const tokenData = loadJSON('hantoo_token.json', null);
        console.log(`[AI:${aiName}] TOKEN 읽기`);
        res.json({ ok: true, ai: aiName, token: tokenData });
    });

    // 한투 토큰 저장 금지 — 토큰 발급/갱신은 hantoo 크롤러가 전담
    // AI는 GET /token으로 읽기만 가능

    // ----------------------------------------------------------
    // NEWS — 뉴스 읽기 (서버 메모리의 storedNews 접근)
    // ----------------------------------------------------------
    router.get(`/${aiName}/news`, requirePermission('ctx', 'read'), (req, res) => {
        const storedNews = req.app.locals.storedNews || [];
        const limit = parseInt(req.query.limit) || 30;
        // 최근 뉴스를 역순(최신 먼저)으로
        const recent = storedNews.slice(-limit).reverse().map(n => ({
            title: n.title,
            source: n.source,
            date: n.date,
            link: n.link,
            cls: n.aiCls || '',
            importance: n.aiImportance || '',
            category: n.aiCategory || '',
            stocks: n.aiStocks || '',
            summary: n.aiSummary || ''
        }));
        // 뉴스 다이제스트도 같이 제공
        const digest = loadContextFile('news_digest.json') || { latest: null };
        console.log(`[AI:${aiName}] NEWS 읽기 — ${recent.length}건`);
        res.json({ ok: true, ai: aiName, news: recent, digest: digest.latest, total: storedNews.length });
    });

    // ----------------------------------------------------------
    // REPORTS — 리포트 읽기 (서버 메모리의 reportStores 접근)
    // ----------------------------------------------------------
    router.get(`/${aiName}/reports`, requirePermission('ctx', 'read'), (req, res) => {
        const reportStores = req.app.locals.reportStores || {};
        const limit = parseInt(req.query.limit) || 30;
        // 모든 소스의 리포트를 모아서 날짜순 정렬
        const allReports = [];
        Object.values(reportStores).forEach(items => allReports.push(...items));
        const sorted = allReports
            .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
            .slice(0, limit)
            .map(r => ({
                title: r.title,
                source: r.source || r.broker || '',
                date: r.date,
                opinion: r.opinion || '',
                targetPrice: r.targetPrice || '',
                link: r.link || ''
            }));
        console.log(`[AI:${aiName}] REPORTS 읽기 — ${sorted.length}건`);
        res.json({ ok: true, ai: aiName, reports: sorted, total: allReports.length });
    });

    // ----------------------------------------------------------
    // PRICES — 실시간 주가 (watchlist 전체, 한투 크롤러 메모리)
    // ----------------------------------------------------------
    router.get(`/${aiName}/prices`, requirePermission('stock', 'read'), (req, res) => {
        if (!hantoo) return res.json({ ok: true, ai: aiName, prices: [] });
        const watchlist = hantoo.getWatchlist();
        const stockPrices = hantoo.getStockPrices();

        const prices = watchlist.map(s => {
            const p = stockPrices[s.code];
            let afterHours = null;
            try { afterHours = companyData?.getPrice(s.code)?.afterHours || p?.afterHours || null; } catch (e) { }
            return {
                code: s.code,
                name: s.name,
                sector: s.sector || '',
                price: p?.current?.price || p?.price || s.price || null,
                change: p?.current?.change || p?.change || null,
                changePct: p?.changePct || null,
                volume: p?.current?.volume || p?.volume || null,
                high: p?.current?.high || null,
                low: p?.current?.low || null,
                open: p?.current?.open || null,
                afterHours
            };
        });
        console.log(`[AI:${aiName}] PRICES 읽기 — ${prices.length}종목`);
        res.json({ ok: true, ai: aiName, prices, count: prices.length });
    });

    // [삭제됨] /claude/dart — DC 서머리에 공시 포함되어 중복 제거

    // ----------------------------------------------------------
    // MACRO — 매크로 경제 데이터 읽기
    // ----------------------------------------------------------
    router.get(`/${aiName}/macro`, requirePermission('ctx', 'read'), (req, res) => {
        const macro = req.app.locals.macro;
        const overseas = loadJSON('overseas.json', { latest: null });
        const result = {
            current: macro?.getCurrent() || null,
            impact: macro?.getMarketImpactSummary() || null,
            overseas: overseas.latest
        };
        console.log(`[AI:${aiName}] MACRO 읽기`);
        res.json({ ok: true, ai: aiName, macro: result });
    });

    // ----------------------------------------------------------
    // OVERSEAS — 해외 시장 데이터 읽기
    // ----------------------------------------------------------
    router.get(`/${aiName}/overseas`, requirePermission('ctx', 'read'), (req, res) => {
        const overseas = loadJSON('overseas.json', { latest: null, history: [] });
        console.log(`[AI:${aiName}] OVERSEAS 읽기`);
        res.json({ ok: true, ai: aiName, overseas: overseas.latest, history: (overseas.history || []).slice(0, 5) });
    });

    // ----------------------------------------------------------
    // COMMANDS — 명령어 읽기/추가/완료
    // ----------------------------------------------------------

    // 명령어 목록 읽기
    router.get(`/${aiName}/commands`, requirePermission('ctx', 'read'), (req, res) => {
        const commands = loadContextFile('commands.json') || [];
        const pending = commands.filter(c => !c.done);
        console.log(`[AI:${aiName}] COMMANDS 읽기 — 전체:${commands.length} 미완료:${pending.length}`);
        res.json({ ok: true, ai: aiName, commands, pending });
    });

    // 명령어 추가
    router.post(`/${aiName}/commands`, requirePermission('ctx', 'write'), (req, res) => {
        const commands = loadContextFile('commands.json') || [];
        const { text, priority } = req.body;
        if (!text) return res.status(400).json({ ok: false, error: '명령어 텍스트 필요' });
        const newCmd = {
            id: Date.now().toString(),
            text,
            priority: priority || 'normal',
            createdAt: new Date().toISOString(),
            createdBy: aiName,
            done: false
        };
        commands.push(newCmd);
        saveContextFile('commands.json', commands);
        console.log(`[AI:${aiName}] COMMANDS 추가 — "${text}"`);
        res.json({ ok: true, ai: aiName, command: newCmd });
    });

    // 명령어 완료 처리
    router.patch(`/${aiName}/commands/:id`, requirePermission('ctx', 'write'), (req, res) => {
        const commands = loadContextFile('commands.json') || [];
        const cmd = commands.find(c => c.id === req.params.id);
        if (!cmd) return res.status(404).json({ ok: false, error: '명령어 없음' });
        cmd.done = true;
        cmd.doneAt = new Date().toISOString();
        cmd.doneBy = aiName;
        if (req.body.result) cmd.result = req.body.result;
        saveContextFile('commands.json', commands);
        console.log(`[AI:${aiName}] COMMANDS 완료 — "${cmd.text}"`);
        res.json({ ok: true, ai: aiName, command: cmd });
    });

    return router;
}

module.exports = { createAiRoutes, getGateStatus };
