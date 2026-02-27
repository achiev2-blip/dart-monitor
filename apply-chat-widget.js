/**
 * Gemini Chat 위젯 패치 스크립트 — VM에서 실행
 * 
 * 사용법: cd ~/dart-monitor && node apply-chat-widget.js
 * 
 * 변경 사항 (VM server.js/ai-space.js 기준 최소 패치):
 * 1) server.js — /gemini 인증 bypass 추가 (gemini만, claude 독립)
 * 2) server.js — createAiRoutes('gemini') 등록
 * 3) ai-space.js — chat 라우트 추가 (독립적, 공유 의존 없음)
 * 4) HTML 3개 — gemini-chat 위젯 참조 추가
 */
const fs = require('fs');
const path = require('path');

const BASE = __dirname;
const PUBLIC = path.join(BASE, 'public');
const errors = [];

// 한국어 로그
function log(msg) { console.log(`[패치] ${msg}`); }

// 백업 후 저장
function safeWrite(filePath, content) {
    const bak = filePath + '.bak-' + Date.now();
    if (fs.existsSync(filePath)) {
        fs.copyFileSync(filePath, bak);
        log(`  백업: ${path.basename(bak)}`);
    }
    fs.writeFileSync(filePath, content, 'utf-8');
}

// ============================================================
// 1. server.js 패치 — gemini 인증 bypass + createAiRoutes 등록
// ============================================================
function patchServerJs() {
    log('=== 1. server.js 패치 ===');
    const fp = path.join(BASE, 'server.js');
    let src = fs.readFileSync(fp, 'utf-8');

    // (A) /gemini 인증 bypass — gemini만 독립 (claude 안 건드림)
    const authMarker = "app.use('/api', (req, res, next) => {";
    if (src.includes("req.path.startsWith('/gemini')")) {
        log('  (A) gemini 인증 bypass: 이미 존재 → 스킵');
    } else if (src.includes(authMarker)) {
        // auth 미들웨어 바로 다음 줄에 gemini bypass 삽입
        const bypass = "\n  // Gemini AI 공간 전용 인증 bypass — gemini 독립 터널\n  if (req.path.startsWith('/gemini')) return next();\n";
        src = src.replace(authMarker, authMarker + bypass);
        log('  (A) gemini 인증 bypass: 추가 완료');
    } else {
        errors.push('server.js: 인증 미들웨어 위치 못 찾음');
        log('  ❌ (A) 인증 미들웨어 마커 못 찾음');
    }

    // (B) createAiRoutes('gemini') 등록 — archive 라우트 다음에
    if (src.includes('createAiRoutes')) {
        log('  (B) createAiRoutes: 이미 등록됨 → 스킵');
    } else {
        const archivePattern = /app\.use\('\/api', require\('\.\/routes\/archive'\)\).*\n/;
        const match = src.match(archivePattern);
        if (match) {
            const registration = `
// Gemini AI 듀얼 공간 라우트 등록 — 팩토리 패턴
const { createAiRoutes } = require('./routes/ai-space');
app.use('/api', createAiRoutes('gemini'));   // → /api/gemini/* (채팅, 컨텍스트, 분석 등)
`;
            src = src.replace(match[0], match[0] + registration);
            log('  (B) createAiRoutes 등록: 추가 완료');
        } else {
            errors.push('server.js: archive 라우트 라인 못 찾음');
            log('  ❌ (B) archive 라우트 패턴 못 찾음');
        }
    }

    safeWrite(fp, src);
    log('  server.js 저장 완료\n');
}

