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
- 호스트별 요청 간격, HTML 콘텐츠 검사, URL 정규화, 링크 발견, 본문 해시, 페이지 `noindex`/`nofollow` 지시어 준수
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
- 공개 크롤은 URL, DNS 사전 검증, 연결 시 DNS 재검증으로 localhost, private/link-local/reserved IP와 DNS rebinding을 차단합니다. 운영 환경에서도 메타데이터·RFC1918·loopback·link-local·IPv6 ULA를 거부하고 public `80`/`443`만 허용하는 네트워크 egress 정책을 적용해야 합니다.
- FTS5 BM25만 사용합니다. 링크 분석, 언어별 분석기, 스팸 방지, 품질/신선도 랭킹은 아직 없습니다.
- 공개 API의 관리자 토큰은 초기 운영용 단일 공유 토큰입니다. 계정, 권한 분리, 감사 로그가 없습니다.

## 다음 구현 순서

### 1. 공개 서비스 신뢰성

- ~~프런티어 작업에 lease/heartbeat를 추가해 다중 워커 안전성 확보~~ (원자적 URL claim, 30초 lease, 10초 heartbeat, 만료 작업 자동 회수 및 관리자 진단 필드 제공)
- ~~요청 실패 분류, 지수 백오프, 재시도 횟수, 수집 로그와 실패 이유 저장~~ (DNS/연결/시간 초과/429/5xx를 분류하고 URL별 실패 정보와 최대 3회 지수 백오프를 SQLite 프런티어에 저장; 관리자 API에서 확인 가능)
- ~~sitemap.xml 발견, canonical URL 클러스터, 본문 중복 문서 제거~~ (sitemap/robots sitemap 탐색, 승인 범위 canonical을 문서 키로 사용, 본문 SHA-256 중복은 최초 대표 문서만 색인하고 URL별 진단 API에 결과 저장)
- ~~DNS/IP 기반 SSRF 방어와 private network egress 차단~~ (모든 DNS 응답이 public IP인지 사전·연결 시점에 검증하여 rebinding을 차단; 운영 인프라 egress allowlist 적용 지침 문서화)
- ~~작업별 속도, 경로 제외, 최대 깊이, 도메인 허용 정책 UI/API~~ (작업별 1~120초 요청 간격, 최대 깊이, include/exclude URL 패턴, 추가 승인 호스트, HTML/XHTML 유형을 API와 Atlas 수집 패널에서 설정; robots `Crawl-delay`와 더 엄격한 간격을 적용)

### 2. 검색 품질

- ~~한국어/다국어 토큰화와 형태소 분석기 도입~~ (Unicode 정규화, 한국어 조사 경량 어간화, 한글/CJK 문자 bigram 보조 색인으로 부분어와 조사형 검색을 보완; 사전 기반 형태소 분석기는 향후 정확도 개선 과제)
- 제목, URL, 본문, 링크 신호, 신선도를 합친 랭킹 (FTS5 BM25 제목 가중치, URL 일치, 7/30일 신선도, 색인된 유효 본문의 인바운드 링크 수를 최대 8개로 제한한 권위 신호, 본문 길이/제목 비율/반복어/외부 링크 수 품질 보정까지 구현; `newest` 정렬은 시간순을 유지. 클로킹 등 고급 스팸 판별은 향후 과제)
- 결과 총계/페이지네이션을 내 Atlas에도 적용
- ~~도메인, 언어, 날짜, 문서 유형 필터 및 검색 제안~~ (도메인/날짜/정렬/언어/HTML·XHTML 필터와 제목·도메인 검색 제안을 공개 API와 Atlas 검색 화면에 제공; 언어는 문자 기반 경량 추정)
- ~~오프라인 relevance 평가 세트와 랭킹 회귀 테스트~~ (영문, 한국어 조사형, CJK, 링크 권위, 반복어·링크 과다 문서를 포함한 고정 코퍼스로 기대 상위 결과와 감점을 검증)

### 3. 저장소와 확장

