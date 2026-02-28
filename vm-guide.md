# VM 작업 완전 가이드 — 복사용

## VM 접속 정보

| 항목 | 값 |
|------|-----|
| **IP** | `34.22.94.45` |
| **프로젝트** | `gen-lang-client-0289807056` |
| **Zone** | `asia-northeast3-b` |
| **인스턴스** | `instance-20260223-054504` |
| **API 키** | `dartmonitor-2024` |
| **프로젝트 경로** | `/home/user/dart-monitor/` |
| **홈페이지** | `http://34.22.94.45/?api_key=dartmonitor-2024` |
| **CTX 페이지** | `http://34.22.94.45/context.html` |

---

## API — 데이터 읽기

```powershell
# 서버 상태
Invoke-RestMethod "http://34.22.94.45/api/status?api_key=dartmonitor-2024"

# 데이터 파일 트리
Invoke-RestMethod "http://34.22.94.45/api/data-tree?api_key=dartmonitor-2024"

# 특정 파일 읽기 (data/ 하위만)
Invoke-RestMethod "http://34.22.94.45/api/data-file?api_key=dartmonitor-2024&path=watchlist.json"
Invoke-RestMethod "http://34.22.94.45/api/data-file?api_key=dartmonitor-2024&path=hantoo_token.json"

# Gemini 관련 API
Invoke-RestMethod "http://34.22.94.45/api/gemini/status?api_key=dartmonitor-2024"
Invoke-RestMethod "http://34.22.94.45/api/gemini/news?api_key=dartmonitor-2024&limit=5"
Invoke-RestMethod "http://34.22.94.45/api/gemini/macro?api_key=dartmonitor-2024"
Invoke-RestMethod "http://34.22.94.45/api/gemini/reports?api_key=dartmonitor-2024&limit=5"
Invoke-RestMethod "http://34.22.94.45/api/gemini/ctx?api_key=dartmonitor-2024"
Invoke-RestMethod "http://34.22.94.45/api/gemini/token?api_key=dartmonitor-2024"

# 수집기 상태
Invoke-RestMethod "http://34.22.94.45/api/collection/status?api_key=dartmonitor-2024"

# 일별 피드 (뉴스+공시+리포트 종합)
Invoke-RestMethod "http://34.22.94.45/api/daily-feed?api_key=dartmonitor-2024&days=7"

# AI 상태 (모델, 라운드 등)
Invoke-RestMethod "http://34.22.94.45/api/state/save?api_key=dartmonitor-2024"

# 메모리 사용량
Invoke-RestMethod "http://34.22.94.45/api/memory?api_key=dartmonitor-2024"

# 예측 조회
Invoke-RestMethod "http://34.22.94.45/api/predictions?api_key=dartmonitor-2024"

# DART 공시 (오늘자)
Invoke-RestMethod "http://34.22.94.45/api/gemini/dart?api_key=dartmonitor-2024"
```

## API — 데이터 쓰기

```powershell
# data/ 하위 파일 쓰기 (path는 body에 포함)
$body = @{ path = "파일명.json"; content = @{ key = "value" } } | ConvertTo-Json -Depth 5
Invoke-RestMethod -Method Post -Uri "http://34.22.94.45/api/data-file?api_key=dartmonitor-2024" -ContentType "application/json" -Body $body
# → { ok: true, path, size, modified }
# 제한: .json만, data/ 폴더 내부만, 5MB 이하
```

## 인증 방식 (2가지)

```powershell
# 방법 1: 쿼리 파라미터
?api_key=dartmonitor-2024

# 방법 2: 헤더
-Headers @{ "x-api-key" = "dartmonitor-2024" }
```

## API — Gemini 채팅

```powershell
# 채팅 (page: 'dart' | 'context')
$body = @{
    message = "질문 내용"
    context = @{ page = "dart" }  # 또는 "context" (CTX 페이지)
    history = @()
} | ConvertTo-Json -Depth 3
$r = Invoke-RestMethod -Method Post -Uri "http://34.22.94.45/api/gemini/chat?api_key=dartmonitor-2024" -ContentType "application/json" -Body $body -TimeoutSec 30
$r.reply
```

