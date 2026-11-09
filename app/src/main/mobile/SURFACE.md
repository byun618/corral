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

프레임 하나 최대 16 KiB(넘으면 close 1009). **예외 둘**: 인증된 연결의 `input.send`·`question.answer` 는 `2×65536+4096` 바이트까지(LIFE-582 P7 — 본문·직접 입력 65536 UTF-8 바이트가 JSON 이스케이프로 불어도 들어가게).
**인증 전** ws 수신 한도(`maxPayload`)는 정확히 16 KiB 다 — 프레임 머리의 선언 길이로 본문이 오기 전에, 끝나지 않은 조각(`fin:false`)은 누계로 넘으면 1009(LIFE-582 R2-A6).
인증되면 그 연결의 수신 한도만 위 예외 크기로 넓힌다,
완성된 프레임도 16 KiB 를 넘으면 파싱 전에 1009. **인증 뒤** 16 KiB 를 넘는 프레임은 JSON 이고 `type` 이 그 둘일 때만 받는다 — 바이너리·JSON 아님·다른 타입은 1009(그 둘의 모양 오류는 `bad_message`, 연결 유지). 16 KiB 이하 바이너리 프레임은 `bad_message`. 연결 후 **10초 안에** 인증(`hello` 성공 또는 `pair` 성공)하지 않으면 `auth_timeout`.

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
| `input.send` | 인증 뒤 (LIFE-582) | `{type:'input.send', id:'<폰이 만든 id — [A-Za-z0-9_-]{8,64}>', channel, text:'<1~65536 UTF-8 바이트>'}` — 지시 보내기. 아래 「쓰기」 |
| `input.cancel` | 인증 뒤 (LIFE-582) | `{type:'input.cancel', id}` — 큐 취소(넣기 시작 전만) |
| `input.status` | 인증 뒤 (LIFE-582) | `{type:'input.status', ids:[id…, 100개까지]}` — 재연결 뒤 결과 조회 |
| `question.answer` | 인증 뒤 (LIFE-582) | `{type:'question.answer', id, channel, question:<질문 말풍선 id>, call:'<그 말풍선의 도구 호출 id>'\|null, digest:'<그 말풍선의 내용 지문 — 16진 32자>'\|null, answers:[{choices:[<0부터 선택지 번호>…], other:'<직접 입력>'\|null}…]}` — 문항 순서대로. 직접 입력은 합계 65536 UTF-8 바이트까지 |
| `turn.stop` | 인증 뒤 (LIFE-582) | `{type:'turn.stop', id, channel}` — 지금 턴 중단 |
| `input.pending` | 인증 뒤 (LIFE-582 r1) | `{type:'input.pending'}` — 이 기기의 끝나지 않은(`queued`·`sending`) 요청 전부를 `input.state` 로(지시는 `text` 까지) — 앱이 다시 시작해 id 를 잊었을 때의 복구(R1-A8) |

인증 전에 `hello`·`pair` 가 아닌 것(`ping`·`list.subscribe`·`chat.*`·쓰기 메시지 포함)은 `not_authenticated` 로 닫는다. 노출이 `exposed` 가 아니면(Funnel·HTTPS 꺼짐·실패 등) `hello`·`pair` 도
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
| `input.state` | 쓰기 메시지를 받을 때·상태가 바뀔 때마다 · 같은 id 를 다시 보내거나 조회하면 지금 상태 1건 (LIFE-582) | `{type:'input.state', id, channel, op:'send'\|'answer'\|'stop'\|null, state, wait:'turn'\|'gate'\|null, reason, at}` — 아래 「쓰기」 |
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
| `available:true, repos[], waiting[]` | `repos` = `{id, name, tasks[]}` · `tasks` = `{id, name, label, isDefault, groups[], channels[]}`(LIFE-588 — `name` 한 줄 꼴·`label` 머리 꼴, `groups` = `{id, name, label}` 하위 워크트리 묶음) · `waiting` = 「나를 기다리는 것」 채널 `id` 순서 |
| 채널 | `id`(pane id · 보존 행 `retained:<pane id>`) · `key`(안 읽음 장부 키 — provider 세션 참조의 SHA-256 앞 16자, 없으면 `pane:<pane id>`) · `status` live/closed · `kind` claude/codex/grok/null · `title` · `dot`·`dotUnseen`(데스크톱 점 9값 — 본 것으로/안 본 것으로 칠 때) · `depth` 0/1(띄운 관계일 때만 1) · `origin`(하위 워크트리 이름 — 한 줄 꼴) · `group`(하위 묶음 id, 루트·머리 없는 행은 null) · `spawnedBy` · `parent` · `preview` {question·approval·reply·prompt·tool·error·none} · `waiting` question/approval/login/other · `model` · `timeAt` · `activityAt` · `outcome` |

- 값·순서는 데스크톱 파생 함수(`shared/` 의 `buildSidebarSections`·`nestSectionItems`·`buildAgentRows`)로 만든다 — 「레포로 묶기」 보기, 데스크톱 필터·고정은 적용하지 않는다.
- **보내지 않는 것**: 셸 pane(에이전트 없는 pane)·서브에이전트 행 · **터미널 화면 내용** · 레포·작업 경로(`id` 는 경로의 SHA-256 앞 16자) ·
  **홈 디렉터리 아래 절대경로** — 미리보기 글(질문·도구 대상·지시·실패 사유)의 경로는 그 pane 의 작업 worktree 안이면 worktree 상대(`src/a.ts`, worktree 자신은 `.`),
  그 밖의 홈 아래면 `~/…` 로 바꿔 보낸다(`list.ts` `maskPaths`, R4-A1 — 경계를 열거하지 않는 한 규칙: ① 유효한 퍼센트 인코딩을 고정점까지 디코딩(이중·부분 인코딩 포함, 8중까지). 8회 안에 고정점에 닿지 못하면(9중 이상) 그 글 전체를 `…` 로 바꿔 보낸다 — 남은 인코딩 안을 볼 수 없으므로 원문도 부분 디코딩 결과도 싣지 않는다(fail-closed, R5-A1) ② 홈 문자열이 나오는 **모든 위치**를 앞 글자와 무관하게 찾고 뒤 경계(글 끝·`/`·영숫자 `_` `-` 가 아닌 글자)만 본다 ③ worktree 안이면 worktree 상대, 아니면 `~`. 과잉 가림은 허용한다(`/x/Users/me/a` → `/x~/a`, `file:///Users/me/a` → `file://~/a`, `/Users/me.bak` → `~.bak`) — 계약은 결과 글에 홈 절대경로가 남지 않는 것 하나다. `/Users/meow`·`/Users/me2`·`/Users/me-old` 는 다른 이름이라 그대로. 범위 밖: Windows 모양). 홈 밖 경로(`/tmp`·`/opt` 등)는 그대로 갈 수 있다 ·
  세션 참조 원문 · 환경·토큰·비용.
- **제목은 보낸다** — 데스크톱 사이드바 같은 자리와 같은 문자열(J4, R1-A3 계약 ①): provider 제목 → 첫 지시 → **터미널 제목 폴백**(셸 프롬프트 모양이면 cwd 의
  홈 축약 `~/…`, 그 밖은 터미널이 준 제목을 왼쪽 잘라 15자 — `shared/session-title.ts` 그대로). 그래서 홈 밖 경로 모양의 터미널 제목(`/tmp/x`)은 제목으로 갈 수 있다.
- **미리보기 순서**(J11 · R1-A5 코디 해석 · LIFE-581 X8): 질문 대기 → 그 질문 · 권한 대기 → 그 도구(claude) · 실패 → 실패 사유 · **작업 중이면 지금 도구** →
  **에이전트 마지막 답**(`reply`, 데스크톱 digest 의 마지막 활동 글 · 가림·160자) → 내 마지막 지시 → 마지막 도구(claude) → 없음. 작업 중 도구와 마지막 지시가 함께 있으면 도구, 실패 사유와 지시가 함께 있으면 실패 사유.
- **하위 워크트리 묶음**(LIFE-588 D1·D2): 작업 = `nestSectionItems` 단위 하나, 그 안 `descendants`(데스크톱 중첩 카드 순서)마다 열린 AI 세션이 있으면 `groups` 하나.
  `channels` = 루트 워크트리 행(열린 → 닫힌 → 머리 없는 하위의 닫힌 행) → 묶음마다 열린 → 닫힌. 한 묶음의 채널은 이어져 있다(폰은 `group` 이 바뀌는 곳에 머리를 그린다).
  옛 폰은 `label`·`groups`·`group` 을 무시하고 평탄 목록 + `↳ origin` 으로 그린다 — 프로토콜 버전은 올리지 않는다.
- **워크트리 이름 두 꼴**(LIFE-588 D3): 머리 꼴 `label` = 데스크톱 카드 제목(`worktreeDisplayName`), detached 면 ` · ` + 메타 배지 글(`worktreeIdentity().sidebarLabel` = `Detached HEAD @ <7자>`).
  한 줄 꼴 `name`·`origin` = `distinctWorktreeName`(detached 면 `<제목> @ <7자>`). 브랜치 있는·HEAD 없는 워크트리는 두 꼴이 같다. 문구는 서버가 데스크톱 함수로 만든다 — 폰은 만들지 않는다.
