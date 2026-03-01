/**
 * 리포트 AI 분석 테스트 — 더미 데이터로 실제 Gemini 호출
 */
const axios = require('axios');

const GEMINI_KEY = 'AIzaSyBwiFfSI2grKBCPX4v9JoElyJTYnut8bno';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
const MODEL = 'gemini-2.0-flash';

// 스크린샷 기반 더미 리포트
const dummyReport = {
    corp: '국내 장비 대장',
    title: '국내 장비 대장',
    broker: 'SK증권(네이버)',
    opinion: '매수',
    targetPrice: 0,
    date: '26.02.27',
    summary: ''
};

const bodyText = (dummyReport.summary || '').substring(0, 500);
const prompt = '증권사 리포트 분석 전문가로서 다음 리포트를 분석해주세요.\n\n'
    + '종목: ' + (dummyReport.corp || '') + '\n'
    + '제목: ' + (dummyReport.title || '') + '\n'
    + '증권사: ' + (dummyReport.broker || '') + '\n'
    + (dummyReport.opinion ? '투자의견: ' + dummyReport.opinion + '\n' : '')
    + (dummyReport.targetPrice ? '목표주가: ' + dummyReport.targetPrice.toLocaleString() + '원\n' : '')
    + (bodyText ? '본문: ' + bodyText + '\n' : '')
    + '\n리포트 제목과 본문 내용에서 목표가 상향/하향, 투자의견 변경, 실적 전망 등을 파악하여 다음 형식으로 답변:\n'
    + '판단: [강력호재/호재/악재/중립] (한 단어)\n'
    + '  - 강력호재 기준: 목표가 20%이상 상향, 투자의견 상향(중립→매수 등), 실적 대폭 서프라이즈\n'
    + '  - 호재: 목표가 소폭 상향, 긍정 전망, 실적 부합 이상\n'
    + '  - 악재: 목표가 하향, 부정 전망, 실적 미달\n'
    + '방향: [상향/하향/유지/신규] (목표가 또는 투자의견 방향)\n'
    + '요약: (1줄 한국어 핵심 요약)';

console.log('=== 프롬프트 ===');
console.log(prompt);
console.log('\n=== Gemini 호출 중... ===\n');

async function test() {
    const url = `${GEMINI_BASE}${MODEL}:generateContent?key=${GEMINI_KEY}`;
    try {
        const resp = await axios.post(url, {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.2, maxOutputTokens: 300 }
        }, { timeout: 20000, headers: { 'Content-Type': 'application/json' } });

        const text = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        console.log('=== AI 원본 응답 ===');
        console.log(text);

        const result = { cls: 'normal', summary: '', direction: '' };
        if (text) {
            const lines = text.split('\n');
            for (const line of lines) {
                const l = line.trim();
                if (l.indexOf('판단') >= 0) {
                    if (l.indexOf('강력호재') >= 0 || l.indexOf('강력 호재') >= 0) result.cls = 'strong_good';
                    else if (l.indexOf('호재') >= 0) result.cls = 'good';
                    else if (l.indexOf('악재') >= 0) result.cls = 'bad';
                }
                if (l.indexOf('방향') >= 0 || l.indexOf('변동') >= 0) {
                    if (l.indexOf('상향') >= 0) result.direction = '상향';
                    else if (l.indexOf('하향') >= 0) result.direction = '하향';
                    else if (l.indexOf('유지') >= 0 || l.indexOf('변동없음') >= 0) result.direction = '유지';
                }
                if (l.indexOf('요약') >= 0) {
                    result.summary = l.replace(/^[^:：]*[:：]\s*/, '').trim();
                }
            }
        }
        console.log('\n=== 파싱 결과 ===');
        console.log(JSON.stringify(result, null, 2));
    } catch (e) {
        console.error('오류:', e.response?.data || e.message);
    }
}

test();
