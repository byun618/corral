# 모바일 서버 노출 표면 (LIFE-577 A3ⓐ)

이 문서는 corral 이 네트워크에 내놓는 것의 **전부**를 적는다. 코드의 라우팅·메시지 분기와 이 문서가 다르면 그 차이가 결함이다.
코드: `server.ts`(HTTP·WS) · `protocol.ts`(메시지·오류 코드) · `pairing.ts`(코드·토큰) · `exposure.ts`·`tailscale.ts`(serve 항목).

## 1. 어디에 열리나

| 층 | 값 |
| --- | --- |
| 바인딩 | `127.0.0.1` 고정(`MOBILE_BIND_HOST` 상수). 설정·환경변수로 바꾸는 길이 없다. `0.0.0.0`·`::`·LAN·`100.x` 에는 열지 않는다 |
| 포트 | 켤 때 OS 가 고르는 임시 포트(`listen(0)`). 껐다 켜면 바뀐다 |
| 언제 | 설정 › Mobile 스위치가 켜져 있을 때만. 꺼져 있으면 리스너 0 · tailscale 호출 0(소유권 기록이 남은 경우 제외) |
| 밖으로 | `tailscale serve --bg --yes --https=8577 http://127.0.0.1:<포트>` 한 항목. 8577 은 Funnel 허용 포트(443·8443·10000) 밖이라 이 항목은 Funnel 될 수 없다 |
| 원격 주소 | `wss://<mac>.<tailnet>.ts.net:8577/ws` — tailnet 안에서만 닿는다(Funnel 이 켜진 노드에서는 노출을 거부) |

## 2. HTTP 경로·메서드

| 메서드 | 경로 | 응답 |
| --- | --- | --- |
| `GET` + `Upgrade: websocket` | `/ws` (쿼리는 무시) | 101 WebSocket. 동시 연결 16개를 넘으면 404 |
| 그 밖 전부 — 모든 메서드 · 모든 경로 · `/ws` 의 업그레이드 없는 요청 | | `404`, 본문 0바이트, `Connection: close` |
| 모양이 틀린 업그레이드 — `/ws` 아닌 경로 · `GET` 아님 · `Sec-WebSocket-Key` 없음·모양 틀림 · `Sec-WebSocket-Version` ≠ 13 · `Sec-WebSocket-Protocol` 있음 · 허용 밖 `Origin` | | `404`, 본문 0바이트, 소켓 닫음 |

**거절 형식은 하나다**(fix1 R1-A10). 업그레이드는 `ws` 에 넘기기 **전에** `ws` 가 400·405 본문을 내는 검사(메서드·Upgrade·키·버전·하위 프로토콜)를
같은 조건으로 먼저 하고 404 로 닫는다(`server.ts` `upgradeAllowed`). 확장 헤더는 permessage-deflate 를 꺼 두어 `ws` 가 읽지 않는다.
남는 예외 하나: 서버를 닫는 순간에 도착한 업그레이드는 `ws` 가 `503` 으로 닫을 수 있다(본문은 상태 문구뿐, 데이터 없음).

### Origin (R1-N2)

- 업그레이드에 `Origin` 헤더가 **없으면** 허용한다 — `repro.mjs`(Node `ws`)는 보내지 않는다.
- `Origin` 이 **있으면** 지금 노출 주소의 origin `https://<mac>.<tailnet>.ts.net:8577` 과 글자 그대로 같을 때만 허용한다. 노출 전(주소 없음)에는 Origin 있는 요청을 전부 거절한다.
  포트 없는 `https://<mac>.ts.net`·다른 호스트·`http://` 는 거절. 브라우저 페이지의 JS 가 loopback 포트로 붙는 길을 막는 것이 목적이다.
- RN 호환(R2-N1 — 소스 확인 수준, **실기 미확인**): RN Android upstream `WebSocketModule` 은 앱이 Origin 을 주지 않으면 URL 에서
  `getDefaultOrigin(url)` 로 만든다 — `wss://<mac>.ts.net:8577/ws` → `https://<mac>.ts.net:8577`. 정규 QR 주소로 붙으면 이 규칙과 맞아 허용된다.
  같은 앱이 loopback 직접 주소(`ws://127.0.0.1:<p>/ws`)로 붙으면 Origin 이 `http://127.0.0.1:<p>` 가 되어 **거절된다**(폰에서는 쓰지 않는 길).
  iOS 기본 동작은 확인하지 않았다. iOS·Android 실기 확인은 M2 몫이고, 어긋나면 이 절을 고친다(리뷰 r2 원자료 `codex-r2-raw/WebSocketModule.kt`).

인증 전에는 어떤 데이터도 돌려주지 않는다 — 앱 버전도 인증 뒤 `hello`/`paired` 응답에만 있다.
헤더 상한: 요청 헤더 64개, 헤더·요청 타임아웃 10초.

## 3. WS 메시지 (JSON 텍스트 프레임 · 프로토콜 버전 1)

프레임 하나 최대 16 KiB(넘으면 close 1009). 바이너리 프레임은 `bad_message`. 연결 후 **10초 안에** 인증(`hello` 성공 또는 `pair` 성공)하지 않으면 `auth_timeout`.

**인증된 연결의 수명 (LIFE-578 E3)** — 이 절은 메시지·경로·인증 전 동작을 더하지 않는다(목록은 아래 LIFE-580 절). 서버 쪽 정리만 더했다.

