/**
 * AI 권한 테이블 유틸리티 — 독립 모듈
 * 
 * 목적: Claude/Gemini 각 AI의 기능별 권한을 관리
 * 파일: data/permissions_claude.json, data/permissions_gemini.json
 * 의존: config.js만 사용 (다른 모듈 의존 없음)
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');

const DATA_DIR = config.DATA_DIR;

// AI 이름 검증 (claude 또는 gemini만 허용)
const VALID_AI = ['claude', 'gemini'];

// 기본 권한 템플릿 — 모든 권한 ON으로 시작
function getDefaultPermissions(ai) {
    return {
        ai,
        updatedAt: new Date().toISOString(),
        permissions: {
            ctx: {
                read: true,
                write: true,
                save: true,
                analyze: true,
                updateLastRead: true
            },
            arc: {
                read: true,
                daily_save: true,
                weekly_save: true,
                monthly_save: true,
                event_save: true,
                auto_summary: true
            },
            pred: {
                read: true,
                input: true,
                save: true,
                evaluate: true,
                analyze: true
            },
            stock: {
                read: true,
                write: true,
                save: true,
                memo: true,
                signal: true,
                analyze: true
            },
            hantooToken: {
                read: true,
                save: true,
                autoRenew: true,
                locked: true
            },
            system: {
                crawler_read: false,
                crawler_write: false,
                schedule_control: false
            }
        }
    };
}

// 권한 파일 경로
function getPermissionPath(ai) {
    return path.join(DATA_DIR, `permissions_${ai}.json`);
}

// 권한 테이블 로드 — 없으면 기본값 생성
function loadPermissions(ai) {
    if (!VALID_AI.includes(ai)) return null;
    const fp = getPermissionPath(ai);
    try {
        if (fs.existsSync(fp)) {
            return JSON.parse(fs.readFileSync(fp, 'utf-8'));
        }
    } catch (e) {
        console.warn(`[권한] ${ai} 권한 파일 읽기 실패: ${e.message}`);
    }
    // 파일 없으면 기본값 생성 후 저장
    const defaults = getDefaultPermissions(ai);
    savePermissions(ai, defaults);
    return defaults;
}

// 권한 테이블 저장
function savePermissions(ai, data) {
    if (!VALID_AI.includes(ai)) return false;
    const fp = getPermissionPath(ai);
    data.updatedAt = new Date().toISOString();
    fs.writeFileSync(fp, JSON.stringify(data, null, 2), 'utf-8');
    console.log(`[권한] ${ai} 권한 저장 완료`);
    return true;
}

// 특정 권한 체크 — section.action (예: 'ctx.write')
function checkPermission(ai, section, action) {
    const data = loadPermissions(ai);
    if (!data || !data.permissions) return false;
    const sec = data.permissions[section];
    if (!sec) return false;
    return sec[action] === true;
}

// AI 이름 유효성 검증
function isValidAi(ai) {
    return VALID_AI.includes(ai);
}

module.exports = {
    loadPermissions,
    savePermissions,
    checkPermission,
    isValidAi,
    getDefaultPermissions,
    VALID_AI
};