- `parent` — 대화 머리 「띄운 세션」(579 Q3, 계보에 부모가 있으면 **항상**, 부모를 모르면 `{title:null}`). `spawnedBy` 는 목록 행용 — 부모가 다른 워크트리(다른 작업·다른 하위 묶음·루트 쪽)에 있거나 모를 때만(LIFE-588 D5).
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
- **세션 이어 가기**(LIFE-766 — 코드 `../transcript-continued.ts`): Claude 가 세션을 백그라운드로 옮기면 새 id 의 새 파일로 이어 쓰고 옛 파일에 `continued-in` 줄을 남긴다. 그 시점에 herdr 참조는 옛 id 그대로이고 목록도 안 바뀐다.
  **참조(`pane.agentSession`)·채널 키는 고쳐 쓰지 않고** 읽는 쪽이 파일과 세션 id 를 함께 옮긴다 — 새 파일의 줄은 새 id 라, 옛 id 로 읽으면 사람 말풍선이 전부 사라진다.
  유효한 `continued-in` = 파일 끝 창 안의 마지막 것 · `continuedInSessionId` 가 소문자 UUID 모양 · 그 뒤에 `user`·`assistant` 줄 없음(옛 세션이 되살아나면 그 줄이 완성되는 즉시 원본으로 돌아온다) · 대상 파일이 **원본과 같은 폴더**에 있음(약 0.9초 늦게 생긴다).
  판별은 끝에서 거꾸로 본다. 메타 줄과 읽지 못하는 줄(쓰는 중·깨진 완성 줄·`type` 없음)은 지나가되 읽지 못한 줄은 표시만 남긴다. 완성된 `user`·`assistant` 를 먼저 만나면 **없음** — 뒤에 읽지 못하는 줄이 있어도 같다. `continued-in` 을 만나면 모양 위반은 **없음**, 뒤에 읽지 못한 줄이 있으면 **모름**, 아니면 **대상**. 파일 전체를 읽고도 결론이 없으면 읽지 못한 줄이 있었을 때 모름, 아니면 없음. 읽기 오류도 모름이다.
  모름이면 같은 파일의 직전 판별을 유지한다(파일이 교체되거나 줄었으면 잇지 않는다) — 직전 판별이 없으면 옛 파일에 머문다(비공식 형식 — 안전한 실패).
  창: 바뀐 파일은 끝 8 KiB(`CONTINUED_PROBE_BYTES`)를 읽고, 그 안의 줄을 다 봐도 결론이 없으면(메타 줄뿐 · 끝 줄이 창보다 커서 잘림) 64 KiB(`CONTINUED_TAIL_BYTES`)까지 넓힌다 — 파일이 바뀔 때마다 hop 당 그 창 크기까지 읽고, 8 KiB 로 끝나는 것은 작은 창 안에서 결론이 난 모든 경우다(`user`·`assistant`·`continued-in` 등). **64 KiB 를 다 읽어도 `continued-in` 이 안 보이면 없음이다** — 이동한 뒤 옛 파일이 창을 넘게 자라면 옛 파일로 한 번 돌아가(`reset` 1회) 거기 머물고, 그 줄이 닫혀도 새 파일로 돌아오지 않는다. 끝이 원 증상과 같은, 합의된 안전한 실패다 — 새 파일에 고정하면 되살아남 판별이 깨진다. 창에 걸린 첫 줄은 온전해 보여도 없는 것으로 본다.
  연쇄는 `CONTINUED_CHAIN_MAX`(8)까지이고 중간에 끊기면(대상 없음·모양 위반) 마지막으로 풀린 hop 에 머문다. 순환은 이미 본 파일 앞에서 멈춘다. Claude 의 id 참조만 — Codex·Grok·경로 참조는 읽지 않는다.
  붙어 있는 Claude 구독은 500 ms(`CHAT_FOLLOW_MS`)마다 참조가 찾은 원본에서 다시 걷는다(안 바뀐 파일은 stat 만, 프로젝트 폴더 훑기 없음, 볼 구독이 없으면 안 돈다). 파일이 달라지면 `reset` 페이지 1회로 옮겨 가고 옛 판독자는 유예 뒤 버린다(로그 `mobile.chat_continued`).
  참조가 뒤늦게 새 id 로 바뀌면(압축의 `SessionStart`) 파일이 같아 `reset` 이 없다. 목록 미리보기·대기 질문·턴 결과도 같은 판별로 새 파일의 지문을 쓴다. **남는 한계**: 새 파일이 대화를 복사한 범위만 스크롤로 보인다 — 옛·새 파일을 합치지 않는다.
  **빈 대상**: 포크 파일은 전환 직후 메타 줄뿐이고(2줄, 입력 때 5줄) 전환 뒤 **첫 입력 때에야** 옛 대화가 같은 파일 뒤에 복사된다(2.1.296 관측 — 같은 inode·앞부분 유지, 복사분은 uuid·timestamp 원본 그대로이고 `sessionId` 만 새 id. Enter 복귀만으로는 복사 안 됨). 그래서 대상에 **완성된 `user`·`assistant`** 가 없으면 대화 화면·지문은 그 앞 파일에 머문다 — 빈 `reset` 을 보내지 않는다. 대화가 생기면 `CHAT_FOLLOW_MS` 주기로 옮겨 간다. 연쇄 중간이 비었으면 그 앞에 머문다.
  대화 유무는 대상 파일을 **앞에서부터** 찾고 찾으면 끝난다(첫 대화 줄 실측 약 8 KiB — 끝 쪽은 큰 `attachment` 줄이 창을 채울 수 있다). 찾은 뒤 재읽기 0, 못 찾았으면 크기가 그대로일 때 재읽기 0·자라면 본 데까지 건너뛴다. 상한 `CONTINUED_CONVERSATION_MAX_BYTES`(16 MiB)까지 없으면 더 읽지 않고 그 앞 파일에 머문다.
  **남는 한계(빈 대상 구간)**: 전환 뒤 첫 입력까지 사이드바 지문·수명은 옛 파일·옛 id 로 읽는다(원 증상과 같은 값). 16 MiB 안에 대화 줄이 없는 대상은 옛 파일에 머문다(실측 없음, 안전한 실패).
  **수명 표시(LIFE-781)**: 전환(`←`) 전에 열린 백그라운드 셸은 전환 뒤에도 계속 돈다(실측 — 셸의 부모는 옛 대화형 프로세스, 끝 통지는 이어 받은 세션이 쓴다). 그래서 목록에 남긴다.
  옛 파일 끝은 `cost-state` → (멈춘 것의 `killed` 통지) → `continued-in` 순이다 — `cost-state` 에서 바로 닫지 않고 보류했다가 `continued-in` 이 오면 남은 것을 **이어 받은 세션에 넘긴 것**으로 적는다.
  보류분에서 두 가지는 뺀다: **Monitor**(문서·실측 모두 전환 때 멈춘다 — `killed` 통지가 없는 실제 기록도 있어 통지에 맡기지 않는다), 그리고 **이전 세대**(`cost-state` 를 읽을 때 그 파일 소유 프로세스가 살아 있어 시작 시각을 알았으면 그보다 먼저 열린 것 — 강제 종료 뒤 재개 전의 열림. 시작 시각은 보류 때 적고 거르기는 볼 때 한다).
  **연쇄 `←`**: 이어 받은 파일에서 다시 `cost-state`·`continued-in` 이 오면, 그 파일이 앞에서 넘겨받은 것은 원래 시각이 그 파일 소유자 시작 시각보다 앞이어도 다음 대상으로 이어 넘긴다 — 연쇄 장부를 원본부터 순서대로 읽어 가른다(합성 시험만, 실기 연쇄는 미확인).
  넘긴 것은 레지스트리에서 이어 받은 bg 세션 항목(`kind:"bg"` · `jobId` 가 대상 id 앞부분 · pid 생존)이 있는 동안 싣는다 — 모양이 다르거나 필드가 없으면 싣지 않는다(빠짐 쪽).
  첫 입력 전(옛 파일에 머무는 구간)에도 끝 통지는 새 파일 `queue-operation` 으로 오므로(실제 기록 1건) 새 파일 장부를 같이 읽어 닫는다. 첫 입력 뒤(새 파일)는 세대 경계(bg 시작 시각) 앞에 복사된 열린 항목 중 **옛 파일이 넘긴 id 만** 남긴다.
  옆 파일(앞 파일·새 파일) 장부를 따라잡는 동안은 넘김을 몰라 목록이 `unknown/catching-up` 이다 — 연쇄 앞쪽 파일(원본부터 바로 앞까지)은 지금 파일에 경계 앞 열린 항목(넘겨받을 후보)이 있거나 지금 파일이 넘긴 것의 세대 거르기가 그 장부에 달렸을 때만, 새 파일은 넘긴 것이 있을 때만 묶는다. 묶이는 시간은 **(연쇄 앞쪽 파일 크기 합 ÷ 2MB) × 판독 주기**다(앱을 막 띄운 때·큰 옛 파일) — 연쇄 앞쪽 장부가 다 따라잡힌 주기에 답을 다시 고른다. 첫 입력으로 옮길 때 따라잡은 앞 파일 장부는 버리지 않아 다시 읽지 않는다.
  첫 입력 전 새 파일에서 한도(2MB)보다 긴 줄을 건너뛰면 넘긴 것의 끝 통지였을 수 있어 목록은 `unknown/unreadable` 이고, 그 id 의 다른 끝 표지가 오면 풀린다.
  서브에이전트는 관측 2건이 갈린다: general-purpose 비동기 에이전트가 「they will be stopped」 뒤 멈춘 실측 1건(옛 파일 `killed`·새 파일 `failed`로 빠짐), `←` 뒤 약 9분 30초 살다 끝난 실제 기록 1건(끝 통지까지 실림). 그래서 에이전트는 통지로만 뺀다.
  옛 pane 을 닫아 옛 대화형 프로세스가 죽어도 셸은 살았고(부모가 1 로 바뀜) 옛 파일에 `cost-state` 가 한 줄 더 붙지만, 넘긴 것은 그대로다.
  `cost-state` 뒤 `continued-in` 이 없으면(정상 종료) 지금처럼 닫고, `continued-in` 뒤 같은 파일에 사람 줄이 이어지면(재개) 넘긴 것을 버린다 — 재개의 옛 세대 제외(LIFE-462 L8)는 그대로다.
  **신호는 2.1.296 관측이지 계약이 아니다**(`cost-state`·`continued-in` 순서, 레지스트리 `sessionId`·`kind`·`jobId`·`startedAt`). 판을 올리면 다시 잰다. 모양이 다르면(보류 없이 온 `continued-in`·모양이 아닌 대상 id) 아무것도 넘기지 않는다 — 고치기 전 동작(빠짐)이다.
  **남는 한계**: ① 옛 소유 프로세스가 이미 죽은 뒤 처음 읽으면(앱 재시작 등) 시작 시각을 몰라 이전 세대를 거르지 못한다 — 강제 종료·재개·`←` 가 겹치고 재개가 `stopped` 를 안 쓴 종류일 때만 거짓 「도는 중」이 될 수 있다(실제 기록 미관측). ② 이어 받은 세션을 `claude stop` 하면 셸이 살아 있어도 빠진다(주인이 없다). ③ bg 프로세스가 레지스트리에 오르기 전 잠깐은 빠질 수 있다. ④ 이어 받은 프로세스가 회수·재시작되는 경우(supervisor)는 LIFE-794. ⑤ pid 재사용은 가리지 못한다. ⑥ 통지 없이 멈춘 비동기 에이전트는 이어 받은 bg 가 사는 동안 남을 수 있다(미확인 — 관측한 멈춤은 모두 `killed`·`failed` 통지가 있었다). ⑦ 연쇄 `←` 는 합성 시험뿐이다 — 실기로 이어 받은 세션에서 새 파일을 만든 경로는 `claude stop` + 대화형 `claude --resume` + `←` 하나였고, 그 재개가 옛 셸을 `stopped` 로 닫아 연쇄로 넘길 열린 작업이 없었다(리뷰어 실기 2회). ⑧ 연쇄 앞쪽 파일 크기에 비례하는 `catching-up`(위).
- 판독: 처음 한 번 파일 전체를 1 MiB 조각으로 **비동기** 읽어 색인(조각 사이 이벤트 루프 양보 — 동기 전체 읽기 없음), 그 뒤 250 ms(`CHAT_POLL_MS`)마다 stat 해 늘어난 바이트만 이어 읽는다.
  개행으로 끝나지 않은 마지막 줄은 개행이 올 때까지 보류한다.
- **말풍선** `items[]` — 기록 순서(id 오름차순). `id` = 그 말풍선 첫 줄의 바이트 오프셋(한 줄에서 여럿이 나오면 소수 `+0.1`) — 같은 파일·같은 내용이면 다시 색인해도 같은 id.
  | kind | 모양 |
  | --- | --- |
  | `prompt` | `{id, kind, at, body:{text, clipped}}` — 사람이 친 지시(데스크톱 지문 규칙과 같은 판정) |
  | `reply` | `{id, kind, at, body:{text, clipped}}` — 에이전트 답(마크다운 원문). 여러 줄로 나뉜 한 답은 하나로 합친다 |
  | `tools` | `{id, kind, at, tools:[{name, target, status: running\|ok\|error\|unknown}], count, names:{이름:횟수}, detail}` — 이어진 도구 호출 묶음. `tools` 는 뒤쪽 120개(`TOOLS_MAX`)까지, 나머지는 `count`·`names`(많은 순 40칸 `TOOL_NAMES_MAX`)로만. `unknown` = 끝났지만 성공/실패를 기록에서 판정 못 함(R1-A9 — Codex 결과 머리에 종료 코드가 없을 때) |
  | `question` | `{id, kind, at, call, digest, questions:[{question, header, options:[{label, description}], multiSelect}], state: pending\|answered\|closed, answer, clipped}` — `call` = 그 질문의 도구 호출 id(없으면 null — 답할 때 같은 질문 대조, LIFE-582 R1-A2). 답하기는 M5(`question.answer`). 문항·머리·선택지·설명 합 8000자(`QUESTION_CHARS`) 예산 — 넘는 것은 빼고 `clipped:true`(R1-A5) |
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