- **생존 확인**: 서버가 인증된 연결에 **10초마다 WS ping 제어 프레임**(RFC 6455 opcode 0x9, 본문 0바이트)을 보낸다. WS 클라이언트는 pong 을 스스로 돌려준다
  (RN Android OkHttp·Node `ws` 기본값). 메시지·pong 어느 것이든 받으면 그 연결은 살아 있다. **30초 동안 아무 프레임도 없으면** 서버가 close 핸드셰이크 없이 끊는다
  (상대가 없다 — 폰이 망을 바꿔 half-open 으로 남은 연결). 죽은 연결이 서버에서 사라지기까지 **최대 40초**(마감 30 + 주기 10). 로그 `mobile.idle_drop {device, idleMs}`.
  인증 전 연결은 여기에 들지 않는다 — `auth_timeout` 이 맡는다.
- **같은 기기 재인증**: `hello` 가 성공하면 **같은 기기 id 의** 이전 연결을 `replaced`(close 4006)로 닫는다. 다른 기기 연결은 건드리지 않는다.
  망을 바꾼 폰이 새 연결로 다시 붙을 때 이전 연결이 상한 16 의 칸을 쥐고 있지 않게 한다. `pair` 는 늘 새 기기라 해당 없다. 로그 `mobile.replaced {device}`.
- 앱 쪽 생존 확인(앱 `ping` 주기·마감·복귀 프로브)은 `mobile/src/core/connection.ts` — 서버는 그 `ping` 에 `pong` 으로 답할 뿐이다.

### 클라이언트 → 서버

| 타입 | 언제 | 모양 |
| --- | --- | --- |
| `hello` | 인증 전 | `{type:'hello', protocol:1, token:'<기기 토큰>', client?:{name,version}}` |
| `pair` | 인증 전 | `{type:'pair', protocol:1, code:'<8자 코드>', name:'<기기 이름, 64자까지>'}` |
| `ping` | 인증 뒤 | `{type:'ping', id?: string\|number}` |
| `list.subscribe` | 인증 뒤 (LIFE-580) | `{type:'list.subscribe'}` — 대화방 목록 구독. 다시 보내면 이전 구독을 끊고 전체를 다시 받는다(재연결·포그라운드 복귀) |
| `chat.subscribe` | 인증 뒤 (LIFE-581) | `{type:'chat.subscribe', channel:'<목록의 채널 id, 200자까지>', gen?:string, from?:number, cursor?:number}` — 대화 하나 구독(연결당 하나 — 다시 보내면 이전 대화 구독을 끊는다). `gen`·`from`·`cursor` 셋이 다 있으면 이어 받기(R1-A2 — r0 의 `after` 대신) |
| `chat.older` | 인증 뒤 (LIFE-581) | `{type:'chat.older', gen, before:<말풍선 id>}` — 지금 대화의 `before` 앞 페이지. 세대가 다르면 무시 |
| `chat.unsubscribe` | 인증 뒤 (LIFE-581) | `{type:'chat.unsubscribe'}` — 대화 구독 끊기(목록 구독은 그대로) |

인증 전에 `hello`·`pair` 가 아닌 것(`ping`·`list.subscribe`·`chat.*` 포함)은 `not_authenticated` 로 닫는다. 노출이 `exposed` 가 아니면(Funnel·HTTPS 꺼짐·실패 등) `hello`·`pair` 도
`unavailable` 로 닫는다(R1-A2). 서버가 거절·close 를 시작한 연결은 **그 뒤 도착한 메시지를 처리하지 않는다** — 같은 write 로 이어 온
`pair` 가 거절된 `hello` 뒤에 통과하지 않는다(R1-A7). 인증 뒤 모르는 타입은 `unknown_type` 오류만 보내고 연결은 유지한다.
인증 뒤 `hello`·`pair` 를 다시 보내면 `bad_message`(연결 유지).

### 서버 → 클라이언트

| 타입 | 언제 | 모양 |
| --- | --- | --- |
| `hello` | hello 성공 | `{type:'hello', ok:true, protocol:1, server:{app:'corral', version:'<app.getVersion()>', macName:'<맥 이름>'}, device:{id,name}}` |
| `paired` | pair 성공 — 연결은 그대로 인증된다 | `{type:'paired', protocol:1, server:{app, version, macName}, token:'<기기 토큰 — 이때 한 번만>', device:{id,name}}` |
| `pong` | ping | `{type:'pong', id, at:<ms>}` |
| `list` | `list.subscribe` 직후 1건 + 목록 내용이 바뀔 때마다 (LIFE-580) | `{type:'list', epoch, seq, at:<ms>, changedAt:<ms>, list}` — 아래 「대화방 목록」 |
| `chat.page` | `chat.subscribe` 직후 1건(`reset`·`resume`) · `chat.older` 응답(`older`) · 세대가 바뀌면 구독자 모두에게 `reset` (LIFE-581) | `{type:'chat.page', channel, gen, cursor, mode, at, writtenAt, hasOlder, items[]}` — 아래 「대화」 |
| `chat.items` | 기록에 새 말풍선이 생기거나 있던 것이 자랄 때 · 이어 받기가 프레임 하나를 넘칠 때 나머지 (LIFE-581) | `{type:'chat.items', channel, gen, cursor, at, readAt, writtenAt, items[]}` — 같은 `id` 는 새 값으로 바꾼다 |
| `chat.unavailable` | 대화를 못 열 때 1건 · 열린 대화의 채널이 목록에서 사라질 때·기록을 잠깐 못 찾을 때 1건(R1-A1·R2-A4) (LIFE-581) | `{type:'chat.unavailable', channel, reason, retrying}` — `not_listed`(목록에 없음) · `no_session`(세션 참조 없음) · `no_file`(기록 파일 없음) · `not_ready`(맥이 herdr 상태를 아직 못 읽음 — 목록 연결 중 포함) · `unreadable`(읽다 실패). `retrying:true`(`no_session`·`no_file`·`not_ready`) = 구독은 살아 있고 찾으면 서버가 첫 페이지를 보낸다. `false` = 구독 끝 |
| `error` | 아래 표 | `{type:'error', code, message}` (`protocol_mismatch` 는 `supported:[1]` 도) |