- SQLite를 PostgreSQL(메타데이터/프런티어), Redis/Kafka/SQS(큐), OpenSearch/Vespa(검색)로 분리
- 수집 원본을 객체 저장소에 보관하고 재처리 가능한 ingestion 이벤트 설계
- 수평 확장 가능한 크롤 워커와 검색 API 배포
- metrics, tracing, dashboard, backup, schema migration, CI/CD 구축 (진행 중: 인증된 `/v1/admin/metrics`에서 DB 크기, 스키마 버전, 문서 언어/유형, 작업·frontier 상태, 재시도·최종 실패 카운터를 URL/검색어 없이 제공하고, Atlas 수집기 패널은 이를 5초마다 갱신하며 요청 시 `/v1/admin/backup`으로 `VACUUM INTO` 스냅샷을 생성한다. `/v1/admin/backups`와 `POST /v1/admin/backups/verify`는 경로를 노출하지 않고 생성 백업의 목록, 읽기 전용 `integrity_check`, 스키마 호환성, 집계 레코드 수를 제공하며 Atlas 패널에서도 실행 DB를 바꾸지 않는 복구 준비 검증을 실행한다. `npm run public-search:restore-drill -- --backup <snapshot>`은 임시 DB 복사본과 임시 loopback 포트의 격리 서비스에서 `/ready`, 인증 metrics, 차단 도메인 수를 원본 스냅샷 집계와 비교하고 정리한다. 환경 변수로 15분~7일 주기의 자동 백업과 보관 개수를 설정할 수 있다. SQLite `schema_migrations`는 적용 baseline을 기록하며 GitHub Actions가 push/PR에서 `npm ci`와 `npm test`를 실행; tracing/외부 dashboard/프로덕션 배포 자동화/후속 세분 migration은 후속)

### 4. 운영/정책

- 고유 크롤러 식별 페이지와 연락처, 삭제/차단 요청 처리 (진행 중: `PUBLIC_SEARCH_CRAWLER_USER_AGENT`로 운영자 정보 URL을 포함한 식별자를 설정하고, HTML meta 및 HTTP `X-Robots-Tag`의 `noindex`/`nofollow`/`none`와 `robots.txt`를 준수. 인증된 `/v1/admin/domain-blocks`와 Atlas 수집기 패널은 검증된 도메인 삭제/차단 요청을 감사 기록과 함께 즉시 색인·링크·frontier에서 제거하고 이후 수집도 차단하며, 활성 차단 목록과 해제도 제공; 외부 요청 접수 채널, 요청자 검증, SLA는 운영 정책으로 후속)
- 저작권, 개인정보, 보존 기간, 악성 콘텐츠, abuse 대응 정책
- 관리자 계정, 역할 기반 권한, API rate limit, 감사 로그

### 5. 제품 경험

- ~~공개 검색 결과의 다음/이전 페이지 UX 완성 및 로컬 결과 페이지네이션~~ (통합 검색에서 내 Atlas와 공개 Atlas 결과의 총계와 독립적인 이전/다음 페이지를 표시)
- ~~공개 크롤 작업의 실시간 상태 갱신과 상세 로그~~ (Atlas 수집기 패널이 열려 있는 동안 5초마다 작업 요약을 갱신하고, 상세 화면에서 frontier 상태, 시도/재시도, 실패 URL과 오류를 확인)
- ~~읽기 목록~~ (현재 페이지를 로컬 읽기 목록에 추가·해제하고 Atlas 도구 패널에서 열거나 제거; 로컬 상태 백업에 포함)
- ~~저장 검색·검색 기록~~ (검색 결과에서 쿼리를 저장하고 Atlas 검색 패널에서 재실행; 최근 100개 로컬 검색 기록은 패널에서 삭제 가능하며 로컬 백업에 포함)
- 동기화/계정은 공개 서비스 운영 기반 후 검토 (진행 중: Supabase Auth 기반 사용자 소유 profile·북마크·읽기 목록·저장 검색 RLS 스키마와 데스크톱 이메일 계정/로그인/수동 동기화를 연결; 노트·방문 기록·검색 인덱스 동기화와 토큰 갱신·다중 기기 충돌 해소는 후속)

## 검증 기준

```powershell
npm test
```

이 명령은 Electron/개인 검색 코어와 공개 서비스의 URL 정규화, 추출, robots 정책, 작업 영속성 테스트를 함께 실행합니다.
