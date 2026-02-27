#!/bin/bash
cd ~/dart-monitor

echo "=== 1. hantoo.js에 getTokenInfo 함수 추가 ==="
# Exports 주석 블록 바로 위에 함수 삽입
sed -i '/^\/\/ =\+$/,/^\/\/ Exports/{
/^\/\/ =\+$/{
/Exports/!{
N
/Exports/i\
// 현재 토큰 정보 조회\
function getTokenInfo() {\
    if (!accessToken) return null;\
    return {\
        token: accessToken,\
        expiry: new Date(tokenExpiry).toISOString(),\
        remainHours: Math.max(0, Math.round((tokenExpiry - Date.now()) / 3600000)),\
        appKey: APP_KEY\
    };\
}\

}
}
}' crawlers/hantoo.js

echo "=== 2. hantoo.js exports에 getTokenInfo 추가 ==="
sed -i '/getWatchlist.*=>/a\    getTokenInfo,' crawlers/hantoo.js

echo "=== 3. context.js — stock-detail 모드 ==="
sed -i '/commands: pendingCommands,/a\                hantooToken: hantoo.getTokenInfo(),' routes/context.js

echo "=== 4. context.js — overview 모드 ==="
sed -i '/commands: pendingCmds,/a\            hantooToken: hantoo.getTokenInfo(),' routes/context.js

echo ""
echo "=== 검증 ==="
echo "--- getTokenInfo in hantoo.js ---"
grep -n "getTokenInfo" crawlers/hantoo.js
echo ""
echo "--- hantooToken in context.js ---"
grep -n "hantooToken" routes/context.js
echo ""
echo "=== 완료! pm2 restart dart-monitor 실행하세요 ==="