---

## SSH 직접 접속

```powershell
# 명령 실행 (한 줄)
gcloud compute ssh instance-20260223-054504 --project=gen-lang-client-0289807056 --zone=asia-northeast3-b --command="명령어"

# 인터랙티브 SSH
gcloud compute ssh instance-20260223-054504 --project=gen-lang-client-0289807056 --zone=asia-northeast3-b
```

## SCP 파일 전송

```powershell
# VM → 로컬 다운로드
gcloud compute scp instance-20260223-054504:/home/user/dart-monitor/routes/ai-space.js "d:\dart-monitor\dart-monitor\routes\ai-space.js" --project=gen-lang-client-0289807056 --zone=asia-northeast3-b

# 로컬 → VM 업로드
gcloud compute scp "d:\dart-monitor\dart-monitor\파일명" instance-20260223-054504:/tmp/파일명 --project=gen-lang-client-0289807056 --zone=asia-northeast3-b

# 디렉토리 통째 (--recurse)
gcloud compute scp --recurse instance-20260223-054504:/home/user/dart-monitor/routes/ "d:\dart-monitor\dart-monitor\routes\" --project=gen-lang-client-0289807056 --zone=asia-northeast3-b
```

---

## 배포 절차 (로컬 → VM)

```powershell
# 1. 로컬에서 파일 수정 후 SCP 업로드
gcloud compute scp "로컬경로" instance-20260223-054504:/home/user/dart-monitor/대상경로 --project=gen-lang-client-0289807056 --zone=asia-northeast3-b

# 2. VM에서 PM2 재시작
gcloud compute ssh instance-20260223-054504 --project=gen-lang-client-0289807056 --zone=asia-northeast3-b --command="cd /home/user/dart-monitor && sudo pm2 restart dart-monitor"

# 3. 검증
Invoke-RestMethod "http://34.22.94.45/api/status?api_key=dartmonitor-2024"
```

## 패치 스크립트 방식 (대안)

```powershell
# 1. 패치 스크립트를 /tmp에 업로드
gcloud compute scp "d:\dart-monitor\dart-monitor\patch.js" instance-20260223-054504:/tmp/patch.js --project=gen-lang-client-0289807056 --zone=asia-northeast3-b

# 2. VM에서 실행
gcloud compute ssh instance-20260223-054504 --project=gen-lang-client-0289807056 --zone=asia-northeast3-b --command="sudo node /tmp/patch.js"

# 3. PM2 재시작
gcloud compute ssh instance-20260223-054504 --project=gen-lang-client-0289807056 --zone=asia-northeast3-b --command="cd /home/user/dart-monitor && sudo pm2 restart dart-monitor"
```

---

## 한투 API 키

```
HANTOO_APP_KEY=PSPolkpHLnT09OlAOlQGpkVNVJipfOtddQ
HANTOO_APP_SECRET=rS43rcXgkVdB1AVrzFH6kv//p5s8vT3G4=nwzLZ62TP8aIWK16eE8ZpRiOQFiGKyWWjj9dpPq/bYfSl6G
```

## 토큰 유효성 확인

```powershell
$r = Invoke-RestMethod "http://34.22.94.45/api/gemini/token?api_key=dartmonitor-2024"
$expiry = $r.token.expiry
$expiryDate = (New-Object DateTime(1970,1,1,0,0,0,[DateTimeKind]::Utc)).AddMilliseconds($expiry)
Write-Host "만료(KST): $($expiryDate.AddHours(9).ToString('yyyy-MM-dd HH:mm:ss'))"
Write-Host "남은: $([math]::Round(($expiryDate - [DateTime]::UtcNow).TotalHours, 1))시간"
```

---

## 프로젝트 디렉토리 구조 (2026-02-27 동기화 기준)

