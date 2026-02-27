# 코드 품질 분석 결과

## 분석 대상
- **프로젝트**: DART 공시 모니터 v3.4
- **경로**: `D:\dart-monitor\dart-monitor`
- **파일 수**: 소스 2개 (server.js 2,723줄, public/index.html 1,984줄)
- **분석일**: 2026-02-20
- **분석 도구**: bkit-code-analyzer (수동 정밀 분석)

## 품질 점수: 32/100

---

## 1. 요약 진단

| 영역 | 점수 | 등급 |
|------|------|------|
| 코드 구조 / 유지보수성 | 15/25 | 위험 |
| 보안 | 8/25 | 심각 |
| 성능 / 안정성 | 12/25 | 경고 |
| 아키텍처 / 확장성 | 7/25 | 심각 |

이 프로젝트는 빠른 프로토타이핑 단계에서 충분히 동작하는 수준이나, **운영 환경 배포 기준으로는 심각한 보안 결함과 구조적 문제**를 다수 포함하고 있습니다.

---

## 2. 이슈 목록

### 2.1 CRITICAL -- 즉시 수정 필요

| # | 파일 | 줄 | 이슈 | 권장 조치 |
|---|------|-----|------|-----------|
| C-01 | `server.js` | 100 | **DART API 키 하드코딩** (`e9b45d9c286b...`) | 환경변수(`process.env.DART_API_KEY`)로 전환. `.env` + `dotenv` 사용 |
| C-02 | `server.js` | 101 | **Gemini API 키 하드코딩** (`AIzaSyD-2Cro...`) | 동일하게 환경변수 전환 |
| C-03 | `server.js` | 67 | **내부 API 키 하드코딩** (`dartmonitor-2024`) | 환경변수 전환 + 강력한 랜덤 토큰으로 교체 |
| C-04 | `index.html` | 241 | **클라이언트에 API 키 노출** (`DART_API_KEY_HEADER = 'dartmonitor-2024'`) | 서버-클라이언트 간 세션 기반 인증으로 전환 |
| C-05 | `index.html` | 282-284 | **텔레그램 봇 토큰/Chat ID 하드코딩** (폴백값으로 실제 토큰 `8258877401:AAE...` 포함) | 하드코딩 제거, 사용자 입력 필수화 |
| C-06 | `server.js` | 69-75 | **CORS 전체 오픈** (`Access-Control-Allow-Origin: *`) | 허용 origin 화이트리스트 설정 |
| C-07 | `server.js` | 80-88 | **localhost 기반 인증 우회** (hostname 검사만으로 인증 스킵) | X-Forwarded-For 스푸핑에 취약. 프록시 환경에서 완전 우회 가능 |
| C-08 | `server.js` | 307-311 | **인증 없는 서버 종료 API** (`POST /api/shutdown`) | 관리자 전용 인증 필수. rate limiting 적용 |
| C-09 | `server.js` | 2260-2261 | **텔레그램 API 프록시에 서버측 검증 없음** (임의 token/chatId로 봇 제어 가능) | 허용된 봇 토큰 화이트리스트 또는 사용자 인증 |

### 2.2 WARNING -- 개선 권장

