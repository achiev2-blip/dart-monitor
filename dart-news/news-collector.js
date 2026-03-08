/**
 * 뉴스 수집기 — 독립 매크로
 * 
 * 역할: RSS 소스에서 뉴스 크롤링 → data/pending/news_YYYYMMDD.json 저장
 * 수집 소스: 매경 + 연합뉴스 + 한경 + Google국내 + Bloomberg + Reuters (6개)
 * 특징:
 *   - crawlers/news.js의 크롤링 함수 참조 (독립 소유 원칙 — 크롤러만 참조)
 *   - 중복 제거: title+link 해시로 _newsId 생성
 *   - 주식/경제 관련 뉴스만 필터링 (isStockRelevant)
 *   - 10분 간격 자동 수집 (시간대별 동적 조절)
 *   - 7일 경과 파일 자동 삭제
 *   - node news-collector.js 로 단독 실행 가능
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// 크롤러 참조 — crawlers/news.js 의 RSS 수집 함수 사용
const { NEWS_FETCHERS, isStockRelevant } = require('../crawlers/news');

const DATA_DIR = path.join(__dirname, 'data', 'pending');
const COLLECT_INTERVAL = 600000; // 10분 기본
const RETENTION_DAYS = 7;        // 파일 보존 기간

// ── 상태 ──
let todayItems = [];           // 오늘 뉴스 배열 (메모리)
let todayDate = '';            // 현재 메모리에 있는 날짜
let lastCollectedAt = null;    // 마지막 수집 시각
let totalCollected = 0;        // 누적 수집 건수
let _timer = null;             // 수집 타이머
let _onCollected = null;       // 수집 완료 콜백 (chain에서 등록)

// ── 유틸리티 ──

// KST 오늘 날짜 (YYYYMMDD)
function getToday() {
    return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10).replace(/-/g, '');
}

// KST 시간 정보
function getKST() {
    const now = new Date(Date.now() + 9 * 3600000);
    return {
        hour: now.getUTCHours(),
        minute: now.getUTCMinutes(),
        iso: now.toISOString(),
        display: now.toISOString().slice(11, 16),
    };
}

// 데이터 디렉토리 확인
function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        console.log('[뉴스-수집] data/pending/ 디렉토리 생성');
    }
}

// 뉴스 ID 생성 — 키워드 추출 기반 중복 방지
// 제목에서 의미있는 단어 추출 → 정렬 → 상위 5개로 해시
function makeNewsId(title, link) {
    if (!title) return crypto.createHash('md5').update(link || '').digest('hex').slice(0, 12);

    // 출처 접미사 제거 ("- 프라임경제" 등)
    const cleaned = title.replace(/\s*[-–—|]\s*[^\-–—|]+$/, '');

    // 특수문자, 괄호, 숫자, 기호 제거
    const stripped = cleaned.replace(/[\[\](){}'"''""\u00B7·…%↑↓△▲▽▼.,!?:;]/g, ' ');

    // 단어 추출 — 한글 2자 이상, 영문 3자 이상
    const words = stripped.split(/\s+/).filter(w => {
        if (/^[가-힣]+$/.test(w)) return w.length >= 2;
        if (/^[a-zA-Z]+$/i.test(w)) return w.length >= 3;
        if (/[가-힣]/.test(w) && w.length >= 2) return true;
        return false;
    }).map(w => w.toLowerCase());

    // 정렬 후 상위 4개
    words.sort();
    const key = words.slice(0, 4).join('|');

    return crypto.createHash('md5').update(key).digest('hex').slice(0, 12);
}

// ════════════════════════════════════════════════
// 시간대별 동적 수집 간격
// ════════════════════════════════════════════════

function getSmartInterval() {
    const { hour } = getKST();

    // 장 시작 전후 피크 (07~09시) — 5분
    if (hour >= 7 && hour < 9) return 5 * 60000;

    // 장중 (09~16시) — 10분
    if (hour >= 9 && hour < 16) return 10 * 60000;

    // 장 마감 후 (16~18시) — 15분
    if (hour >= 16 && hour < 18) return 15 * 60000;

    // 야간 (18~07시) — 10분 (해외 뉴스 대응)
    return 10 * 60000;
}

// ════════════════════════════════════════════════
// 수집 — 6개 소스 순차 호출 → 중복 제거 → 파일 저장
// ════════════════════════════════════════════════

async function collectOnce() {
    const today = getToday();
    const kst = getKST();
    console.log(`\n[뉴스-수집] 시작 — ${today} ${kst.display} KST`);

    ensureDataDir();

    // 날짜 변경 체크 — 자정 넘으면 리셋
    if (todayDate !== today) {
        todayItems = [];
        todayDate = today;
        console.log(`[뉴스-수집] 날짜 변경 → ${today} (메모리 리셋)`);
    }

    // 기존 파일이 있으면 로드 (서버 재시작 대응 — 분류 상태 보존)
    const loadPath = path.join(DATA_DIR, `news_${today}.json`);
    if (todayItems.length === 0 && fs.existsSync(loadPath)) {
        try {
            const data = JSON.parse(fs.readFileSync(loadPath, 'utf-8'));
            const cutoff = Date.now() - 24 * 3600000;
            todayItems = (data.items || []).filter(i => {
                if (!i.pubDate) return true;
                const t = new Date(i.pubDate).getTime();
                return isNaN(t) || t > cutoff;
            });
            console.log(`[뉴스-수집] 기존 파일 로드: ${todayItems.length}건 (24h 필터, 원본 ${(data.items || []).length}건)`);
        } catch (e) {
            console.error(`[뉴스-수집] 파일 로드 실패: ${e.message}`);
        }
    }

    // 기존 ID 집합 (중복 제거용)
    const existingIds = new Set(todayItems.map(i => i._newsId));

    // 6개 소스 순차 호출
    let newCount = 0;
    for (const { name, fn } of NEWS_FETCHERS) {
        try {
            const rawItems = await fn();

            for (const item of rawItems) {
                // 주식/경제 관련 뉴스만 수집
                if (!isStockRelevant(item.title)) continue;

                // 24시간 이내 뉴스만 수집 (과거 뉴스 필터)
                if (item.pubDate) {
                    const pubTime = new Date(item.pubDate).getTime();
                    if (!isNaN(pubTime) && Date.now() - pubTime > 24 * 3600000) continue;
                }

                const newsId = makeNewsId(item.title, item.link);
                if (existingIds.has(newsId)) continue;

                // 뉴스 아이템 구성
                todayItems.push({
                    ...item,
                    _newsId: newsId,
                    _crawledAt: kst.iso,
                    _cls: null,           // 분류 전
                    _clsBy: null,         // 분류 방식
                    _clsAt: null,         // 분류 시각
                });

                existingIds.add(newsId);
                newCount++;
            }

            console.log(`[뉴스-수집] ${name}: ${rawItems.length}건 수집, 관련 뉴스 필터링 완료`);
        } catch (e) {
            console.error(`[뉴스-수집] ${name} 실패: ${e.message}`);
        }
    }

    // 발행시간순 정렬 (최신 먼저 — pubDate 파싱)
    todayItems.sort((a, b) => {
        const da = new Date(a.pubDate || 0).getTime() || 0;
        const db = new Date(b.pubDate || 0).getTime() || 0;
        return db - da;
    });

    // 파일 저장
    const filePath = path.join(DATA_DIR, `news_${today}.json`);
    const saveData = {
        date: today,
        updatedAt: kst.iso,
        totalItems: todayItems.length,
        items: todayItems,
    };
    fs.writeFileSync(filePath, JSON.stringify(saveData, null, 2), 'utf-8');

    totalCollected += newCount;
    lastCollectedAt = kst.iso;

    console.log(`[뉴스-수집] 완료 — 신규 ${newCount}건, 전체 ${todayItems.length}건 (${filePath})`);

    return { newCount, total: todayItems.length };
}

// ════════════════════════════════════════════════
// 보존규칙 — 7일 경과 파일 삭제
// ════════════════════════════════════════════════

function cleanOldFiles() {
    if (!fs.existsSync(DATA_DIR)) return;

    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000);
    const files = fs.readdirSync(DATA_DIR)
        .filter(f => f.startsWith('news_') && f.endsWith('.json'));

    let deleted = 0;
    for (const file of files) {
        const dateStr = file.replace('news_', '').replace('.json', '');
        const fileDate = new Date(`${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`);
        if (fileDate < cutoff) {
            fs.unlinkSync(path.join(DATA_DIR, file));
            deleted++;
        }
    }

    if (deleted > 0) {
        console.log(`[뉴스-수집] 오래된 파일 ${deleted}개 삭제 (보존기간: ${RETENTION_DAYS}일)`);
    }
}

// ════════════════════════════════════════════════
// 자동 수집 시작/중지
// ════════════════════════════════════════════════

async function start() {
    console.log('[뉴스-수집] 자동 수집 시작');

    // 즉시 1회 수집
    await collectOnce();
    cleanOldFiles();
    if (_onCollected) {
        try { await _onCollected(); } catch (e) {
            console.error(`[뉴스-수집] onCollected 콜백 오류: ${e.message}`);
        }
    }

    // 동적 간격으로 반복
    function scheduleNext() {
        const interval = getSmartInterval();
        const kst = getKST();
        console.log(`[뉴스-수집] 다음 수집: ${Math.round(interval / 60000)}분 후 (${kst.display} KST)`);

        _timer = setTimeout(async () => {
            try {
                await collectOnce();
                cleanOldFiles();
                if (_onCollected) {
                    try { await _onCollected(); } catch (e) {
                        console.error(`[뉴스-수집] onCollected 콜백 오류: ${e.message}`);
                    }
                }
            } catch (e) {
                console.error(`[뉴스-수집] 오류: ${e.message}`);
            }
            scheduleNext();
        }, interval);
    }

    scheduleNext();
}

function stop() {
    if (_timer) {
        clearTimeout(_timer);
        _timer = null;
        console.log('[뉴스-수집] 자동 수집 중지');
    }
}

// ════════════════════════════════════════════════
// 외부 인터페이스
// ════════════════════════════════════════════════

// 수집 완료 콜백 등록 (chain에서 사용)
function onCollected(fn) { _onCollected = fn; }

// 오늘 수집된 뉴스 배열 반환 (메모리 읽기만 — 부하 0)
function getTodayItems() {
    return todayItems;
}

// 상태 조회
function getStatus() {
    const kst = getKST();
    return {
        todayDate,
        todayCount: todayItems.length,
        totalCollected,
        lastCollectedAt,
        nextInterval: `${Math.round(getSmartInterval() / 60000)}분`,
        currentTime: `${kst.display} KST`,
        isRunning: !!_timer,
    };
}

module.exports = {
    start,
    stop,
    collectOnce,
    cleanOldFiles,
    getTodayItems,
    getStatus,
    getToday,
    onCollected,
};

// ════════════════════════════════════════════════
// 독립 실행 모드 — node news-collector.js
// ════════════════════════════════════════════════

if (require.main === module) {
    (async () => {
        console.log('[뉴스-수집] 독립 실행 모드');
        try {
            await collectOnce();
            cleanOldFiles();
            const status = getStatus();
            console.log(`[뉴스-수집] 결과: ${status.todayCount}건`);
        } catch (e) {
            console.error(`[뉴스-수집] 오류: ${e.message}`);
            process.exit(1);
        }
        process.exit(0);
    })();
}