**맥 이름 `server.macName`(R5 A5ⓓ, 표시용)** — 인증 뒤 `hello`·`paired` 응답에만 있다. 인증 전 응답·오류(`error`)에는 없다.
출처(`mac-name.ts`): ① `/usr/sbin/scutil --get ComputerName`(macOS 「컴퓨터 이름」, 절대경로라 셸 PATH 없는 GUI 앱에서도 같다, 2초 타임아웃) →
② 실패·빈 값이면 `os.hostname()` 에서 `.local` 을 뗀 값 → ③ 그것도 비면 `"Mac"`. 제어 문자 제거·64자. 앱 기동 때 한 번 읽는다(읽기 전엔 ②).

### 대화방 목록 (LIFE-580 — 코드 `list.ts`·`feed.ts`, 서버 분기 `server.ts` `subscribeList`)

- **구독한 인증 연결에만** 간다. 보내기 직전마다 그 연결이 닫는 중이 아닌지·기기가 해지되지 않았는지 본다 — 해지·`replaced`·`unavailable`·닫힘·생존 확인 끊김 뒤에는
  그 연결로 한 건도 가지 않는다(해지가 연결 닫기보다 먼저 보이면 그 자리에서 `revoked` 로 닫는다). 공급이 없는 서버(시험)는 `unknown_type`.
- **매번 전체**를 보낸다(증분 없음). `epoch` = 서버(main) 기동마다 새 값, `seq` = 보낼 내용이 바뀔 때만 +1. 재구독은 지금 `seq` 의 전체를 그대로 다시 보낸다.
  앱은 같은 `epoch` 의 더 낮은 `seq` 를 버린다. 같은 내용이면 보내지 않는다.
- **뭉침**: 상태 변화 뒤 100 ms, 첫 변화에서 최대 300 ms 안에 한 번(`LIST_COALESCE_MS`·`LIST_MAX_WAIT_MS`). 구독자가 있는 동안 30초마다 다시 계산한다(정렬의 30분 신선도 경계).
- **구독자 0 이면 변환하지 않는다** — main 상태 이벤트는 카운터 확인 하나로 끝난다. 같은 세대에 붙은 구독들은 직렬화 결과 하나를 공유한다.
- `at` = 서버가 이 목록을 만든 시각, `changedAt` = 이 목록이 담은 첫 상태 변화를 main 이 낸 시각(3초 측정 J5ⓐ 의 시작점).
- 비용 로그: `mobile.list_built {seq, bytes, buildMs, subscribers}` · `mobile.list_push {seq, subscribers, sendMs}` · `mobile.list_subscribe {device}` — 제목·글은 없다.

`list` 모양:

| 칸 | 값 |
| --- | --- |
| `available:false, reason` | 맥이 herdr 상태를 아직 못 읽었다(link 가 `live` 아님) — `repos`·`waiting` 빈 배열. 「세션 0」 과 다르다 |
| `available:true, repos[], waiting[]` | `repos` = `{id, name, tasks[]}` · `tasks` = `{id, name, isDefault, channels[]}` · `waiting` = 「나를 기다리는 것」 채널 `id` 순서 |
| 채널 | `id`(pane id · 보존 행 `retained:<pane id>`) · `key`(안 읽음 장부 키 — provider 세션 참조의 SHA-256 앞 16자, 없으면 `pane:<pane id>`) · `status` live/closed · `kind` claude/codex/grok/null · `title` · `dot`·`dotUnseen`(데스크톱 점 9값 — 본 것으로/안 본 것으로 칠 때) · `depth` 0/1 · `origin`(하위 워크트리 이름) · `spawnedBy` · `parent` · `preview` {question·approval·reply·prompt·tool·error·none} · `waiting` question/approval/login/other · `model` · `timeAt` · `activityAt` · `outcome` |

- 값·순서는 데스크톱 파생 함수(`shared/` 의 `buildSidebarSections`·`nestSectionItems`·`buildAgentRows`)로 만든다 — 「레포로 묶기」 보기, 데스크톱 필터·고정은 적용하지 않는다.
- **보내지 않는 것**: 셸 pane(에이전트 없는 pane)·서브에이전트 행 · **터미널 화면 내용** · 레포·작업 경로(`id` 는 경로의 SHA-256 앞 16자) ·
  **홈 디렉터리 아래 절대경로** — 미리보기 글(질문·도구 대상·지시·실패 사유)의 경로는 그 pane 의 작업 worktree 안이면 worktree 상대(`src/a.ts`, worktree 자신은 `.`),
  그 밖의 홈 아래면 `~/…` 로 바꿔 보낸다(`list.ts` `maskPaths`, R4-A1 — 경계를 열거하지 않는 한 규칙: ① 유효한 퍼센트 인코딩을 고정점까지 디코딩(이중·부분 인코딩 포함, 8중까지). 8회 안에 고정점에 닿지 못하면(9중 이상) 그 글 전체를 `…` 로 바꿔 보낸다 — 남은 인코딩 안을 볼 수 없으므로 원문도 부분 디코딩 결과도 싣지 않는다(fail-closed, R5-A1) ② 홈 문자열이 나오는 **모든 위치**를 앞 글자와 무관하게 찾고 뒤 경계(글 끝·`/`·영숫자 `_` `-` 가 아닌 글자)만 본다 ③ worktree 안이면 worktree 상대, 아니면 `~`. 과잉 가림은 허용한다(`/x/Users/me/a` → `/x~/a`, `file:///Users/me/a` → `file://~/a`, `/Users/me.bak` → `~.bak`) — 계약은 결과 글에 홈 절대경로가 남지 않는 것 하나다. `/Users/meow`·`/Users/me2`·`/Users/me-old` 는 다른 이름이라 그대로. 범위 밖: Windows 모양). 홈 밖 경로(`/tmp`·`/opt` 등)는 그대로 갈 수 있다 ·
  세션 참조 원문 · 환경·토큰·비용.