### 쓰기 (LIFE-582 — 코드 `input.ts`(큐·확인) · `keys.ts`(provider 키 표·본문 정리·초안 판별) · `input-backend.ts`(guard 호출), 서버 분기 `server.ts`)

- **폰은 키·바이트를 보내지 않는다.** 위 쓰기 메시지(다섯 + 복구 조회 `input.pending`)가 전부다 — 질문 답은 「몇 번째 선택지 / 직접 입력 글」, 중단은 「중단」 만. 키 순서는 서버가 `keys.ts` 의 실측표(`specs/LIFE-582-mobile-input/raw/claude/z1-measure.md`)로 만든다.
- 넣는 길은 CLI `terminal prompt` 와 같은 guard 봉투(`corral.terminal`) — 지시는 `agent.prompt`, 질문 답·중단 키는 `pane.send_text`. 둘 다 **관측한 `state_change_seq` 그대로일 때만** 쓴다
  (`expected_state_change_seq` — `pane.send_text` 의 비교는 LIFE-582 가 guard 에 더했다, `backend/herdr-guard.patch`). 바뀌었으면 guard 가 아무것도 쓰지 않고 `agent_state_changed` 로 거절한다.
  지시(`agent.prompt`)는 거기에 **pane 의 사람 입력 revision** 까지 같은 App 턴에서 비교한다(R1-A3·R2-A3): guard 가 초안이 될 수 있는 PTY 사용자 입력 쓰기(키·글자·붙여넣기·
  `pane.send_text` — 데스크톱 타자와 attach 클라이언트 포함, 마우스 보고가 꺼진 alt-screen 의 휠 `AlternateScroll` 화살표 키 포함 — 마우스 보고(휠·클릭·드래그·이동)는 세지 않는다, LIFE-708)와 **제출 대기열에 넣은 `agent.prompt`(칸 없는 CLI 제출 포함)** 마다 revision 을 올린다. `agent.get` 과 **`pane.read`(화면)** 가 같은 턴의 `corral_input_revision`·`corral_input_idle_ms`
  (화면은 `corral_state_change_seq` 도)를 싣는다. corral 은 **화면을 잡은 턴**에 입력이 조용한 시간 하한(500 ms) 이상 조용했을 때만 그 화면을 믿고(아니면 기다림), 그 화면의 revision 이
  **접수 때 revision(R0)에서 허브 자기 쓰기 사슬만 따라간 울타리**와 같을 때만 그 울타리를 `expected_input_revision` 으로 보낸다(LIFE-598 r2·r3 — 아래 「접수 때 대상을 묶는다」) —
  넣는 순간까지 울타리 뒤 입력이 하나라도 있었으면 `input_changed`, 하한이 모자라면 `input_recent` 로 아무것도 쓰지 않는다 → 다시 관측해 입력이면 `mac_input`, 아니면 큐로 돌아가 다음 관문.
  하한 근거 = 격리 실측 echo(키 → 화면, 읽기 왕복 포함) 최대 Claude 225 · Codex 221 · Grok 223 ms(각 10표본, r2 — 부하·원격 attach 상한은 아니다).
  revision 이 없는 guard 면 넣지 않는다(`failed/guard_outdated`). 질문 답 키(`pane.send_text`)도 같은 울타리를 친다 — 아래 「질문 답」.
  같은 자리에 **모든 입력 revision**(`corral_any_input_revision`·`corral_any_input_idle_ms` — 마우스 보고까지 센다, LIFE-708 r1)도 싣는다. 울타리 친 `pane.send_text` 는
  `expected_any_input_revision` 을 받아 다르면 같은 턴에 `any_input_changed` 로 아무것도 쓰지 않고, 결과에 쓴 뒤 두 값을 돌려준다. 지시(`agent.prompt`)는 이 값을 쓰지 않는다.
  CLI `terminal prompt` 계약·AgentRecord 는 건드리지 않는다 — 관리되지 않은 pane(GUI 로 연 세션)도 같은 관문을 지난다.
- **목록의 살아 있는 AI 채널만**: 셸 pane·닫힌 세션·목록 밖은 `failed`(`not_listed`·`closed`), 세션 참조가 아직 없으면(Codex 첫 지시 전) `no_session`. 맥이 guard 바인딩 세션이 아니면 넣지 않는다(대기 → 실패).
  지시는 herdr **관리 에이전트**(데스크톱 GUI·하네스가 `agent.start` 로 띄운 것)와 **관리 밖 pane**(셸에서 직접 친 `claude`·`codex`·`grok`, `--resume` 포함 — LIFE-597, 582 D1 대체)에 넣는다.
  관리 밖 pane 은 `interactive_ready` 가 켜지지 않으므로 폰 경로만 `agent.prompt` 에 **`unmanaged_agent: <채널 종류>`** 를 실어 보낸다(관리 밖이라고 관측했을 때만 — 관리 pane 은 싣지 않는다).
  guard 는 그 칸이 있고 pane 에 관리 결속이 없을 때만(관리 pane 이 Pending·Blocked·Active 면 지금 술어 그대로) `interactive_ready` 대신 같은 App 턴에서 본다:
  ⓐ 칸의 종류 = herdr 가 감지한 종류(`unready: unmanaged_kind_mismatch`) — 전경 프로세스가 그 에이전트인지는 `queue_agent_prompt` 가 이어서 본다
  ⓑ 감지 상태·종류가 마지막으로 바뀐 뒤 **3 s 이상**(herdr `AGENT_START_SETTLE_DELAY` — 관리 기동이 Active 가 되기 전 기다리는 값, `unready: unmanaged_settling`).
  idle|done · launch_pending 아님 · seq · 입력 revision · 조용한 하한은 관리 pane 과 같다. corral 은 `agent.get` 의 `corral_state_quiet_ms` 가 3 s 를 넘은 뒤에만 넣으러 간다(거절로 헛돌지 않게 — 기다리는 동안 `queued/turn`).
  CLI `terminal prompt`·orchestration 은 이 칸을 싣지 않으므로 관리 밖 pane 에는 지금처럼 `agent_not_ready` 다.
  guard 가 이 갈래를 아는지는 handshake 의 `"unmanaged_prompt": 1` 로 안다 — 없는 guard(설치본 herdr 서버를 재기동하기 전, LIFE-582 D15)면 관리 밖 pane 지시는 **쓰지 않고** `failed/guard_outdated`
  (옛 guard 는 모르는 칸을 무시하고 `interactive_ready` 를 요구하므로 보내도 거절되지만, 기다리지 않고 바로 끝낸다). 질문 답·중단(`pane.send_text`)은 관리 여부와 무관하게 같은 seq 비교로 받는다.
- **메시지 id 당 많아야 한 번**: (기기, id) 를 기억한다(기기당 끝난 것 500개까지 상태를). 같은 id 를 다시 보내면 넣지 않고 `input.state` 로 지금 상태만. 같은 글이라도 새 id 면 새 지시다.
  500개에서 밀린 id 는 상태를 잊어도 **표지는 남긴다**(앱 기동 동안) — 다시 오면 넣지 않고 `unknown/expired`(R1-A6).
