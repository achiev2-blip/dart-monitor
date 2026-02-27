---
description: VM 데이터 읽기/쓰기 API 사용법
---
# VM 데이터 API

## 서버
- URL: http://34.22.94.45
- 인증: `?api_key=dartmonitor-2024` 또는 헤더 `x-api-key: dartmonitor-2024`

## 읽기 (GET)
```
GET http://34.22.94.45/api/data-file?api_key=dartmonitor-2024&path=watchlist.json
```
→ `{ ok: true, content: { ... } }`

## 쓰기 (POST)
```
POST http://34.22.94.45/api/data-file?api_key=dartmonitor-2024
Content-Type: application/json
Body: { "path": "파일경로.json", "content": { 데이터 } }
```
→ `{ ok: true, size: 81, modified: "..." }`

## 파일목록
```
GET http://34.22.94.45/api/data-tree?api_key=dartmonitor-2024
```

## 주요 경로
- `watchlist.json` — 감시 종목 목록
- `companies/{종목코드}/context.json` — 종목별 컨텍스트
- `companies/{종목코드}/price.json` — 주가
- `companies/{종목코드}/layers.json` — 투자자별 매매
- `news.json` — 뉴스
- `predictions/active/*.json` — 활성 예측
- `context/commands.json` — AI 명령 큐
- `macro/current.json` — 매크로 지표

## 제한
- `.json` 파일만 쓰기 가능
- `data/` 폴더 내부만 접근
- 최대 5MB