- **제목은 보낸다** — 데스크톱 사이드바 같은 자리와 같은 문자열(J4, R1-A3 계약 ①): provider 제목 → 첫 지시 → **터미널 제목 폴백**(셸 프롬프트 모양이면 cwd 의
  홈 축약 `~/…`, 그 밖은 터미널이 준 제목을 왼쪽 잘라 15자 — `shared/session-title.ts` 그대로). 그래서 홈 밖 경로 모양의 터미널 제목(`/tmp/x`)은 제목으로 갈 수 있다.
- **미리보기 순서**(J11 · R1-A5 코디 해석 · LIFE-581 X8): 질문 대기 → 그 질문 · 권한 대기 → 그 도구(claude) · 실패 → 실패 사유 · **작업 중이면 지금 도구** →
  **에이전트 마지막 답**(`reply`, 데스크톱 digest 의 마지막 활동 글 · 가림·160자) → 내 마지막 지시 → 마지막 도구(claude) → 없음. 작업 중 도구와 마지막 지시가 함께 있으면 도구, 실패 사유와 지시가 함께 있으면 실패 사유.
- `parent` — 대화 머리 「띄운 세션」(579 Q3, 계보에 부모가 있으면 **항상**, 부모를 모르면 `{title:null}`). `spawnedBy` 는 목록 행용 — 부모가 다른 작업 그룹에 있거나 모를 때만.
  열린 AI 세션이 없는 작업(셸만·닫힌 세션만)은 목록에 없다. 행 수는 자르지 않는다 — 제목 120자·미리보기 160자만 자른다.
- 프레임 크기: 수신 상한 16 KiB 는 서버가 **받는** 프레임에만 걸린다 — `list` 는 그보다 클 수 있다(F9).

### 대화 (LIFE-581 — 코드 `chat.ts`(판독·구독) · `../chat-parse.ts`(기록 줄 → 말풍선), 서버 분기 `server.ts` `subscribeChat`)

- 폰은 **채널 id 만** 준다. 서버가 목록과 같은 함수(`list.ts` `chatChannel` — `buildMobileList` + 보존 행)로 그 채널의 provider 세션 참조를 찾고 기록 파일을 고른다
  (Claude 본 파일 · Codex rollout · Grok `updates.jsonl`). 경로·세션 id 는 폰에 가지 않고 폰에서 받지도 않는다. 닫힌 세션(보존 행 `retained:<pane id>`)도 지난 기록을 연다.
- **열린 대화가 0 이면 기록을 읽지 않는다.** 판독자는 첫 구독에 생기고, 마지막 구독이 떠나면 **그 자리에서 stat·꼬리 읽기를 멈춘다**(R1-A3) — 첫 색인·따라잡기 도중이어도
  다음 1 MiB 조각 경계에서 멈춘다(R2-A3). 다 못 읽은 첫 색인은 공개하지 않고(ready 아님) 다시 열면 처음부터 색인한다. 색인은 15초(`CHAT_GRACE_MS`) 들고 있다가 버린다 —
  그 안에 다시 열면 멈춘 동안 늘어난 바이트를 한 번 따라잡은 뒤 첫 페이지를 보낸다. 파일 하나에 판독자 하나(여러 연결이 같은 대화를 열어도 한 벌).
- **세션 교체**(R1-A1): 목록 재료가 바뀔 때마다(100 ms `CHAT_REFRESH_MS` 뭉침) 열린 구독마다 채널 → 세션 → 파일을 다시 고른다. 파일이 바뀌었으면(`/clear`·새 세션) 새 파일로 옮겨
  `reset` 페이지. **채널이 목록에서 사라지면**(pane 닫힘 등) `chat.unavailable`(`retrying:false`) 뒤 구독 해제. 모바일을 끄면 판독자를 모두 멈춘다.
- **일시 부재는 구독을 끝내지 않는다**(R2-A4, X6): 세션 참조가 아직 없거나 새 참조의 기록 파일이 아직 없으면 판독자를 떼고 `chat.unavailable`(`retrying:true`) 한 건 —
  구독은 들고 있다가 1초(`CHAT_RETRY_MS`)마다 다시 찾고(기다리는 대화가 열려 있을 때만), 찾으면 `reset` 페이지부터 이어진다. 상태를 못 읽음(목록 연결 중)이면 붙은 구독은
  그대로 읽고 아무것도 보내지 않는다. 처음 열 때의 같은 부재도 같다.
- 판독: 처음 한 번 파일 전체를 1 MiB 조각으로 **비동기** 읽어 색인(조각 사이 이벤트 루프 양보 — 동기 전체 읽기 없음), 그 뒤 250 ms(`CHAT_POLL_MS`)마다 stat 해 늘어난 바이트만 이어 읽는다.
  개행으로 끝나지 않은 마지막 줄은 개행이 올 때까지 보류한다.