| # | 파일 | 줄 | 이슈 | 권장 조치 |
|---|------|-----|------|-----------|
| W-01 | `server.js` | 전체 | **단일 파일 2,723줄 모놀리식 구조** | 모듈 분리 (아래 아키텍처 개선안 참조) |
| W-02 | `index.html` | 전체 | **HTML+CSS+JS 1,984줄 단일 파일 SPA** | 컴포넌트 분리, 번들러 도입 |
| W-03 | `server.js` | 248 | **좀비 프로세스 강제 kill** (`taskkill /f /im chrome.exe`) | Windows 전용 명령어. 크로스플랫폼 미지원. 프로세스 트리 관리 필요 |
| W-04 | `server.js` | 244-249 | **메모리 500MB 초과 시 process.exit(1)** | 근본 원인(메모리 누수) 해결 없이 증상만 처리. graceful shutdown 미구현 |
| W-05 | `server.js` | 1489-1492 | **Puppeteer 브라우저 인스턴스 관리 미흡** | 매 요청마다 브라우저 생성/소멸. 브라우저 풀 또는 재사용 패턴 필요 |
| W-06 | `server.js` | 346, 358 | **동기 파일 I/O** (`writeFileSync`, `readFileSync`) | 비동기 `writeFile`/`readFile` 사용. 대량 데이터 저장 시 이벤트 루프 블로킹 |
| W-07 | `server.js` | 429 | **API 키가 URL 쿼리스트링에 노출** (`crtfc_key=${DART_API_KEY}`) | 서버 로그/네트워크에 키 노출. 가능하면 헤더 방식 전환 |
| W-08 | `server.js` | 전체 | **Rate Limiting 미적용** | express-rate-limit 등으로 API 호출 제한 필요 |
| W-09 | `server.js` | 전체 | **입력값 유효성 검증 미흡** | date 파라미터 정규식 검증, body 스키마 검증(joi/zod) 미적용 |
| W-10 | `server.js` | 426-427 | **SQL Injection은 없으나 SSRF 가능성** | 사용자 입력 date를 외부 API URL에 직접 삽입. 값 범위 검증 필요 |
| W-11 | `server.js` | 전체 | **에러 처리 불완전** | 다수의 catch 블록이 비어있거나 `catch(e) {}` 형태. 에러 추적 불가 |
| W-12 | `server.js` | 전체 | **전역 변수 남용** (약 30개 이상의 `let` 전역 변수) | 상태 객체로 캡슐화 필요 |
| W-13 | `index.html` | 전체 | **XHR 직접 사용** (fetch API와 혼용) | fetch API로 통일. async/await 패턴 적용 |
| W-14 | `index.html` | 489-504 | **localStorage에 민감 정보 저장** (텔레그램 토큰, 채팅 ID) | 서버측 암호화 저장소로 전환 권장 |
| W-15 | `server.js` | 전체 | **로깅 시스템 부재** | console.log만 사용. winston 등 구조화 로거 도입 필요 |
| W-16 | `server.js` | 전체 | **테스트 코드 없음** | 단위 테스트, 통합 테스트 0건. 회귀 방지 불가 |
| W-17 | `package.json` | 전체 | **.env.example 파일 없음** | 환경변수 템플릿 미제공. 신규 개발자 온보딩 어려움 |
| W-18 | `server.js` | 2306 | **백업 경로 하드코딩** (`G:\\dart-backup`) | 환경변수 또는 설정 파일로 분리 |

### 2.3 INFO -- 참고 사항

- 네이밍 컨벤션은 대체로 camelCase로 일관성 있음
- 한글 주석과 콘솔 로그가 비교적 풍부하여 디버깅에 도움
- KST 시간대 처리 로직이 수동 UTC+9 계산으로 처리됨 (라이브러리 없이도 동작하나 DST 이슈 주의)
- `.gitignore` 파일이 없어 `node_modules`와 `data/` 폴더가 커밋될 위험

---

## 3. 상세 분석

### 3.1 코드 구조 (15/25)

#### 3.1.1 단일 파일 모놀리식 문제

**server.js (2,723줄)**는 다음 기능이 모두 하나의 파일에 응집되어 있습니다:

```
줄 1-96      : 설정, 미들웨어, 초기화
줄 97-300    : Gemini 모델 관리/폴백/쿨다운/상태 관리
줄 300-420   : 데이터 저장/복원, 전송이력, 리포트 저장소
줄 420-490   : DART API 프록시, Gemini API 프록시
줄 490-670   : 리포트 AI 분석 (배치/개별/캐시)
줄 670-960   : 뉴스 RSS 수집 (6개 소스, 각각 30-50줄 반복)
줄 960-1380  : 증권사 리포트 크롤링 (WiseReport, 미래에셋, 하나, 네이버)
줄 1380-1775 : 네이버/미래에셋 상세페이지 Puppeteer 크롤링
줄 1775-2115 : 소스별 독립 수집/스케줄링/동적 간격
줄 2115-2512 : 리포트 API, 디버그, 텔레그램, 전송이력, 백업/복원
줄 2512-2723 : 서버 상태, 일시정지, Claude API, 서버 시작
```

**문제점**:
- 함수 간 의존성 파악이 극도로 어려움
- 부분 수정 시 사이드이펙트 예측 불가
- 코드 리뷰 및 병합 충돌 빈번 (단일 파일)
- IDE 성능 저하 (2700줄 파일 탐색)

#### 3.1.2 함수 길이

| 함수명 | 줄수 | 권장 여부 |
|--------|------|-----------|
| `fetchReportPage()` | ~320줄 | 50줄 이하 권장 위반 (6.4배 초과) |
| `fetchHyundaiWithPuppeteer()` | ~180줄 | 50줄 이하 권장 위반 |
| `fetchSourceReports()` | ~190줄 | 50줄 이하 권장 위반 |
| `analyzeReportBatch()` | ~90줄 | 50줄 이하 권장 위반 |
| `renderCorp()` (index.html) | ~80줄 | 50줄 이하 권장 위반 |