```
dart-monitor/
├── server.js              # 메인 서버
├── config.js              # 설정 (API키, 경로 등)
├── .env                   # 환경 변수 (한투키, Gemini키 등)
├── package.json
│
├── routes/                # API 라우트
│   ├── ai-space.js        # ⭐ Gemini/Claude 챗봇 핵심 (Chat 핸들러)
│   ├── dart.js            # DART 공시 조회
│   ├── context.js         # CTX 컨텍스트 관리
│   ├── news.js            # 뉴스 라우트
│   ├── macro.js           # 매크로 라우트
│   ├── reports.js         # 리포트 라우트
│   ├── stocks.js          # 종목 라우트
│   ├── data-viewer.js     # 데이터 파일 읽기/쓰기 API
│   ├── predictions.js     # 예측 라우트
│   ├── archive.js         # 아카이브
│   ├── system.js          # 시스템
│   ├── backup.js          # 백업
│   └── telegram.js        # 텔레그램
│
├── crawlers/              # 데이터 수집기
│   ├── hantoo.js          # 한투 API (주가, 워치리스트)
│   ├── news.js            # 뉴스 크롤러
│   ├── macro.js           # 매크로 지표 수집
│   ├── reports.js         # 리포트 수집
│   └── consensus.js       # 컨센서스 수집
│
├── services/
│   └── gemini.js          # Gemini API 호출
│
├── utils/
│   ├── company-data.js    # 종목 데이터 유틸
│   ├── permissions.js     # AI 권한 관리
│   ├── prediction.js      # 예측 유틸
│   ├── file-io.js         # 파일 IO
│   └── archive.js         # 아카이브 유틸
│
├── public/                # 프론트엔드
│   ├── index.html         # 메인 (DART 공시 모니터)
│   ├── context.html       # CTX (Context Tracker) ⭐
│   ├── stocks.html        # 종목 상세
│   ├── us_market.html     # US 마켓
│   ├── predictions.html   # 예측
│   ├── archive.html       # 아카이브
│   ├── news-viewer.html   # 뉴스 뷰어
│   ├── data-viewer.html   # 데이터 뷰어
│   ├── gemini-chat.js     # 채팅 위젯 JS
│   └── gemini-chat.css    # 채팅 위젯 CSS
│
└── data/                  # 런타임 데이터 (VM에만)
    ├── watchlist.json
    ├── news.json
    ├── hantoo_token.json
    ├── dart_*.json         # DART 공시 (날짜별)
    ├── companies/{CODE}/   # 종목별 (context.json, price.json 등)
    ├── context/            # commands.json, market.json
    └── macro/              # current.json, daily/
```

---

## 미완료 작업 (다음 대화에서 이어할 것)

### 1. CTX 채팅 버그 수정 (패치 스크립트 준비됨)
- **문제 A**: `context.html`이 `page: 'context'` 보내는데, `ai-space.js`가 `page === 'ctx'`로 체크 → 불일치
- **문제 B**: 매크로 필드 `current.vix.value` → 실제는 `current.vix.price`
- **수정**: `ai-space.js` Line 763, 782~786 수정
- **방법**: 로컬에서 직접 `routes/ai-space.js` 편집 → SCP 배포 → PM2 restart

### 2. DART 공시 수집 점검
- `dart_*.json` 파일이 **2/25까지만** 존재 (2/26~27 없음)
- `routes/dart.js` (DART 수집 크롤러) 분석 필요
- DART 2페이지 로드 시 500 에러 발생
- 수집기 상태에 DART가 포함 안 됨 → 별도 스케줄러인지 확인 필요

### 3. 서버 메모리 데이터 현황
- 뉴스: 1000건 (req.app.locals.storedNews)
- 리포트: 462건 (req.app.locals.reportStores)
- 매크로: VIX 18.63, S&P 6908, USD/KRW 1289 (req.app.locals.macro)
- 한투 토큰: 유효 (2027-02-27 17:34 KST 만료)