- **말풍선** `items[]` — 기록 순서(id 오름차순). `id` = 그 말풍선 첫 줄의 바이트 오프셋(한 줄에서 여럿이 나오면 소수 `+0.1`) — 같은 파일·같은 내용이면 다시 색인해도 같은 id.
  | kind | 모양 |
  | --- | --- |
  | `prompt` | `{id, kind, at, body:{text, clipped}}` — 사람이 친 지시(데스크톱 지문 규칙과 같은 판정) |
  | `reply` | `{id, kind, at, body:{text, clipped}}` — 에이전트 답(마크다운 원문). 여러 줄로 나뉜 한 답은 하나로 합친다 |
  | `tools` | `{id, kind, at, tools:[{name, target, status: running\|ok\|error\|unknown}], count, names:{이름:횟수}, detail}` — 이어진 도구 호출 묶음. `tools` 는 뒤쪽 120개(`TOOLS_MAX`)까지, 나머지는 `count`·`names`(많은 순 40칸 `TOOL_NAMES_MAX`)로만. `unknown` = 끝났지만 성공/실패를 기록에서 판정 못 함(R1-A9 — Codex 결과 머리에 종료 코드가 없을 때) |
  | `question` | `{id, kind, at, questions:[{question, header, options:[{label, description}], multiSelect}], state: pending\|answered\|closed, answer, clipped}` — 표시만(답하기는 M5). 문항·머리·선택지·설명 합 8000자(`QUESTION_CHARS`) 예산 — 넘는 것은 빼고 `clipped:true`(R1-A5) |
  | `note` | `{id, kind, at, note: interrupted\|failed\|compacted, text, clipped}` — 중단·실패(API 오류)·압축 안내 |
- `clipped` = 글이 16000자(`ITEM_TEXT_MAX`)를 넘어 잘렸을 때 원래 길이(아니면 `null`). 도구 대상은 240자.
- 말풍선 하나 직렬화 64 KiB(`ITEM_BYTES_MAX`, R1-A5) — 글자 상한만으로는 바이트가 막히지 않아서(한글 3바이트·이스케이프 6바이트) 넘으면 글을 더 자르고(`clipped` 는 원래 길이),
  도구 줄은 앞쪽부터 덜고, 질문은 뒤 문항부터 덜고, 안내 글은 500자로. 그래서 어떤 말풍선도 프레임 하나에 든다.
- **세대 `gen`** = 색인 한 번마다 새로 뽑는 값 + `.` + Claude rewind 횟수(R1-A4). 처음부터 다시 색인하면(파일 교체·줄어듦·inode/장치 변화·이미 읽은 구간 덮어쓰기·판독자를 버린 뒤 새로 열기)
  세대가 반드시 바뀐다. 덮어쓰기는 파일 크기·수정 시각이 바뀔 때마다 이미 읽은 구간의 **앞·뒤 4 KiB 해시**를 다시 대 봐서 잡는다(같은 크기 덮어쓰기 포함).
  세대가 바뀌면 구독자 모두에게 `reset` 을 보낸다. 앱은 지금 세대가 아닌 `chat.items`·`older` 를 버린다.
- **변경 순번 `cursor`**(R1-A2): 판독자는 말풍선이 생기거나 바뀔 때마다 순번을 올려 그 말풍선에 붙인다. `chat.page`·`chat.items` 의 `cursor` = **이 프레임까지 받았으면 확정되는 순번** —
  한 묶음(이어 받기 또는 한 번의 push)을 여러 프레임으로 나누면 마지막 프레임만 새 순번이고 앞 프레임은 묶음 전 순번이다(R2-A1). 앱은 받은 가장 큰 값을 든다 —
  중간에 끊기면 묶음 전 순번으로 이어 받아 나머지를 다시 받는다(같은 id 는 합친다).
- **보낸 범위**(R2-A2): 구독마다 보낸 말풍선 중 가장 오래된 id 를 든다(첫 페이지·과거 페이지·이어 받기의 `from`). 그보다 앞(앱이 아직 불러오지 않은 과거) 말풍선이
  바뀌어도(늦은 도구 결과 등) push 하지 않는다 — 앱 배열 앞에 끼어 과거 요청 경계(`before`)를 당기지 않게. 그 과거 페이지를 열면 그때의 최신 상태로 받는다.
- **이어 받기**: `gen` 이 지금 세대이면 `id ≥ from` 이고 순번이 `cursor` 보다 큰 말풍선(새로 생긴 것 + 끊긴 동안 자란·바뀐 것)을 `mode:'resume'` 으로. 400개(`CHAT_RESUME_MAX`) 넘으면 reset.
  `from` 은 앱이 들고 있는 가장 오래된 id — 그 앞의 바뀐 말풍선은 앱에 없으니 보내지 않는다.
  아니면 `mode:'reset'` 으로 최근 40개(`CHAT_PAGE_SIZE`). 이어 받기가 프레임 하나를 넘치면 첫 프레임 뒤를 `chat.items` 로 나눠 보낸다(빠짐 없음).