#### 3.1.3 중복 코드 (DRY 위반)

**뉴스 RSS 파싱 함수 6개가 거의 동일한 패턴 반복**:

```
fetchNews_MK()       : 줄 698-733  (35줄)
fetchNews_Yonhap()   : 줄 736-772  (36줄)
fetchNews_Hankyung()  : 줄 775-810  (35줄)
fetchNews_Bloomberg() : 줄 813-848  (35줄)
fetchNews_Reuters()   : 줄 851-886  (35줄)
fetchNews_GoogleKR()  : 줄 889-924  (35줄)
```

이 6개 함수의 구조는 거의 동일합니다:
1. axios.get(url, headers)
2. itemBlocks 정규식 추출
3. for 루프에서 title/link/pubDate/desc 파싱
4. items 배열에 push
5. 에러 시 빈 배열 반환

**개선안**: 제네릭 RSS 파서 1개로 통합 가능:

```javascript
// 개선 전: 6개 함수 x 35줄 = 210줄
// 개선 후: 1개 함수 + 6개 설정 객체 = ~60줄
async function fetchRss(config) {
  const { url, sourceName, feedName, type, headers, extraFields } = config;
  // ... 공통 파싱 로직
}
```

**프론트엔드 필터 함수 중복**: `getFiltered()`와 `getFilteredReports()`가 동일한 필터 로직을 반복합니다 (index.html 줄 1626-1651).

**네이버 교차중복 제거 로직 중복**: `fetchSourceReports()` 내부(줄 1904-1948)와 `filterNaverDuplicates()`(줄 2118-2148)가 거의 동일한 로직을 독립적으로 구현하고 있습니다.

---

### 3.2 보안 (8/25)

#### 3.2.1 시크릿 관리 -- 심각

현재 소스코드에 하드코딩된 시크릿 목록:

| 시크릿 | 위치 | 위험도 |
|--------|------|--------|
| DART OpenAPI 키 | server.js:100 | 높음 -- API 할당량 소진, 데이터 탈취 |
| Gemini API 키 | server.js:101 | 높음 -- 과금 발생, 무단 사용 |
| 내부 API 인증 키 | server.js:67, index.html:241 | 높음 -- 클라이언트에서 평문 노출 |
| 텔레그램 봇 토큰 | index.html:282 | 높음 -- 봇 제어권 탈취 |
| 텔레그램 Chat ID | index.html:283 | 중간 -- 스팸 전송 가능 |
| 백업 경로 | server.js:2306 | 낮음 -- 파일 시스템 정보 노출 |

**Git에 커밋 시 이 모든 키가 이력에 영구 보존**됩니다. 이미 커밋된 경우 키를 즉시 교체(revoke)해야 합니다.

#### 3.2.2 인증/인가

- **localhost 바이패스** (줄 80-88): `req.hostname`이 `localhost`이면 인증 없이 모든 API 접근 허용. 리버스 프록시(Cloudflare 터널 등)를 통과하면 hostname이 변경되어 우회 불가하나, **같은 네트워크 내 다른 머신에서 접근 시 보호 없음**
- **shutdown API에 인증 미적용**: `POST /api/shutdown`으로 서버 즉시 종료 가능
- **백업 복원 API에 인증 미적용**: `POST /api/backup/restore`로 임의 경로 파일 덮어쓰기 가능 (Path Traversal 위험)

#### 3.2.3 입력 검증

- `req.query.date` 값에 대한 형식 검증 없음 (줄 426). 악의적 문자열이 외부 API URL에 삽입
- `req.body.folderPath`가 서버의 `fs.copyFileSync`에 직접 전달 (줄 2438-2446). **디렉토리 순회 공격** 가능
- `req.body.source` 값에 대한 화이트리스트 검증 없음 (줄 2237)

#### 3.2.4 XSS 방어

- 프론트엔드에서 `escHtml()` 함수로 기본적인 HTML 이스케이프 처리 (줄 412). 이 부분은 양호
- 다만 `innerHTML`로 직접 DOM 삽입하는 패턴이 다수 존재하여, 이스케이프 누락 시 XSS 취약

---

### 3.3 성능 (12/25)

#### 3.3.1 메모리 관리