// ============================================================
// 2. ai-space.js 패치 — chat 라우트 추가 (독립적, 공유 의존 없음)
// ============================================================
function patchAiSpace() {
    log('=== 2. ai-space.js 패치 ===');
    const fp = path.join(BASE, 'routes', 'ai-space.js');
    let src = fs.readFileSync(fp, 'utf-8');

    // 중복 확인
    if (src.includes("'/chat'") || src.includes('/chat`')) {
        log('  chat 라우트: 이미 존재 → 스킵');
        return;
    }

    // chat 라우트 블록 — 독립적으로 config/axios를 require (공유 헬퍼 의존 없음)
    const chatBlock = `
    // ----------------------------------------------------------
    // CHAT — Gemini 채팅 (쿨다운 무시, 직접 API 호출)
    // 독립 모듈: config, axios를 자체 require. 공유 헬퍼 미사용.
    // ----------------------------------------------------------
    router.post(\`/\${aiName}/chat\`, requirePermission('ctx', 'read'), async (req, res) => {
        const { message, context, history } = req.body;

        // 필수값 검증
        if (!message || !message.trim()) {
            return res.status(400).json({ ok: false, error: '메시지 필수', ai: aiName });
        }

        try {
            // 독립 require — 이 라우트만의 의존성
            const axios = require('axios');
            const config = require('../config');

            // ── 서버 데이터 수집 (Gemini에 맥락 제공, 읽기 전용) ──
            let serverContext = '';

            // 워치리스트 가격 요약 (읽기 전용)
            try {
                const hantoo = req.app.locals.hantoo;
                if (hantoo) {
                    const watchlist = hantoo.getWatchlist();
                    const prices = hantoo.getStockPrices();
                    const priceList = watchlist.slice(0, 20).map(s => {
                        const p = prices[s.code];
                        return \`\${s.name}(\${s.code}): \${p?.current?.price || p?.price || '?'}원 \${p?.current?.change || p?.change || ''}%\`;
                    }).join('\\n');
                    serverContext += \`\\n[현재 워치리스트 주가 (상위 20)]\\n\${priceList}\\n\`;
                }
            } catch (e) { /* 워치리스트 없으면 무시 */ }

            // 시장 컨텍스트 (파일 직접 읽기, 독립적)
            try {
                const marketPath = require('path').join(__dirname, '..', 'data', 'context', 'market.json');
                if (require('fs').existsSync(marketPath)) {
                    const market = JSON.parse(require('fs').readFileSync(marketPath, 'utf-8'));
                    serverContext += \`\\n[시장 상황]\\nKOSPI: \${market.kospi || '?'} 날짜: \${market.lastDate || '?'}\\n\`;
                    if (market.keyInsights?.length) {
                        serverContext += \`핵심: \${market.keyInsights.slice(0, 3).join(', ')}\\n\`;
                    }
                }
            } catch (e) { /* 시장 데이터 없으면 무시 */ }

            // ── 프롬프트 조립 ──
            const systemPrompt = \`너는 한국 주식시장 전문 AI 어시스턴트 "\${aiName}"이다.
DART 모니터 서버에 연결되어 있으며, 아래 실시간 데이터를 참고해서 대화한다.
항상 한국어로 답하고, 간결하게 핵심만 전달한다.
\${serverContext}\`;

            // 대화 히스토리 구성
            const contents = [];
            contents.push({ role: 'user', parts: [{ text: systemPrompt }] });
            contents.push({ role: 'model', parts: [{ text: '네, 한국 주식시장 AI 어시스턴트입니다. 실시간 데이터를 참고해서 답변하겠습니다.' }] });

            // 이전 대화 히스토리 (최대 10턴)
            if (history && Array.isArray(history)) {
                for (const h of history.slice(-10)) {
                    contents.push({ role: 'user', parts: [{ text: h.user }] });
                    if (h.ai) contents.push({ role: 'model', parts: [{ text: h.ai }] });
                }
            }

            // 현재 메시지
            contents.push({ role: 'user', parts: [{ text: message }] });

            // ── Gemini API 직접 호출 (쿨다운 무시, 독립 키 사용) ──
            const CHAT_KEY = config.GEMINI_KEY_CHAT || config.GEMINI_KEY;
            const GEMINI_BASE = config.GEMINI_BASE || 'https://generativelanguage.googleapis.com/v1beta/models/';
            const chatModel = 'gemini-2.5-flash';
            const apiUrl = \`\${GEMINI_BASE}\${chatModel}:generateContent?key=\${CHAT_KEY}\`;

            const resp = await axios.post(apiUrl, {
                contents,
                generationConfig: { temperature: 0.7, maxOutputTokens: 1000 }
            }, { timeout: 30000, headers: { 'Content-Type': 'application/json' } });

            const reply = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!reply) {
                return res.status(503).json({ ok: false, error: 'Gemini 응답 없음', ai: aiName });
            }

            console.log(\`[AI:\${aiName}] CHAT — "\${message.substring(0, 30)}..." → \${reply.length}자\`);
            res.json({ ok: true, ai: aiName, reply });

        } catch (e) {
            console.error(\`[AI:\${aiName}] CHAT 오류: \${e.message}\`);
            res.status(e.response?.status || 500).json({ ok: false, error: e.message, ai: aiName });
        }
    });

`;

    // "return router;" 앞에 삽입
    const marker = 'return router;';
    if (src.includes(marker)) {
        src = src.replace(marker, chatBlock + '    ' + marker);
        log('  chat 라우트: return router 앞에 삽입 완료');
    } else {
        errors.push('ai-space.js: "return router;" 못 찾음');
        log('  ❌ return router 마커 못 찾음');
    }

    safeWrite(fp, src);
    log('  ai-space.js 저장 완료\n');
}

