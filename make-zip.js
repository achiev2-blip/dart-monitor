// ZIP 생성 스크립트 (Node.js) — PowerShell 의존 제거
// 핵심 파일 포함 여부를 검증 후 ZIP 생성
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = __dirname;
const ZIP_NAME = 'dart-monitor-update.zip';
const ZIP_PATH = path.join(ROOT, ZIP_NAME);

// 제외 패턴
const EXCLUDES = ['node_modules', '.git', 'backup_'];
const EXCLUDE_EXT = ['.log'];
const EXCLUDE_FILES = [ZIP_NAME, 'check-zip.ps1', 'debug-zip.ps1'];

// 핵심 파일 목록 (반드시 포함되어야 하는 파일)
const CRITICAL_FILES = [
    'server.js',
    'routes/ai-space.js',
    'routes/context.js',
    'utils/permissions.js'
];

// 1단계: 핵심 파일 존재 확인
console.log('=== 1단계: 핵심 파일 존재 확인 ===');
let allExist = true;
for (const f of CRITICAL_FILES) {
    const fp = path.join(ROOT, f);
    if (fs.existsSync(fp)) {
        const stat = fs.statSync(fp);
        console.log(`  ✅ ${f} (${stat.size} bytes)`);
    } else {
        console.log(`  ❌ ${f} — 파일 없음!`);
        allExist = false;
    }
}
if (!allExist) {
    console.log('\n❌ 핵심 파일 누락 — ZIP 생성 중단');
    process.exit(1);
}

// 2단계: 전체 파일 수집
console.log('\n=== 2단계: 파일 수집 ===');
function collectFiles(dir, base) {
    const results = [];
    for (const item of fs.readdirSync(dir)) {
        const full = path.join(dir, item);
        const rel = path.relative(base, full).replace(/\\/g, '/');

        // 제외 디렉터리 체크
        if (EXCLUDES.some(ex => rel.includes(ex))) continue;

        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
            results.push(...collectFiles(full, base));
        } else {
            // 제외 확장자/파일명 체크
            if (EXCLUDE_EXT.includes(path.extname(full))) continue;
            if (EXCLUDE_FILES.includes(path.basename(full))) continue;
            results.push({ full, rel, size: stat.size });
        }
    }
    return results;
}

const files = collectFiles(ROOT, ROOT);
console.log(`  수집된 파일: ${files.length}개`);

// 3단계: 핵심 파일 포함 재확인
console.log('\n=== 3단계: 핵심 파일 포함 재확인 ===');
for (const cf of CRITICAL_FILES) {
    const found = files.find(f => f.rel === cf);
    if (found) {
        console.log(`  ✅ ${cf} (${found.size} bytes)`);
    } else {
        console.log(`  ❌ ${cf} — 수집에서 누락!`);
        process.exit(1);
    }
}

// 4단계: ZIP 생성 (tar + gzip 대신 PowerShell의 .NET 사용)
console.log('\n=== 4단계: ZIP 생성 ===');
if (fs.existsSync(ZIP_PATH)) fs.unlinkSync(ZIP_PATH);

// 파일 목록을 임시 파일에 저장하고 PowerShell로 ZIP 생성
const listFile = path.join(ROOT, '_zip_files.txt');
fs.writeFileSync(listFile, files.map(f => f.rel).join('\n'));

const ps = `
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open('${ZIP_PATH.replace(/\\/g, '\\\\')}', 'Create')
$base = '${ROOT.replace(/\\/g, '\\\\')}' + '\\\\'
$lines = Get-Content '${listFile.replace(/\\/g, '\\\\')}'
foreach ($rel in $lines) {
    $full = $base + $rel.Replace('/', '\\\\')
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $full, $rel) | Out-Null
}
$zip.Dispose()
`;
const psFile = path.join(ROOT, '_make_zip.ps1');
fs.writeFileSync(psFile, ps);
execSync(`powershell -ExecutionPolicy Bypass -File "${psFile}"`, { stdio: 'inherit' });

// 임시 파일 정리
fs.unlinkSync(listFile);
fs.unlinkSync(psFile);

// 5단계: ZIP 크기 확인
const zipStat = fs.statSync(ZIP_PATH);
console.log(`\n=== 완료 ===`);
console.log(`  ZIP: ${ZIP_NAME} (${zipStat.size.toLocaleString()} bytes)`);
console.log(`  파일수: ${files.length}개`);
