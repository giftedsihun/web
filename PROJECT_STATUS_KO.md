# Atlas Browser: 구현 현황과 다음 계획

> 마지막 갱신: 2026-07-28

## 프로젝트 한눈에 보기

Atlas는 Chromium 기반 데스크톱 브라우저에 두 가지 검색 범위를 결합하는 프로젝트입니다.

1. **내 Atlas**: 사용자가 방문하거나 직접 수집한 문서와 노트를 PC의 SQLite FTS5 색인에서 검색합니다.
2. **공개 Atlas Starter**: 별도 Node.js 서버가 승인된 공개 웹 호스트를 수집하고, 자체 FTS5 색인과 HTTP API로 검색 결과를 제공합니다.

현재 공개 Atlas는 구글과 같은 전체 웹 검색엔진이 아닙니다. 전체 웹 검색을 위한 구조를 연습하고 검증하는 단일 노드, 승인 도메인 기반의 초기 구현입니다.

## 현재 구현됨

### 데스크톱 브라우저

- Electron + Chromium `webview` 기반 탭 브라우징, 뒤로/앞으로/새로고침, 주소창, 북마크
- 탭 세션 및 최근 닫은 탭 복원 (`Ctrl+Shift+T`)
- 방문 페이지의 제목, 본문, 헤딩, 링크 추출 및 개인 로컬 색인
- SQLite FTS5/BM25 기반 개인 검색: `AND`, `OR`, `NOT`, 괄호, 구문 검색
- 선택 문장으로 생성하는 노트, 태그, 수정/삭제, 문서 링크 그래프
- 단일 호스트 내 개인 크롤러: robots.txt 확인, 진행률, 취소, 최대 50페이지
- 검색 결과 전용 메인 화면: 주소창/새 탭/Atlas 검색에서 실행한 검색을 넓은 결과 화면에서 표시
- 내 Atlas와 공개 Atlas 결과를 분리해 한 화면에서 표시

### 공개 Atlas Starter (`public-search/`)

- Electron과 분리된 Node.js HTTP 서비스
- SQLite 기반 영속 URL 프런티어, 문서 메타데이터, FTS5 전문 색인
- `robots.txt`의 봇 그룹, `Allow`, `Disallow`, `Crawl-delay` 처리
- 호스트별 요청 간격, HTML 콘텐츠 검사, URL 정규화, 링크 발견, 본문 해시
- 시작 호스트 및 명시된 `allowedHosts`만 수집하는 승인 호스트 정책
- 작업 생성/조회/취소 API와 관리자 Bearer 토큰 보호
- 서버 재시작 시 대기/진행 작업 재개 및 예약 재수집 (`recrawlMinutes`)
- 공개 검색 API의 결과 페이지네이션 메타데이터 (`page`, `pageSize`, `total`, `totalPages`)
- Docker Compose 실행 구성
- 데스크톱 수집기 패널에서 공개 크롤 작업 등록, 목록 조회, 취소

## 주요 경로

| 경로 | 역할 |
| --- | --- |
| `src/main.ts` | Electron 메인 프로세스, 개인 데이터/색인/크롤 IPC |
| `src/renderer/app.ts` | 브라우저 UI, 메인 검색 결과 화면, 공개 API 연동 |
| `src/renderer/index.html` | 데스크톱 앱 레이아웃 |
| `public-search/src/server.ts` | 공개 검색/크롤 HTTP API |
| `public-search/src/crawler.ts` | 공개 크롤러와 robots/호스트 정책 실행 |
| `public-search/src/store.ts` | 공개 인덱스, 프런티어, 작업 영속성 |
| `public-search/src/extract.ts` | URL 정규화와 HTML 텍스트/링크 추출 |
| `public-search/src/robots.ts` | robots.txt 정책 해석 |
| `docker-compose.yml` | 공개 검색 서비스 로컬 컨테이너 실행 |

## 실행 방법

### 데스크톱 앱

```powershell
npm install
npm start
```

### 공개 검색 서비스

```powershell
$env:PUBLIC_SEARCH_ADMIN_TOKEN = "replace-this-token"
npm run public-search
```

공개 수집 등록 예시:

```powershell
Invoke-RestMethod http://localhost:8787/v1/crawls -Method Post `
  -Headers @{ Authorization = "Bearer replace-this-token" } `
  -ContentType "application/json" `
  -Body '{"seedUrl":"https://example.com","maxPages":25,"allowedHosts":["www.example.com"],"recrawlMinutes":1440}'
```

Atlas 앱에서는 `ATLAS` -> `통합 검색`에서 공개 서비스 주소를 설정하고, `ATLAS` -> `수집기`에서 공개 수집 작업을 관리합니다.

## API 요약

| 메서드 | 경로 | 인증 | 설명 |
| --- | --- | --- |
| `GET` | `/health` | 없음 | 서비스 상태와 문서 수 |
| `GET` | `/v1/search?q=...&page=...` | 없음 | 공개 색인 검색 |
| `GET` | `/v1/crawls` | Bearer 토큰 | 최근 공개 크롤 작업 조회 |
| `POST` | `/v1/crawls` | Bearer 토큰 | 공개 크롤 작업 등록 |
| `DELETE` | `/v1/crawls/:id` | Bearer 토큰 | 대기/실행 작업 취소 |

## 의도적인 제한

- 공개 Atlas는 단일 Node 프로세스와 SQLite로 동작하며, 다중 워커/다중 서버 환경을 지원하지 않습니다.
- HTML은 경량 추출기로 처리하므로 JavaScript 렌더링 페이지, 복잡한 마크업, 로그인 페이지를 완전하게 수집하지 못합니다.
- robots.txt 구현은 실용적인 초기 버전이며 모든 예외 규칙을 포괄하지 않습니다.
- 공개 크롤은 SSRF 방어를 위해 localhost와 `.local` 대상 요청을 차단하지만, 운영 환경에서는 DNS 재검증과 네트워크 egress 정책이 추가로 필요합니다.
- FTS5 BM25만 사용합니다. 링크 분석, 언어별 분석기, 스팸 방지, 품질/신선도 랭킹은 아직 없습니다.
- 공개 API의 관리자 토큰은 초기 운영용 단일 공유 토큰입니다. 계정, 권한 분리, 감사 로그가 없습니다.

## 다음 구현 순서

### 1. 공개 서비스 신뢰성

- 프런티어 작업에 lease/heartbeat를 추가해 다중 워커 안전성 확보
- 요청 실패 분류, 지수 백오프, 재시도 횟수, 수집 로그와 실패 이유 저장
- sitemap.xml 발견, canonical URL 클러스터, 본문 중복 문서 제거
- DNS/IP 기반 SSRF 방어와 private network egress 차단
- 작업별 속도, 경로 제외, 최대 깊이, 도메인 허용 정책 UI/API

### 2. 검색 품질

- 한국어/다국어 토큰화와 형태소 분석기 도입
- 제목, URL, 본문, 링크 신호, 신선도를 합친 랭킹
- 결과 총계/페이지네이션을 내 Atlas에도 적용
- 도메인, 언어, 날짜, 문서 유형 필터 및 검색 제안
- 오프라인 relevance 평가 세트와 랭킹 회귀 테스트

### 3. 저장소와 확장

- SQLite를 PostgreSQL(메타데이터/프런티어), Redis/Kafka/SQS(큐), OpenSearch/Vespa(검색)로 분리
- 수집 원본을 객체 저장소에 보관하고 재처리 가능한 ingestion 이벤트 설계
- 수평 확장 가능한 크롤 워커와 검색 API 배포
- metrics, tracing, dashboard, backup, schema migration, CI/CD 구축

### 4. 운영/정책

- 고유 크롤러 식별 페이지와 연락처, 삭제/차단 요청 처리
- 저작권, 개인정보, 보존 기간, 악성 콘텐츠, abuse 대응 정책
- 관리자 계정, 역할 기반 권한, API rate limit, 감사 로그

### 5. 제품 경험

- 공개 검색 결과의 다음/이전 페이지 UX 완성 및 로컬 결과 페이지네이션
- 공개 크롤 작업의 실시간 상태 갱신과 상세 로그
- 읽기 목록, 저장 검색, 검색 기록, 동기화/계정은 공개 서비스 운영 기반 후 검토

## 검증 기준

```powershell
npm test
```

이 명령은 Electron/개인 검색 코어와 공개 서비스의 URL 정규화, 추출, robots 정책, 작업 영속성 테스트를 함께 실행합니다.