| 항목 | 현재 상태 | 위험도 |
|------|-----------|--------|
| 뉴스 배열 | 최대 1,000건 메모리 상주 (server.js) + 500건 (client) | 중 |
| 리포트 저장소 | 5개 소스 x 200건 = 최대 1,000건 메모리 상주 | 중 |
| AI 캐시 | reportAiCache 무제한 증가 | 높음 |
| 전송이력 | sentItems 객체 무제한 증가 (7일 정리는 있으나) | 중 |
| reportCache | 무제한 증가, 정리 로직 없음 | 중 |
| 뉴스 AI 캐시 (client) | newsAiCache 객체 무제한 증가 | 중 |

`reportAiCache`는 리포트가 누적될수록 무한 성장합니다. 서버가 장기 운용될 경우 메모리 소진의 직접적 원인이 됩니다. 500MB 한도에 도달하면 `process.exit(1)`로 강제 종료하는 것은 **근본 해결이 아닌 증상 처리**입니다.

#### 3.3.2 동기 파일 I/O 블로킹

```javascript
// server.js:346 -- 이벤트 루프 블로킹
fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf-8');

// server.js:358 -- 이벤트 루프 블로킹
return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
```

뉴스/리포트 데이터가 클 경우 (`news.json`이 1,000건), JSON 직렬화 + 동기 쓰기가 수백 ms 이상 소요될 수 있으며, 이 동안 **모든 HTTP 요청이 대기**합니다.

#### 3.3.3 Puppeteer 리소스 관리

```javascript
// server.js:1489 -- 매번 새 브라우저 인스턴스 생성
miraeBrowser = await puppeteer.launch({ ... });

// server.js:1606 -- 현대차증권도 매번 생성
hyundaiBrowser = await puppeteer.launch({ ... });
```

- 미래에셋 상세 크롤링: 리포트 1건당 브라우저 1개 생성/소멸 (최대 10건 = 10번 launch)
- Chrome 프로세스 누수 시 taskkill로 강제 종료하는 방어 코드는 있으나, SIGKILL 이후 좀비 프로세스 잔류 가능

#### 3.3.4 불필요한 반복 계산

```javascript
// server.js:2150-2175 -- /api/reports 호출 시 매번
const all = [];
Object.values(reportStores).forEach(items => all.push(...items)); // 최대 1,000건 복사
const filtered = filterNaverDuplicates(all); // N*M 비교
```

교차 중복 제거 로직이 매 API 호출마다 실행됩니다. 결과를 캐싱하고 reportStores 변경 시에만 재계산하면 성능 개선 가능합니다.

---

### 3.4 에러 처리 (부분 분석)

#### 3.4.1 빈 catch 블록

```javascript
// server.js:546 -- 파싱 실패 무시
} catch (e) {}

// server.js:654 -- 분석 실패 무시
} catch (e2) {}

// server.js:2380 -- 백업 정리 실패 무시
} catch (e) {}
```

최소 **12개의 빈 catch 블록**이 확인됩니다. 에러가 발생해도 추적 불가능하여 운영 중 문제 진단이 극도로 어렵습니다.

#### 3.4.2 에러 응답 불일치

```javascript
// 방식 1: { error: message }
res.status(500).json({ error: e.message });

// 방식 2: { ok: false, error: message }
res.status(401).json({ ok: false, error: '인증 필요...' });

// 방식 3: { success: false, error: message }
return { success: false, error: e.message };
```

3가지 이상의 에러 응답 형식이 혼재되어 있어 클라이언트에서 일관된 에러 처리가 어렵습니다.

---

### 3.5 아키텍처 / 확장성 (7/25)

#### 3.5.1 현재 아키텍처

```
[단일 server.js] = 라우팅 + 비즈니스 로직 + 데이터 접근 + 스케줄링 + 크롤링
                   모든 계층이 하나의 파일에 혼합

[단일 index.html] = HTML + CSS + JavaScript (SPA)
                    프레임워크 없이 수동 DOM 조작
```

**의존성 방향 위반**: 모든 것이 전역 변수로 연결되어 있어 계층 구분이 불가능합니다.

#### 3.5.2 하드코딩 / 매직 넘버

| 코드 | 위치 | 의미 |
|------|------|------|
| `3000` | server.js:55 | 포트 번호 |
| `500` | server.js:229 | 메모리 한도 MB |
| `60 * 60000` | server.js:115 | 쿨다운 시간 |
| `200` | server.js:1968 | 소스별 최대 리포트 수 |
| `1000` | server.js:1038 | 최대 뉴스 수 |
| `30` | server.js:2602 | 미분석 배치 크기 |
| `500` | server.js:555 | AI 프롬프트 본문 절삭 길이 |
| `2500` | server.js:653 | API 호출 간격 ms |
| `86400` | server.js:74 | CORS max-age |

