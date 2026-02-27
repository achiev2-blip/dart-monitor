/**
 * 아카이브 조회 API — 독립 라우트 모듈
 * 
 * 목적: 아카이브 데이터를 프론트엔드에서 조회하기 위한 읽기 전용 API
 * 의존: config.DATA_DIR 만 사용 (utils/archive.js 의존 없음)
 * 경로: /api/archive/*
 * 
 * API 목록:
 *   GET /api/archive/status          — 카테고리별 파일 수 + 마지막 수정일
 *   GET /api/archive/list/:type      — 특정 카테고리의 파일명 목록
 *   GET /api/archive/file/:type/:name — 특정 파일 내용 조회
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const router = express.Router();

// ============================================================
// 아카이브 디렉토리 경로 (독립 계산)
// ============================================================
const ARCHIVE_DIR = path.join(config.DATA_DIR, 'context', 'archive');

// 허용된 카테고리 (디렉토리 이름)
const ALLOWED_TYPES = ['daily', 'weekly', 'monthly', 'quarterly', 'yearly', 'events'];

// ============================================================
// 유틸: JSON 파일 수 카운트
// ============================================================
function countJsonFiles(dir) {
    try {
        if (!fs.existsSync(dir)) return 0;
        return fs.readdirSync(dir).filter(f => f.endsWith('.json')).length;
    } catch { return 0; }
}

// ============================================================
// 유틸: 디렉토리 내 가장 최근 수정된 파일의 날짜
// ============================================================
function getLatestModified(dir) {
    try {
        if (!fs.existsSync(dir)) return null;
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
        if (files.length === 0) return null;
        let latest = 0;
        files.forEach(f => {
            const stat = fs.statSync(path.join(dir, f));
            if (stat.mtimeMs > latest) latest = stat.mtimeMs;
        });
        return new Date(latest).toISOString();
    } catch { return null; }
}

// ============================================================
// GET /api/archive/status — 아카이브 현황 조회
// 반환: 카테고리별 파일 수 + 마지막 수정일
// ============================================================
router.get('/archive/status', (req, res) => {
    const status = {};

    ALLOWED_TYPES.forEach(type => {
        const dir = path.join(ARCHIVE_DIR, type);
        status[type] = {
            count: countJsonFiles(dir),
            latestModified: getLatestModified(dir)
        };
    });

    res.json({
        ok: true,
        archiveDir: ARCHIVE_DIR,
        status
    });
});

// ============================================================
// GET /api/archive/list/:type — 파일명 목록 조회
// :type = daily | weekly | monthly | quarterly | yearly | events
// 반환: 파일명 배열 (최신순 정렬)
// ============================================================
router.get('/archive/list/:type', (req, res) => {
    const { type } = req.params;

    // 타입 검증 (path traversal 방지)
    if (!ALLOWED_TYPES.includes(type)) {
        return res.status(400).json({ ok: false, error: `허용되지 않는 타입: ${type}. 허용: ${ALLOWED_TYPES.join(', ')}` });
    }

    const dir = path.join(ARCHIVE_DIR, type);
    if (!fs.existsSync(dir)) {
        return res.json({ ok: true, type, files: [] });
    }

    const files = fs.readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .sort()
        .reverse();  // 최신순

    res.json({ ok: true, type, files, total: files.length });
});

// ============================================================
// GET /api/archive/file/:type/:name — 특정 파일 내용 조회
// :type = daily | weekly | monthly | quarterly | yearly | events
// :name = 파일명 (예: 2026-02-22.json, 20260206.json)
// 반환: 파일 내용 (JSON)
// ============================================================
router.get('/archive/file/:type/:name', (req, res) => {
    const { type, name } = req.params;

    // 타입 검증
    if (!ALLOWED_TYPES.includes(type)) {
        return res.status(400).json({ ok: false, error: `허용되지 않는 타입: ${type}` });
    }

    // 파일명 검증 (path traversal 방지: .json으로 끝나야 하고 ../ 포함 불가)
    if (!name.endsWith('.json') || name.includes('..') || name.includes('/') || name.includes('\\')) {
        return res.status(400).json({ ok: false, error: '잘못된 파일명' });
    }

    const fp = path.join(ARCHIVE_DIR, type, name);
    if (!fs.existsSync(fp)) {
        return res.status(404).json({ ok: false, error: `파일 없음: ${type}/${name}` });
    }

    try {
        const content = JSON.parse(fs.readFileSync(fp, 'utf-8'));
        res.json({ ok: true, type, name, content });
    } catch (e) {
        res.status(500).json({ ok: false, error: `파일 파싱 실패: ${e.message}` });
    }
});

module.exports = router;