- **과거**: `chat.older` → `before` 앞 40개, `mode:'older'`. `hasOlder` = 이 페이지 앞에 더 있는지. 보내는 프레임 하나 256 KiB(`MAX_FRAME_BYTES`) — `reset`·`older` 가 넘치면 오래된 쪽부터 덜어 내고 `hasOlder` 가 남은 것을 말한다.
- 시각: `at` = 서버가 보낸 시각 · `readAt` = 그 줄을 읽은 시각 · `writtenAt` = 파일 수정 시각 · 말풍선 `at` = 기록의 시각(3초 측정 Y3 재료).
- 보내기 직전마다 목록과 같이 연결이 닫는 중이 아닌지·기기가 해지되지 않았는지 본다 — 해지·`replaced` 뒤에는 한 건도 가지 않는다. `list.subscribe` 를 다시 보내도 대화 구독은 끊기지 않는다.
  공급이 없는 서버(시험)는 `unknown_type`.
- 비용 로그: `mobile.chat_index {agent, bytes, items, ms, lines}` · `mobile.chat_index_paused {agent, bytes, of}` · `mobile.chat_push {items, bytes, subscribers, readMs, sendMs, totalMs}` ·
  `mobile.chat_page {mode, items, frames, bytes, firstPageMs}` · `mobile.chat_subscribe {agent, status, readers}` · `mobile.chat_unavailable {reason, retrying}` · `mobile.chat_session_switch {agent}` ·
  `mobile.chat_recovered {agent, reason}` · `mobile.chat_reader_drop {readers}` — 글은 없다.
  구간(C2·R2-A5): `firstPageMs` = **구독 입구(`subscribe` 호출 — 세션 찾기 전) → 보낼 프레임이 다 준비된 때**(색인 기다림·가림·변환·크기 조절·직렬화 포함, sink 직전. 세션 교체·회복이면 다시 붙은 때부터) ·
  `readMs` = 그 변화를 읽은 꼬리 확인 한 번(stat·덮어쓰기 확인·읽기·파싱·순번 찍기) · `sendMs` = push 입구 → 발송 끝(변경 말풍선 고르기·보낸 범위 거르기·변환·직렬화·발송) ·
  `totalMs` = `readMs + sendMs`. 최종 관문(Y4·Y10ⓓ)은 이 로그와 폰 수신 시각(`chat_recv`)을 따로 남겨 교차 대조한다.
- **보내지 않는 것**: 생각(thinking·reasoning) 글 · **도구 결과 본문**(성공/실패 여부만) · 도구 입력 전체(대상 한 줄 미리보기만) · 시스템·하네스가 넣은 사용자 줄(지문 규칙으로 거른다) ·
  기록 파일 경로·세션 id · **홈 디렉터리 아래 절대경로** — 대화의 모든 글(지시·답·도구 대상·질문·안내)을 목록과 같은 `maskPaths` 로 가린다(worktree 상대 · `~/…`).
  어느 줄이 어느 말풍선이 되고 무엇을 버리는지는 `specs/LIFE-581-mobile-chat/raw/claude/mapping.md`.

## 4. 오류 코드

| code | 뜻 | 연결 | close 코드 |
| --- | --- | --- | --- |
| `bad_json` | JSON 이 아니다 | 인증 전 닫음 · 인증 뒤 유지 | 4004 |
| `bad_message` | 모양이 틀렸다(타입 없음·protocol 없음·바이너리) | 인증 전 닫음 · 인증 뒤 유지 | 4004 |
| `protocol_mismatch` | `protocol` 이 1 이 아니다 | 닫음 | 4002 |
| `unauthorized` | 토큰 없음·틀림·해지됨(구별하지 않는다) | 닫음 | 4001 |
| `not_authenticated` | 인증 전 hello·pair 아닌 메시지(`ping`·`list.subscribe`·`chat.*` 포함) | 닫음 | 4001 |
| `code_expired` | 만료된 페어링 코드(10분 지남) — 새 QR 을 만든 뒤에도 그 코드는 만료로 답한다 | 닫음 | 4005 |
| `code_used` | 이미 쓴 페어링 코드(1회 사용) | 닫음 | 4005 |
| `code_invalid` | 그 밖 전부 — 모르는 코드 · 형식 오류(문자열 아님) · 코드 없음 · **5회 실패로 폐기된 코드** · **새 QR 로 무효화된 이전 코드** · 스위치를 꺼 폐기된 코드 · 기억 범위(최근 8개) 밖의 끝난 코드 | 닫음 | 4005 |
| `pair_rejected` | 코드는 맞았으나 기기 저장(디스크 쓰기)이 실패했다 — 코드는 소모되지 않는다 | 닫음 | 4005 |
| `device_limit` | 기기 5대가 차 있다 — 데스크톱에서 해지한 뒤 다시 | 닫음 | 4005 |
| `unknown_type` | 인증 뒤 모르는 타입 | 유지 | — |
| `auth_timeout` | 10초 안에 인증하지 않았다 | 닫음 | 4008 |
| `revoked` | 열린 연결의 기기가 해지됐다 | 닫음(0.5초 뒤 강제 종료) | 4003 |
| `unavailable` | 노출이 막혔다(`exposed` 아님) — 새 hello·pair 거절, 이미 열린 연결도 이 코드로 닫는다 | 닫음(0.5초 뒤 강제 종료) | 4009 |
| `replaced` | 같은 기기가 새 연결로 다시 인증했다 — 이전 연결에만 보낸다(LIFE-578 E3) | 닫음(0.5초 뒤 강제 종료) | 4006 |

앱 종료·스위치 끄기는 close 1001. 생존 확인 마감으로 끊긴 연결은 close 프레임 없이 TCP 를 닫는다(상대 쪽에서 1006).

## 5. 페어링 QR 페이로드

QR 은 아래 JSON 문자열을 담는다. 같은 내용을 설정 › Mobile 에 텍스트로도 보여 준다.