이 값들은 `const` 변수로 추출되었으나, 모두 server.js 상단에 하드코딩되어 있어 환경별 설정 변경이 불가능합니다.

#### 3.5.3 switch/if-else 체인

`getSmartInterval()` (줄 1800-1841)에 3단계 시간대 x 5개 소스 = 15개 분기가 switch/case로 구현되어 있습니다. 새 소스 추가 시 3곳을 수정해야 합니다.

`fetchReportPage()` (줄 1052-1375)에 소스별 `if/else if` 체인이 5개 분기로 구성되어 있으며, 각 분기가 50-100줄입니다. Strategy 패턴으로 분리해야 합니다.

#### 3.5.4 Windows 종속성

```javascript
// server.js:248 -- Windows 전용
require('child_process').execSync('taskkill /f /im chrome.exe ...');

// server.js:38-51 -- Windows 경로 하드코딩
'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
```

Linux/macOS 배포 불가. 크로스플랫폼 Chrome 탐색 라이브러리(`chrome-launcher` 등) 사용 권장합니다.

---

## 4. 중복 코드 분석

### 4.1 정확한 중복 (Exact Duplicates)

| 유형 | 위치 1 | 위치 2 | 유사도 | 권장 조치 |
|------|--------|--------|--------|-----------|
| RSS 파싱 패턴 | server.js:698-733 (매경) | server.js:736-772 (연합) 외 4개 | 90% | 제네릭 RSS 파서 1개로 통합 |
| 네이버 중복 제거 | server.js:1904-1948 (수집 시) | server.js:2118-2148 (조회 시) | 85% | 공통 함수로 추출 |
| 프론트엔드 필터 | index.html:1626-1638 | index.html:1640-1651 | 80% | 제네릭 필터 함수 1개 |
| Puppeteer 브라우저 정리 | server.js:1565-1576 | server.js:1749-1762 | 90% | 공통 cleanup 함수 추출 |
| 본문 추출 전략 | server.js:1427-1466 (네이버) | server.js:1529-1560 (미래에셋) | 75% | 공통 body extractor |

### 4.2 구조적 중복 (Structural Duplicates)

| 패턴 | 발생 횟수 | 권장 조치 |
|------|-----------|-----------|
| `axios.get() -> cheerio.load() -> 파싱 -> items.push()` | 6회 (뉴스) + 4회 (리포트) | 크롤링 엔진 추상화 |
| `try { await puppeteer.launch() } finally { browser.close(); kill() }` | 3회 | Puppeteer 매니저 클래스 |
| `saveJSON(filename, data)` 후 `console.log()` | 15회 이상 | 저장 + 로깅 데코레이터 |
| `if (isCooldownActive()) return;` 패턴 | 4회 | 미들웨어 또는 데코레이터 |

---

## 5. 확장성 분석

### 5.1 새 데이터 소스 추가 비용

현재 새 증권사 크롤러를 추가하려면:
1. `fetchReportPage()`에 else if 분기 추가 (~50-100줄)
2. `REPORT_SOURCES` 배열에 항목 추가
3. `reportStores` 초기화에 키 추가
4. `getSmartInterval()`에 switch case 3개 추가
5. 파일명 매핑에 추가
6. 초기화/리셋 코드에 추가
7. 프론트엔드 디버그 뷰에 추가

**최소 7개 파일 위치를 수정해야 하며, 실수 가능성이 높습니다.**

### 5.2 권장 모듈 구조

