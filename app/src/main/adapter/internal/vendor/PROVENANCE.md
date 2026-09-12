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
| `endpoint-client.ts` | `server/src/bridge/endpoint-client.ts` | import 경로 1건 (`./thin-client` → `./frame-types`). 본문 무수정 |
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
| `endpoint-client.test.ts` | 공통 수정 + "rejects when the welcome carries a handshake error" 에 `client.on("error", () => {})` 1줄 — Node(vitest) 는 리스너 없는 `'error'` emit 을 unhandled 로 띄운다 (bun:test 는 러너가 흡수). 그 외 무수정 |
| `frame-to-ansi.test.ts` (추가) | bun:test 전용 매처 `toStartWith`/`toEndWith` 2곳 → `startsWith`/`endsWith` + `toBe(true)` 동치 변환 |
| `endpoint-terminal-session.test.ts` | 공통 수정 + **strip**: 원본 2361줄 중 `createTerminalBridge`/`ServerWebSocket`(bun)/`session.create()`/`EndpointCreationDeadline` 에 의존하는 테스트 전량 — terminal-bridge 는 벤더 금지(코디네이터 지시: 참고만, 얇게 재작성), `create()` 는 R3 범위라 세션에서 strip 됨. **남긴 것**: 헬퍼 전체(1–334) + `describe("EndpointTerminalSession")` 전체(336–780) + top-level 마우스 테스트 2건(781–945) + `describe("cropFrame")`(1382–1411). **strip 한 것**(원본 줄 번호): 946–1381 (bridge 팬아웃·클립보드 소유권·재접속 광고 5건 + spyOn 기반 2건), 1414–2361 (creation·bridge RPC 계열 전부) |

strip 검증: 남긴 테스트가 벤더한 코드 표면(EndpointTerminalSession·cropFrame·EndpointClient·
frameToAnsi·VtInputClassifier)의 전부를 덮고, strip 한 테스트는 벤더하지 않은 코드
(terminal-bridge.ts·endpoint-creation.ts)의 표면만 잰다. 러너 출력은 `raw/claude/s7-vendor-tests.txt`.