- **접수 때 대상을 묶는다**(R1-A5·R2-A4·LIFE-598 r2): 지시를 받으면 그 pane 의 backend epoch·PTY 세대·provider 세션·**입력 revision**(접수 때 herdr 관측, R0)을 묶는다.
  넣기 전 하나라도 바뀌면 `failed` — herdr 재시작·같은 pane 의 새 세션은 `target_changed`, 접수 뒤 입력은 `mac_input`(LIFE-709). 이전 지시가 새 세대로 따라가지 않는다.
  - **접수 뒤 맥 입력이 있으면 보내지 않는다**(LIFE-598 게이트 ① 결정 「1안」): 지시 대기 중 같은 pane 에 맥에서 **아무 키나** 치면(글자·Esc·`/clear`·붙여넣기, 그 pane 에 붙은
    다른 클라이언트의 쓰기 — CLI `terminal prompt`·orchestration 배달 포함 — 모두 맥 쪽 입력이다) 그 지시는 넣지 않고 `failed/mac_input`(쓰기 0) 다.
    마우스 보고가 꺼진 alt-screen 에서 휠은 herdr 가 화살표 키로 보내므로(`AlternateScroll`) 키와 같이 막는다 — provider TUI 에서 ↑ 는 이전 입력을 불러와 초안을 만든다.
    **마우스 보고**(provider 가 1000/1002/1003/1006 을 켠 pane 의 휠·클릭·드래그·이동)는 막지 않는다(LIFE-708) — herdr 가 마우스 의미 이벤트로 받아 인코딩한 쓰기는 guard 가
    입력 revision·조용한 시각을 움직이지 않는다(그 전에는 휠 +1·클릭 +2 로 지시가 실패했다 — LIFE-598 리뷰 r3 실측). 지시 경로에서 클릭이 에이전트 상태를 바꾸면 seq·준비 관문이 따로 막는다.
    **질문 답은 클릭도 계속 막는다**(LIFE-708 r1 · C10): 질문 대기(`blocked`) 중 클릭은 선택만 옮기고 seq 를 올리지 않을 수 있어, 답 경로는 아래 「질문 답」 의 **모든 입력 revision**(마우스 보고 포함)으로 울타리 친다.
    **전환기**: 새 guard 는 설치본 herdr 서버를 새 바이너리로 재기동한 뒤에 돈다 — 그 전(새 허브 + 옛 서버)에는 옛 guard 가 마우스도 세므로 휠·클릭도 `mac_input` 으로 보인다.
    반대 방향(옛 허브 + 새 guard)에서는 옛 허브가 모든 입력 값을 모르므로 답 경로가 맥 클릭을 못 본다 — herdr 는 앱 번들(`Contents/Resources/backend`)과 함께 움직이므로 이 조합은
    「새 앱으로 서버를 재기동한 뒤 옛 앱으로 되돌린」 경우뿐이다.
    **포커스 전환**(다른 pane·창으로 포커스만 옮김 — corral 의 `pane.focus` 경로)도 revision 을 올리지 않는다(리뷰 r3 실측 +0, 양성 대조 포함).
    범위 밖 — provider 가 포커스 보고(1004)를 켜면 그 pane 으로의 포커스 이동이 입력으로 센다(base 와 같음).
    **한계**: 다른 도구가 `pane.read`·`agent.read` 를 `recent` 소스로 읽으면 herdr 가 alt-screen 기록을 읽으려고 스스로 합성하는 휠(`alt_screen_read.rs`)은 여전히 입력으로 센다(base 와 같다 —
    corral 은 `visible`·스트림 소스만 쓰므로 그 휠을 만들지 않는다).
    폰 문구는 「그 사이 맥에서 입력이 있어 보내지 않았습니다」(LIFE-709 — 세션·세대가 바뀐 `target_changed` 는 「그 사이 세션이 바뀌어 보내지 않았습니다」 그대로).
    `mac_input` 을 모르는 옛 앱은 사유 없이 「보내지 못했습니다」 로 보인다(모르는 사유는 문구 없이 그린다 — 깨지지 않는다).
    허브 자기 쓰기 경합의 거짓 실패(아래 「남는 창」 — 자기 쓰기와 재관측 사이 맥 키 등, 빈도 낮음)도 이 사유로 보일 수 있다. 기다리지 않는다 — 대기 중이어도 다음 관측에서 바로 끝낸다.
  - **보장 강도 — 결정적인 것은 revision 울타리**: 효과(`agent.prompt`)의 `expected_input_revision` 이 **R0 에서 허브 자기 쓰기 사슬을 따라간 끝**(자기 쓰기가 없으면 R0)이라 guard 가 쓰는 같은 App 턴에서 접수 뒤 남의 입력을 거절한다.
    `/clear` 는 키 입력이라 herdr 가 새 세션을 언제 알든(리뷰 r2 실측 Enter 뒤 최대 ≈ 6 s, 한 번은 7 s 안에 반영 안 됨 — Claude 세션 참조는 SessionStart 훅 경로라 상한이 없다) 막힌다.
    guard 가 거절하면 다시 관측해 그 revision 을 지금의 사슬로 가른다 — 사슬 밖(`moved`, 접수 뒤 남의 입력)이면 `mac_input`(`input_refused`), 사슬 위이거나 자기 쓰기 진행 중(`behind`)이면
    상태 전이로 보고 큐로 돌아가 다음 관문을 기다린다.
  - **허브 자기 쓰기는 접수 뒤 입력이 아니다**(r2·r3): 같은 pane 앞 지시의 넣기·질문 답 키·중단 키는 쓰기 **전에** 「쓰기 직전 revision → +1」 고리를 걸고 그 pane 에 쓰기 진행을 표시한다.
    대기 지시의 울타리는 R0 에서 이 고리들만 따라간 값이고, 관측 revision 이 그 사슬 위의 값이면 남의 입력이 아니다(사슬 중간 값이면 다시 본다). 쓰기 진행 중에는 사슬 밖 값도 실패로 단정하지 않고
    효과도 내지 않는다 — guard 에서 쓰기가 일어난 뒤 응답이 오기 전에 대기 지시가 새 revision 을 봐도 거짓 `mac_input` 이 아니다(리뷰 r3 C·R3-C2).
    **진행 중 미룸이 걸리는 곳**: 지시 경로의 효과 직전(다른 자기 쓰기가 진행 중이면 넣지 않는다 — 중단·답 키가 guard 에 닿기 전 맥 키가 예측 끝값과 같아지는 창을 이것만 막는다, 리뷰 r4 C·R4-C1)과
    질문 답의 첫 키 앞(같은 pane 지시 쓰기가 끝나 고리가 확정·회수될 때까지 기다린다 — 미확정 끝값을 울타리로 쓰지 않는다, 기한 넘으면 키 0회 `failed/busy`, R4-C4).
    고리 확정: **키**는 guard 가 돌려준 쓴 뒤 revision 이 고리 끝이다. 응답에 revision 이 없는 **지시**(guard 가 같은 턴에서 1 올리는 규칙 — `queue_user_input_submission` → `corral_note_input`)와
    **울타리 없는 중단 키**는 예측 +1 을 그대로 믿지 않고 끝난 뒤 다시 관측해 직전+1 일 때만 확정한다(R4-C3) — +0(guard 계약 깨짐)이면 거둬 뒤 지시는 R0 그대로 울타리(영구 대기 없음),
    +2 이상(그 사이 맥 입력)이면 거둬 뒤 지시는 `mac_input`. 남는 창: guard 가 +0 인데 맥 키가 쓰기와 그 재관측 사이(RPC 한 번)에 든 경우. 거절이면 거두고, `unknown`(썼을 수 있음)·백엔드 reject 도
    거둔다(reject 는 `finally` 로 진행 표시까지 닫는다 — R4-C2) — 뒤 지시는 `mac_input`(쓰지 않는 쪽). 쓴 뒤 revision 이 직전보다 크지 않으면 고리를 걸지 않고, 사슬은 순환·반복 상한으로 끊는다(R3-C3).
    쓰기 직전 revision 은 그 쓰기의 울타리(guard 가 같은 턴에서 확인)라 그 사이 맥 입력이 끼면 쓰기가 거절된다. **중단 키(Claude·Codex)는 울타리 없이** 보낸다(LIFE-598 r3 — 02-kickoff
    「중단 경로는 바꾸지 않는다」, 응급 조작이 휠·타자에 실패하지 않게) — 고리는 바로 앞 관측 revision → +1 이고, 관측과 키 사이 맥 입력이 끼면 실제 revision 이 고리 끝을 넘어
    뒤 대기 지시는 `mac_input`(쓰지 않는 쪽). Grok 의 Ctrl+C 는 이전대로 빈 입력 줄 울타리(R3-A6)이고 그 울타리 값에서 고리를 건다.
  - **보조 — 효과 직전 세션 대조**: 목록(이 프로세스 상태라 그 확인과 넣기 호출 사이에 바뀌지 않는다)과 **herdr 관측**(효과 호출 바로 앞에서 다시 한 `agent.get` 의 `agent_session`,
    source·kind·값으로 대조 — LIFE-598 r0·r1) 둘 중 하나라도 접수 때와 다르면 `target_changed`. 관측에 세션이 없으면 같은 세션임을 증명 못 한 것이라 쓰지 않고 `target_changed`.
    목록 세션은 herdr 가 새 세션을 받은 뒤 정상 응답이면 **최대 약 1.5 s**(+ 왕복), herdr 응답이 느려도 **응답이 timeout 안에 오는 한** 최대 약 2.5 s(주기 1.5 s + 조회 timeout 1.0 s) 늦게 바뀐다(연속 timeout 이면 그보다 늦고 런타임 로그에 `agent_session.poll.failed` 가 남는다)
    (LIFE-710 — 에이전트가 붙은 pane 이 있는 동안 런타임이 `agent.list` 를 1.5 s 마다 보내 세션 참조만 맞춘다, `adapter/internal/link.ts` `AGENT_SESSION_POLL_MS`.
    전에는 30 s 재동기까지 기다려 `/clear` 뒤 약 20~25 s 옛 값이었다 — 598 final/f1q). herdr 도 `/clear` 뒤 수백 ms 는 옛 세션이고
    보고가 상한 없이 늦을 수 있어 이것만으로는 확률적이다 — 접수 뒤 `/clear` 는 울타리가 막고, 이 대조는 아래 구멍을 일부 줄인다.
    남는 창(herdr 보고 전 수백 ms + 목록 따라잡기 상한) 안에 접수된 폰 지시는 목록 기준으로 옛 세션에 묶이고, herdr 관측이 그새 새 세션이면 이 대조(`herdr_session`)에서
    `failed/target_changed` 로 끝난다(598 final/f1b 의 긴 지시가 이 갈래 — 쓰지 않는 쪽). 폰 목록이 새 세션으로 바뀐 뒤 다시 보내면 들어간다.
  - **남는 구멍**(범위 한계, 막지 않는다): 맥에서 `/clear` 를 **먼저** 치고, 목록·herdr 가 아직 새 세션을 모르는 때(Enter 뒤 수백 ms~수 초) 폰 지시가 **접수**되면 R0 가 이미 그 키를 포함한다 —
    울타리로는 못 막고, 효과 직전 herdr·목록 대조가 그때까지 새 세션을 알면만 막는다(모르면 새 세션에 들어간다 — `unconfirmed/record_missing` 로 보인다).
    R0 는 접수 뒤 `bind` 의 locate·observe 왕복(리뷰 r3 실측 ≈ 0~0.3 s) 뒤의 표본이라, **접수 직후 그 왕복 동안 친 키**도 같은 구멍에 든다(답은 `before` 관측까지 같다 — revision 은 RPC 로만 와 접수 시점에 얻을 수 없다).
  - r1 의 효과 시점 2 s 조용함 하한(`sessionSettleMs`)은 되돌렸다(지연 비용만 남아서) — 조용함 하한은 echo 를 덮는 500 ms(`quietMs`) 하나다. guard `min_input_idle_ms` 도 500.
  - 실패 갈래는 로그 `mobile.input_target_changed` 의 `check`(`list`·`pane`·`herdr_session`·`input`·`input_refused`, 질문 답은 `any_input` 도)로 남는다 — 무엇이 막았는지 실물 회차가 가른다.
    지시의 사유는 갈래를 따른다: `input`·`input_refused` → `mac_input`, `list`·`pane`·`herdr_session` → `target_changed`. 질문 답은 입력 울타리도 `question_changed`, 답 키 사이 세션 대조는 `target_changed` 그대로다.
- **해지·끔**(R1-A1·A4): 기기를 해지하면 그 기기의 대기 지시는 `failed/revoked`(결과도 보내지 않는다). 모바일을 끄면 활성 세대가 바뀌어 이전 세대의 요청은 효과를 내지 않는다 — 넣는 중이던 지시에
  늦게 온 guard 거절도 큐로 되살리지 않는다(`failed/mobile_off`), 질문 답은 남은 키를 멈춘다(일부가 들어갔으면 `unconfirmed`). 매 await 뒤·효과 직전에 페어링과 세대를 다시 본다.
  **연결이 끊긴 것(폰 화면 끔)은 해지가 아니다** — 큐는 남고 결과는 다음 연결에서 조회로 받는다.
- **state**: `queued`(큐 — `wait:'turn'` 작업 중이라 기다림 · `'gate'` 준비 관문 확인 중) → `sending`(넣기 시작 — 취소 불가) → 끝: `delivered`(들어감) · `unconfirmed`(확인 못 함 — 들어갔을 수 있다, 다시 넣지 않는다) ·
  `failed`(넣지 않았다) · `cancelled` · `stopped`(중단 확인). 조회한 id 를 서버가 모르면 `unknown`(`channel`·`op` null, 기억 만료면 `reason:'expired'`) — 앱은 **「들어갔는지 확인하지 못했습니다」**(unconfirmed/unknown)로 둔다
  (들어갔을 수 있다 — 「보내지 못함」 이라 하지 않는다. r0 앱은 failed 로 두었다, R1-A8 에서 정정).
- **들어감 = 이 제출 직전 커서 뒤 기록 매칭 정확히 1건**(`countSubmissions`, CLI 와 같은 대조, 15초). 0건 `unconfirmed/record_missing` · 2건 이상 `record_ambiguous` · 기록이 다시 쓰임 `record_rewritten`.
  커서는 **기록 꼬리**(제출 직전 그 파일의 dev·ino · 크기 + 끝 64 KiB 지문 — 한 번 연 파일에서 함께 잡고, 읽을 때도 같은 파일인지 본다. 이름이 다른 파일로 바뀌면 `record_rewritten`, R2-A7)이고 확인은 커서 뒤 바이트만 읽는다 — 지시마다 기록 전체를 동기로 읽지 않는다(C1: 45 MB 기록에서 루프 지연 p99 211~232 ms → 6.3 ms).
  **근거로 세는 줄은 이 세션 · 이 접수 뒤의 줄만**(R3-A4·A5): 줄의 시각이 넣기 직전 시각 이후(기록 시각의 단위만큼만 봐준다 — ms 가 있으면 ms, Grok 처럼 초뿐이면 그 초)이고,
  세션이 접수 때 묶은 세션(Claude 줄 `sessionId` · Grok `params.sessionId`)인 줄. 시각이 없거나 세션이 다른 줄은 세지 않는다. Codex 는 줄에 세션이 없어 기록 파일(이름에 세션 id)로 귀속하고 시각만 본다.
  그래서 0건 경로에서 나중에 생긴 파일이 옛 기록 복원본이거나 다른 세션 줄이면, 같은 파일을 제자리에서 다시 써 옛 줄이 커서 뒤에 와도 들어감이 아니다(`record_missing`).
  **남는 한계**: 「새 세션의 첫 지시」 와 「지워졌다 다시 생긴 기록」 은 파일만으로 구분하지 않는다 — 둘 다 이 세션·이 접수 뒤 시각의 줄이 있어야 들어감이라, 지운 기록을 같은 세션 id 로 이 접수 뒤에
  새로 쓰는 경우만 남는다(provider 가 그렇게 쓰는 경로는 실측에 없다).
