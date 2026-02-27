# DART 모니터 — 데이터 지도 (Data Map)
# Claude가 시스템 진입 시 참조하는 전체 데이터 구조 안내서
# 최종 갱신: 2026-02-22

## 개요
이 문서는 DART 모니터 시스템이 수집·저장하는 **모든 데이터의 위치, 구조, 갱신 주기, 접근 방법**을 정리한 지도입니다.
데이터가 나뉘어 저장되어 있으므로, 이 지도를 먼저 확인한 후 필요한 데이터를 찾아가세요.

---

## 1. 폴더 구조 전체도

```
data/
│
├── 🔑 hantoo_token.json          ← 한투 API OAuth 토큰 (자동 갱신, 24시간)
├── 📋 watchlist.json              ← 워치리스트 (종목 배열: name, code, sector)
│
├── 📰 news.json                   ← 수집된 뉴스 전체 배열
├── 📊 reports.json                ← 통합 리포트 (레거시)
├── 📊 reports_naver.json          ← 네이버 리서치 리포트
├── 📊 reports_hana.json           ← 하나증권 리포트
├── 📊 reports_mirae.json          ← 미래에셋 리포트
├── 📊 reports_wisereport.json     ← 와이즈리포트 리포트
├── 📊 report_last_dates.json      ← 소스별 마지막 수집일 (KST)
├── 📊 report_cache.json           ← 리포트 원문 캐시
├── 🤖 report_ai_cache.json        ← AI 분석 결과 캐시
├── ✈️ sent_items.json              ← 텔레그램 전송 이력
├── 💾 server_state.json           ← 서버 상태 (Gemini 쿨다운 등)
├── 📝 context_data.json           ← 컨텍스트 데이터
│
├── 🏢 companies/                  ← ⭐ 기업별 데이터 (종목코드 = 폴더명)
│   └── {6자리코드}/               예: 005930 = 삼성전자
│       ├── info.json              ← 기본정보 {name, code, sector, createdAt}
│       ├── price.json             ← 현재가 + 일봉 + 시간외
│       ├── reports.json           ← 기업 관련 리포트 (최대 100건)
│       ├── layers.json            ← ⭐ 7레이어 통합 데이터 (핵심!)
│       ├── intraday/              ← 5분 틱 데이터 (7일 보존)
│       │   └── {YYYYMMDD}.json
│       └── intraday_summary/      ← AI 일중 분석 (30일 보존)
│           └── {YYYYMMDD}.json
│
├── 🌍 macro/                      ← 글로벌 매크로 경제 지표
│   ├── current.json               ← 최신 전체 지표 (30분마다 갱신)
│   ├── closing.json               ← 미장 마감 확정 종가 (KST 06:30)
│   ├── alerts.json                ← 급변 알림 이력 (최대 100건)
│   ├── market_investor.json       ← 외인/기관 순매수 (네이버 크롤링)
│   └── daily/                     ← 일별 스냅샷 히스토리 (30일 보존)
│       └── {YYYY-MM-DD}.json
│
├── 🎯 predictions/                ← 예측 피드백 루프
│   ├── active/                    ← 진행 중 예측
│   ├── evaluated/                 ← 평가 완료 (90일 보존)
│   └── stats.json                 ← 적중률 통계
│
└── 📦 context/                    ← 아카이브 시스템
    ├── archive/
    │   ├── daily/{YYYY-MM-DD}.json     ← 일별 스냅샷 (30일)
    │   ├── weekly/{YYYY-Wnn}.json      ← 주간 요약 (1년)
    │   ├── monthly/{YYYY-MM}.json      ← 월간 요약 (영구)
    │   ├── quarterly/{YYYY-Qn}.json    ← 분기 요약 (3년)
    │   ├── yearly/{YYYY}.json          ← 연간 요약 (영구)
    │   ├── events/                     ← 변곡점 이벤트 (영구)
    │   └── trump_policy.json           ← 정책 데이터
    ├── sectors/                    ← 섹터별 집계
    └── stocks/                     ← 종목별 컨텍스트
```

---

## 2. 핵심 데이터 접근 가이드