```
dart-monitor/
  src/
    config/
      index.js           # 환경변수, 상수, 설정
      sources.js          # 데이터 소스 정의
    middleware/
      auth.js             # API 인증
      cors.js             # CORS 설정
      rateLimit.js        # Rate limiting
    services/
      gemini.js           # Gemini AI 관리 (모델 폴백, 쿨다운)
      scheduler.js        # 스케줄링/타이머 관리
      backup.js           # 백업/복원
      telegram.js         # 텔레그램 알림
    crawlers/
      base.js             # 크롤러 기본 클래스
      rss.js              # RSS 파서 (6개 뉴스소스 통합)
      wisereport.js       # WiseReport 크롤러
      mirae.js            # 미래에셋 크롤러
      hana.js             # 하나증권 크롤러
      hyundai.js          # 현대차증권 크롤러 (Puppeteer)
      naver.js            # 네이버 금융 크롤러
    store/
      json-store.js       # JSON 파일 기반 데이터 저장소
      report-store.js     # 리포트 CRUD + 중복 제거
      news-store.js       # 뉴스 CRUD
    routes/
      dart.js             # DART API 라우트
      gemini.js           # Gemini API 라우트
      reports.js          # 리포트 라우트
      news.js             # 뉴스 라우트
      telegram.js         # 텔레그램 라우트
      backup.js           # 백업 라우트
      status.js           # 상태/모니터링 라우트
    app.js                # Express 앱 설정
    server.js             # 서버 시작 진입점 (< 30줄)
  public/
    index.html            # (추후 프레임워크 전환 시 분리)
  .env.example            # 환경변수 템플릿
  .gitignore
  package.json
```

---

## 6. 즉시 실행 가능한 개선 로드맵

### Phase 1: 보안 긴급 조치 (1일)

1. `.env` 파일 생성 + `dotenv` 패키지 추가
2. 모든 API 키를 환경변수로 이전
3. `.gitignore`에 `.env`, `data/`, `node_modules/` 추가
4. 텔레그램 폴백 토큰 하드코딩 제거
5. 기존에 커밋된 키가 있다면 즉시 revoke 후 재발급

```bash
# .env.example
DART_API_KEY=your_dart_api_key_here
GEMINI_API_KEY=your_gemini_api_key_here
INTERNAL_API_KEY=generate_random_32char_token
PORT=3000
BACKUP_PATH=G:\\dart-backup
MEMORY_LIMIT_MB=500
```

### Phase 2: 구조 분리 (3-5일)

1. 뉴스 RSS 파서 통합 (6개 -> 1개 제네릭 함수)
2. 크롤러를 개별 모듈로 분리
3. 라우트를 개별 파일로 분리
4. 전역 변수를 상태 객체로 캡슐화
5. 동기 I/O를 비동기로 전환

### Phase 3: 안정성 강화 (2-3일)

1. 입력값 검증 미들웨어 추가
2. Rate Limiting 적용
3. 에러 응답 형식 통일
4. 구조화 로깅 도입 (winston)
5. Puppeteer 브라우저 풀 도입
6. AI 캐시 크기 제한 + LRU 정책

### Phase 4: 테스트 및 문서화 (2-3일)

1. 핵심 비즈니스 로직 단위 테스트 작성
2. API 통합 테스트 작성
3. API 문서화 (swagger 또는 간단한 README)
4. 환경별 설정 가이드

---

## 7. 긍정적 측면

분석 결과 모든 것이 문제인 것은 아닙니다. 다음은 잘 된 부분입니다:

1. **기능 완성도가 높음**: 5개 증권사 크롤링, 6개 뉴스 소스, AI 분석, 텔레그램 알림, 백업/복원까지 단독 개발로 완성
2. **에러 복원력**: DART API 실패 시 캐시 폴백, Gemini 모델 자동 강등/복원, 서버 재시작 시 상태 복원 등 방어 로직이 체계적
3. **Gemini 폴백 체인**: 프로 -> 라이트 -> 무료 -> 쿨다운 -> 자동 복원 (2회차 시도 포함)이 잘 설계됨
4. **시간대별 동적 수집**: 장 시간/피크/장외에 따라 수집 빈도를 자동 조절하는 스마트 스케줄링
5. **데이터 보존**: 서버 재시작 시 뉴스/리포트/AI캐시/Gemini 상태까지 완전 복원
6. **HTML 이스케이프**: `escHtml()` 함수로 XSS 기본 방어 구현
7. **주말/장외 대응**: 주말 수집 중단, 장외 시간 수집 빈도 감소

---

## 8. 결론

| 항목 | 판정 |
|------|------|
| **로컬 개인 사용** | 주의하에 사용 가능 (API 키 노출 주의) |
| **팀 공유/Git 커밋** | 차단 -- 시크릿 하드코딩 제거 필수 |
| **외부 배포/서비스** | 차단 -- 보안 + 구조 개선 후 재검토 |
| **Cloudflare 터널 공개** | 심각 차단 -- 인증 우회, 서버 종료 API 노출 |

**우선순위**: Phase 1(보안) > Phase 2(구조) > Phase 3(안정성) > Phase 4(테스트) 순서로 단계적 개선을 권장합니다.
