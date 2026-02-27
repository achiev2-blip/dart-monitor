// 패치 B5 v3: 안전한 복구 + 재패치
// 이전 패치가 깨뜨린 경우 복구하고 다시 적용
const fs = require('fs');
const path = require('path');
const COMPANY_DATA = path.join(__dirname, 'utils', 'company-data.js');

console.log('[B5v3] 복구 + 재패치 시작...');

let src = fs.readFileSync(COMPANY_DATA, 'utf8');

// 이미 정상적으로 패치된 경우
const hasProperPatch = src.includes('prev.latestSummary === summary') &&
    src.includes('history.push(') &&
    src.includes('while (history.length > 10)');

// 문법 체크
try {
    new Function(src);
    if (hasProperPatch) {
        console.log('[B5v3] ✅ 이미 정상 패치됨 → 스킵');
        process.exit(0);
    }
} catch (e) {
    console.log('[B5v3] 문법 오류 감지 → 복구 시작:', e.message.substring(0, 80));
}

// 줄바꿈 스타일 감지
const NL = src.includes('\r\n') ? '\r\n' : '\n';
const lines = src.split(NL);

// updateAiLayer 함수 시작 줄과 끝 줄 찾기
let funcStart = -1;
let funcEnd = -1;
for (let i = 0; i < lines.length; i++) {
    if (lines[i].match(/^function updateAiLayer\(code, summary, sentiment\)/)) {
        funcStart = i;
        // 중괄호 카운트로 함수 끝 찾기
        let braceCount = 0;
        for (let j = i; j < lines.length; j++) {
            const line = lines[j];
            for (const ch of line) {
                if (ch === '{') braceCount++;
                if (ch === '}') braceCount--;
            }
            if (braceCount === 0 && j > i) {
                funcEnd = j;
                break;
            }
        }
        break;
    }
}

if (funcStart === -1) {
    console.error('[B5v3] ❌ updateAiLayer 함수를 찾을 수 없습니다');
    process.exit(1);
}

console.log(`[B5v3] updateAiLayer 발견: L${funcStart + 1}~L${funcEnd + 1}`);

// 새 함수 코드
const newFuncLines = [
    'function updateAiLayer(code, summary, sentiment) {',
    '    const layers = getLayers(code);',
    '    const prev = layers.AI\uBD84\uC11D || {};',
    '    const now = new Date().toISOString();',
    '',
    '    // \uC911\uBCF5 \uBC29\uC9C0: \uAC19\uC740 \uC694\uC57D\uC774\uBA74 \uC2DC\uAC01\uB9CC \uAC31\uC2E0',
    '    if (prev.latestSummary === summary) {',
    '        prev.updatedAt = now;',
    '        prev.lastAnalyzedAt = now;',
    '        layers.AI\uBD84\uC11D = prev;',
    '        saveCompanyJSON(code, \'layers.json\', layers);',
    '        return;',
    '    }',
    '',
    '    // \uC774\uC804 \uBD84\uC11D\uC744 history\uC5D0 push',
    '    const history = Array.isArray(prev.history) ? [...prev.history] : [];',
    '    if (prev.latestSummary) {',
    '        history.push({',
    '            summary: prev.latestSummary,',
    '            sentiment: prev.sentiment,',
    '            analyzedAt: prev.updatedAt || prev.lastAnalyzedAt || now',
    '        });',
    '    }',
    '    // \uCD5C\uADFC 10\uAC74\uB9CC \uC720\uC9C0',
    '    while (history.length > 10) history.shift();',
    '',
    '    // \uD558\uC704\uD638\uD658 \uD544\uB4DC(latestSummary, sentiment, updatedAt) \uC720\uC9C0 + \uC2E0\uADDC \uD544\uB4DC \uCD94\uAC00',
    '    layers.AI\uBD84\uC11D = {',
    '        latestSummary: summary,',
    '        sentiment,',
    '        updatedAt: now,',
    '        history,',
    '        lastAnalyzedAt: now',
    '    };',
    '    saveCompanyJSON(code, \'layers.json\', layers);',
    '}'
];

// 함수 교체
lines.splice(funcStart, funcEnd - funcStart + 1, ...newFuncLines);

const result = lines.join(NL);
fs.writeFileSync(COMPANY_DATA, result, 'utf8');
console.log('[B5v3] ✅ 함수 교체 완료');

// 문법 검증
try {
    require('child_process').execSync('node --check utils/company-data.js', { cwd: __dirname });
    console.log('[B5v3] ✅ 문법 검증 통과');
} catch (e) {
    console.error('[B5v3] ❌ 문법 검증 실패:', e.stderr?.toString().substring(0, 200));
    process.exit(1);
}

// 기능 검증
const verifyStr = fs.readFileSync(COMPANY_DATA, 'utf8');
const checks = ['history.push(', 'lastAnalyzedAt', 'prev.latestSummary === summary', 'while (history.length > 10)'];
const allPassed = checks.every(c => verifyStr.includes(c));
if (allPassed) {
    console.log('[B5v3] ✅ 기능 검증 통과');
} else {
    console.error('[B5v3] ❌ 기능 검증 실패');
    process.exit(1);
}
