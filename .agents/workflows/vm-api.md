---
description: VM 데이터 읽기/쓰기 API 사용법
---

# DART 모니터 VM API 가이드

## 서버 정보

- **URL**: `http://34.22.94.45`
- **인증**: 모든 요청에 `?api_key=dartmonitor-2024` 쿼리 파라미터 또는 `x-api-key: dartmonitor-2024` 헤더 필수

---

## 1. 데이터 파일 읽기 (GET)

```
GET http://34.22.94.45/api/data-file?api_key=dartmonitor-2024&path=watchlist.json
```

- `path` 파라미터: `data/` 폴더 기준 상대 경로
- 응답: `{ ok: true, path, size, modified, content: { ... } }`
- `.json` 파일만 지원, `data/` 폴더 내부만 접근 가능

### curl 예시

```bash
# 감시 종목 목록 읽기
curl "http://34.22.94.45/api/data-file?api_key=dartmonitor-2024&path=watchlist.json"

# 특정 종목 컨텍스트 읽기
curl "http://34.22.94.45/api/data-file?api_key=dartmonitor-2024&path=companies/005930/context.json"
```

---

## 2. 데이터 파일 쓰기 (POST)

```
POST http://34.22.94.45/api/data-file?api_key=dartmonitor-2024
Content-Type: application/json
```

Body:
```json
{
  "path": "companies/005930/context.json",
  "content": { "key": "value" }
}
```

- 응답: `{ ok: true, path, size, modified }`
- 제한: `.json` 파일만, `data/` 폴더 내부만, 5MB 이하

### curl 예시

```bash
curl -X POST "http://34.22.94.45/api/data-file?api_key=dartmonitor-2024" \
  -H "Content-Type: application/json" \
  -d '{"path":"test.json","content":{"hello":"world"}}'
```

---

## 3. 파일 트리 조회 (GET)

```
GET http://34.22.94.45/api/data-tree?api_key=dartmonitor-2024
```

- `data/` 폴더 전체 트리 구조 반환 (최대 depth 3)
- 응답: `{ ok: true, root: "data/", tree: [...], totalFiles: N }`

---

## 4. 뉴스/공시/리포트 피드 (GET)

```
GET http://34.22.94.45/api/daily-feed?api_key=dartmonitor-2024&days=7
```

- 최근 N일간(최대 14일) 뉴스, DART 공시, 증권사 리포트를 일별로 집계
- 응답: `{ ok: true, days, feeds: [{ date, news: {...}, reports: {...}, dart: {...} }] }`

---

## 5. 기타 유용한 API

| 엔드포인트 | 메서드 | 설명 |
|-----------|--------|------|
| `/api/status` | GET | 서버 상태 |
| `/api/state/save` | GET | AI 상태 (model, round 등) |
| `/api/collection/status` | GET | 수집기 상태 (일시정지 여부, 인터벌 등) |
| `/api/memory` | GET | 메모리 사용량 |
| `/api/predictions` | GET | 활성 예측 조회 |
| `/api/predictions` | POST | 예측 생성 |

모든 엔드포인트에 `?api_key=dartmonitor-2024` 필수.

---

## 주요 데이터 경로

| 경로 | 설명 |
|------|------|
| `watchlist.json` | 감시 종목 목록 (70+ 종목) |
| `companies/{코드}/context.json` | 종목별 AI 컨텍스트 |
| `companies/{코드}/price.json` | 주가 데이터 |
| `companies/{코드}/layers.json` | 투자자별 매매 데이터 |
| `companies/{코드}/reports.json` | 증권사 리포트 |
| `news.json` | 뉴스 데이터 |
| `predictions/active/*.json` | 활성 예측 |
| `context/commands.json` | AI 명령 큐 |
| `macro/current.json` | 매크로 지표 |

---

## PowerShell에서 사용 (Windows)

```powershell
# 읽기
Invoke-RestMethod "http://34.22.94.45/api/data-file?api_key=dartmonitor-2024&path=watchlist.json"

# 쓰기
$body = @{ path = "test.json"; content = @{ hello = "world" } } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "http://34.22.94.45/api/data-file?api_key=dartmonitor-2024" -ContentType "application/json" -Body $body
```