### 🔍 특정 종목 데이터를 찾을 때
```
1. watchlist.json → 종목코드 확인 (예: "삼성전자" → "005930")
2. companies/005930/layers.json → 7레이어 통합 데이터 (가장 중요!)
   ├── 기본정보: {name, code}
   ├── 시세: {current:{price,change,...}, daily:[{date,OHLCV}...]}
   ├── 공시: [{title, date, ...}]
   ├── 리포트: [{title, date, source, ...}]  (최대 50건)
   ├── 뉴스: [{title, link, category, ...}]  (최대 100건)
   ├── AI분석: {latestSummary, sentiment}
   └── 메모: {notes, tags}
3. companies/005930/price.json → 상세 가격 (60일 일봉 포함)
4. companies/005930/intraday/{오늘날짜}.json → 당일 5분 틱
```

### 🌎 시장 전체 상황을 알고 싶을 때
```
1. macro/current.json → 글로벌 지표 한 눈에
   ├── sox, vix, usdkrw (핵심 3개)
   ├── indices: {sp500, nasdaq, dow, dxy}
   ├── futures: {nasdaq, sp500, dow}
   ├── semiEquip: {lrcx, klac}  ← 반도체 장비 선행지표
   ├── aiTheme: {arm, smci}
   ├── gold, oil, us10y
   └── dataStatus: "preliminary" | "confirmed"
2. macro/market_investor.json → 외인/기관 순매수
3. macro/alerts.json → 최근 급변동 이벤트
```

### 📰 오늘 뉴스/공시/리포트를 확인할 때
```
1. news.json → 전체 뉴스 배열
2. reports_naver.json / reports_hana.json / reports_mirae.json → 소스별 리포트
3. DART 공시 → API /api/dart 호출 또는 dart_*.json 파일
```

### 📈 과거 트렌드를 확인할 때
```
1. context/archive/daily/{날짜}.json → 특정일 전체 스냅샷
2. context/archive/weekly/{주차}.json → 주간 요약
3. context/archive/monthly/{월}.json → 월간 요약
4. macro/daily/{날짜}.json → 매크로 지표 히스토리 (스냅샷 배열)

⭐ API로 조회:
   GET /api/archive/status        → 카테고리별 파일 수 + 최종 수정일
   GET /api/archive/list/{type}   → 파일명 목록 (daily|weekly|monthly|quarterly|yearly|events)
   GET /api/archive/file/{type}/{filename} → 파일 내용 JSON
```

### 🎯 예측 정확도를 확인할 때
```
1. predictions/stats.json → 전체 통계 (적중률, 평균 점수)
2. predictions/active/ → 현재 진행 중 예측
3. predictions/evaluated/ → 과거 평가 결과
```

---

## 3. API 엔드포인트 (서버 실행 시)

| 엔드포인트 | 설명 | 용도 |
|-----------|------|------|
| `GET /api/status` | 서버 상태 + 주가 + 매크로 | 대시보드 |
| `GET /api/macro` | 매크로 지표 | 시장 분석 |
| `GET /api/stocks` | 전 종목 현재가 | 포트폴리오 |
| `GET /api/stored-news` | 저장된 뉴스 | 뉴스 조회 |
| `GET /api/stored-reports` | 저장된 리포트 | 리포트 조회 |
| `GET /api/dart` | DART 공시 | 공시 조회 |
| `GET /api/predictions` | 예측 목록/통계 | 예측 피드백 |
| `GET /api/data-tree` | 전체 폴더 트리 구조 | 데이터 탐색 |
| `GET /api/data-file?path=...` | 특정 파일 내용 | 파일 조회 |
| `GET /api/daily-feed?days=7` | 최근N일 뉴스/공시/리포트 | 일별 피드 |
| `GET /api/context/current` | 컨텍스트 데이터 | AI 분석 |
| `POST /api/gemini` | Gemini AI 프록시 | AI 질의 |
| `GET /api/archive/status` | 아카이브 현황 (카테고리별 파일 수) | 아카이브 조회 |
| `GET /api/archive/list/:type` | 파일명 목록 (daily,weekly,events 등) | 아카이브 조회 |
| `GET /api/archive/file/:type/:name` | 특정 아카이브 파일 내용 | 아카이브 조회 |
| `GET /api/consensus/:code` | 실시간 컨센서스 (투자의견, 목표주가 등) | 컨센서스 조회 |

