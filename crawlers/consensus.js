// ============================================================
// 컨센서스 크롤러 — 멀티 프로바이더 지원 (소스 전환 대비)
// 독립 모듈: 외부 의존 없음 (axios, iconv-lite만 사용)
// ============================================================
// 프로바이더 전환: .env 파일에서 CONSENSUS_PROVIDER 설정
//   naver  → 네이버 금융 coinfo (기본, 무료)
//   custom → 유료 API 연동 시 _fetchCustom 구현
// ============================================================
const axios = require('axios');
const iconv = require('iconv-lite');

// ─── 현재 프로바이더 (환경변수 또는 기본값) ───
const PROVIDER = (process.env.CONSENSUS_PROVIDER || 'naver').toLowerCase();

// ─── 메인 진입점: 프로바이더 라우팅 ───
async function fetchConsensus(stockCode) {
    switch (PROVIDER) {
        case 'naver':
            return _fetchNaver(stockCode);
        case 'custom':
            return _fetchCustom(stockCode);
        default:
            console.warn(`[컨센서스] 알 수 없는 프로바이더: ${PROVIDER}, naver로 대체`);
            return _fetchNaver(stockCode);
    }
}

// ============================================================
// 프로바이더 1: 네이버 금융 (무료)
// ============================================================
async function _fetchNaver(stockCode) {
    try {
        const url = `https://finance.naver.com/item/coinfo.naver?code=${stockCode}`;
        const resp = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
            responseType: 'arraybuffer',
            timeout: 8000
        });

        const html = iconv.decode(resp.data, 'euc-kr');

        // "투자의견" 영역 탐색
        const start = html.indexOf('투자의견');
        if (start < 0) {
            console.log(`[컨센서스] ${stockCode}: 투자의견 영역 없음`);
            return null;
        }

        // 투자의견 ~ 3000자 범위에서 td 추출
        const chunk = html.substring(start, start + 3000);
        const tds = (chunk.match(/<td[^>]*>[\s\S]*?<\/td>/g) || [])
            .map(td => td.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim());

        // td 구조: [0]="4.00매수 l 216,417"  [1]="190,900 l 52,500"  [2]="39.47배 l 4,816원"  [3]="9.00배 l 20,562원"
        if (tds.length < 2) {
            console.log(`[컨센서스] ${stockCode}: td 데이터 부족 (${tds.length}개)`);
            return null;
        }

        // ─── td[0] 파싱: "4.00매수 l 216,417" → 투자의견 + 목표주가 ───
        const opinionMatch = tds[0].match(/([\d.]+)\s*(매수|중립|매도|Buy|Hold|Sell)/i);
        const tpMatch = tds[0].match(/l\s*([\d,]+)/);

        // ─── td[1] 파싱: "190,900 l 52,500" → 52주 최고/최저 ───
        const weekParts = tds[1] ? tds[1].split('l').map(s => s.replace(/[^\d]/g, '')) : [];

        // ─── td[2] 파싱: "39.47배 l 4,816원" → 추정 PER / EPS ───
        const perEps = tds[2] ? tds[2].split('l').map(s => s.replace(/[배원,\s]/g, '').trim()) : [];

        // ─── td[3] 파싱: "9.00배 l 20,562원" → 추정 PBR / BPS ───
        const pbrBps = tds[3] ? tds[3].split('l').map(s => s.replace(/[배원,\s]/g, '').trim()) : [];

        // 투자의견 텍스트 변환
        const opScore = opinionMatch ? parseFloat(opinionMatch[1]) : null;
        const opText = opinionMatch ? opinionMatch[2] : null;
        let opLabel = '정보없음';
        if (opText) {
            if (/매수|Buy/i.test(opText)) opLabel = '매수';
            else if (/매도|Sell/i.test(opText)) opLabel = '매도';
            else opLabel = '중립';
        }

        const result = {
            opinion: opLabel,                                           // 투자의견 (매수/중립/매도)
            opinionScore: opScore,                                      // 투자의견 점수 (5.0 = 적극매수)
            targetPrice: tpMatch ? parseInt(tpMatch[1].replace(/,/g, '')) : null,  // 목표주가
            week52High: weekParts[0] ? parseInt(weekParts[0]) : null,   // 52주 최고
            week52Low: weekParts[1] ? parseInt(weekParts[1]) : null,    // 52주 최저
            estPER: perEps[0] ? parseFloat(perEps[0]) : null,           // 추정 PER
            estEPS: perEps[1] ? parseInt(perEps[1]) : null,             // 추정 EPS
            estPBR: pbrBps[0] ? parseFloat(pbrBps[0]) : null,           // 추정 PBR
            estBPS: pbrBps[1] ? parseInt(pbrBps[1]) : null,             // 추정 BPS
            source: 'naver',                                            // 출처
            fetchedAt: new Date().toISOString()                         // 조회 시각
        };

        console.log(`[컨센서스] ${stockCode}: ${opLabel}(${opScore}) 목표가 ${result.targetPrice?.toLocaleString() || '-'}원`);
        return result;
    } catch (e) {
        console.error(`[컨센서스] ${stockCode} 네이버 조회 실패:`, e.message);
        return null;
    }
}

// ============================================================
// 프로바이더 2: 유료 API (템플릿 — 나중에 구현)
// ============================================================
// 유료 API 전환 시 이 함수만 구현하면 됨
// .env에 CONSENSUS_PROVIDER=custom, CONSENSUS_API_URL, CONSENSUS_API_KEY 설정
// 반환 형식은 _fetchNaver와 동일해야 함
async function _fetchCustom(stockCode) {
    const apiUrl = process.env.CONSENSUS_API_URL;
    const apiKey = process.env.CONSENSUS_API_KEY;

    if (!apiUrl || !apiKey) {
        console.error('[컨센서스] custom 프로바이더: CONSENSUS_API_URL, CONSENSUS_API_KEY 필요');
        return null;
    }

    try {
        const resp = await axios.get(`${apiUrl}/${stockCode}`, {
            headers: { 'Authorization': `Bearer ${apiKey}` },
            timeout: 10000
        });

        const d = resp.data;

        // ────────────────────────────────────────
        // ⚠️ 유료 API 응답 형식에 맞게 매핑 수정 필요
        // 아래는 예시 매핑 — 실제 API 응답 구조에 맞춰 변경
        // ────────────────────────────────────────
        return {
            opinion: d.opinion || '정보없음',
            opinionScore: d.opinionScore || null,
            targetPrice: d.targetPrice || null,
            week52High: d.week52High || null,
            week52Low: d.week52Low || null,
            estPER: d.estPER || null,
            estEPS: d.estEPS || null,
            estPBR: d.estPBR || null,
            estBPS: d.estBPS || null,
            source: 'custom',
            fetchedAt: new Date().toISOString()
        };
    } catch (e) {
        console.error(`[컨센서스] ${stockCode} custom API 실패:`, e.message);
        return null;
    }
}

module.exports = { fetchConsensus };
