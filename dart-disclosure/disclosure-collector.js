/**
 * DART 공시 수집기 — 독립 모듈
 * 
 * 역할: DART API에서 오늘 시세영향 공시만 수집 → data/dart_YYYYMMDD.json 저장
 * 수집 대상: B(주요사항) + C(발행) + D(지분) + I(거래소) 4가지 유형만
 * 특징:
 *   - 정기공시(사업보고서 등) 제외 → 수집량 70% 절감
 *   - 메모리 최소: todayItems 배열만 보관 (자정 자동 초기화)
 *   - 파일: 날짜별 1개 파일 (유형별 병합)
 *   - 7일 보존규칙 자동 적용
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// ── 설정 ──
const DART_API_KEY = process.env.DART_API_KEY || '';
const DATA_DIR = path.join(__dirname, 'data');
const DART_API_BASE = 'https://opendart.fss.or.kr/api/list.json';
const MAX_PAGES = 10;          // 유형당 최대 10페이지 (1000건)
const COLLECT_INTERVAL = 600000; // 10분
const RETENTION_DAYS = 7;      // 파일 보존 기간

// 시세에 영향 주는 공시 유형만 수집
const TARGET_TYPES = [
    { code: 'B', name: '주요사항' },  // 자사주, 합병, 분할 등
    { code: 'C', name: '발행' },      // 유상증자, 전환사채 등
    { code: 'D', name: '지분' },      // 최대주주 변경 등
    { code: 'I', name: '거래소' },    // 상장폐지, 거래정지 등
];

// ── 상태 ──
let todayItems = [];           // 오늘 공시 배열 (메모리)
let todayDate = '';            // 현재 메모리에 있는 날짜
let lastCollectedAt = null;    // 마지막 수집 시각
let totalCollected = 0;        // 누적 수집 건수
let _timer = null;             // 수집 타이머

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

// ════════════════════════════════════════════════
// 수집 — DART API (유형별) → 파일 + 메모리
// ════════════════════════════════════════════════

/**
 * 단일 유형 수집 — DART API 호출 (페이지 반복)
 * @param {string} today - YYYYMMDD
 * @param {string} typeCode - 공시유형 코드 (B/C/D/I)
 * @param {Set} existingIds - 이미 수집된 rcept_no 집합
 * @returns {Array} 새로 수집된 항목 배열
 */
async function collectByType(today, typeCode, existingIds) {
    const items = [];

    for (let p = 1; p <= MAX_PAGES; p++) {
        try {
            const url = `${DART_API_BASE}?crtfc_key=${DART_API_KEY}&bgn_de=${today}&end_de=${today}&page_no=${p}&page_count=100&pblntf_ty=${typeCode}`;
            const resp = await axios.get(url, { timeout: 15000 });

            if (!resp.data || !resp.data.list || resp.data.list.length === 0) break;

            // 중복 제거 (rcept_no 기준) + 크롤링 시간 기록
            const crawledAt = new Date(Date.now() + 9 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
            for (const item of resp.data.list) {
                if (!existingIds.has(item.rcept_no)) {
                    item._type = typeCode;       // 수집 유형 (B/C/D/I)
                    item._crawledAt = crawledAt;  // 크롤링 시간 (KST)
                    items.push(item);
                    existingIds.add(item.rcept_no);
                }
            }

            // 마지막 페이지면 중단
            if (resp.data.list.length < 100) break;

            // API 부하 방지 — 페이지 간 200ms 대기
            if (p < MAX_PAGES) await sleep(200);

        } catch (e) {
            console.error(`[수집] ${typeCode} p${p} 실패: ${e.message}`);
            break;
        }
    }

    return items;
}

/**
 * 오늘 공시 수집 (1회) — B+C+D+I 유형별 순차 호출
 */
async function collectOnce() {
    if (!DART_API_KEY) {
        console.log('[수집] DART_API_KEY 없음 — 스킵');
        return { collected: 0, reason: 'no_key' };
    }

    const kst = getKST();

    // 24시간 수집 — DART에 새 공시가 있으면 언제든 수집

    const today = getToday();
    ensureDataDir();

    // 날짜 바뀌면 메모리 초기화 (메모리 절약 핵심)
    if (todayDate !== today) {
        todayItems = [];
        todayDate = today;
        console.log(`[수집] 날짜 변경 → 메모리 초기화 (${today})`);
    }

    // 기존 파일이 있으면 로드 (서버 재시작 대응)
    const filePath = path.join(DATA_DIR, `dart_${today}.json`);
    let existingIds = new Set();
    if (todayItems.length === 0 && fs.existsSync(filePath)) {
        try {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            todayItems = data.items || [];
            existingIds = new Set(todayItems.map(i => i.rcept_no));
            console.log(`[수집] 기존 파일 로드: ${todayItems.length}건`);
        } catch (e) {
            console.error(`[수집] 파일 로드 실패: ${e.message}`);
        }
    } else {
        existingIds = new Set(todayItems.map(i => i.rcept_no));
    }

    // 유형별 순차 수집 (API 부하 분산)
    let newItems = [];
    const typeCounts = {};

    for (const type of TARGET_TYPES) {
        const items = await collectByType(today, type.code, existingIds);
        typeCounts[type.name] = items.length;
        newItems.push(...items);

        // 유형 간 300ms 대기 (API 부하 방지)
        if (type !== TARGET_TYPES[TARGET_TYPES.length - 1]) await sleep(300);
    }

    // 새 항목 병합
    if (newItems.length > 0) {
        todayItems.push(...newItems);
        totalCollected += newItems.length;
        lastCollectedAt = new Date().toISOString();

        // 파일 저장 (날짜별 1개 파일로 병합)
        const saveData = {
            date: today,
            total: todayItems.length,
            types: TARGET_TYPES.map(t => t.code).join('+'),
            _collectedAt: lastCollectedAt,
            items: todayItems,
        };
        fs.writeFileSync(filePath, JSON.stringify(saveData, null, 2), 'utf-8');

        // 유형별 건수 로그
        const counts = Object.entries(typeCounts).filter(([, v]) => v > 0).map(([k, v]) => `${k}:${v}`).join(' ');
        console.log(`[수집] ${kst.dateStr} +${newItems.length}건 (${counts}) 총${todayItems.length}건`);
    }

    return { collected: newItems.length, total: todayItems.length, typeCounts };
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
    const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('dart_') && f.endsWith('.json'));

    for (const f of files) {
        const dateStr = f.replace('dart_', '').replace('.json', '');
        if (dateStr < cutoffStr) {
            fs.unlinkSync(path.join(DATA_DIR, f));
            removed++;
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
    console.log(`[수집] 자동 수집 시작 — ${COLLECT_INTERVAL / 1000}초 간격 (${TARGET_TYPES.map(t => t.name).join('+')})`);

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

// 오늘 수집된 공시 배열 반환 (메모리 읽기만 — 부하 0)
function getTodayItems() {
    return todayItems;
}

// 상태 조회
function getStatus() {
    const mem = process.memoryUsage();
    return {
        todayDate,
        itemCount: todayItems.length,
        targetTypes: TARGET_TYPES.map(t => `${t.code}(${t.name})`).join(', '),
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

module.exports = {
    start,
    stop,
    collectOnce,
    cleanOldFiles,
    getTodayItems,
    getStatus,
    getToday,
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
