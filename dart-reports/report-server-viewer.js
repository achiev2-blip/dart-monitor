/**
 * 증권사 리포트 전용 뷰어 서버
 * 
 * ⚠️ 출력 전용 — 수집/분류는 매크로(collector.js, classifier.js)가 담당
 * 
 * 역할:
 *   1. 서버 시작 시 data/ 파일들에서 최신 300건 캐시 (역순)
 *   2. 2분마다 파일 변경 체크 → 캐시 갱신
 *   3. API 요청 → 메모리 캐시에서 즉시 응답
 * 
 * 포트: 3200
 * 
 * API:
 *   GET /api/report/feed   — 캐시된 리포트 (최신 300건)
 *   GET /api/report/status — 캐시 상태 정보
 *   GET /                  — 리포트 뷰어 (public/)
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const app = express();
const PORT = process.env.PORT || 3200;
const DATA_DIR = path.join(__dirname, 'data');

const CACHE_SIZE = 300;         // 최대 캐시 건수
const REFRESH_MS = 2 * 60000;  // 2분마다 갱신

// ── 메모리 캐시 ──
let cache = [];                 // 최신 300건 (역순)
let cacheUpdatedAt = null;
let lastFileModified = null;    // 파일 변경 감지용

// ════════════════════════════════════════════════
// 캐시 로드 — data/ 폴더에서 최신 파일들 읽어서 300건 채움
// ════════════════════════════════════════════════

function loadCache() {
    if (!fs.existsSync(DATA_DIR)) {
        console.log('[캐시] data/ 폴더 없음');
        return;
    }

    // reports_YYYYMMDD.json 파일들을 날짜 역순으로 정렬
    const files = fs.readdirSync(DATA_DIR)
        .filter(f => f.startsWith('reports_') && f.endsWith('.json'))
        .sort().reverse();

    if (files.length === 0) {
        console.log('[캐시] 파일 없음');
        return;
    }

    // 파일 변경 체크 (최신 파일의 mtime)
    let latestMtime = '';
    for (const f of files) {
        const stat = fs.statSync(path.join(DATA_DIR, f));
        const mt = stat.mtime.toISOString();
        if (mt > latestMtime) latestMtime = mt;
    }

    if (latestMtime === lastFileModified) {
        return; // 변경 없음 → 스킵
    }

    // 파일들에서 읽어서 300건 채움 (중복 제거 포함)
    const collected = [];
    const seenKeys = new Set();
    for (const file of files) {
        try {
            const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf-8'));
            const items = data.items || [];
            for (const item of items) {
                const key = `${item.corp}|${item.title}|${item.date}`;
                if (!seenKeys.has(key)) {
                    seenKeys.add(key);
                    collected.push(item);
                }
            }
        } catch (e) {
            console.error(`[캐시] ${file} 읽기 실패: ${e.message}`);
        }
    }

    // 날짜 역순 정렬 → 쓰레기 데이터 필터 → 300건 제한
    // 헤더/푸터 키워드 — 수집 시 잘못 파싱된 행 제거
    const GARBAGE_KEYWORDS = [
        '전일수정주가', '목표주가', '투자의견', '기관명', '기업명',
        '작성자', '종목명', '리포트제목', 'FnGuide', 'Copyright', '괴리율',
    ];
    const filtered = collected.filter(item => {
        const check = (item.corp || '') + ' ' + (item.title || '') + ' ' + (item.opinion || '');
        return !GARBAGE_KEYWORDS.some(kw => check.includes(kw));
    });

    // opinion은 AI 분류기(classifier)가 설정 — 뷰어는 읽기만 함

    // 정렬 키: _crawledAt 우선, 없으면 date. 구분자 통일해서 비교
    const sortKey = (item) => {
        let k = item._crawledAt || item.date || '';
        // 2자리 연도 보정 (26.03.04 → 2026.03.04)
        if (/^\d{2}[.\-]/.test(k)) k = '20' + k;
        return k.replace(/[.\-\/\s:]/g, ''); // 구분자 제거 → 순수 숫자
    };
    filtered.sort((a, b) => sortKey(b).localeCompare(sortKey(a)));
    cache = filtered.slice(0, CACHE_SIZE);
    cacheUpdatedAt = new Date().toISOString();
    lastFileModified = latestMtime;

    console.log(`[캐시] 갱신: ${cache.length}건 (파일 ${files.length}개)`);
}

// ════════════════════════════════════════════════
// Express
// ════════════════════════════════════════════════

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ── API ──

// 리포트 피드 (캐시에서 즉시 응답)
app.get('/api/report/feed', (req, res) => {
    res.json({
        ok: true,
        total: cache.length,
        updatedAt: cacheUpdatedAt,
        items: cache,
    });
});

// 캐시 상태
app.get('/api/report/status', (req, res) => {
    // 소스별 카운트
    const sourceCounts = {};
    cache.forEach(i => {
        const src = i.source || '기타';
        sourceCounts[src] = (sourceCounts[src] || 0) + 1;
    });

    // 분류별 카운트
    const clsCounts = {};
    cache.forEach(i => {
        const cls = i._cls || '미분류';
        clsCounts[cls] = (clsCounts[cls] || 0) + 1;
    });

    res.json({
        ok: true,
        cache: {
            size: cache.length,
            maxSize: CACHE_SIZE,
            updatedAt: cacheUpdatedAt,
            refreshInterval: `${REFRESH_MS / 1000}초`,
        },
        sources: sourceCounts,
        classification: clsCounts,
    });
});

// ── Claude 전용 엔드포인트 ──
// GET /api/claude/reports           → 캐시에서 최신 300건
// GET /api/claude/reports?limit=50  → 최신 50건만
// GET /api/claude/reports?today=true → 오늘 파일 전체

app.get('/api/claude/reports', (req, res) => {
    const today = req.query.today === 'true';
    const limit = parseInt(req.query.limit) || 0;

    let items;
    let source;

    if (today) {
        // 오늘 파일에서 전체 가져오기
        const dateStr = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10).replace(/-/g, '');
        const todayFile = path.join(DATA_DIR, `reports_${dateStr}.json`);
        try {
            const data = JSON.parse(fs.readFileSync(todayFile, 'utf-8'));
            items = data.items || [];
            source = `오늘(${dateStr}) 전체`;
        } catch (e) {
            items = [];
            source = `오늘(${dateStr}) 파일 없음`;
        }
    } else {
        items = limit > 0 ? cache.slice(0, limit) : [...cache];
        source = limit > 0 ? `캐시 최신 ${limit}건` : `캐시 전체 ${cache.length}건`;
    }

    // 소스별 카운트
    const counts = {};
    items.forEach(i => {
        const src = i.source || '기타';
        counts[src] = (counts[src] || 0) + 1;
    });

    const countStr = Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(' / ');

    // 읽기 쉬운 형태로
    const readable = items.map((item, i) => ({
        no: i + 1,
        종목: item.corp,
        제목: item.title,
        증권사: item.broker,
        의견: item.opinion || '-',
        목표가: item.targetPrice || 0,
        날짜: item.date,
        PDF: item.pdfLink || '',
    }));

    res.json({
        summary: `📊 증권사 리포트 — ${source} (${items.length}건) | ${countStr || '없음'}`,
        total: items.length,
        counts,
        items: readable,
    });
});

// ════════════════════════════════════════════════
// 서버 시작
// ════════════════════════════════════════════════

app.listen(PORT, () => {
    console.log(`[증권사 리포트 뷰어] http://localhost:${PORT}`);

    // 즉시 캐시 로드
    loadCache();

    // 2분마다 캐시 갱신
    setInterval(loadCache, REFRESH_MS);
});
