/**
 * VM에서 파일 읽기 — VM이 참(truth)이므로 VM 파일을 로컬에 저장
 * public 폴더의 파일은 HTTP로 다운로드 가능
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const VM = 'http://34.22.94.45';
const OUT_DIR = path.join(__dirname, '_vm_files');

// VM에서 다운로드할 파일 목록 (public 폴더 = HTTP로 접근 가능)
const FILES = [
    '/index.html',
    '/stocks.html',
    '/context.html',
    '/archive.html',
    '/data-viewer.html',
    '/news-viewer.html',
    '/predictions.html',
    '/us_market.html',
    '/robots.txt'
];

function download(urlPath) {
    return new Promise((resolve) => {
        http.get(`${VM}${urlPath}`, { timeout: 15000 }, (res) => {
            if (res.statusCode !== 200) {
                resolve({ path: urlPath, status: res.statusCode, data: null });
                return;
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ path: urlPath, status: 200, data }));
        }).on('error', e => resolve({ path: urlPath, status: 0, error: e.message, data: null }));
    });
}

async function main() {
    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

    const results = [];

    for (const f of FILES) {
        process.stdout.write(`다운로드: ${f} ... `);
        const r = await download(f);
        if (r.data) {
            const outPath = path.join(OUT_DIR, f.replace(/\//g, ''));
            fs.writeFileSync(outPath, r.data, 'utf-8');
            const localPath = path.join(__dirname, 'public', f.replace(/\//g, ''));
            const localSize = fs.existsSync(localPath) ? fs.statSync(localPath).size : 0;
            const vmSize = Buffer.byteLength(r.data);
            const match = localSize === vmSize;
            results.push({ file: f, vmSize, localSize, match: match ? 'SAME' : 'DIFF' });
            console.log(`OK (${vmSize} bytes) ${match ? '✅ 동일' : `❌ 차이 (로컬:${localSize} VM:${vmSize})`}`);
        } else {
            results.push({ file: f, status: r.status, error: r.error || 'not found' });
            console.log(`FAIL (${r.status})`);
        }
    }

    console.log('\n=== 파일 크기 비교 ===');
    console.log('파일'.padEnd(25) + 'VM크기'.padEnd(10) + '로컬크기'.padEnd(10) + '상태');
    console.log('-'.repeat(55));
    for (const r of results) {
        if (r.vmSize !== undefined) {
            console.log(r.file.padEnd(25) + String(r.vmSize).padEnd(10) + String(r.localSize).padEnd(10) + r.match);
        } else {
            console.log(r.file.padEnd(25) + 'N/A'.padEnd(10) + 'N/A'.padEnd(10) + r.error);
        }
    }

    // 결과를 파일에도 저장
    fs.writeFileSync(path.join(OUT_DIR, '_comparison.json'), JSON.stringify(results, null, 2), 'utf-8');
    console.log(`\nVM 파일 → ${OUT_DIR} 에 저장됨`);
    console.log(`비교 결과 → ${path.join(OUT_DIR, '_comparison.json')}`);
}

main().catch(e => console.error(e));