### 외부 API (서버가 호출하는 API)

| API | 엔드포인트 | 용도 | 사용 코드 |
|-----|-----------|------|----------|
| 네이버 증권 자동완성 | `GET https://ac.stock.naver.com/ac?q={종목명}&target=stock` | **종목명 → 종목코드 조회** | `crawlers/hantoo.js` → `lookupStockCode()` |
| 한투 KIS | `https://openapi.koreainvestment.com/` | 현재가, 일봉, 시간외 등 | `crawlers/hantoo.js` |
| Yahoo Finance | `https://query1.finance.yahoo.com/` | 미국증시 글로벌 지표 | `crawlers/macro.js` |
| DART API | `https://opendart.fss.or.kr/` | 공시 수집 | `crawlers/dart.js` |

---

## 4. 데이터 흐름 요약

```
[한투 API] ──5분──→ companies/{code}/price.json (현재가)
                  → companies/{code}/intraday/{날짜}.json (5분 틱)
           ──06:00──→ companies/{code}/price.json (60일 일봉)
           ──15:30──→ companies/{code}/price.json (시간외)
           ──장마감──→ companies/{code}/intraday_summary/{날짜}.json (AI 요약)

[Yahoo/네이버] ──30분──→ macro/current.json (글로벌 지표)
                       → macro/daily/{날짜}.json (스냅샷 누적)
              ──06:30──→ macro/closing.json (확정 종가)

[뉴스 RSS] ──수집시──→ news.json
[리포트 크롤링] ──수집시──→ reports_*.json → companies/{code}/layers.json 뉴스/리포트 레이어
[DART 공시] ──수집시──→ companies/{code}/layers.json 공시 레이어

[네이버 증권 AC] ──종목추가시──→ lookupStockCode(종목명) → 종목코드 반환
                               → addStock()에서 watchlist.json에 {name, code} 저장

[아카이브] ──매일 02:00──→ context/archive/daily/{날짜}.json
          ──매주 월요일──→ context/archive/weekly/{주차}.json
          ──매달 1일──→ context/archive/monthly/{월}.json

⭐ 아카이브 → 분석 파이프라인:
[아카이브 저장소] ──→ GET /api/claude  (context.js L648-747)
  context/archive/weekly/   최근 2개  ──→ 응답.archive.weekly
  context/archive/monthly/  최근 1개  ──→ 응답.archive.monthly
  context/archive/quarterly/ 최근 1개 ──→ 응답.archive.quarterly
                                 ↓
                             클로드가 장기 트렌드 분석에 활용

[네이버 금융] ──실시간──→ GET /api/consensus/:code → 컨센서스 (투자의견, 목표주가)
                         GET /api/claude?code=종목코드 → target.consensus에 포함 (유/무 판단)
```

---

## 5. 보존 규칙

| 데이터 | 보존 기간 | 정리 시점 |
|--------|----------|----------|
| 인트라데이 틱 | 7일 | 장외 시간 자동 |
| AI 일중 요약 | 30일 | 장외 시간 자동 |
| 매크로 일별 스냅샷 | 30일 | 수집 시 자동 |
| 아카이브 daily | 30일 | 매일 02:00 |
| 아카이브 weekly | 1년 | 매일 02:00 |
| 아카이브 quarterly | 3년 | 매일 02:00 |
| 평가 완료 예측 | 90일 | 정리 함수 호출 시 |
| 월간/연간/이벤트 | **영구** | — |

---

## 6. 파일 접근 코드 예시 (서버 내부)

```javascript
// 특정 종목 전체 데이터
const companyData = require('./utils/company-data');
const layers = companyData.getLayers('005930');  // 7레이어 통합

// 현재가
const price = companyData.getPrice('005930');

// 매크로 지표
const macro = require('./crawlers/macro');
const current = macro.getCurrent();

// 워치리스트
const hantoo = require('./crawlers/hantoo');
const watchlist = hantoo.getWatchlist();

// 예측
const prediction = require('./utils/prediction');
const stats = prediction.getStats();
```
