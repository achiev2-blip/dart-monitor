#!/bin/bash
# VM에 data-viewer.js POST 쓰기 엔드포인트 추가 패치
# 사용법: GCP SSH에서 bash patch-data-write.sh

cd ~/dart-monitor

# 백업
cp routes/data-viewer.js routes/data-viewer.js.bak

# module.exports 위에 POST 엔드포인트 삽입
cat > /tmp/data-write-patch.js << 'PATCH_EOF'
// POST /api/data-file — JSON 파일 쓰기
// body: { path: "watchlist.json", content: { ... } }
router.post('/data-file', (req, res) => {
    const { path: relPath, content } = req.body;
    if (!relPath) return res.status(400).json({ error: 'path 필수' });
    if (content === undefined) return res.status(400).json({ error: 'content 필수' });

    // .json 확장자만 허용
    if (!relPath.endsWith('.json')) {
        return res.status(400).json({ error: '.json 파일만 쓰기 가능' });
    }

    const full = path.join(DATA_DIR, relPath);
    if (!isSafePath(full)) return res.status(403).json({ error: '접근 불가' });

    try {
        // 크기 제한 (5MB)
        const jsonStr = JSON.stringify(content, null, 2);
        if (jsonStr.length > 5 * 1024 * 1024) {
            return res.status(413).json({ error: '데이터가 너무 큽니다 (5MB 초과)' });
        }

        // 서브디렉토리 자동 생성
        const dir = path.dirname(full);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        fs.writeFileSync(full, jsonStr, 'utf-8');
        const stat = fs.statSync(full);
        res.json({
            ok: true, path: relPath,
            size: stat.size, modified: stat.mtime.toISOString()
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
PATCH_EOF

# 기존 파일에서 module.exports 줄 제거 후 패치 추가
sed -i '/^module\.exports = router;/d' routes/data-viewer.js

# 패치 코드 + module.exports 추가
cat /tmp/data-write-patch.js >> routes/data-viewer.js
echo "" >> routes/data-viewer.js
echo "module.exports = router;" >> routes/data-viewer.js

# 정리
rm /tmp/data-write-patch.js

echo "✅ data-viewer.js 패치 완료"
echo "재시작: pm2 restart dart-monitor"

# 자동 재시작
pm2 restart dart-monitor
echo "✅ PM2 재시작 완료"
