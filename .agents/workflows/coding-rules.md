---
description: 코드 작성 시 지켜야 할 규칙
---

# DART Monitor 코딩 규칙

## 1. 운영 환경 — Windows

- **개발/실행 환경**: Windows (PowerShell)
- **임시 파일 경로**: `/tmp`는 Linux 전용. Windows에서는 `os.tmpdir()` 또는 프로젝트 내부 경로 사용
- **경로 구분자**: `path.join()` 사용 필수 (슬래시 직접 쓰지 않기)

### 임시 파일 현황 (2026-03-08 점검)

| 서브프로젝트 | `/tmp` 사용 | `os.tmpdir()` 사용 | 비고 |
|---|---|---|---|
| dart-news | ❌ 없음 | ❌ 없음 | 모든 데이터는 `data/` 하위 |
| dart-reports | ❌ 없음 | ❌ 없음 | 모든 데이터는 `data/` 하위 |
| dart-disclosure | ❌ 없음 | ❌ 없음 | 모든 데이터는 `data/` 하위 |
| crawlers | ❌ 없음 | ❌ 없음 | 상태 없음 (순수 함수) |

> **결론**: 전체 프로젝트에서 임시 경로를 사용하는 코드 없음. 향후 추가 시 `os.tmpdir()` 사용할 것.

## 2. 데이터 경로 규칙

- 수집 데이터: `data/pending/`
- 분류 완료: `data/output/`
- 뷰어는 `data/output/`만 읽음
- `data/` 루트에 직접 파일 저장 금지

## 3. 독립 모듈 원칙

- Collector, Classifier, Server는 서로 `require`하지 않음
- Chain(오케스트레이터)만 다른 모듈 require 허용
- 파일 기반 통신 (메모리 공유 금지)