```json
{"kind":"corral-pair","v":1,"url":"wss://<mac>.<tailnet>.ts.net:8577/ws","code":"ABCD2345"}
```

- 코드: 8자, 알파벳 `ABCDEFGHJKMNPQRTUVWXY23456789`(혼동 문자 I·L·O·S·Z·0·1 제외, 29자 ≈ 39비트). 대소문자·앞뒤 공백 무시.
- 10분 유효 · 1회 사용 · 5회 틀리면 폐기 · 유효 코드는 동시에 하나(새 QR 이 이전 코드를 무효화) · 스위치를 끄면 폐기.
- 실패 오류(R5 A4ⓖ): 만료 → `code_expired`, 사용 → `code_used`, 그 밖 → `code_invalid`(§4). 서버는 만료·사용으로 끝난 코드의 **해시**만
  최근 8개 기억한다(메모리, 스위치 끄면 비움). 그 코드로 온 `pair` 는 활성 코드의 실패 횟수로 세지 않는다 — 추측이 아니라 이미 받은 코드라서.
- QR 은 serve 로 노출된 동안에만 만든다(주소가 있어야 한다).

## 6. 비밀이 사는 곳

| 비밀 | 어디에 | 어디에 **없나** |
| --- | --- | --- |
| 기기 토큰(32바이트 무작위, base64url) | 폰. 서버는 `paired` 응답으로 한 번 보내고 잊는다 | 디스크(해시만) · 로그 · IPC push · 오류 문구 |
| 토큰 해시(SHA-256) | `<userData>/mobile/devices.json`(0600, 폴더 0700, `atomicWrite`) | — |
| 페어링 코드 | main 메모리(해시) + 「QR 만들기」 응답 → 설정 화면 상태 | 디스크 · 로그 · `corral:mobile` push |
| serve 소유권 기록 `{host, httpsPort, target}` | `<userData>/mobile/serve-owner.json`(0600) | (비밀 아님 — 다음 기동 reconcile 용) |

토큰 비교는 SHA-256 해시를 길이 확인 뒤 `timingSafeEqual` 로. 코드 비교도 해시 + `timingSafeEqual`.
판정·변경(코드 확인 → 기기 등록 → 코드 소모, 해지)은 동기 코드라 동시 `pair` 사이에 끼어드는 틈이 없다.

## 7. 위협 모델 메모

- **loopback 의 다른 로컬 프로세스도 이 포트에 붙을 수 있다.** 같은 맥의 아무 프로세스(브라우저 페이지의 JS 포함)가 `ws://127.0.0.1:<포트>/ws` 를 열 수 있다.
  그래서 **경계는 페어링 토큰**이다 — 인증 전에는 아무 데이터도 없고, 코드 추측은 39비트 · 5회로 막힌다. 브라우저 페이지는 `Origin` 검사로
  막는다(§2 Origin). Origin 을 보내지 않는 로컬 프로세스는 막지 못한다 — 그것은 토큰이 막는다.
- **페어링 실패 구분(R5 A4ⓖ)이 주는 정보** — 「이 코드는 최근에 만료됐다/쓰였다」 는 사실뿐이다. 끝난 코드는 다시 쓸 수 없고, 그 값을 알려면 이미
  QR·화면을 본 사람이어야 하며, 39비트 추측으로 끝난 코드를 맞히는 것은 활성 코드를 맞히는 것만큼 어렵고 맞혀도 얻는 것이 없다. 활성 코드에 대한
  추측은 여전히 `code_invalid` 하나로만 답하고 5회로 막힌다 — 활성 코드에 관한 정보는 늘지 않는다. 낮음으로 평가한다.
- **맥 이름**은 인증 뒤에만 준다 — 페어링 안 된 접속자는 이름을 얻지 못한다(tailnet 의 기기 목록에는 이미 보이는 수준의 값).
- tailscale serve 가 붙이는 `Tailscale-User-*`·`X-Forwarded-For` 헤더는 쓰지 않는다 — loopback 에서는 위조할 수 있다(W6).
- serve 경유 요청은 전부 `127.0.0.1` 에서 오므로 IP 별 제한은 의미가 없다(E3) — 코드 실패 횟수는 코드 하나에 건다.
- tailnet 의 다른 기기는 `wss://…:8577` 에 닿는다. 그 역시 토큰이 경계다. Funnel 이 노드에 하나라도 켜지면 corral 항목을 내린다(60초 이하 주기 재확인, 현재 30초).
- `tailscale` argv 는 상수와 숫자(포트)만으로 조립한다. `serve reset`·`funnel` 을 부르는 경로가 없고, 제거는 소유권 기록과 serve 설정의
  `<host>:8577` 의 `/` 프록시가 일치할 때만 `serve --yes --https=8577 --set-path=/ off` — `/` 하나만 지우고 같은 host:port 의 남의 다른 경로는 남긴다(R1-A4).
  포트 점유(배경 TCP·Web 키, **Foreground 세션** 포함 — R1-N1)와 `/` 소유는 따로 본다: 남이 그 포트를 쓰면 올리지 않는다(`foreign`).
  **올리기(등록·재등록·대상 교체)는 `<host>:8577` 에 어떤 항목도(남의 다른 경로·`/` 의 Path/Text·TCP 칸·Foreground) 없을 때만**(R2-A3 · 수정 r4 사용자 결정).
  하나라도 있으면 corral 은 자기 `/`(기록과 host·target 이 일치하는 Proxy)를 **지울 수는 있지만 다시 올리지 않는다** — 상태 `foreign`, serve 쓰기 0,
  화면 안내 「HTTPS 포트 8577 에 다른 항목이 있다 — … 그 항목을 치우면 다시 확인에서 올린다」(A6ⓒ). 이미 노출 중에 남의 경로가 생기면 그대로 노출을
  유지하고, 끄기·종료·Funnel 차단 때 자기 `/` 만 지운다(R1-A4).
  **사용자 경험 대가:** 크래시 뒤 재기동(서버 포트가 바뀌어 대상 교체가 필요할 때)이나 정상 종료 뒤 재기동 때 8577 에 남의 경로가 있으면 corral 은
  올라가지 않는다 — 사용자가 그 항목을 치운 뒤 「다시 확인」 을 누른다. 소유 기록은 지금 설정에 있는 자기 `/` 를 가리킬 때만 의미가 있고, 자기 `/` 가
  사라지면 버린다(제거 직후 조회가 실패하면 기록을 남겨 두지만, 다음 조회에서 host·target·Proxy 가 일치하지 않으면 버린다).
