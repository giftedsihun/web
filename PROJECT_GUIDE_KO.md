# Atlas Browser 프로젝트 안내서

> 갱신일: 2026-07-31
>
> 이 문서는 Atlas Browser의 파일 구조, 현재 구현된 기능, 실행 방법, 그리고 다음 개발 계획을 한곳에 정리한 안내서입니다. 상세 진행 이력은 [PROJECT_STATUS_KO.md](PROJECT_STATUS_KO.md)를 참고하세요.

## 1. 프로젝트 목적

Atlas Browser는 두 종류의 지식 탐색을 하나의 데스크톱 앱에 결합합니다.

1. **내 Atlas**: 방문하거나 직접 수집한 페이지와 노트를 이 PC의 SQLite 색인에 저장하고 검색합니다.
2. **공개 Atlas**: 사용자가 승인한 공개 도메인을 수집하고, 별도 SQLite 전문 검색 색인에서 검색합니다.

공개 Atlas는 전체 웹을 자동으로 수집하는 검색엔진이 아닙니다. 사용자가 수집기에서 `https://` 시작 주소를 등록한 뒤, 해당 작업에 승인된 호스트와 robots 정책 안에서만 동작합니다.

## 2. 빠른 실행

### 개발 실행

```powershell
npm install
npm start
```

### 패키지 실행

```powershell
npm run package
```

생성된 앱은 `dist/win-unpacked/Atlas Browser.exe`입니다.

### 검사

```powershell
npm test
git diff --check
```

`npm test`는 TypeScript 빌드와 로컬 브라우저, 공개 검색 서비스, 복구 드릴 테스트를 함께 실행합니다.

## 3. 주요 파일과 폴더

| 경로 | 역할 |
| --- | --- |
| `src/main.ts` | Electron 메인 프로세스입니다. 로컬 SQLite 상태/검색, IPC, 로컬 공개 검색 프로세스 시작, Supabase 공개 설정을 담당합니다. |
| `src/preload.ts` | 렌더러가 사용할 수 있는 제한된 Electron IPC API를 노출합니다. |
| `src/core.ts` | URL 정규화, 로컬 검색, 세션 등 공유 코어 유틸리티입니다. |
| `src/renderer/index.html` | Atlas 데스크톱 UI의 정적 레이아웃입니다. |
| `src/renderer/app.ts` | 탭, 탐색, 검색, 북마크, 수집기, 계정/동기화 등 화면 동작입니다. |
| `src/renderer/*.css` | 앱의 기본, 기능, 보강 스타일입니다. |
| `public-search/src/server.ts` | 공개 검색 HTTP API와 스케줄러 진입점입니다. |
| `public-search/src/crawler.ts` | 공개 웹 수집, robots 준수, 속도 제한, SSRF 방어, 재시도 실행부입니다. |
| `public-search/src/store.ts` | 공개 인덱스, URL 프런티어, 작업, 백업, 운영 데이터를 SQLite에 저장합니다. |
| `public-search/src/extract.ts` | HTML 텍스트/링크/robots/canonical 추출과 검색 토큰화입니다. |
| `public-search/openapi.yaml` | 공개 검색 HTTP API 계약입니다. |
| `public-search/test/` | 공개 서비스 단위 및 HTTP 통합 테스트입니다. |
| `test/` | 데스크톱 코어와 복구 드릴 테스트입니다. |
| `scripts/` | 백업, 상태 점검, 격리 복구 검증 스크립트입니다. |
| `supabase/migrations/` | 사용자 소유 동기화 데이터를 위한 Supabase SQL/RLS 마이그레이션입니다. |
| `.github/workflows/verify.yml` | push와 pull request에서 `npm ci`, `npm test`를 실행하는 CI입니다. |
| `.env.example` | 공개 환경 변수의 예시입니다. 실제 `.env`는 Git에 포함하지 않습니다. |
| `PROJECT_STATUS_KO.md` | 구현 상태, 제약, 로드맵의 상세 기준 문서입니다. |

## 4. 현재 구현된 기능

### 데스크톱 Atlas

- Chromium `webview` 기반 탭, 주소 입력, 뒤로/앞으로/새로고침, 확대/축소, 페이지 내 찾기
- 탭 세션과 최근 닫은 탭 복원
- 방문 문서의 제목/본문/헤딩/링크 로컬 색인 및 SQLite FTS5 검색
- 북마크, 방문 기록, 읽기 목록, 저장 검색, 최근 검색 기록, 지식 노트, 링크 그래프
- 로컬 문서/노트와 공개 Atlas 결과를 구분해 표시하는 통합 검색 및 독립 페이지네이션
- 앱 시작 시 loopback 전용 공개 검색 서버 자동 시작

### 공개 Atlas 수집과 검색

