/**
 * VM → 로컬 동기화 v2
 * 1) public HTML은 이미 다운로드한 VM 버전으로 덮어쓰기
 * 2) 서버사이드 JS는 VM의 backup API 등으로 읽기 시도
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

const VM = 'http://34.22.94.45';
const API_KEY = 'dartmonitor-2024';
const VM_DIR = path.join(__dirname, '_vm_files');
const PUBLIC_DIR = path.join(__dirname, 'public');

// --- PART 1: VM HTML → 로컬 public 덮어쓰기 ---
function syncPublicFiles() {
    const htmlFiles = ['index.html', 'stocks.html', 'context.html', 'archive.html'];
    const results = [];

    for (const f of htmlFiles) {
        const vmPath = path.join(VM_DIR, f);
        const localPath = path.join(PUBLIC_DIR, f);

        if (!fs.existsSync(vmPath)) {
            results.push(`${f}: VM 파일 없음 — 스킵`);
            continue;
        }

        // 로컬 백업
        if (fs.existsSync(localPath)) {
            const backupPath = localPath + '.local-backup';
            fs.copyFileSync(localPath, backupPath);
        }

        // VM 버전으로 덮어쓰기
        fs.copyFileSync(vmPath, localPath);
        const vmSize = fs.statSync(vmPath).size;
        results.push(`${f}: VM 버전 적용 (${vmSize} bytes)`);
    }

    return results;
}

// --- PART 2: VM 서버사이드 파일 읽기 시도 ---
function fetch(urlPath) {
    return new Promise((resolve) => {
        http.get(`${VM}${urlPath}`, { timeout: 10000 }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
                catch (e) { resolve({ status: res.statusCode, raw: data.substring(0, 5000) }); }
            });
        }).on('error', e => resolve({ status: 0, error: e.message }));
    });
}

async function main() {
    console.log('=== VM → 로컬 동기화 ===\n');

    // Part 1: HTML 파일 동기화
    console.log('--- HTML 파일 동기화 ---');
    const htmlResults = syncPublicFiles();
    htmlResults.forEach(r => console.log(`  ${r}`));

    // Part 2: VM에서 서버사이드 정보 읽기
    console.log('\n--- VM 서버 구성 확인 ---');

    // Gemini 모델 설정 확인
    const gs = await fetch(`/api/gemini/status?api_key=${API_KEY}`);
    if (gs.data) {
        console.log('  Gemini 모델:', JSON.stringify(gs.data.models?.map(m => m.id), null, 2));
    }

    // 서버 상태
    const st = await fetch(`/api/status?api_key=${API_KEY}`);
    if (st.data) {
        console.log('  서버 상태:', JSON.stringify({
            uptime: Math.round(st.data.uptime / 60) + '분',
            news: st.data.news,
            reports: st.data.reports,
            memory: st.data.memory
        }));
    }

    // 서버사이드 파일은 HTTP로 접근 불가하므로 유저에게 안내
    console.log('\n--- 서버사이드 파일 (SSH 필요) ---');
    console.log('  서버사이드 JS 파일 (server.js, config.js, routes/*.js 등)은');
    console.log('  HTTP로는 접근할 수 없습니다.');
    console.log('  GCP SSH에서 다음 명령으로 확인 필요:');
    console.log('    cat ~/dart-monitor/server.js | head -30');
    console.log('    cat ~/dart-monitor/config.js');
    console.log('    cat ~/dart-monitor/.env');
    console.log('    wc -l ~/dart-monitor/server.js ~/dart-monitor/config.js ~/dart-monitor/routes/ai-space.js');

    // 결과 저장
    const summary = {
        htmlSync: htmlResults,
        vmGemini: gs.data || gs.raw,
        vmStatus: st.data || st.raw,
        timestamp: new Date().toISOString()
    };
    fs.writeFileSync(path.join(VM_DIR, '_sync_result.json'), JSON.stringify(summary, null, 2), 'utf-8');

    console.log('\n=== 완료 — HTML 파일 VM 버전으로 동기화됨 ===');
}

main().catch(e => console.error(e));