- **쓰기 직전 재조회·쓰기 뒤 대조(R1-A3).** add·off 바로 앞에서 `serve status --json` 을 다시 읽어 그때도 올릴 수 있을(지울 수 있을) 때만 쓰고,
  쓴 뒤 다시 읽어 「`/` 만 바뀌었나」 를 대조한다. 다른 곳이 바뀌었으면 `failed` + 경고(「serve 설정이 corral 쓰기와 동시에 바뀌었다」).
  기대 delta 에는 CLI 가 스스로 하는 정리 하나를 넣는다(R2-A2): **이 `<host>:8577` 키의 `AllowFunnel:false`** 삭제 — add 의 `SetFunnel(false)`,
  off 의 `RemoveWebHandler(cleanupFunnel)`(1.102.2 `ipn/serve.go:514`·`:536`). 다른 키·`true` 값의 변화는 계속 동시 변경으로 잡는다.
  **잔존 위험: 외부 클라이언트가 같은 루트를 ms 창 안에 바꾸는 경합은 CLI 방식의 잔존 위험이다.** 재조회와 쓰기 사이(수 ms~수십 ms)는
  원자적이지 않다 — tailscale CLI 에 조건부 쓰기(ETag)가 없어서다. LocalAPI(ETag 조건부 `SetServeConfig`)로 옮기면 닫히지만 이번 범위가 아니다.
  **같은 루트의 중간 변경은 미탐지될 수 있다 — 쓰기 뒤 상태에 차이가 남을 때만 경고한다**(R2-A6). 예: 재조회와 쓰기 사이에 남이 `/` 를 바꾸고
  우리 쓰기가 그것을 덮으면 쓰기 뒤 상태는 기대와 같아 보여 경고가 없다.
- **Tailscale 이름이 바뀌면(R1-A11)** 기록의 host 와 지금 `Self.DNSName` 이 다르다. 옛 이름의 `/` 를 CLI 로는 지울 수 없다 — `off` 는 **지금** 이름으로
  키를 만든다(tailscale 1.102.2 `serve_v2.go:451`). 새 이름으로 `off` 를 부르면 남의 항목을 지울 수 있어 부르지 않고, 노출됨으로 쓰지 않은 채 `failed`
  로 알린다. 옛 항목이 사라지면 다음 재확인이 기록을 버리고 새 이름으로 올린다. 스위치 끄기·재기동·재확인만으로는 풀리지 않는다.
  **복구 절차**(화면 경고에도 같은 문구 — **소스 근거 추론, 미실행**: 실제 tailscale 로 이름을 바꿔 실행해 보지 않았다):
  1. Tailscale 관리 콘솔(Machines › 이 맥 › Edit machine name)에서 이름을 **기록의 옛 이름**으로 잠시 되돌린다 — `Self.DNSName` 이 기록 host 와 같아진다.
  2. 설정 › Mobile 을 **끈다**. 기록과 이름이 맞으므로 corral 이 자기 `/` 만 `off` 로 지우고 기록을 버린다 — 상태가 「꺼짐」 이 되는지 확인한다
     (`tailscale serve status --json` 에 옛 `<옛 이름>:8577` 키가 없는지도 볼 수 있다).
  3. 새 이름으로 다시 바꾸고 Mobile 을 켠다 — 새 이름으로 등록되고 QR 주소가 바뀐다(기기 토큰은 그대로 유효하다 — 폰이 새 주소를 얻는 방법은 M2 몫).
  전체 `tailscale serve reset` 은 **권하지 않는다** — 남의 serve 항목까지 지운다(00-analysis W2).
- **노출이 막히면 로컬 서버도 닫는다(R1-A2).** Funnel·HTTPS 꺼짐·serve 제거 실패 등 `exposed` 가 아니면 새 인증을 `unavailable` 로 거절하고 열린 연결도 닫는다.
  「Funnel 이 켜져 corral 항목을 내렸다」 경고와 `removed:true` 로그는 제거를 다시 읽어 확인했을 때만 남긴다 — 못 내렸으면 `failed`, 재확인이 다시 내린다.
- **계측 소켓(`CORRAL_CONTROL_SOCKET`)의 `mobile-pairing`(R1-A6)** 은 소켓 폴더가 이 사용자 소유·심링크 아님·0700 이고 소켓 파일이 0600 일 때만
  코드를 돌려준다(소켓은 umask 077 아래에서 만들고 0600 으로 고정). 아니면 `control_socket_not_private` 로 거절한다. 같은 UID 의 다른 프로세스는 막지 못한다.
