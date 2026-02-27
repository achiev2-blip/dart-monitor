const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { saveJSON, loadJSON } = require('../utils/file-io');
const router = express.Router();

const DATA_DIR = config.DATA_DIR;

// 백업 설정
const BACKUP_CONFIG_FILE = path.join(DATA_DIR, 'backup_config.json');
let backupConfig = loadJSON('backup_config.json', {
    enabled: true,
    folderPath: 'G:\\dart-backup',
    intervalHours: 6,
    lastBackup: null
});

function saveBackupConfig() {
    saveJSON('backup_config.json', backupConfig);
}

function createBackupZip(targetDir, storedNews, reportStores, sentItems, reportCache) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupFolder = path.join(targetDir, 'dart-backup-' + timestamp);

    try {
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
        if (!fs.existsSync(backupFolder)) fs.mkdirSync(backupFolder, { recursive: true });

        const files = ['news.json', 'reports.json', 'sent_items.json', 'report_cache.json',
            'reports_wisereport.json', 'reports_mirae.json', 'reports_hana.json',
            'reports_hyundai.json', 'reports_naver.json', 'report_ai_cache.json'];
        let copied = 0;
        for (const file of files) {
            const src = path.join(DATA_DIR, file);
            if (fs.existsSync(src)) {
                fs.copyFileSync(src, path.join(backupFolder, file));
                copied++;
            }
        }

        const dartFiles = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('dart_') && f.endsWith('.json'));
        for (const f of dartFiles) {
            fs.copyFileSync(path.join(DATA_DIR, f), path.join(backupFolder, f));
            copied++;
        }

        const totalReportCount = Object.values(reportStores).reduce((sum, arr) => sum + arr.length, 0);
        const meta = {
            timestamp: new Date().toISOString(),
            news: storedNews.length,
            reports: totalReportCount,
            sentItems: Object.keys(sentItems).length,
            files: copied
        };
        fs.writeFileSync(path.join(backupFolder, '_backup_meta.json'), JSON.stringify(meta, null, 2));

        cleanOldBackups(targetDir, 30);

        backupConfig.lastBackup = new Date().toISOString();
        saveBackupConfig();

        console.log(`[백업] 완료: ${backupFolder} (${copied}개 파일)`);
        return { success: true, path: backupFolder, files: copied, timestamp: meta.timestamp };
    } catch (e) {
        console.error(`[백업] 실패: ${e.message}`);
        return { success: false, error: e.message };
    }
}

function cleanOldBackups(dir, maxKeep) {
    try {
        const dirs = fs.readdirSync(dir)
            .filter(d => d.startsWith('dart-backup-'))
            .sort()
            .reverse();
        if (dirs.length > maxKeep) {
            for (let i = maxKeep; i < dirs.length; i++) {
                const old = path.join(dir, dirs[i]);
                fs.rmSync(old, { recursive: true, force: true });
                console.log(`[백업정리] 삭제: ${dirs[i]}`);
            }
        }
    } catch (e) { }
}

// 자동 백업 스케줄러
let backupTimer = null;
function startAutoBackup(getLocals) {
    if (backupTimer) clearInterval(backupTimer);
    if (!backupConfig.enabled || !backupConfig.folderPath) return;

    const ms = (backupConfig.intervalHours || 6) * 3600000;
    backupTimer = setInterval(() => {
        console.log('[자동백업] 실행...');
        const locals = getLocals();
        createBackupZip(backupConfig.folderPath, locals.storedNews, locals.reportStores, locals.sentItems, locals.reportCache);
    }, ms);
    console.log(`[자동백업] ${backupConfig.intervalHours}시간 간격 설정됨 → ${backupConfig.folderPath}`);
}

// 백업 API
router.get('/backup', (req, res) => {
    const { storedNews, reportStores, sentItems, reportCache } = req.app.locals;
    const allReports = [];
    Object.values(reportStores).forEach(items => allReports.push(...items));
    res.json({
        news: storedNews,
        reports: allReports,
        reportStores,
        sentItems,
        reportCache,
        timestamp: new Date().toISOString()
    });
});

router.get('/backup/config', (req, res) => {
    res.json(backupConfig);
});

router.post('/backup/config', (req, res) => {
    const { enabled, folderPath, intervalHours } = req.body;
    if (typeof enabled !== 'undefined') backupConfig.enabled = !!enabled;
    if (folderPath !== undefined) backupConfig.folderPath = folderPath;
    if (intervalHours) backupConfig.intervalHours = Math.max(1, Math.min(24, intervalHours));
    saveBackupConfig();
    if (backupConfig.enabled) startAutoBackup(() => req.app.locals);
    else if (backupTimer) { clearInterval(backupTimer); backupTimer = null; }
    res.json({ ok: true, config: backupConfig });
});

router.post('/backup/now', (req, res) => {
    const folder = req.body.folderPath || backupConfig.folderPath;
    if (!folder) return res.status(400).json({ error: '백업 폴더 경로가 설정되지 않았습니다' });
    const { storedNews, reportStores, sentItems, reportCache } = req.app.locals;
    const result = createBackupZip(folder, storedNews, reportStores, sentItems, reportCache);
    res.json(result);
});

router.post('/backup/restore', (req, res) => {
    const { folderPath } = req.body;
    if (!folderPath) return res.status(400).json({ error: '복원할 폴더 경로 필요' });
    const { storedNews, reportStores, sentItems } = req.app.locals;

    try {
        const files = ['news.json', 'reports.json', 'sent_items.json', 'report_cache.json'];
        let restored = 0;
        for (const file of files) {
            const src = path.join(folderPath, file);
            if (fs.existsSync(src)) {
                fs.copyFileSync(src, path.join(DATA_DIR, file));
                restored++;
            }
        }
        // 메모리 갱신 (참조 유지를 위해 배열/객체 내용 교체)
        const newNews = loadJSON('news.json', []);
        storedNews.length = 0;
        storedNews.push(...newNews);

        const newSent = loadJSON('sent_items.json', {});
        Object.keys(sentItems).forEach(k => delete sentItems[k]);
        Object.assign(sentItems, newSent);

        const newReportCache = loadJSON('report_cache.json', {});
        const reportCache = req.app.locals.reportCache;
        Object.keys(reportCache).forEach(k => delete reportCache[k]);
        Object.assign(reportCache, newReportCache);

        // 소스별 리포트 복원
        const storeMap = {
            WiseReport: 'reports_wisereport.json',
            '미래에셋': 'reports_mirae.json',
            '하나증권': 'reports_hana.json',
            '현대차증권': 'reports_hyundai.json',
            '네이버': 'reports_naver.json'
        };
        for (const [key, fname] of Object.entries(storeMap)) {
            const data = loadJSON(fname, []);
            reportStores[key].length = 0;
            reportStores[key].push(...data);
        }

        // 기존 reports.json 마이그레이션
        const totalCount = Object.values(reportStores).reduce((sum, arr) => sum + arr.length, 0);
        const legacy = loadJSON('reports.json', []);
        if (legacy.length > 0 && totalCount === 0) {
            legacy.forEach(r => {
                const src = r.source || '네이버';
                if (reportStores[src]) reportStores[src].push(r);
            });
        }

        res.json({ success: true, restored });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = { router, startAutoBackup, backupConfig };
