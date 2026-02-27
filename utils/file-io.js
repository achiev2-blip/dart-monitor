/**
 * DART 모니터 — 파일 I/O 유틸리티
 * 
 * JSON 파일 읽기/쓰기 + 데이터 디렉토리 관리
 * server.js에서 그대로 추출 (로직 변경 없음)
 */
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../config');

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function saveJSON(filename, data) {
    ensureDataDir();
    const filepath = path.join(DATA_DIR, filename);
    try {
        fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf-8');
        return true;
    } catch (e) {
        console.error(`[저장실패] ${filename}:`, e.message);
        return false;
    }
}

function loadJSON(filename, fallback) {
    const filepath = path.join(DATA_DIR, filename);
    try {
        if (fs.existsSync(filepath)) {
            return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
        }
    } catch (e) {
        console.error(`[로드실패] ${filename}:`, e.message);
    }
    return fallback;
}

module.exports = { ensureDataDir, saveJSON, loadJSON };
