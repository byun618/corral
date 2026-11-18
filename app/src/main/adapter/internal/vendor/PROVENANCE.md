# 벤더 출처 (기준 S7ⓐ)

- 원본: herdr-studio — https://github.com/getherdr/herdr-studio (로컬 클론 `~/repos/etc/herdr-studio`)
- 기준 커밋: **e806c14** ("Fix login redirect behind reverse proxies (#129)") = **v0.6.1**
- 라이선스: **MIT**
- 벤더일: 2026-09-12 (LIFE-353)
- 업스트림 diff 뜨는 법: `git -C ~/repos/etc/herdr-studio diff e806c14..<대상> -- server/src/bridge/`

## 파일별 원본 경로와 수정 내역

| 파일 | 원본 경로 | 수정 |
| --- | --- | --- |
| `bincode.ts` | `server/src/bridge/bincode.ts` | **무수정** |
| `vt-input-classifier.ts` | `server/src/bridge/vt-input-classifier.ts` | **무수정** |
| `terminal-clipboard.ts` | `server/src/bridge/terminal-clipboard.ts` | **무수정** |
| `frame-types.ts` | `server/src/bridge/thin-client.ts` **발췌** | `CellData`·`CursorState`·`FrameData`·`readCellData`·`readFrameData` 다섯 개만. thin-client.ts 본체(레거시 프로토콜 클라이언트)는 02-rebuild-plan §2 "안 봄" — 벤더하지 않는다. 발췌 본문 무수정 |
| `endpoint-client.ts` | `server/src/bridge/endpoint-client.ts` | ① import 경로 1건 (`./thin-client` → `./frame-types`) ② **`EndpointSurface.full: boolean`** — `handleSurface` 는 `true`, `handlePatch` 는 `false` 로 채운다 (LIFE-373 §10-R7). 원본은 두 경로가 `panes` 를 통째로 교체하는데 patch 의 `panes` 는 **바뀐 pane 만** 실어 온다 — 소비자가 "이 탭에 없다"와 "이번엔 안 바뀌었다"를 구분할 방법이 없었다. 필드 추가뿐, 로직 무변경. ③ **오류 응답의 `code` 를 Error 에 싣는다** (LIFE-812) — `pending.reject(Object.assign(new Error(message), { code }))`. 검색(`search.ts`)이 `stale_content` 를 가려 새 revision 으로 다시 묻는다. 재동기화 때 빠지면 재시도가 조용히 `error` 로 떨어지므로 벤더 시험 「rejects endpoint error responses with the error code attached」가 지킨다. 그 외 본문 무수정 |
| `frame-to-ansi.ts` | `server/src/bridge/frame-to-ansi.ts` | ① import 경로 (`./thin-client` → `./frame-types`) ② **`Bun.stringWidth` → `./string-width` 의 `stringWidth`** (Node 대체 — 00-analysis §4-2). 그 외 본문 무수정 |
| `endpoint-terminal-session.ts` | `server/src/bridge/endpoint-terminal-session.ts` | ① import 경로 (`./thin-client` → `./frame-types`, `../utils/logger` → `./logger`) ② **`create()` 메서드 + `endpoint-creation` import strip** — 탭/워크스페이스 생성은 R3 범위 (00-analysis §4-2·§4-3 권고 그대로. `endpoint-creation.ts` 는 벤더하지 않음) ③ **계측 `logger.debug` 3줄** — `client.resize` 호출 2지점(`"resize request"`)과 `onSurface` 1지점(`"surface"`). 기준 S5 오라클(요청 횟수·innerRect 서버 응답)의 원자료. 로직 무변경. 그 외 본문 무수정 |

## 컴파일 옵션 예외

