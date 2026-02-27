// 배포 ZIP 생성 스크립트 (Node.js 순수 구현)
// archiver 대신 yazl 또는 직접 PowerShell Compress-Archive 사용
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = __dirname;
const ZIP_NAME = 'dart-monitor-deploy.zip';
const EXCLUDE_DIRS = ['node_modules', 'data', '.git', 'backup_20260222_142510', '_deploy_verified', '_deploy_extract'];
const EXCLUDE_EXT = ['.zip', '.log'];
const EXCLUDE_FILES = ['.env', '.gitignore'];

// 1. 파일 수집
function collectFiles(dir, rel) {
    let files = [];
    for (const name of fs.readdirSync(dir)) {
        if (EXCLUDE_DIRS.includes(name)) continue;
        const full = path.join(dir, name);
        const relPath = rel ? rel + '/' + name : name;
        const st = fs.statSync(full);
        if (st.isDirectory()) {
            files.push(...collectFiles(full, relPath));
        } else {
            if (EXCLUDE_EXT.includes(path.extname(name))) continue;
            if (EXCLUDE_FILES.includes(name)) continue;
            files.push({ full, rel: relPath, size: st.size });
        }
    }
    return files;
}

console.log('=== Step 2: 파일 수집 ===');
const files = collectFiles(ROOT, '');
console.log(`  수집 파일: ${files.length}개`);

// 핵심 파일 확인
const keyFiles = ['server.js', 'routes/ai-space.js'];
for (const kf of keyFiles) {
    const found = files.find(f => f.rel === kf);
    if (found) {
        const content = fs.readFileSync(found.full, 'utf8');
        const lines = content.split(/\r?\n/).length;
        console.log(`  ✅ ${kf}: ${lines}줄, ${found.size} bytes`);
    } else {
        console.log(`  ❌ ${kf}: NOT FOUND!`);
        process.exit(1);
    }
}

// ai-space.js 내용 검증
const aiContent = fs.readFileSync(path.join(ROOT, 'routes/ai-space.js'), 'utf8');
console.log(`  memo route: ${aiContent.includes('stocks/:code/memo') ? 'YES' : 'NO'}`);
console.log(`  ai-analysis route: ${aiContent.includes('stocks/:code/ai-analysis') ? 'YES' : 'NO'}`);

// 2. 임시 폴더에 파일 복사 (LF 변환)
const TEMP_DIR = path.join(ROOT, '_deploy_staging');
if (fs.existsSync(TEMP_DIR)) fs.rmSync(TEMP_DIR, { recursive: true });

console.log('\n=== Step 3: 스테이징 폴더 생성 ===');
for (const f of files) {
    const dest = path.join(TEMP_DIR, f.rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // CRLF → LF 변환 (텍스트 파일만)
    const textExt = ['.js', '.json', '.html', '.css', '.md', '.txt', '.sh', '.bat'];
    if (textExt.includes(path.extname(f.full).toLowerCase())) {
        const content = fs.readFileSync(f.full, 'utf8');
        fs.writeFileSync(dest, content.replace(/\r\n/g, '\n'), 'utf8');
    } else {
        fs.copyFileSync(f.full, dest);
    }
}
console.log(`  ${files.length}개 파일 복사 완료 (CRLF→LF)`);

// 스테이징 ai-space.js 줄수 확인
const stagedAi = fs.readFileSync(path.join(TEMP_DIR, 'routes/ai-space.js'), 'utf8');
const stagedLines = stagedAi.split('\n').length;
console.log(`  스테이징 ai-space.js: ${stagedLines}줄, ${Buffer.byteLength(stagedAi)} bytes`);

// 3. ZIP 생성 (PowerShell로 스테이징 폴더 압축)
console.log('\n=== Step 4: ZIP 생성 ===');
const zipPath = path.join(ROOT, ZIP_NAME);
if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

// PowerShell Compress-Archive 사용
const psCmd = `Compress-Archive -Path "${TEMP_DIR}\\*" -DestinationPath "${zipPath}" -Force`;
execSync(`powershell -Command "${psCmd}"`, { stdio: 'inherit' });

const zipStat = fs.statSync(zipPath);
console.log(`  ZIP 생성: ${ZIP_NAME} (${zipStat.size} bytes)`);

// 4. ZIP 검증 — 해제 후 확인
console.log('\n=== Step 5: ZIP 해제 검증 ===');
const EXTRACT_DIR = path.join(ROOT, '_deploy_extract');
if (fs.existsSync(EXTRACT_DIR)) fs.rmSync(EXTRACT_DIR, { recursive: true });
fs.mkdirSync(EXTRACT_DIR);

const psExtract = `Expand-Archive -Path "${zipPath}" -DestinationPath "${EXTRACT_DIR}" -Force`;
execSync(`powershell -Command "${psExtract}"`, { stdio: 'inherit' });

// 해제된 ai-space.js 검증
const extractedAiPath = path.join(EXTRACT_DIR, 'routes', 'ai-space.js');
if (fs.existsSync(extractedAiPath)) {
    const extractedContent = fs.readFileSync(extractedAiPath, 'utf8');
    const extractedLines = extractedContent.split('\n').length;
    console.log(`  해제 ai-space.js: ${extractedLines}줄, ${Buffer.byteLength(extractedContent)} bytes`);
    console.log(`  memo route: ${extractedContent.includes('stocks/:code/memo') ? 'YES' : 'NO'}`);
    console.log(`  ai-analysis route: ${extractedContent.includes('stocks/:code/ai-analysis') ? 'YES' : 'NO'}`);

    if (extractedLines >= 880) {
        console.log('\n✅ 전체 검증 통과 — 배포 준비 완료');
    } else {
        console.log('\n❌ 줄수 불일치! 예상: 883, 실제:', extractedLines);
    }
} else {
    console.log('  ❌ ai-space.js 해제 실패!');
}

// 정리
fs.rmSync(TEMP_DIR, { recursive: true, force: true });
fs.rmSync(EXTRACT_DIR, { recursive: true, force: true });
console.log('  임시 폴더 정리 완료');
