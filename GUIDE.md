# 구름이 작업 가이드 — CONTEXT TRACKER

## 📁 파일 구조
```
C:\Users\user\cwork\
├── context_view.html   ← 아빠가 크롬으로 보는 뷰어 (30초 자동 새로고침)
├── context_data.json   ← 참고용 (실제 데이터는 HTML 안에 있음)
└── GUIDE.md            ← 이 파일 (작업 전 반드시 읽기)
```

---

## ✅ 해도 되는 것
- `context_view.html` 안의 `DATA = { ... }` 내용 수정
- `stocks` 배열에 새 종목 추가
- `pinned: true/false` 변경 (고정 여부)
- `history` 배열에 과거 내용 추가
- `keyInsights`, `events`, `nextAction` 수정

## ❌ 절대 건드리지 말 것
- DATA 구조 자체 (키 이름, 배열 형태 변경 금지)
- `<style>` 영역
- `render()` 함수들
- 자동 새로고침 코드
- 탭/이벤트/인사이트 관련 함수들

---

## 📌 새 종목 추가 시 템플릿
`stocks` 배열 안에 아래를 복사해서 추가:

```json
{
  "code": "종목코드6자리",
  "name": "종목명",
  "pinned": false,
  "lastDate": "YYYY-MM-DD",
  "price": 0,
  "change": 0,
  "isHigh52": false,
  "context": "현재 맥락 한 줄 요약",
  "events": [],
  "keyInsights": [],
  "nextAction": "",
  "history": []
}
```

## 📌 이벤트 추가 시 템플릿
`events` 배열 안에 추가:

```json
{
  "id": "e1",
  "title": "이벤트명",
  "timing": "날짜/시간",
  "probability": "확률 설명",
  "status": "대기중",
  "scenarios": [
    { "type": "A. 시나리오명", "prob": "40%", "val": "+3~5%", "note": "설명" }
  ]
}
```

---

## 📌 히스토리 압축 기준
- **1주일 이내** → keyInsights에 유지
- **1주일 이후** → history 배열로 이동
- **1개월 이후** → history에서 삭제

history 항목 형식:
```json
{ "date": "2026-02-20", "note": "요약 내용" }
```

---

## ⚠️ 작업 순서
1. 이 파일(GUIDE.md) 먼저 읽기
2. `context_view.html` 열기
3. `DATA = {` 부분 찾기
4. 해당 종목 내용만 수정
5. 파일 저장
6. 아빠 화면에 30초 내 자동 반영