- **기록 파일**(R1-A13·R2-A5): 대화 표시와 같은 파일이되 **같은 세션 id 의 후보가 하나일 때만** 쓴다(`resolveTranscriptUnique`). 둘 이상이면 `failed/record_ambiguous`. 폴더·후보 하나라도 못 읽으면
  (EACCES 등 — 「없음」 과 구분) 하나를 찾았어도 유일하다고 하지 않고 기다린다. 모든 탐색이 성공한 0건(새 세션 — 첫 지시 뒤에 파일이 생긴다)일 때만 그 세션이 쓸 경로(pane cwd + 세션 id)를 커서로 쓴다.
  표시용 찾기·CLI 계약은 그대로다.
  **세션 이어 가기**(LIFE-766): 후보가 하나인 세션에 유효한 `continued-in` 이 있으면 대화와 같은 대상 파일을 커서로 쓰고 줄은 **옮겨 간 id** 로 센다(`continuedAs`). 옮겨 간 id 의 후보가 둘 이상이면 `failed/record_ambiguous`, 폴더를 못 읽으면 기다린다 — 원본과 같은 계약.
  **빈 대상도 쓴다** — 화면은 옛 파일에 머물러도 지시는 새 파일에 기록되므로 커서·확인은 대상 파일이다. 그 지시가 복사를 일으키면 커서 뒤에 옛 대화가 통째로 들어오는데, **옛 줄과 새 줄은 줄 시각으로 가른다**(`submissionLines` — 제출 시각 이후 ms 단위, `sessionId` 는 복사분도 새 id 라 세션으로는 못 가른다) — 같은 글의 옛 지시를 들어감으로 세지 않는다. 복사분이 원본 시각을 유지한다는 전제는 **관측한 한 버전의 사실**이다(2.1.296, 포크 4쌍·쌍마다 복사 줄 3개 비교 — `uuid`·`timestamp` 같음). 다른 버전이 복사분에 새 시각을 찍으면 `record_ambiguous` 또는 거짓 `delivered` 쪽으로 틀릴 수 있고, 관측 위반이 없어 이중 확인은 넣지 않았다. 복사가 큰 대화면 확인 주기마다 커서 뒤 전체를 읽는다(찾으면 끝, 실측 348 KiB).
  **빈 대상 구간의 대기 질문은 관측되지 않았다**(2.1.296, 각 1회): 질문·검토·권한 화면에서 `←` 는 포크하지 않고, 작업 중 `←` 는 복사가 바로 되어 대상이 비지 않으며 대기 질문과 답 모두 대상 파일이다. 그래서 질문 답도 지시처럼 대상 파일 하나만 본다 — 그런 순서가 와도 그 파일에 항목이 없어 키 0회 `failed/question_closed` 다.
  **입력 상자 윗줄 이름**: 세션을 백그라운드로 옮겼다 돌아오면 입력 상자 윗줄 오른쪽에 세션 이름이 붙는다(`─────… 이름 ─`). `draftState` 는 윗줄의 이 꼴을 받고, 아랫줄은 글 없는 가로줄만 받는다 — 아니면 `draft_unknown`(fail-closed).
  **질문 화면 맨 아래 이름**: 같은 세션의 질문·검토 화면은 맨 끝 줄이 이름 줄이다. 키 앞 판독 `activeQuestion` 은 안내 줄(검토 화면은 `2. Cancel`) 아래 빈 줄이 아닌 줄이 이 꼴 하나뿐일 때만 받는다 — 다른 글이거나 그 뒤에 글이 더 있으면 `none`(키 0회). **이 가드는 모양만 본다** — 이름인지 가리지 않아 제목 달린 가로줄 한 줄도 받는다. 권한 화면은 이름 줄 없이 줄이 여럿인 대화상자라 조건을 못 지난다(2.1.296 표본 — `none`). 계획 승인 등 다른 대화상자는 표본이 없다. 검토 화면은 글 대조 없이 `review` 만 본다. **좁은 pane 에서 긴 이름은 잘려 앞 가로줄이 사라진다**(` 이름 … ─`, 39열 실측) — 입력 상자는 `draft_unknown`, 질문 답의 키 앞 판독은 `question_changed` 로 폰 조작이 막힌다(fail-closed. 넓혀서 풀리는지는 재지 않았다). **상태 판독(LIFE-780)**: herdr 패치의 Claude 규칙 `live_blocked_form_named_session`·`live_blocked_review_named_session` 이 이 꼴의 질문·검토 화면을 `blocked` 로 읽는다 — 안내 줄(검토 화면은 `2. Cancel`) + 이름 줄 + (질문만) 작업 패널 + 화면 끝일 때만이고, 그 뒤에 새 글이 있으면 안 맞는다. 채널이 질문 대기가 되어 폰 답·CLI 거절·사이드바 점은 이름 없는 세션과 같은 경로로 간다. **남는 한계**: ⓐ 새 규칙은 herdr 서버를 재기동해야 실린다. 재기동 전 서버는 옛 manifest `2026.09.04.1`(기대값이 받아 준다)이라 이 꼴을 `idle`/`done` 으로 읽어 폰 카드가 잠기고 키는 0회다 — 안내는 맥 확인을 먼저 말한다. 이 구간의 CLI `terminal prompt`·`worker-start` 는 거절되지 않아 열린 이름 붙은 대화상자에 글이 들어갈 수 있다(고치기 전과 같은 위험, 실행 확인은 관문 몫). ⓑ 작업 패널이 붙은 질문은 `blocked` 이지만 `activeQuestion` 이 패널 꼬리를 받지 않아 폰 답은 키 0회 `question_changed` 다(fail-closed, 실표본 없음). 규칙이 받는 패널 모양은 상류 #4573 캡처 한 장이 근거다(`◼` 2칸·활동 줄 4칸) — 다른 칸 수나 머리 모양은 안 맞아 질문을 놓치고, 그쪽은 입력이 거절되지 않는다. ⓒ 위의 잘린 이름 줄은 규칙이 안 잡아 `done` 이고 폰 키는 0회다. ⓓ 계획 승인(`Exit plan mode?`)은 이름과 무관하게 `idle` 이다(2.1.296 표본 각 1, 이 규칙 밖). ⓔ Claude Code 2.1.314 이후 권한·계획 화면에도 이름 줄이 생길 수 있다는 changelog 가 있고 표본이 없다(표본 기준 2.1.296). ⓕ 스크롤한 pane 의 오판(상류 #5593)은 다른 원인이다. ⓖ 규칙은 안내 줄 힌트를 열어 두었지만 키 앞 판독은 그렇지 않다 — 꺾인 안내 줄의 힌트가 `CLAUDE_FOOTER_KNOWN` 밖이면(예 줄바꿈된 `Tab to switch questions`, #5741) 카드는 열리는데 `activeQuestion` 이 `none` 이라 폰 답은 키 0회 `question_changed` 다(fail-closed). 2.1.296 에서는 나오지 않았다. ⓗ 입력 상자 초안에 안내 줄 글을 다음 줄로 그대로 쓰고 상자 아래 상태 줄이 없는 화면은 `blocked` 로 읽힌다 — 입력이 거절되는 쪽이고, 실제 pane 은 상태 줄이 있어 재현되지 않았다(합성 화면). 검토 화면도 같은 종류다 — `1. Submit answers`·`2. Cancel` 두 줄 + 이름 줄로 끝나는 화면은 대화상자가 아니어도 `blocked` 다. 안내 줄의 이어진 줄은 임의 글을 받으므로, 두 규칙의 안전은 「이름 붙은 입력 상자는 이름 줄 뒤에 `❯` 가 온다」는 화면 불변식에 걸려 있다. 그 불변식이 깨지는 판이 나오면 다시 본다.
  이 쌍은 **커서를 잡기 직전에 다시 푼다** — 관문을 도는 사이의 이동을 받고, 커서와 확인이 같은 쌍을 쓴다. 중단 확인(`runStop`)도 이어 간 파일을 읽는다 — 다만 키를 보내기 전에 파일을 한 번 풀므로, 그 뒤에 포크하면 옛 파일을 읽는다(기록으로 멈춤을 못 보면 `unconfirmed/still_running`). 질문 답은 항목을 찾기 전에 열린 대화의 이어 가기를 한 번 돌리고, 그 판독자가 색인 중일 때만 색인을 기다린다(2초 상한, `CHAT_QUESTION_READY_MS`) — 그 대화를 연 구독이 없으면 판독자도 없어 `failed/question_closed`, 키는 나가지 않는다. **이동 전 질문 id 의 답**도 `failed/question_closed` 다 — 말풍선 id 가 파일 위치라 새 파일에서 맞지 않는다. 새 id 는 이동의 `reset` 페이지로 폰에 간다. 질문 답은 파일을 한 번 고정한다 — 답을 넣는 중간에 이어 가면 `failed/question_closed` 또는 `unconfirmed` 로 끝나고 키가 다른 대화로 가지 않는다.
  접수 대조(`sessionMoved`)는 참조끼리 비교하므로 전환만으로 `target_changed` 가 나지 않는다.
  **남는 한계 — 끝은 모두 정직한 `unconfirmed/record_missing` 이다(들어갔을 수 있다, 다시 넣지 않는다)**: ① 커서를 잡은 뒤 주입 사이에 이어 가면 줄은 새 파일에 있고 커서는 옛 파일이다 — 확인을 옛·새 양쪽으로 넓히지 않는다. ② 대상 파일이 생기기 전 약 0.9초 안에 들어간 지시도 같다. ③ `--resume <옛 id>` 직후 첫 `user` 줄이 기록되기 전까지는 표시·커서가 새 파일을 따라가서, 그 사이 들어간 지시는 옛 파일에 쓰여 확인되지 않는다.