원본은 Studio 의 tsconfig(strict, `noUncheckedIndexedAccess` **없음**)로 작성됐다. corral 은
그 옵션을 켜고 있어 파서·인코더의 인덱싱 39곳이 걸린다 — 고치면 벤더 diff 가 로직 아닌
잡음으로 덮이므로, 걸리는 3파일(`vt-input-classifier.ts`·`frame-to-ansi.ts`·`endpoint-client.ts`)에
`// @ts-nocheck` 를 얹고 무수정을 유지한다. 이 파일들의 검증은 벤더 테스트(84건 통과)가 한다.
테스트 파일 4개는 tsc 대상에서 제외 (tsconfig.node.json exclude — vitest 가 esbuild 로 돈다).

## corral 작성 파일 (벤더 아님)

| 파일 | 무엇 |
| --- | --- |
| `string-width.ts` | `Bun.stringWidth` 대체. 3자 대조 원자료: `raw/claude/s7-width-oracle.json` (기준 S7ⓔ) |
| `logger.ts` | 원본 `server/src/utils/logger.ts` (Studio 서버 전용 200줄) 의 얇은 shim — 세션이 쓰는 표면(`Logger`·`silentLogger`)만 |

## 테스트 파일 (원본 경로 동일, `server/src/bridge/*.test.ts`)

공통 수정: `bun:test` → `vitest` · `Bun.sleep` → 로컬 `sleep` (S7ⓑ: 벤더 트리 `Bun.` 참조 0) ·
import 경로(`./thin-client` → `./frame-types`, `../utils/logger` → `./logger`).

| 파일 | 수정 |
| --- | --- |
| `frame-to-ansi.test.ts` | 공통 수정 외 무수정 |
| `vt-input-classifier.test.ts` | 공통 수정 외 무수정 |
| `endpoint-client.test.ts` | 공통 수정 + "rejects when the welcome carries a handshake error" 에 `client.on("error", () => {})` 1줄 — Node(vitest) 는 리스너 없는 `'error'` emit 을 unhandled 로 띄운다 (bun:test 는 러너가 흡수). + LIFE-812 시험 1건 「rejects endpoint error responses with the error code attached」(수정 ③). 그 외 무수정 |
| `frame-to-ansi.test.ts` (추가) | bun:test 전용 매처 `toStartWith`/`toEndWith` 2곳 → `startsWith`/`endsWith` + `toBe(true)` 동치 변환 |
| `endpoint-terminal-session.test.ts` | 공통 수정 + **strip**: 원본 2361줄 중 `createTerminalBridge`/`ServerWebSocket`(bun)/`session.create()`/`EndpointCreationDeadline` 에 의존하는 테스트 전량 — terminal-bridge 는 벤더 금지(코디네이터 지시: 참고만, 얇게 재작성), `create()` 는 R3 범위라 세션에서 strip 됨. **남긴 것**: 헬퍼 전체(1–334) + `describe("EndpointTerminalSession")` 전체(336–780) + top-level 마우스 테스트 2건(781–945) + `describe("cropFrame")`(1382–1411). **strip 한 것**(원본 줄 번호): 946–1381 (bridge 팬아웃·클립보드 소유권·재접속 광고 5건 + spyOn 기반 2건), 1414–2361 (creation·bridge RPC 계열 전부) |

### LIFE-544 — `endpoint-terminal-session.test.ts` 간헐 실패 안정화 (2026-10-23)

전체 스위트 부하에서 고정 `sleep(N)` 뒤 "도착했어야 할 것"을 단언하던 7개 테스트가 간헐 실패했다
(원인·재현: `specs/LIFE-544-overshoot-flake/raw/claude/RESULT.md`). 제품 코드 무수정, 단언 무삭제.

