/**
 * DART 공시 수집 + 분석기 — ai-queue 연동
 * 역할: (1) DART API에서 오늘 공시 자동 수집 → dart_*.json 저장
 *       (2) 미분류 공시를 ai-queue에 추가 → 결과 콜백으로 저장
 * AI: ai-queue 공유 큐 사용 (리포트와 KEY2 공유)
 * 트리거: 주기적 실행 (10분마다)
 * 읽기/쓰기: data/dart_*.json
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const aiQueue = require('./ai-queue');

// 데이터 디렉토리 경로
const DATA_DIR = path.join(__dirname, '..', 'data');

// DART API 설정
const config = require('../config');
const DART_API_KEY = config.DART_API_KEY;
const DART_API_BASE = 'https://opendart.fss.or.kr/api/list.json';
const MAX_PAGES = 5;

// 상태 추적
let isAnalyzing = false;
let lastAnalyzedAt = null;
let lastCollectedAt = null;
let totalAnalyzed = 0;
let totalCollected = 0;

/**
 * 초기화 — server.js에서 호출
 * @param {Object} opts - { intervalMs: number }
 */
function init(opts = {}) {
    const intervalMs = opts.intervalMs || 600000; // 기본 10분

    console.log(`[공시분석] 초기화 — ${intervalMs / 1000}초 간격 (ai-queue 연동)`);

    // 초기 실행 (서버 시작 30초 후)
    setTimeout(() => analyzeDartFiles(), 30000);

    // 주기적 실행
    setInterval(() => analyzeDartFiles(), intervalMs);
}

/**
 * DART 파일에서 미분류 공시 찾아서 ai-queue에 추가
 */
async function analyzeDartFiles() {
    if (isAnalyzing) {
        console.log('[공시분석] 이미 분석 중 — 스킵');
        return;
    }

    isAnalyzing = true;

    try {
        // [STEP 1] 오늘 공시 자동 수집 (DART API → 파일 저장)
        await collectDartToday();

        // [STEP 2] 오늘 날짜의 dart 파일만 읽기
        const today = getToday();
        const dartFiles = fs.readdirSync(DATA_DIR)
            .filter(f => f.startsWith(`dart_${today}`) && f.endsWith('.json'))
            .sort();

        if (dartFiles.length === 0) {
            isAnalyzing = false;
            return;
        }

        let unclassified = [];

        // 미분류 공시 수집
        for (const fileName of dartFiles) {
            const filePath = path.join(DATA_DIR, fileName);
            try {
                const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                const items = data.list || [];
                items.forEach((item, idx) => {
                    if (!item._aiCls) {
                        unclassified.push({ fileName, idx, item });
                    }
                });
            } catch (e) { }
        }

        if (unclassified.length === 0) {
            isAnalyzing = false;
            return;
        }

        console.log(`[공시분석] 미분류 ${unclassified.length}건 → ai-queue 추가`);

        // 1건씩 ai-queue에 추가 — 콜백으로 결과 저장
        for (const entry of unclassified) {
            aiQueue.addDisclosure(entry.item, (result) => {
                // 결과를 공시 라인으로: dart 파일에 저장
                entry.item._aiCls = result.cls || '일반';
                entry.item._aiSummary = result.summary || '';
                totalAnalyzed++;
                saveSingleDartItem(entry.fileName, entry.idx, result);
            });
        }

        lastAnalyzedAt = new Date().toISOString();

    } catch (e) {
        console.error(`[공시분석] 오류: ${e.message}`);
    } finally {
        isAnalyzing = false;
    }
}

/**
 * 단건 결과를 dart 파일에 저장 (콜백용)
 */
function saveSingleDartItem(fileName, idx, result) {
    const filePath = path.join(DATA_DIR, fileName);
    try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (data.list && data.list[idx]) {
            data.list[idx]._aiCls = result.cls || '일반';
            data.list[idx]._aiSummary = result.summary || '';
            data._analyzedAt = new Date().toISOString();
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
        }
    } catch (e) {
        console.error(`[공시분석] 파일 저장 실패 ${fileName}: ${e.message}`);
    }
}


/**
 * 오늘 날짜 반환 (KST, YYYYMMDD)
 */
function getToday() {
    const d = new Date();
    d.setHours(d.getHours() + 9);
    return d.toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * 대기 유틸리티
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 분석 상태 조회
 */
/**
 * DART API에서 오늘 공시 수집 → dart_*.json 저장
 */
async function collectDartToday() {
    if (!DART_API_KEY) return;

    const today = getToday();
    const kstNow = new Date(Date.now() + 9 * 3600000);
    const kstHour = kstNow.getUTCHours();

    // 영업시간 외엔 수집 안 함 (KST 08~19시만)
    if (kstHour < 8 || kstHour >= 19) return;

    // 주말엔 수집 안 함 (토=6, 일=0)
    const day = kstNow.getUTCDay();
    if (day === 0 || day === 6) return;

    let totalItems = 0;
    let newPages = 0;

    for (let p = 1; p <= MAX_PAGES; p++) {
        try {
            const url = `${DART_API_BASE}?crtfc_key=${DART_API_KEY}&bgn_de=${today}&end_de=${today}&page_no=${p}&page_count=100`;
            const resp = await axios.get(url, { timeout: 15000 });

            if (resp.data && resp.data.list && resp.data.list.length > 0) {
                resp.data._fetchedAt = new Date().toISOString();
                resp.data._collectedAt = new Date().toISOString();

                // 파일에 저장
                const fileName = `dart_${today}_p${p}.json`;
                const filePath = path.join(DATA_DIR, fileName);
                fs.writeFileSync(filePath, JSON.stringify(resp.data, null, 2), 'utf-8');

                totalItems += resp.data.list.length;
                newPages++;

                // 마지막 페이지면 중단
                if (resp.data.list.length < 100) break;
            } else {
                break; // 빈 결과 → 더 이상 페이지 없음
            }
        } catch (e) {
            console.error(`[공시수집] p${p} 실패: ${e.message}`);
            break;
        }
    }

    if (totalItems > 0) {
        totalCollected += totalItems;
        lastCollectedAt = new Date().toISOString();
        const kstStr = kstNow.toISOString().replace('T', ' ').slice(0, 19);
        console.log(`[공시수집] ${kstStr} KST ${today} 수집완료: ${totalItems}건 ${newPages}페이지`);
    }
}

function getStatus() {
    return {
        isAnalyzing,
        lastAnalyzedAt,
        lastCollectedAt,
        totalAnalyzed,
        totalCollected
    };
}

module.exports = { init, getStatus };