- **채널 큐**: 채널마다 순서대로 한 건씩, 대기 5건까지(넘으면 `queue_full`). 준비 관문(CLI 와 같은 750 ms 두 관측·같은 seq·detect manifest) 통과 = 턴이 끝난 뒤에만 — 턴 안에 끼어들지 않는다.
  모바일 끔·앱 종료 → 큐는 `failed/mobile_off`, 다시 켜도 넣지 않는다. 맥 앱 재시작이면 서버가 그 id 를 잊는다 → 조회 `unknown`(앱은 「확인 못 함」 으로 둔다).
  **폰 앱** 재시작이면 앱이 id 를 잊는다 → 연결될 때마다 `input.pending` 으로 이 기기의 끝나지 않은 요청을 다시 받아(지시 본문 포함) 대기 줄·취소를 되살린다(R1-A8).
  큐는 herdr 상태가 `idle`·`done` 이 아닌 동안 기다린다(`agentQuiescent`) — 백그라운드 작업이 남아 herdr 가 working 에 머물면(Grok) 그것까지 끝나야 들어가고, 턴이 끝나 herdr 가 한가면(Claude·Codex 「지켜보는 중」) 바로 들어가며 백그라운드는 계속 돈다(Z1ⓓ · 네이티브 n3d). 앱 문구(C2 · LIFE-582 F2): 지켜보는 중 입력창 「지시 보내기 — 백그라운드 작업은 계속 돕니다」, 대기 줄은 서버가 `queued` 이고 `wait` 가 `gate`(넣기 직전 확인)가 아닐 때만 — 지켜보는 중이면 「대기 중 · 백그라운드 작업까지 끝나면 들어갑니다」, 아니면 「대기 중 · 이 턴이 끝나면 들어갑니다」.
- **맥 입력창 초안**: 넣기 직전 보이는 화면에서 그 provider 의 입력 줄이 **비었다고 확인될 때만** 넣는다. 글이 있으면 `failed/mac_draft`, 입력 줄을 못 찾으면 `failed/draft_unknown` — 세 provider 모두 초안과 합쳐 보내기 때문이다(Z1ⓔ).
- **Claude agent view** (LIFE-770): 빈 프롬프트에서 `←` 로 나갔거나 `claude agents` 로 띄운 agent view 에서는 입력이 폰이 보던 대화로 가지 않는다 — 맨 아래 입력 상자는 **새 세션을 만들고**(사용자 기본 권한이면 그 권한으로 뜬다), Space 패널의 입력은 **그 행의 세션으로** 간다. 초안 판정보다 먼저 이 화면을 알아보고 넣기 전에 `failed/agent_view` 로 끝낸다 — 폰 문구 「보내지 못했습니다 · 맥이 agent view 화면이라 보내지 않았습니다 — 맥에서 대화로 돌아온 뒤 다시 보내 주세요」. 폰이 맥을 대신 복귀시키지 않는다(`esc` 를 보내지 않는다). `mac_draft`·`draft_unknown` 의 뜻과 문구는 그대로다. 작업 중 접수되어 대기하던 지시는, 그 사이 맥에서 `←` 로 agent view 에 들어가면 그 키도 맥 입력이라 기존 입력 울타리가 화면을 읽기 전에 `failed/mac_input`(「그 사이 맥에서 입력이 있어 보내지 않았습니다」)으로 끝낸다 — 쓰기 0. 그 뒤 agent view 인 채 보낸 지시는 `agent_view` 다(실제 guard 실측, LIFE-770 최종 관문 `d`·`d2` 회차). 중단·질문 답 경로는 이 판별을 쓰지 않는다.
  **판별**(`keys.ts agentViewShown`, 표본 Claude Code 2.1.296): 공식 신호가 없어 화면 글자로 본다. herdr 는 이 화면을 `idle`·`live_prompt_box` 로 읽어 상태로는 못 가린다. 표지는 맨 아래 입력 상자와 그 아래 줄에서만 찾는다 — ⓐ 상자 바로 아래 **한 줄**의 안내 칸: `space to reply`·`enter to return|open|create|collapse|expand|show all`·`ctrl+x to confirm`(뒤가 ` ·` 또는 줄 끝). 잘린 꼴은 `…` 가 줄 끝이고 동사 앞부분이 한 글자라도 남아 있을 때(`enter to r…`·`enter to show a…`, 24~56열 스윕 실측). `?` 안내표와 Space 패널의 `space to close`·`enter to send · esc to close` 는 꺾이므로 줄을 이어 본다. 색을 보지 않는다. ⓑ 안내를 못 읽어도 상자 글이 흐림(SGR 2)뿐인 `describe a task for a new session`. 좁으면 꺾이니(34열부터 두 줄) 줄을 이어 대조한다. 일반 프롬프트에 사람이 친 같은 글은 진하니 `mac_draft` 로 남고, 대화 출력에 인용된 글은 상자 위라 잡히지 않는다.
  **못 알아보는 화면과 실제 결과**(`agent-view.test.ts` 가 고정한다): 2.1.296 의 자리표시는 흐림(SGR 2)이 아니다 — 트루컬러 `38;2;153;153;153`, 256색·16색 환경 `38;5;7`, `NO_COLOR` 는 무색으로 쟀다(테마는 미측정). 그래서 아래 표에서 못 알아본 화면은 넣지 않고 **막히되 문구가 사실과 다르다**(`mac_draft`·`draft_unknown`). `NO_COLOR` 는 일반 프롬프트의 `Try "…"` 도 무색이라 빈 입력까지 `mac_draft` 다(이 일감과 무관한 기존 동작).

  | 화면 (2.1.296) | 결과 | 근거 |
  | --- | --- | --- |
  | agent view 상자에 `/`·`@` | `mac_draft` | 실표본 |
  | 찾기(`ctrl+f`, 상자가 `⌕ …`) | `draft_unknown` | 실표본 |
  | simple view(`CLAUDE_CODE_FLEETVIEW_SIMPLE`, 상자 없음) | `draft_unknown` | 실표본 |
  | 36열 이하 — 안내가 `enter to …`·`enter…`·`e…` 로 잘림(권한 표지 길이에 따라 폭은 달라진다) | 자리표시 회색이면 `mac_draft`. 흐림이면 ⓑ 로 `agent_view`. 글을 친 상태는 `mac_draft` | 실표본 + 합성 |
  | `ctrl+c` 한 번 | `agent_view` — 안내가 그대로 남는다(`claude agents` 직접 기동 pane·접힌 행 각 1회 실측) | 실표본 |
  | 소스의 Ctrl-C 종료 확인 줄·이름 바꾸기 `enter to save`·오류·힌트 줄이 안내를 대체 | **재지 않았다** — `ctrl+c` 로 안 떴고 나머지는 시도하지 않았다 | 소스만 |

  **표본이 얇은 안내**: 삭제 확인 `ctrl+x to confirm` 의 실제 pane 재현은 리뷰어 화면 1장뿐이다(행이 사용자 세션이라 `ctrl+x` 를 누르지 않기로 했다) — 끝-끝 칸은 공백이고 그 화면과 단위 시험으로만 본다. 접힌 행 `enter to show all` 은 높이 12 pane 에서 전체·잘린 꼴(`show al…`~`s…`)을 뜬 표본이 있다. 32·28열의 흐린 자리표시는 합성으로만 시험한다 — 쟀던 색 환경 어디서도 자리표시가 흐림이 아니었다.

  **남는 한계**: ① **입력이 들어갈 수 있는 경우** — 자리표시 글자가 바뀌고 흐림이면서 안내도 못 읽을 때다: 안내 문구까지 바뀌었거나, 36열 이하라 안내가 잘렸을 때. `empty` 로 읽혀 지시가 새 세션으로 들어갈 수 있다(합성 시험으로 고정). 글자 바뀜을 잡는 것은 Claude Code 판을 올릴 때 표본 재측정이다. ② 글자가 바뀌고 안내도 못 읽어도 색이 그대로면 `mac_draft` 로 막힌다. ③ 판별과 넣기 사이에 맥에서 `←` 를 누르면 입력 울타리가 거절한다(`mac_input`). 화면만 바뀌고 입력 revision 이 그대로인 창의 실제 guard 확인은 최종 관문 몫이다. ④ 테마는 재지 않았다 — ⓐ 는 색을 안 보고, 흐림 여부만 ⓑ 에 쓴다. ⑤ 2.1.296 이후 판은 표본이 없다. ⑥ **옛 폰 앱은 이 코드를 몰라 「보내지 못했습니다」 만 띄운다**(`reasonText` 가 모르는 코드는 사유 없이 표시한다). 재시도 버튼은 같다. ⑦ `pane get` 의 탭 제목 `… · claude agents` 가 agent view 를 가리키지만(2.1.296 실측) 입력 관문은 이 값을 읽지 않는다. 쓰려면 guard 관측을 넓혀야 해 이 일감에서 하지 않았다. ⑧ 안내 줄 모양을 한 다른 글은 그대로 걸린다 — 상자 아래 첫 줄이 `/` 로 시작하지 않으면서 `· enter to open` 으로 끝나는 경우 등. 2.1.296 일반 화면에서는 나오지 않았고 막히는 방향이다.
  **CLI 경로는 관문이 없다**: `terminal prompt`·`worker-start --terminal` 은 이 화면에서 실제로 새 세션을 만든다(`terminal prompt` 실측) — LIFE-787 로 넘겼다.
