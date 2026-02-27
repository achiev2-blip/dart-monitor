#!/bin/bash
# GCP에서 직접 실행 — context.js, ai-space.js 패치
# _instructions 강화 + apiGuide 추가

cd ~/dart-monitor

echo "=== 1. context.js _instructions 패치 ==="
# 옛날 ⚠️ 버전을 🚨 버전으로 교체 (2곳)
sed -i "s|⚠️ 전용 API 활성화됨. 모든 읽기/쓰기는 /api/claude/\* 경로 사용. 읽기: GET /api/claude/ctx, /api/claude/news, /api/claude/reports, /api/claude/prices, /api/claude/dart, /api/claude/macro, /api/claude/commands, /api/claude/predictions, /api/claude/stocks/:code/analysis. 쓰기: POST /api/claude/ctx (시장+종목+인사이트), POST /api/claude/archive (type+data), POST /api/claude/predictions, POST /api/claude/commands (text). 인증: ?api_key=dartmonitor-claude. 1) commands 먼저 확인하고 미완료 명령 처리. 2) 종목 분석 시 consensus 참고. 3) 작업 완료 후 POST /api/claude/ctx로 결과 저장.|🚨 [필수] 이 응답의 기존 경로(/api/context 등)는 사용하지 말 것. 전용 API가 활성화됨. 작업 시작 전 반드시 GET /api/claude/permissions?api_key=dartmonitor-claude 를 먼저 호출하여 전체 API 가이드를 확인할 것. 모든 읽기/쓰기는 /api/claude/* 하위 경로만 사용. 인증: ?api_key=dartmonitor-claude. 1) /api/claude/commands 먼저 확인하고 미완료 명령 처리. 2) 종목 분석 시 consensus 참고. 3) 작업 완료 후 POST /api/claude/ctx로 결과 저장.|g" routes/context.js

# 두번째 _instructions (컨센서스 버전)
sed -i "s|⚠️ 전용 API 활성화됨. 모든 읽기/쓰기는 /api/claude/\* 경로 사용. 읽기: GET /api/claude/ctx, /api/claude/news, /api/claude/reports, /api/claude/prices, /api/claude/dart, /api/claude/macro, /api/claude/commands, /api/claude/predictions, /api/claude/stocks/:code/analysis. 쓰기: POST /api/claude/ctx (시장+종목+인사이트), POST /api/claude/archive (type+data), POST /api/claude/predictions, POST /api/claude/commands (text). 인증: ?api_key=dartmonitor-claude. 1) commands 먼저 확인. 2) 컨센서스 필요 시 GET /api/consensus/:code. 3) 작업 완료 후 POST /api/claude/ctx로 저장.|🚨 [필수] 이 응답의 기존 경로(/api/context 등)는 사용하지 말 것. 전용 API가 활성화됨. 작업 시작 전 반드시 GET /api/claude/permissions?api_key=dartmonitor-claude 를 먼저 호출하여 전체 API 가이드를 확인할 것. 모든 읽기/쓰기는 /api/claude/* 하위 경로만 사용. 인증: ?api_key=dartmonitor-claude. 1) /api/claude/commands 먼저 확인. 2) 컨센서스 필요 시 GET /api/consensus/:code. 3) 작업 완료 후 POST /api/claude/ctx로 저장.|g" routes/context.js

# 확인
echo "context.js 패치 확인:"
grep -c "필수" routes/context.js
echo "(2가 나와야 정상)"

echo ""
echo "=== 2. ai-space.js permissions에 apiGuide 추가 ==="
# 기존: res.json({ ok: true, ...data });
# 변경: apiGuide 객체 추가
sed -i '/권한 테이블 조회.*AI가 입장/,/res\.json.*ok: true.*\.\.\.data/ {
  s|res\.json({ ok: true, \.\.\.data });|// API 가이드 — Claude가 사용 가능한 전체 경로\
        const apiGuide = {\
            _notice: "\xf0\x9f\x9a\xa8 이 가이드를 반드시 읽고 아래 경로만 사용할 것. /api/context, /api/predictions 등 기존 경로 사용 금지.",\
            auth: "모든 요청에 ?api_key=dartmonitor-claude",\
            read: {\
                "GET /api/claude/ctx": "시장 요약 + 종목 컨텍스트",\
                "GET /api/claude/news?limit=N": "최신 뉴스 (기본 30건)",\
                "GET /api/claude/reports?limit=N": "리서치 리포트 (기본 30건)",\
                "GET /api/claude/prices": "전 종목 현재가/등락률",\
                "GET /api/claude/dart": "최신 DART 공시",\
                "GET /api/claude/macro": "매크로 지표",\
                "GET /api/claude/overseas": "미국시장 지표",\
                "GET /api/claude/commands": "미완료 사용자 명령 목록",\
                "GET /api/claude/token": "한투 API 토큰 (읽기 전용)",\
                "GET /api/claude/predictions": "예측 데이터",\
                "GET /api/claude/stocks/:code/analysis": "종목별 AI 분석",\
                "GET /api/consensus/:code": "종목별 컨센서스"\
            },\
            write: {\
                "POST /api/claude/ctx": { body: "{ market, stocks, insights, newsDigest }", desc: "분석 결과 저장" },\
                "POST /api/claude/archive": { body: "{ type, data }", desc: "아카이브 저장" },\
                "POST /api/claude/predictions": { body: "{ predictions:[] }", desc: "예측 저장" },\
                "POST /api/claude/commands": { body: "{ text }", desc: "새 명령 추가" },\
                "PATCH /api/claude/commands": { body: "{ id, done:true, result }", desc: "명령 완료 처리" }\
            },\
            workflow: [\
                "1. 이 permissions 응답으로 API 확인",\
                "2. GET /api/claude/commands 로 미완료 명령 확인",\
                "3. GET /api/claude/ctx 로 현재 컨텍스트 읽기",\
                "4. 필요 시 news, reports, prices, dart, macro 추가 조회",\
                "5. 분석 완료 후 POST /api/claude/ctx 로 결과 저장"\
            ]\
        };\
        res.json({ ok: true, apiGuide, ...data });|
}' routes/ai-space.js

echo "ai-space.js 패치 확인:"
grep -c "apiGuide" routes/ai-space.js
echo "(2 이상이면 정상)"

echo ""
echo "=== 3. 서버 재시작 ==="
pm2 restart dart-monitor
echo ""
echo "=== 완료! ==="