- 승인 도메인/호스트만 수집하는 URL 프런티어와 작업별 깊이, 경로, 콘텐츠 유형, 요청 간격 정책
- `robots.txt`, HTML meta robots, `X-Robots-Tag`, sitemap, canonical URL, `noindex`/`nofollow` 준수
- DNS 사전 검증과 연결 시 재검증으로 private/loopback/link-local 주소 및 DNS rebinding 차단
- 실패 유형 분류, 최대 3회 지수 백오프, `Retry-After`, URL별 실패 진단
- 원자적 lease/heartbeat, 만료 작업 회수, 재시작 복구
- 본문 SHA-256 중복 제거, canonical/중복 진단, 제한된 링크 권위와 콘텐츠 품질 신호
- BM25 제목 가중치, URL 일치, 신선도, 한국어 조사/CJK bigram 보조 검색, 언어/문서 유형 필터
- 관리자 작업/프런티어/문서/도메인 차단 관리와 5초 간격 Atlas 패널 갱신

### 운영과 복구

- 인증된 운영 metrics, 구조화 로그, 선택적 서명 웹훅, API rate limit
- `VACUUM INTO` 기반 일관된 백업, 예약 백업/보관 수, 백업 목록과 읽기 전용 무결성 검증
- 임시 loopback 서비스에서 실제 백업을 점검하는 `public-search:restore-drill`
- SQLite `schema_migrations` baseline과 GitHub Actions 검증

### 계정과 동기화

- Supabase 이메일/비밀번호 회원가입과 로그인
- RLS로 보호된 사용자별 프로필, 북마크, 읽기 목록, 저장 검색 테이블
- 수동 동기화로 로컬 데이터와 원격 컬렉션을 병합
- 세션은 앱 세션 저장소에만 보관하며, 서비스 역할 키는 Electron에 노출하지 않음

## 5. 설정 파일과 보안

`.env`는 커밋하면 안 됩니다. 개발에서는 프로젝트 루트에, 패키지 앱에서는 `Atlas Browser.exe` 옆 또는 `resources` 폴더에 두세요.

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-publishable-key
```

- `SUPABASE_ANON_KEY`는 데스크톱 클라이언트용 publishable key입니다.
- `SUPABASE_SERVICE_ROLE_KEY`는 절대로 Electron 앱 또는 공개 저장소에 넣지 않습니다.
- 공개 수집 API를 독립 실행할 때는 `PUBLIC_SEARCH_ADMIN_TOKEN`에 긴 임의 토큰을 설정합니다.

## 6. 다음 구현 계획

### 우선순위 1: 운영 완성도

- 외부 관측 대시보드와 tracing 연동
- 프로덕션 배포 자동화 및 세분화된 SQLite 스키마 마이그레이션
- 백업 복구 절차의 운영 자동화와 정기 복구 훈련
- 삭제/차단 요청 접수, 요청자 검증, 처리 기한(SLA) 운영 흐름

### 우선순위 2: 공개 서비스 확장

- SQLite 단일 노드 구조를 PostgreSQL, 큐, 객체 저장소, 분산 검색 인덱스로 단계적 분리
- 수평 확장 크롤 워커와 검색 API 배포
- JavaScript 렌더링/복잡한 문서 처리 품질 향상
- 고급 스팸, 클로킹, 저작권, 개인정보, 악성 콘텐츠 대응 정책

### 우선순위 3: 제품 경험과 동기화

- Supabase access token 갱신, 다중 기기 충돌 해소, 실패 재시도 UX
- 노트, 방문 기록, 선택적 검색 인덱스 동기화 여부와 개인정보 정책 결정
- 관리자 계정, 역할 기반 권한(RBAC), 감사 로그 분리

## 7. 알려진 제약

- 공개 Atlas는 의도적으로 전체 웹 검색엔진이 아니며, 승인한 HTTPS 도메인만 수집합니다.
- HTML 경량 추출기이므로 JavaScript 렌더링, 로그인 필요 페이지, 복잡한 동적 사이트는 완전하게 수집하지 못합니다.
- 공개 서비스는 현재 SQLite 기반 초기 구현입니다. 대형/다중 리전 서비스에는 분산 저장소와 큐가 필요합니다.
- Supabase 동기화는 현재 북마크, 읽기 목록, 저장 검색만 수동으로 지원합니다.
- 이메일 확인 메일은 Supabase Email Provider와 SMTP 설정에 따라 지연되거나 발송되지 않을 수 있습니다.

## 8. 관련 문서

- [상세 구현 현황과 로드맵](PROJECT_STATUS_KO.md)
- [공개 검색 API 계약](public-search/openapi.yaml)
- [Supabase 설정 안내](supabase/README.md)
- [백업 복구 드릴](scripts/public-search-restore-drill.mjs)