| 무엇 | 왜 |
| --- | --- |
| 헬퍼 `until(label, check, budgetMs)` 추가 — 진짜 `setTimeout` 으로 5ms 폴링, 예산을 폴링 횟수로 센다. 넘으면 `expect.fail("missing <label> …")` | 고정 대기 대신 조건 대기. 이벤트 루프가 부하로 멈춰도 예산이 벽시계로 깎이지 않고, 오지 않으면 단언 오류로 끝난다 — 벽시계 상한은 fix r1 의 천장(테스트 시작부터 4000ms)이 맡는다. 정지가 천장을 넘어 계속되면 천장 오류가 5초 뒤에 날 수 있다 |
| 헬퍼 `fakeProductTimers()`(`vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })`)·`surfaceLog()`(세션 debug 로그의 `surfaceRevision` 수집) 추가 | 제품의 `FIT_DEFER_MS`(500ms) 보류 기한이 실시간이라 테스트 단계와 경합했다. 제품 타이머만 가짜 시계로 두고 테스트가 시간을 넘긴다. 소켓은 실제로 돈다. 처리 여부는 기존 계측 로그(벤더 수정 ③)로 본다 |
| `corrects a one-cell overshoot` ×2: `sleep(60)` 앞에 `until("80x24 frame")` | 보정 왕복이 60ms 를 넘으면 실패했다. `sleep(60)` 은 수렴 뒤 "추가 보정 없음" 관측 창으로 남긴다 |
| `first visible frame fits …` ×3: 가짜 제품 타이머, `sleep(60)`→`until("stale surface")`+`advanceTimersByTime(60)`, 두 번째 `sleep(60)`→`until("settled frame")`, `sleep(550)`→`advanceTimersByTime(550)` | 부하 정지가 500ms 를 넘기면 보류 프레임이 settle 보다 먼저 나왔다 — 조건 대기만으로는 안 닫힌다(RESULT 근거) |
| `continuous stale frames …`: 가짜 제품 타이머, 루프의 `sleep(100)`→`until(stale surface n)`+`advanceTimersByTime(100)`, `sleep(40)`→`until(surface 처리)` | 같은 경합 + 실시간 700ms 루프의 시간초과 |
| `fits pane content …`(5건 공용 `waitForSize`): 2000ms 실시간 `setTimeout` reject → `until(…, 2000)` | 부하 정지가 2000ms 벽시계 예산을 먹어 `missing 81x25 frame` 이 났다. 같은 오류문 접두를 유지한다 |

**fix r1 (리뷰 r1 지적 반영)**:

| 무엇 | 왜 |
| --- | --- |
| `afterEach` 첫 줄 `vi.useRealTimers()` | 테스트가 vitest 시간초과로 끝나면 `finally` 가 안 돌아 가짜 시계가 뒤 테스트로 샜다(변이 M1 에서 무관 5건 연쇄 시간초과) |
| `until` 에 벽시계 천장 — 테스트 시작(`beforeEach` 의 `performance.now()`)부터 4000ms | 폴링 예산만으로는 벽시계 상한이 없어 vitest 5초 시간초과가 먼저 날 수 있었다. 천장에서도 `missing <label> at the 4000ms wall-clock ceiling` 단언 오류 |
| `untilSettled(label, promise)` — first visible frame ×3·continuous stale frames 의 `session.connect`·`requested.promise` 대기 | 가짜 시계 아래에선 제품의 connect 안전망(핸드셰이크 8초·첫 surface 10초)이 안 울리고 resize 요청 대기도 상한이 없었다 |

**의존 경고**: `surfaceLog` 는 벤더 수정 ③ 의 `logger.debug("surface", { surfaceRevision })` 에 의존한다 — 그 줄을 지우거나 이름·필드를 바꾸면 이 테스트들이 `missing stale surface` 로 실패한다(조용히 통과하지 않는다).

업스트림(herdr-studio `origin/HEAD` 791379e)은 같은 고정 대기를 유지한다 — 가져올 패치 없음.

strip 검증: 남긴 테스트가 벤더한 코드 표면(EndpointTerminalSession·cropFrame·EndpointClient·
frameToAnsi·VtInputClassifier)의 전부를 덮고, strip 한 테스트는 벤더하지 않은 코드
(terminal-bridge.ts·endpoint-creation.ts)의 표면만 잰다. 러너 출력은 `raw/claude/s7-vendor-tests.txt`.
