// 원복: updateAiLayer를 B5 이전 상태로 되돌리기
const fs = require('fs');
const path = require('path');
const F = path.join(__dirname, 'utils', 'company-data.js');
const NL = fs.readFileSync(F, 'utf8').includes('\r\n') ? '\r\n' : '\n';
const lines = fs.readFileSync(F, 'utf8').split(NL);

// updateAiLayer 함수 찾기 (중괄호 카운트)
let s = -1, e = -1;
for (let i = 0; i < lines.length; i++) {
    if (lines[i].match(/^function updateAiLayer\(/)) {
        s = i; let b = 0;
        for (let j = i; j < lines.length; j++) {
            for (const c of lines[j]) { if (c === '{') b++; if (c === '}') b--; }
            if (b === 0 && j > i) { e = j; break; }
        } break;
    }
}
if (s < 0) { console.error('NOT FOUND'); process.exit(1); }
console.log(`Found L${s + 1}~L${e + 1}, replacing...`);

// 원본 함수
const orig = [
    'function updateAiLayer(code, summary, sentiment) {',
    '    const layers = getLayers(code);',
    '    layers.AI\uBD84\uC11D = { latestSummary: summary, sentiment, updatedAt: new Date().toISOString() };',
    '    saveCompanyJSON(code, \'layers.json\', layers);',
    '}'
];
lines.splice(s, e - s + 1, ...orig);
fs.writeFileSync(F, lines.join(NL), 'utf8');

// 검증
const { execSync } = require('child_process');
try {
    execSync('node --check utils/company-data.js', { cwd: __dirname });
    console.log('RESTORE OK');
} catch (e) { console.error('SYNTAX ERROR'); process.exit(1); }