// ============================================================
// 3. HTML 파일에 위젯 참조 추가
// ============================================================
function patchHtml(fileName) {
    const fp = path.join(PUBLIC, fileName);
    if (!fs.existsSync(fp)) {
        log(`  ${fileName}: 파일 없음 → 스킵`);
        return;
    }
    let src = fs.readFileSync(fp, 'utf-8');

    // 중복 확인
    if (src.includes('gemini-chat.js')) {
        log(`  ${fileName}: 이미 참조 있음 → 스킵`);
        return;
    }

    // </body> 앞에 위젯 참조 삽입
    const ref = `    <link rel="stylesheet" href="gemini-chat.css">\n    <script src="gemini-chat.js"></script>\n`;
    if (src.includes('</body>')) {
        src = src.replace('</body>', ref + '</body>');
        safeWrite(fp, src);
        log(`  ${fileName}: 위젯 참조 추가 완료`);
    } else {
        errors.push(`${fileName}: </body> 없음`);
        log(`  ❌ ${fileName}: </body> 없음`);
    }
}

// ============================================================
// 메인 실행
// ============================================================
function main() {
    console.log('==========================================');
    console.log(' Gemini Chat 위젯 전체 활성화 패치');
    console.log('==========================================\n');

    // 사전 확인 — 정적 파일 존재 여부
    log('=== 0. 사전 확인 ===');
    const jsOk = fs.existsSync(path.join(PUBLIC, 'gemini-chat.js'));
    const cssOk = fs.existsSync(path.join(PUBLIC, 'gemini-chat.css'));
    log(`  gemini-chat.js: ${jsOk ? '✅' : '❌ 없음'}`);
    log(`  gemini-chat.css: ${cssOk ? '✅' : '❌ 없음'}`);
    if (!jsOk || !cssOk) {
        console.error('\n❌ public/ 폴더에 gemini-chat.js 또는 .css가 없습니다!');
        process.exit(1);
    }

    // 패치 실행
    patchServerJs();
    patchAiSpace();

    log('=== 3. HTML 위젯 참조 추가 ===');
    patchHtml('index.html');
    patchHtml('stocks.html');
    patchHtml('context.html');

    // 결과
    console.log('\n==========================================');
    if (errors.length === 0) {
        console.log(' ✅ 모든 패치 성공!');
        console.log(' 다음 단계: pm2 restart dart-monitor');
    } else {
        console.log(` ⚠️ ${errors.length}개 오류:`);
        errors.forEach(e => console.log(`   - ${e}`));
    }
    console.log('==========================================');
}

main();