- **본문 정리**: 탭·줄바꿈 말고 C0·DEL·C1 제어 문자는 지운다(`\r\n`→`\n`) — 본문 안 ESC·Ctrl+C 가 키로 작동하지 않는다. 질문 직접 입력은 한 줄(줄바꿈·탭 → 공백, 합계 65536 UTF-8 바이트까지 — P7, R1-A11).
- **질문 답**(R1-A2·R2-A1): 폰은 말풍선 id · **그 질문의 도구 호출 id**(`call`) · **내용 지문**(`digest` — 서버가 기록의 문항 전체로 만들어 대화 말풍선 `question` 에 싣는다)을 보낸다.
  말풍선 id 는 파일 위치라 다른 질문에 다시 쓰일 수 있고, 같은 id·호출에 내용이 바뀔 수도 있다 — 셋이 모두 같아야 폰이 답한 그 질문이다(`call`·`digest` 가 없으면 넣지 않는다).
  서버는 ① 그 질문이 기록에서 **마지막 대기 질문**이고 내용 지문이 같고 ② 관측이 `blocked` 이고 ③ 키 묶음(문항 하나의 키들 · Codex 펼치기 · Claude 검토)마다 그 앞에서, 입력이 500 ms 이상 조용할 때
  잡은 화면의 **활성 질문 영역**(맨 아래 질문 상자 — provider 별 실측 모양 `keys.ts activeQuestion`)이 그 문항(문항 글 전체 · 선택지 글 전부 · 보이면 위치)일 때만 넣는다. 화면 위쪽 과거 글은 보지 않는다.
  **좁은 pane 줄바꿈**(R4-A2 · R5-A4): 상자 안의 물리 줄바꿈을 되살려 비교한다 — Claude 는 번호 없는 이어진 줄(선택지 글·설명)을 앞 행에 잇는다. 안내 줄은 이미 `Esc to cancel` 로 끝나면
  거기서 멈추고(그 아래 비어 있지 않은 줄이 있으면 none — R3-A2), 덜 끝났을 때만 실측 안내 문구 조각(`↑/↓ to navigate` · `Tab/Arrow keys to navigate` · `ctrl+g to edit in VS Code` · `n to add notes` · `Esc to cancel`)이
  될 때까지 다음 줄을 잇는다(40열 `…Esc` / `to cancel`). Grok 은 커서 행의 이어진 줄(8칸 들여쓰기)을 앞 번호 행에 잇는다.
  **선택지 글은 끝까지 보여야 한다**(R5-A1): 선택지 글이 `…` 로 잘렸으면 보이는 앞부분이 같아도 받지 않는다(숨은 뒷부분이 다른 질문일 수 있다) — 설명만 `…` 로 잘린 것은 받는다.
  선택지 글이 잘렸거나 행이 화면에서 빠졌으면(스크롤) 키 0회 `failed/question_truncated`(폰 「맥 화면이 좁아 질문이 잘려 보여 보내지 않았습니다 — 맥에서 답해 주세요」).
  실측(r4/width · r5/native): Claude 는 줄을 감아 다 보이므로 150·100·80·60·40 모두 그 문항, Grok 은 비포커스 행을 한 줄로 자르므로 긴 선택지는 150 만 그 문항(100·80·60·40 잘림), 다 보이는 길이면 80열도 그 문항.
  Codex 의 좁은 폭 줄바꿈은 되살리지 않는다(그대로 비교 — 다르면 `question_changed`).
  상자의 끝(안내 줄)부터 **화면 끝까지** provider 마다 정해진 줄만 있어야 한다(R3-A2) — 그 아래 모르는 줄·다른 대화상자(권한 질문 등)가 있으면 그 상자는 지금 것이 아니다. Claude 검토 화면도
  `Review your answers` → 요약 → `Ready to submit…` → `1. Submit answers`·`2. Cancel`(+ 안내 줄)로 끝나야 한다. 위치의 뜻: Grok `[k/n]` = 전체 중 k번째, Codex `k of n` = **남은 문항 중 위치**
  (3문항이면 `1 of 3` → `1 of 2` → 마지막은 표시 없음 — R3-A3 실측), Claude 는 머리 줄 문항 탭(앞 문항 ☒ · 뒤 문항 ☐).
  **그 문항이 갓 열린 빈 상태여야 한다**(R3-A1·D3): 커서가 첫 행(Claude ❯ · Codex ›), 직접 입력 행이 자리표시 글, 체크 없음, Claude 탭이 이 요청의 진행과 같음. 맥에서 이미 고르는 중이면
  키 0회 `failed/question_in_progress`(폰 문구 「맥에서 이미 고르는 중이라 보내지 않았습니다 — 맥에서 답해 주세요」). 예외는 정확히 셀 수 있는 하나 — Claude multiSelect 에 **체크만** 있는 상태
  (커서 첫 행 · 직접 입력 행 빈 상태): 숫자는 칸을 뒤집기만 하고 커서를 옮기지 않아(Z1 a-q2-after13) 폰 답과 다른 칸만 뒤집는다.
  Codex 는 접힌 표시(`? N question(s)` + `⇧← to answer`)가 **맨 아래 입력창 바로 위**일 때만(아래가 입력창·상태 줄뿐 — D2. R4-A3: 입력창 `› …` 과 그 이어진 줄(정확히 2칸 들여쓰기),
  빈 줄 뒤 상태 줄 3줄까지만 — 상태 줄은 실측 모양 `모델 · 경로[ · 제목]` · `? for shortcuts[  ⚠ N warnings · f2 to view]` · `⚠ N warnings · f2 to view` 만 받고 그 밖의 줄 하나라도 있으면 접힌 질문이 아니다) 그 문항 수를 본 뒤 ⇧← 를 한 번 보내 펼치고, 펼친 상자가 맞을 때만
  답 키를 넣는다(이미 펼쳐져 있으면 ⇧← 를 보내지 않는다). ④ 키마다 guard 가 그 `blocked` seq 와 **입력 revision** 을 같은 턴에서 비교한다 —
  첫 키는 접수 때의 revision(LIFE-598 r2, 그 화면도 같은 값), 다음 키는 guard 가 앞 키를 쓴 직후 돌려준 revision 이라 그 사이 다른 클라이언트의 입력이 끼면 그 키부터 쓰지 않는다. ⑤ 키마다 접수 세션이 그대로여야 한다(R2-A4 목록 + 키마다 바로 앞에서 다시 한 herdr 관측, seq·revision 도 울타리 값 그대로 — LIFE-598).
  **첫 키의 울타리는 접수 때의 revision**(LIFE-598 r2 — 답 요청을 받은 직후 관측): 첫 키 묶음의 화면도 그 revision 그대로여야 하고, 접수 뒤 맥 입력이 있으면 키 0회 `failed/question_changed`
  (답의 폰 문구 그대로 — 로그 `check: input`). 화면 조용함 하한은 다른 묶음과 같은 500 ms.
  **맥 클릭도 막는다**(LIFE-708 r1 · C10): 초안 revision 은 마우스 보고를 세지 않으므로, 답은 **모든 입력 revision** 도 같은 자리에서 본다 — 화면 조용함(500 ms)을 그 값의 조용한 시간으로 재고
  (클릭 직후 화면은 기다렸다 다시 읽는다), 화면·키 앞 관측이 그 울타리 값 그대로여야 하며, 키마다 guard 가 `expected_any_input_revision` 으로 같은 턴에서 비교한다(다음 키는 앞 키가 돌려준 쓴 뒤 값).
  접수 뒤 맥 클릭·휠·(provider 가 1003 any-motion 을 켜면) 포인터 이동이 끼면 갈래별로(모두 쓰기 0 — 의도된 fail-closed 설계): 첫 키 앞 허브 관측(화면·키 앞 `agent.get`)이 잡으면 키 0회 `failed/question_changed`·로그 `check: any_input`,
  관측과 guard 턴 사이에 끼어 guard 가 `any_input_changed` 로 거절하면 같은 `failed/question_changed`(키 0회 — `mobile.input_target_changed` 로그 없음),
  둘째 키 이후에 끼면 앞 키가 들어갔으므로 `unconfirmed/question_changed`. 클릭·휠·포인터 이동이 이어져 모든 입력이 끝내 조용해지지 않으면(화면 읽기 여섯 번) 화면을 믿지 않는다 —
  첫 화면이면 키 0회 `failed/question_changed`, 앞 묶음 키가 이미 나간 뒤의 다음 화면이면 `unconfirmed/question_changed`(둘 다 로그 없음). 마우스 보고가 꺼진 alt-screen 의 휠(`AlternateScroll` — 화살표 키)은 초안 revision 도 올리므로 키 입력과 같은 갈래다
  (허브 관측이면 로그 `check: input`, guard 면 `input_changed`). 울타리의 시작은 접수 때 값 + 그 사이 자기 쓰기가 올린 만큼(자기 쓰기는 두 값을 같이 올린다) — 자기 쓰기 사슬 자체는 초안 revision 그대로다.
  그 값이 없는 이전 guard 는 마우스도 초안 revision 에 세므로 초안 울타리만으로 같다(그 칸을 싣지 않는다). 중단 키는 바꾸지 않았다.
  기록의 질문이 닫혔으면 `failed/question_closed`, 화면·seq·revision·지문이 다르면 `question_changed`(키가 하나도 안 들어갔으면 `failed`, 들어갔으면 `unconfirmed`). 잠긴 질문(선택지 9개 이상 · Claude 아닌 multiSelect · Claude preview 의 직접 입력) `question_locked`·`other_locked`.
  잠긴 질문의 폰 문구는 「맥에서 답해 주세요」 한 갈래다 — 카드 「맥에서 답해 주세요 — 이 질문은 폰에서 고를 수 없습니다」 · 입력창 자리표시 「맥에서 답해 주세요」 · 결과 줄 `question_locked` 「이 질문은 맥에서 답해 주세요」(D1 — 잠금 + 안내).
  폰 카드는 그 채널이 **질문을 기다릴 때만**(목록 `waiting: question`) 연다(서버도 상태가 blocked 가 아니면 `question_closed`). 기록엔 대기인데 채널이 기다리지 않으면 카드를 잠그고 입력창은 그 질문을 뺀 일반 지시 규칙 —
  턴이 끝났으면(대기·작업 없음) 「Codex 가 턴을 마쳤습니다 — 아래 입력창에 답을 지시로 보내 주세요」(Codex 밖은 턴이 끝났다고 단정하지 않는다 — 「이 질문이 아직 열려 있는지 맥에서 확인해 주세요 — 닫혔으면 아래 입력창에 지시로 보내 주세요」), 작업 중·다른 대기면 「지금은 폰에서 답할 수 없는 질문입니다 — 맥에서 확인해 주세요」(L15). 새 서버 메시지 없음.
  **들어감 = 키 직전 꼬리 커서 뒤 기록에 그 질문의 답 정확히 1건**(Claude·Grok = 그 도구 호출의 `result` 줄 · Codex = 답 봉투의 `questionItemId`(도구 호출 id + 문항 번호)가 **이 호출**인 항목이 문항마다 한 번씩 —
  다른 질문의 봉투는 세지 않고, 귀속을 못 읽은 봉투가 있으면 `unconfirmed/record_unattributed`, R2-A2) **+ 판독자에서 그 질문이 대기에서 풀림**(10초) — UI 의 `answered` 만으로 세지 않는다.
  판독자(`chat-parse`)도 Codex 봉투를 문항마다 받아 **그 호출의 문항이 모두 답해져야** 질문을 푼다(R3-A3 — 봉투 하나가 질문 전체를 풀지 않는다, 다른 호출의 봉투는 이 질문을 건드리지 않는다).
  **+ 기록의 답 값이 문항마다 폰이 고른 답**(R3-A1 · R4-A1 — 문항↔답 대응을 보존한다): Claude `toolUseResult.answers` 의 문항 글 키 · Codex 봉투의 그 호출 문항 번호 ·
  Grok `UserAnswered.message` 의 문항 경계(`"문항"="답"` — 머리·꼬리 문구와 각 문항 표시가 정확히 한 번씩 순서대로, 못 읽으면 `answer_unreadable`)로 문항마다 값을 꺼내 그 문항의 답과만 비교한다.
  단일 선택은 같은 글, 직접 입력은 그 글(Grok 은 고정 접두 `"Other" user notes: ` 뒤 글 그대로 — 따옴표·끝 쉼표도 답 글, 마지막 문항 글은 손대지 않고 문항 사이 구분자 `, ` 만 뗀다 — R5-A3).
  multiSelect(Claude)는 한 문항 안에서만 순서 무관 — 실측 형식(`, ` 로 잇고 쉼표나 `"` 가 든 글은 `"…"` 로 감싸 안의 `"` 를 `\"` 로, r5/native m01)대로 나눈 글 목록이
  고른 글·직접 입력 글의 집합과 같아야 한다(R5-A2 — 따옴표를 일괄로 지우지 않아 `"Red, Blue"` 한 칸과 `Red`·`Blue` 두 칸이 갈린다. 형식이 어긋나면 다르다고 본다). 다르면 `unconfirmed/answer_mismatch`(폰 「기록된 답이 고른 답과 다릅니다 — 맥에서 확인해 주세요」), 답 값을 못 읽으면 `unconfirmed/answer_unreadable`.
  답 줄이 오류면 `unconfirmed/question_declined`, 2건 이상 `record_ambiguous`. **답·중단은 취소를 받지 않는다**(`input.cancel` 은 큐의 지시만 — 받으면 지금 상태만 돌려준다, R2-A9).
