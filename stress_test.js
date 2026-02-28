// VM 부하 테스트 — 모든 엔드포인트를 동시에 호출하여 메모리 피크 측정
const http = require('http');

const BASE = 'http://34.22.94.45';
const HEADERS = { 'x-api-key': 'dartmonitor-2024' };

function fetch(urlPath) {
    return new Promise((resolve) => {
        const url = new URL(urlPath, BASE);
        http.get(url, { headers: HEADERS }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve({ path: urlPath, status: res.statusCode, size: data.length, body: data }));
        }).on('error', e => resolve({ path: urlPath, status: 0, error: e.message }));
    });
}

async function main() {
    // 1단계: 전체 엔드포인트 동시 호출
    console.log('=== 1단계: 전체 동시 호출 ===');
    const endpoints = [
        '/api/claude/summary',
        '/api/claude/summary?section=news',
        '/api/claude/summary?section=reports',
        '/api/claude/summary?section=prices',
        '/api/claude/summary?section=macro',
        '/api/claude',
        '/api/status',
        '/api/context',
    ];
    const r1 = await Promise.all(endpoints.map(e => fetch(e)));
    r1.forEach(r => console.log(`  ${r.path}: ${r.status} (${(r.size / 1024).toFixed(1)}KB)`));

    // 2단계: summary 동시 5회 (딥카피 동시 5개)
    console.log('\n=== 2단계: summary 동시 5회 ===');
    const r2 = await Promise.all([1, 2, 3, 4, 5].map(() => fetch('/api/claude/summary')));
    r2.forEach((r, i) => console.log(`  #${i + 1}: ${r.status} (${(r.size / 1024).toFixed(1)}KB)`));

    // 3단계: 연속 10회
    console.log('\n=== 3단계: 연속 10회 ===');
    for (let i = 0; i < 10; i++) {
        const r = await fetch('/api/claude/summary');
        process.stdout.write(`#${i + 1}:${(r.size / 1024).toFixed(0)}KB `);
    }
    console.log();

    // 메모리 확인
    await new Promise(r => setTimeout(r, 2000));
    console.log('\n=== 부하 후 메모리 ===');
    const memRes = await fetch('/api/memory');
    try {
        const j = JSON.parse(memRes.body);
        console.log('현재:', j.current);
        console.log('업타임:', j.uptime);
    } catch (e) { console.log('파싱 실패:', memRes.body.slice(0, 200)); }
}

main().catch(console.error);
