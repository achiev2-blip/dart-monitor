# 📊 DART 공시 모니터 v3 — Node.js 서버

## 최초 설치 (1회만)

1. 이 폴더를 `D:\dart-monitor`에 복사
2. `start.bat` 더블클릭 (자동으로 패키지 설치 + 서버 시작)
3. 브라우저에서 http://localhost:3000 접속

## 이후 실행

- `start.bat` 더블클릭만 하면 됩니다
- 서버 종료: cmd 창에서 `Ctrl+C`

## 폴더 구조

```
D:\dart-monitor\
├── server.js              ← 백엔드 서버 (DART/뉴스/리포트/텔레그램)
├── config.js              ← 환경 설정 (.env 기반)
├── package.json           ← 의존성 목록
├── start.bat              ← 실행 스크립트
├── migrate-phase2.js      ← 데이터 마이그레이션 스크립트
├── .env                   ← API 키 (DART, Gemini, 한투)
├── crawlers/
│   └── hantoo.js          ← 한투 API (현재가, 일봉, 워치리스트)
├── utils/
│   ├── file-io.js         ← JSON 파일 읽기/쓰기
│   └── company-data.js    ← 기업별 데이터 관리
├── public/
│   └── index.html         ← 프론트엔드 UI (Chart.js 차트 포함)
└── data/
    ├── watchlist.json      ← 워치리스트 (동적 관리)
    ├── stock_prices.json   ← 전체 주가 (한투 API)
    ├── companies/          ← 기업별 데이터 폴더
    │   └── {종목코드}/
    │       ├── info.json   ← 기본 정보
    │       ├── price.json  ← 현재가 + 일봉
    │       ├── reports.json← 관련 리포트
    │       └── layers.json ← 7레이어 누적 데이터
    ├── news.json           ← 뉴스 (최대 500건)
    ├── reports_*.json      ← 증권사 리포트 (소스별)
    └── sent_items.json     ← 텔레그램 전송 이력
```

## 주요 API

| 엔드포인트 | 설명 |
|---|---|
| `GET /api/dart` | DART 공시 조회 |
| `GET /api/companies` | 전 종목 요약 (현재가+등락률) |
| `GET /api/companies/:code` | 기업별 전체 레이어 |
| `GET /api/watchlist` | 워치리스트 조회 |
| `POST /api/watchlist` | 종목 추가 |
| `DELETE /api/watchlist` | 종목 삭제 |
| `GET /api/reports` | 증권사 리포트 |
| `GET /api/news` | 뉴스 수집 |
| `POST /api/gemini` | AI 분석 |
| `GET /api/claude` | Claude용 요약 데이터 |

## 서버가 꺼졌다 다시 켜면?

`data/` 폴더에 저장된 데이터가 자동 복원됩니다.
뉴스, 리포트, 주가, 전송 이력 모두 이어집니다.

## API 키 (.env)

- `DART_API_KEY` — DART 공시 API
- `GEMINI_KEY` — Gemini AI 분석
- `HANTOO_APP_KEY` / `HANTOO_APP_SECRET` — 한국투자증권 API
- `INTERNAL_API_KEY` — 내부 API 인증
