/**
 * DART 공시 전용 뷰어 서버
 * 
 * ⚠️ 출력 전용 — 수집/분류는 매크로(collector.js, classifier.js)가 담당
 * 
 * 역할:
 *   1. 서버 시작 시 data/output/ 파일들에서 최신 300건 캐시 (일반 제외, 역순)
 *   2. 2분마다 파일 변경 체크 → 캐시 갱신
 *   3. API 요청 → 메모리 캐시에서 즉시 응답
 * 
 * 포트: 3100
 * 
 * API:
 *   GET /api/disclosure/feed   — 캐시된 공시 (호재/악재/강력호재/확인필요)
 *   GET /api/disclosure/status — 캐시 상태 정보
 *   GET /                      — 공시 뷰어 (public/)
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const app = express();
const PORT = process.env.PORT || 3100;
const DATA_DIR = path.join(__dirname, 'data', 'output');

const CACHE_SIZE = 300;         // 최대 캐시 건수
const REFRESH_MS = 2 * 60000;  // 2분마다 갱신

// ── 메모리 캐시 ──
let cache = [];                 // 최신 300건 (일반 제외, 역순)
let cacheUpdatedAt = null;
let lastFileModified = null;    // 파일 변경 감지용

// ════════════════════════════════════════════════
// 캐시 로드 — data/output/ 폴더에서 최신 파일들 읽어서 300건 채움
// ════════════════════════════════════════════════

function loadCache() {
    if (!fs.existsSync(DATA_DIR)) {
        console.log('[캐시] data/output/ 폴더 없음');
        return;
    }

    // dart_YYYYMMDD.json 파일들을 날짜 역순으로 정렬
    const files = fs.readdirSync(DATA_DIR)
        .filter(f => f.startsWith('dart_') && f.endsWith('.json'))
        .sort()
        .reverse();

    if (files.length === 0) {
        console.log('[캐시] 파일 없음');
        return;
    }

    // 파일 변경 체크 (최신 파일의 mtime)
    const latestFile = path.join(DATA_DIR, files[0]);
    const stat = fs.statSync(latestFile);
    const mtime = stat.mtime.toISOString();

    if (mtime === lastFileModified) {
        return; // 변경 없음 → 스킵
    }

    // 파일들에서 역순으로 읽어서 300건 채움
    const collected = [];
    for (const file of files) {
        if (collected.length >= CACHE_SIZE) break;

        try {
            const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf-8'));
            const items = data.items || [];

            // 일반, 미분류 제외 / Quick의 확인필요(Search 대기 중)도 제외
            const filtered = items.filter(item => {
                if (!item._cls) return false;
                if (item._cls === '일반') return false;
                return true;
            });

            collected.push(...filtered);
        } catch (e) {
            console.error(`[캐시] ${file} 읽기 실패: ${e.message}`);
        }
    }

    // 역순 정렬 (최신 먼저) → 300건 제한
    collected.sort((a, b) => (b._crawledAt || '').localeCompare(a._crawledAt || ''));
    cache = collected.slice(0, CACHE_SIZE);
    cacheUpdatedAt = new Date().toISOString();
    lastFileModified = mtime;

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

// 공시 피드 (캐시에서 즉시 응답)
app.get('/api/disclosure/feed', (req, res) => {
    res.json({
        ok: true,
        total: cache.length,
        updatedAt: cacheUpdatedAt,
        items: cache,
    });
});

// 캐시 상태
app.get('/api/disclosure/status', (req, res) => {
    const clsCounts = {};
    cache.forEach(i => {
        clsCounts[i._cls] = (clsCounts[i._cls] || 0) + 1;
    });

    res.json({
        ok: true,
        cache: {
            size: cache.length,
            maxSize: CACHE_SIZE,
            updatedAt: cacheUpdatedAt,
            refreshInterval: `${REFRESH_MS / 1000}초`,
        },
        classification: clsCounts,
    });
});
// ── Claude 전용 엔드포인트 ──
// GET /api/claude/disclosures           → 캐시에서 최신 300건 (일반 제외)
// GET /api/claude/disclosures?limit=50  → 최신 50건만
// GET /api/claude/disclosures?today=true → 오늘 파일 전체 (일반 포함)

app.get('/api/claude/disclosures', (req, res) => {
    const today = req.query.today === 'true';
    const limit = parseInt(req.query.limit) || 0;

    let items;
    let source;

    if (today) {
        // 오늘 파일에서 전체 가져오기
        const dateStr = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10).replace(/-/g, '');
        const todayFile = path.join(DATA_DIR, `dart_${dateStr}.json`);
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

    // 분류별 카운트
    const counts = {};
    items.forEach(i => {
        const cls = i._cls || '미분류';
        counts[cls] = (counts[cls] || 0) + 1;
    });

    const countStr = Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(' / ');

    // 읽기 쉬운 형태로
    const readable = items.map((item, i) => ({
        no: i + 1,
        회사: item.corp_name,
        제목: item.report_nm,
        분류: item._cls || '미분류',
        날짜: item.rcept_dt,
        원문: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${item.rcept_no}`,
    }));

    res.json({
        summary: `📋 DART 공시 — ${source} (${items.length}건) | ${countStr || '없음'}`,
        total: items.length,
        counts,
        items: readable,
    });
});

// ════════════════════════════════════════════════
// 서버 시작
// ════════════════════════════════════════════════

app.listen(PORT, () => {
    console.log(`[DART 공시 전용 뷰어] http://localhost:${PORT}`);

    // 즉시 캐시 로드
    loadCache();

    // 2분마다 캐시 갱신
    setInterval(loadCache, REFRESH_MS);
});