- **중단**: 그 순간 다시 관측해 `working`·`blocked` 일 때만 키 1회(Claude·Codex Esc · Grok Ctrl+C), 재시도 없음. 한가 `failed/not_running` · 숨김 대기(Grok 질문·권한 · 로그인 등 — Grok 권한은 상자가 입력 줄을 덮어 초안 확인 불가, 최종 관문 Z5ⓔ) `stop_hidden` ·
  Grok 입력창에 글 `mac_draft` · 관측 뒤 전이 `state_changed`. Grok 의 Ctrl+C 는 입력 줄의 글을 지우므로 **빈 입력 줄을 본 같은 guard 턴**(입력 500 ms 이상 조용 · 같은 seq)의
  입력 revision 으로 `pane.send_text` 를 울타리 친다(R3-A6) — 화면을 읽은 뒤 맥 입력이 끼면 guard 가 거절해 Ctrl+C 0회 `failed/state_changed`. Claude·Codex 의 Esc 는 그대로(seq 비교만 — LIFE-598 r2 가 울타리를 쳤다가 r3 에서 되돌림. 같은 pane 대기 지시의 사슬은 관측 revision → +1 을 쓰기 전에 건다, 위 「허브 자기 쓰기」). 멈춤 = 상태가 working·blocked 를 떠남 또는 기록의 그 턴 `interrupted`(5초 — 사슬 확정용 재관측을 했으면 그 뒤부터 잰다, LIFE-598 r5), 아니면 `unconfirmed/still_running`.
  백그라운드 작업(Bash·서브에이전트)은 멈추지 않는다(Z1ⓓ).
- 답·중단은 채널당 한 번에 하나(겹치면 `failed/busy`). 그 밖 이유: `empty`(정리 뒤 빈 글) · `bad_answer` · `not_ready` · `backend`(guard 오류 — 넣기 전이면 failed, 뒤면 unconfirmed) ·
  `revoked` · `target_changed`(세션·세대가 바뀜) · `mac_input`(접수 뒤 맥 입력 — LIFE-709) · `guard_outdated`(입력 revision 이 없는 guard, 또는 관리 밖 pane 인데 `unmanaged_prompt` 가 없는 guard) · `record_ambiguous`(기록 후보 둘 이상) · `record_unreadable`(커서용 기록을 못 읽음 — 넣지 않았다).
- 로그: `mobile.input_send {bytes, sha}`(정규화 본문 sha256 앞 8자) · `mobile.input_answer {questions}` · `mobile.input_stop` · `mobile.input_state {op, state, reason}` · `mobile.input_delivered {ms}` · `mobile.input_error` — 본문은 없다.

## 4. 오류 코드

| code | 뜻 | 연결 | close 코드 |
| --- | --- | --- | --- |
| `bad_json` | JSON 이 아니다 | 인증 전 닫음 · 인증 뒤 유지 | 4004 |
| `bad_message` | 모양이 틀렸다(타입 없음·protocol 없음·바이너리) | 인증 전 닫음 · 인증 뒤 유지 | 4004 |
| `protocol_mismatch` | `protocol` 이 1 이 아니다 | 닫음 | 4002 |
| `unauthorized` | 토큰 없음·틀림·해지됨(구별하지 않는다) | 닫음 | 4001 |
| `not_authenticated` | 인증 전 hello·pair 아닌 메시지(`ping`·`list.subscribe`·`chat.*`·쓰기 다섯 포함) | 닫음 | 4001 |
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

프레임 상한 초과는 오류 메시지 없이 close 1009. 앱 종료·스위치 끄기는 close 1001. 생존 확인 마감으로 끊긴 연결은 close 프레임 없이 TCP 를 닫는다(상대 쪽에서 1006).

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

## 8. 쓰기 한계 (LIFE-582 — 리뷰 r1~r6 종합 · 사용자 결정 D6)

고치지 않고 남긴 것. 모두 **폰에서 보내지 않는 쪽(맥에서 답)** 이거나 **기록/화면이 서로 어긋나야만 생기는 좁은 경계**다. 후속 일감 후보.
각 줄: 무엇이 막히나 / 무엇을 보장하지 않나 / 폰에 무엇이 보이나.

| # | 한계 | 막히는 것 · 보장하지 않는 것 | 폰에 보이는 것 |
| --- | --- | --- | --- |
| L1 (R6-A1) | **숨은 설명 뒷부분** — 선택지 글은 다 보이고 설명만 `…` 로 잘린 행(Grok 비포커스 행의 기본 표시)은 보이는 앞부분이 기록과 같으면 그 질문으로 받는다 | 기록의 질문과 맥 화면의 질문이 **설명의 보이지 않는 뒷부분만** 다르면 화면 질문에 답 키가 갈 수 있다. 제목·선택지 글·위치·지문은 다 맞아야 하므로 provider 가 그런 불일치를 만드는 실측은 없다 — 보장하지 않을 뿐 | 정상 표시(들어감 또는 `확인하지 못했습니다`) — 따로 알리지 않는다 |
| L2 (R6-A2) | **선택지 글이 원래 `…` 로 끝나는 질문** | 잘림 표시와 구분하지 않아 폭과 무관하게 폰으로 답할 수 없다(키 0회) | 「맥 화면이 좁아 질문이 잘려 보여 보내지 않았습니다 — 맥에서 답해 주세요」 |
| L3 (R6-A3) | **Grok 선택지 글이 `Other" user notes: …` 꼴** | 직접 입력 표시와 겹쳐 정상 선택을 확인하지 못한다. 그런 기록에 다른 직접 입력 글이 같다고 읽힐 수 있다(합성 재현만) | 정상 선택이면 「기록된 답이 고른 답과 다릅니다 — 맥에서 확인해 주세요」(키는 들어갔다) |
| L4 | **Codex 좁은 pane** — 줄 바꿈을 되살리지 않는다(Claude·Grok 만 복원) | 선택지·문항 글이 꺾이는 폭에서는 폰으로 답할 수 없다(키 0회) | 「그 사이 질문이 바뀌어 답하지 않았습니다」(원인이 폭이라는 문구가 아니다) |
| L5 | **Grok 긴 선택지 · 100열 이하** — 비포커스 행을 한 줄로 잘라 `…` 로 보인다 | 선택지 글이 잘리면 폰으로 답할 수 없다(r4/width 실측 질문 기준 100·80·60·40열). 다 보이는 길이면 80열도 답한다 | 「맥 화면이 좁아 질문이 잘려 보여 보내지 않았습니다 — 맥에서 답해 주세요」 |
| L6 | **측정하지 않은 화면 모양** — Codex 접힌 질문 아래 상태 줄 · Claude 안내 줄 조각이 실측 목록 밖이면 활성 질문으로 보지 않는다 | provider 판 올림·설정으로 상태 줄/안내 문구가 바뀌면 그 질문은 폰으로 답할 수 없다(키 0회 — 넣지 않는 쪽으로 깨진다) | 「그 사이 질문이 바뀌어 답하지 않았습니다」 |
| L7 | **기록 근거의 시각 정밀도·귀속** — 들어감 근거는 이 세션·이 접수 뒤 시각의 줄만 센다. Grok 기록은 초 단위, Codex 줄에는 세션이 없다(파일 이름으로 귀속) | Grok 은 **같은 초**의 이전 줄을 이 접수 뒤로 볼 수 있고, Codex 는 같은 파일 안의 다른 세션 줄을 가르지 못한다(provider 가 그렇게 쓰는 실측은 없다) | 정상 표시 |
| L8 | **새 세션 첫 지시 vs 지워졌다 다시 생긴 기록** — 파일만으로 가르지 않는다(§3 「쓰기」 남는 한계) | 같은 세션 id 로 지운 기록을 이 접수 뒤에 새로 쓰는 경우만 남는다(실측 없음) | 정상 표시 |
| L9 | **맥 입력 조용한 시간 500 ms** — 화면을 믿는 하한의 근거는 무부하 격리 echo 최대 225 ms(r2)다 | 부하·원격 attach 로 키 echo 가 500 ms 를 넘으면, 화면을 잡기 직전에 친 맥 초안이 화면에 아직 없어 빈 입력 줄로 볼 수 있다. 화면을 잡은 **뒤**의 입력은 revision 울타리가 항상 막는다 | 드물게 초안과 합쳐질 수 있다 — 기록 대조는 합쳐진 글을 `확인하지 못했습니다` 로 잡는다(들어감으로 올리지 않는다) |
| L10 | **Claude 40열 질문 전체 전달** — r6 리뷰 실물 1회 `question_closed`(원인 미계측) | 최종 관문 계측 결과는 `specs/LIFE-582-mobile-input/raw/claude/RESULT.md` 「final」 의 「Claude 40열 관찰」 | 「질문이 이미 닫혔습니다」(키 0회) |
| L11 (D1 → LIFE-597) | **셸에서 corral 없이 직접 띄운 provider 세션** | 지시는 들어간다(§3 「쓰기」 — 종류 결속 + 3 s settle). 단 설치본 herdr 서버가 이 작업 전 guard 로 돌고 있으면(재기동 전) 넣지 않는다. 막 띄운 세션·막 끝난 턴은 3 s 기다린 뒤 들어간다 | 옛 guard 면 「맥의 터미널 백엔드가 오래되어 보내지 않았습니다」(`failed/guard_outdated`) — `failed/unmanaged` 는 더 내지 않는다(폰 문구는 남아 있다) |
| L12 | **Codex 새 세션의 첫 지시** — 세션 참조가 Codex 첫 지시 뒤에 생긴다 | 맥에서 한 번도 지시하지 않은 Codex 세션은 폰 지시를 넣지 않는다 | 「맥에서 첫 지시를 보낸 뒤 쓸 수 있습니다」(`failed/no_session`) |
| L13 (R1) | **중단 = 지금 턴만** | 백그라운드 Bash·서브에이전트는 멈추지 않는다(Z1ⓓ 실측) — 백그라운드 정지 키는 보내지 않는다 | 중단 버튼 「이 턴 멈추기」(장전 「한 번 더 → 중단」) — 문구가 범위를 「이 턴」 으로 말한다 |
| L14 (최종 관문 Z2ⓒ) | **탭이 든 지시 — Claude·Grok** — 두 provider 가 입력창에서 탭을 공백 4칸으로 바꿔 기록한다(Claude 2.1.296 · Grok 1.0.50 실측, Codex 는 보존). 본문 정리는 탭을 남기고 기록 대조는 앞뒤 공백만 떼므로 0건이 된다 | 실제로는 들어갔어도 「들어감」 으로 확정하지 않는다(거짓 실패 — 안전 방향). CLI `terminal prompt` 도 같은 대조(앞뒤 SPACE·TAB·CR·LF 만 떼고 길이·지문 비교 — `cli/README.md`)라 같은 0건이다(코드 읽기, 실측 안 함) | 「들어갔는지 확인하지 못했습니다」(`unconfirmed/record_missing`) — 대화에서 확인 |
| L15 (최종 관문 Z4ⓓ · D10) | **Codex 비동기 질문(`request_user_input_async`)** — codex-cli 0.162.1 은 질문 직후 약 2초만 blocked 였다가 턴을 끝낸다(「Wait for the answer」 프롬프트여도). 턴이 끝나면 맥에도 고르는 UI 가 없다(⇧← 무반응 — `raw/claude/final/codex-ended/m4`) | 폰·맥 모두 다음 지시로 답한다. 버튼 답은 Codex 가 질문 직후 기다리는 짧은 창에서만 — 그 창에서도 접힌 표시와 입력창 사이에 쿼터 배너(`⚠ weekly limit: N% left · /status`)가 끼면 측정 밖 모양이라 답하지 않는다(L6 실물 사례, 배너 허용은 후속 후보) | 카드 잠금 「Codex 가 턴을 마쳤습니다 — 아래 입력창에 답을 지시로 보내 주세요」 · 짧은 창의 버튼 답 실패는 「그 사이 질문이 바뀌어 답하지 않았습니다」 |
