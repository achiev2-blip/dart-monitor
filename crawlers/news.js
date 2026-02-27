/**
 * DART 모니터 — 뉴스 RSS 크롤러 (독립 모듈)
 * 
 * server.js에서 그대로 추출 (로직 변경 없음)
 * 각 소스별 함수가 독립적 — 하나 수정해도 다른 소스에 영향 없음
 */
const axios = require('axios');

// --- 공통: RSS XML에서 link 추출 헬퍼 (cheerio <link> 파싱 버그 대응) ---
function extractLinkFromItemXml(itemXml) {
    // 1순위: <link> 태그 안의 CDATA 또는 텍스트
    const linkMatch = itemXml.match(/<link[^>]*>\s*(?:<!\[CDATA\[)?\s*(https?:\/\/[^\s<\]]+)/i);
    if (linkMatch) return linkMatch[1].trim();
    // 2순위: <guid> 태그
    const guidMatch = itemXml.match(/<guid[^>]*>\s*(?:<!\[CDATA\[)?\s*(https?:\/\/[^\s<\]]+)/i);
    if (guidMatch) return guidMatch[1].trim();
    return '';
}

// --- 공통 국내 RSS 헤더 (브라우저 수준) ---
const DOMESTIC_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': 'application/rss+xml, application/xml, text/xml, */*',
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cache-Control': 'no-cache'
};

// --- 매경 ---
async function fetchNews_MK() {
    try {
        const resp = await axios.get('https://www.mk.co.kr/rss/30100041/', {
            timeout: 10000, maxRedirects: 10,
            headers: DOMESTIC_HEADERS,
            responseType: 'text'
        });

        const items = [];
        // item 블록 단위로 분리 후 개별 파싱
        const itemBlocks = resp.data.match(/<item>([\s\S]*?)<\/item>/g) || [];

        for (const block of itemBlocks) {
            const titleM = block.match(/<title>\s*(?:<!\[CDATA\[)?\s*(.+?)(?:\]\]>)?\s*<\/title>/);
            const link = extractLinkFromItemXml(block);
            const pubDateM = block.match(/<pubDate>([^<]+)<\/pubDate>/);
            const descM = block.match(/<description>\s*(?:<!\[CDATA\[)?\s*([\s\S]*?)(?:\]\]>)?\s*<\/description>/);

            const title = titleM ? titleM[1].trim() : '';
            if (!title || !link) continue;

            items.push({
                title, link,
                source: '매경', feedName: '매경', type: 'domestic',
                desc: descM ? descM[1].trim().slice(0, 200) : '',
                pubDate: pubDateM ? pubDateM[1].trim() : new Date().toISOString()
            });
        }

        console.log(`[뉴스-매경] ${items.length}건 수집`);
        return items;
    } catch (e) {
        console.error(`[뉴스-매경] 실패: ${e.message}`);
        return [];
    }
}

// --- 연합뉴스 ---
async function fetchNews_Yonhap() {
    try {
        const resp = await axios.get('https://www.yna.co.kr/rss/economy.xml', {
            timeout: 10000, maxRedirects: 10,
            headers: DOMESTIC_HEADERS,
            responseType: 'text'
        });

        const items = [];
        const itemBlocks = resp.data.match(/<item>([\s\S]*?)<\/item>/g) || [];

        for (const block of itemBlocks) {
            const titleM = block.match(/<title>\s*(?:<!\[CDATA\[)?\s*(.+?)(?:\]\]>)?\s*<\/title>/);
            const link = extractLinkFromItemXml(block);
            const pubDateM = block.match(/<pubDate>([^<]+)<\/pubDate>/);
            const descM = block.match(/<description>\s*(?:<!\[CDATA\[)?\s*([\s\S]*?)(?:\]\]>)?\s*<\/description>/);
            const authorM = block.match(/<dc:creator>([^<]+)<\/dc:creator>/);

            const title = titleM ? titleM[1].trim() : '';
            if (!title || !link) continue;

            items.push({
                title, link,
                source: authorM ? `연합뉴스(${authorM[1].trim()})` : '연합뉴스',
                feedName: '연합뉴스', type: 'domestic',
                desc: descM ? descM[1].trim().slice(0, 200) : '',
                pubDate: pubDateM ? pubDateM[1].trim() : new Date().toISOString()
            });
        }

        console.log(`[뉴스-연합] ${items.length}건 수집`);
        return items;
    } catch (e) {
        console.error(`[뉴스-연합] 실패: ${e.message}`);
        return [];
    }
}

// --- 한경 ---
async function fetchNews_Hankyung() {
    try {
        const resp = await axios.get('https://www.hankyung.com/feed/economy', {
            timeout: 10000, maxRedirects: 10,
            headers: DOMESTIC_HEADERS,
            responseType: 'text'
        });

        const items = [];
        const itemBlocks = resp.data.match(/<item>([\s\S]*?)<\/item>/g) || [];

        for (const block of itemBlocks) {
            const titleM = block.match(/<title>\s*(?:<!\[CDATA\[)?\s*(.+?)(?:\]\]>)?\s*<\/title>/);
            const link = extractLinkFromItemXml(block);
            const pubDateM = block.match(/<pubDate>([^<]+)<\/pubDate>/);
            const authorM = block.match(/<author>\s*(?:<!\[CDATA\[)?\s*(.+?)(?:\]\]>)?\s*<\/author>/);

            const title = titleM ? titleM[1].trim() : '';
            if (!title || !link) continue;

            items.push({
                title, link,
                source: authorM ? `한경(${authorM[1].trim()})` : '한경',
                feedName: '한경', type: 'domestic',
                desc: '',
                pubDate: pubDateM ? pubDateM[1].trim() : new Date().toISOString()
            });
        }

        console.log(`[뉴스-한경] ${items.length}건 수집`);
        return items;
    } catch (e) {
        console.error(`[뉴스-한경] 실패: ${e.message}`);
        return [];
    }
}

// --- Bloomberg (Google News 경유) ---
async function fetchNews_Bloomberg() {
    try {
        const resp = await axios.get('https://news.google.com/rss/search?q=site:bloomberg.com+Korea+OR+KOSPI+OR+Samsung&hl=en&gl=US&ceid=US:en', {
            timeout: 10000,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) DART-Monitor/3.0' },
            responseType: 'text'
        });

        const items = [];
        const itemBlocks = resp.data.match(/<item>([\s\S]*?)<\/item>/g) || [];

        for (const block of itemBlocks) {
            const titleM = block.match(/<title>(.+?)<\/title>/);
            const link = extractLinkFromItemXml(block);
            const pubDateM = block.match(/<pubDate>([^<]+)<\/pubDate>/);
            const sourceM = block.match(/<source[^>]*>([^<]+)<\/source>/);

            const title = titleM ? titleM[1].trim() : '';
            if (!title || !link) continue;

            items.push({
                title, link,
                source: sourceM ? sourceM[1].trim() : 'Bloomberg',
                feedName: 'Bloomberg', type: 'foreign',
                desc: '',
                pubDate: pubDateM ? pubDateM[1].trim() : new Date().toISOString()
            });
        }

        console.log(`[뉴스-Bloomberg] ${items.length}건 수집`);
        return items;
    } catch (e) {
        console.error(`[뉴스-Bloomberg] 실패: ${e.message}`);
        return [];
    }
}

// --- Reuters (Google News 경유) ---
async function fetchNews_Reuters() {
    try {
        const resp = await axios.get('https://news.google.com/rss/search?q=site:reuters.com+Korea+OR+KOSPI+OR+Samsung+OR+Hyundai&hl=en&gl=US&ceid=US:en', {
            timeout: 10000,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) DART-Monitor/3.0' },
            responseType: 'text'
        });

        const items = [];
        const itemBlocks = resp.data.match(/<item>([\s\S]*?)<\/item>/g) || [];

        for (const block of itemBlocks) {
            const titleM = block.match(/<title>(.+?)<\/title>/);
            const link = extractLinkFromItemXml(block);
            const pubDateM = block.match(/<pubDate>([^<]+)<\/pubDate>/);
            const sourceM = block.match(/<source[^>]*>([^<]+)<\/source>/);

            const title = titleM ? titleM[1].trim() : '';
            if (!title || !link) continue;

            items.push({
                title, link,
                source: sourceM ? sourceM[1].trim() : 'Reuters',
                feedName: 'Reuters', type: 'foreign',
                desc: '',
                pubDate: pubDateM ? pubDateM[1].trim() : new Date().toISOString()
            });
        }

        console.log(`[뉴스-Reuters] ${items.length}건 수집`);
        return items;
    } catch (e) {
        console.error(`[뉴스-Reuters] 실패: ${e.message}`);
        return [];
    }
}

// --- Google News 국내 (백업 — 직접 RSS 실패 시 보충) ---
async function fetchNews_GoogleKR() {
    try {
        const resp = await axios.get('https://news.google.com/rss/search?q=%EC%BD%94%EC%8A%A4%ED%94%BC+OR+%EC%BD%94%EC%8A%A4%EB%8B%A5+OR+%EC%A6%9D%EC%8B%9C+OR+%EC%A3%BC%EC%8B%9D&hl=ko&gl=KR&ceid=KR:ko', {
            timeout: 10000, maxRedirects: 10,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' },
            responseType: 'text'
        });

        const items = [];
        const itemBlocks = resp.data.match(/<item>([\s\S]*?)<\/item>/g) || [];

        for (const block of itemBlocks) {
            const titleM = block.match(/<title>(.+?)<\/title>/);
            const link = extractLinkFromItemXml(block);
            const pubDateM = block.match(/<pubDate>([^<]+)<\/pubDate>/);
            const sourceM = block.match(/<source[^>]*>([^<]+)<\/source>/);

            const title = titleM ? titleM[1].trim() : '';
            if (!title || !link) continue;

            items.push({
                title, link,
                source: sourceM ? sourceM[1].trim() : 'Google뉴스',
                feedName: 'Google뉴스(국내)', type: 'domestic',
                desc: '',
                pubDate: pubDateM ? pubDateM[1].trim() : new Date().toISOString()
            });
        }

        console.log(`[뉴스-Google국내] ${items.length}건 수집`);
        return items;
    } catch (e) {
        console.error(`[뉴스-Google국내] 실패: ${e.message}`);
        return [];
    }
}

// --- 뉴스 선별 필터 (주식/경제 무관 뉴스 제거) ---
const NEWS_RELEVANT_KW = [
    '코스피', '코스닥', '증시', '주가', '주식', 'KOSPI', 'KOSDAQ', '거래소', '상장',
    '반도체', '배터리', '2차전지', '자동차', '조선', '바이오', 'IT', 'AI', '로봇',
    '삼성', 'SK', 'LG', '현대', '기아', 'NAVER', '카카오', '포스코', '한화', '두산', '크래프톤', '셀트리온', 'HD현대',
    'Samsung', 'Hyundai', 'POSCO', 'Celltrion',
    '금리', '환율', '원달러', '원화', '달러', '엔화', '위안', '국채', '채권', '통화',
    '수출', '수입', '무역', 'GDP', '경기', '인플레', 'CPI', '고용', '실업',
    '한은', '한국은행', '금통위', '기준금리', 'Fed', '연준',
    '실적', '매출', '영업이익', '순이익', '배당', '자사주', '공시', 'IR', 'IPO', '상폐',
    '수주', '계약', '투자', '인수', '합병', 'MOU',
    '목표가', '매수', '매도', '리포트', '컨센서스', '애널리스트',
    '외국인', '기관', '개인', '공매도', '대차', '신용',
    '호재', '악재', '급등', '급락', '신고가', '52주',
    '관세', '규제', '제재', '정책', '법안', '개정', '시행령',
    '유가', '원유', '천연가스', '리튬', '니켈', '구리', '금값', '원전', '태양광',
    'stock', 'market', 'trade', 'tariff', 'earnings', 'revenue', 'profit',
    'semiconductor', 'chip', 'battery', 'EV', 'oil', 'rate', 'bond', 'GDP',
    'Korea', 'KOSPI', 'Samsung', 'Hyundai', 'SK Hynix', 'LG Energy'
];

function isStockRelevant(title) {
    if (!title) return false;
    const t = title.toLowerCase();
    for (const kw of NEWS_RELEVANT_KW) {
        if (t.indexOf(kw.toLowerCase()) >= 0) return true;
    }
    return false;
}

// 뉴스 소스 목록
const NEWS_FETCHERS = [
    { name: '매경', fn: fetchNews_MK },
    { name: '연합뉴스', fn: fetchNews_Yonhap },
    { name: '한경', fn: fetchNews_Hankyung },
    { name: 'Google국내', fn: fetchNews_GoogleKR },
    { name: 'Bloomberg', fn: fetchNews_Bloomberg },
    { name: 'Reuters', fn: fetchNews_Reuters }
];

module.exports = {
    NEWS_FETCHERS,
    isStockRelevant,
    fetchNews_MK,
    fetchNews_Yonhap,
    fetchNews_Hankyung,
    fetchNews_Bloomberg,
    fetchNews_Reuters,
    fetchNews_GoogleKR
};
