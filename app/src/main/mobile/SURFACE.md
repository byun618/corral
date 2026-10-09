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

### 클라이언트 → 서버

| 타입 | 언제 | 모양 |
| --- | --- | --- |
| `hello` | 인증 전 | `{type:'hello', protocol:1, token:'<기기 토큰>', client?:{name,version}}` |
| `pair` | 인증 전 | `{type:'pair', protocol:1, code:'<8자 코드>', name:'<기기 이름, 64자까지>'}` |
| `ping` | 인증 뒤 | `{type:'ping', id?: string\|number}` |

인증 전에 `hello`·`pair` 가 아닌 것은 `not_authenticated` 로 닫는다. 노출이 `exposed` 가 아니면(Funnel·HTTPS 꺼짐·실패 등) `hello`·`pair` 도
`unavailable` 로 닫는다(R1-A2). 서버가 거절·close 를 시작한 연결은 **그 뒤 도착한 메시지를 처리하지 않는다** — 같은 write 로 이어 온
`pair` 가 거절된 `hello` 뒤에 통과하지 않는다(R1-A7). 인증 뒤 모르는 타입은 `unknown_type` 오류만 보내고 연결은 유지한다.
인증 뒤 `hello`·`pair` 를 다시 보내면 `bad_message`(연결 유지).

### 서버 → 클라이언트

| 타입 | 언제 | 모양 |
| --- | --- | --- |
| `hello` | hello 성공 | `{type:'hello', ok:true, protocol:1, server:{app:'corral', version:'<app.getVersion()>', macName:'<맥 이름>'}, device:{id,name}}` |
| `paired` | pair 성공 — 연결은 그대로 인증된다 | `{type:'paired', protocol:1, server:{app, version, macName}, token:'<기기 토큰 — 이때 한 번만>', device:{id,name}}` |
| `pong` | ping | `{type:'pong', id, at:<ms>}` |
| `error` | 아래 표 | `{type:'error', code, message}` (`protocol_mismatch` 는 `supported:[1]` 도) |

**맥 이름 `server.macName`(R5 A5ⓓ, 표시용)** — 인증 뒤 `hello`·`paired` 응답에만 있다. 인증 전 응답·오류(`error`)에는 없다.
출처(`mac-name.ts`): ① `/usr/sbin/scutil --get ComputerName`(macOS 「컴퓨터 이름」, 절대경로라 셸 PATH 없는 GUI 앱에서도 같다, 2초 타임아웃) →
② 실패·빈 값이면 `os.hostname()` 에서 `.local` 을 뗀 값 → ③ 그것도 비면 `"Mac"`. 제어 문자 제거·64자. 앱 기동 때 한 번 읽는다(읽기 전엔 ②).

## 4. 오류 코드

| code | 뜻 | 연결 | close 코드 |
| --- | --- | --- | --- |
| `bad_json` | JSON 이 아니다 | 인증 전 닫음 · 인증 뒤 유지 | 4004 |
| `bad_message` | 모양이 틀렸다(타입 없음·protocol 없음·바이너리) | 인증 전 닫음 · 인증 뒤 유지 | 4004 |
| `protocol_mismatch` | `protocol` 이 1 이 아니다 | 닫음 | 4002 |
| `unauthorized` | 토큰 없음·틀림·해지됨(구별하지 않는다) | 닫음 | 4001 |
| `not_authenticated` | 인증 전 hello·pair 아닌 메시지 | 닫음 | 4001 |
| `code_expired` | 만료된 페어링 코드(10분 지남) — 새 QR 을 만든 뒤에도 그 코드는 만료로 답한다 | 닫음 | 4005 |
| `code_used` | 이미 쓴 페어링 코드(1회 사용) | 닫음 | 4005 |
| `code_invalid` | 그 밖 전부 — 모르는 코드 · 형식 오류(문자열 아님) · 코드 없음 · **5회 실패로 폐기된 코드** · **새 QR 로 무효화된 이전 코드** · 스위치를 꺼 폐기된 코드 · 기억 범위(최근 8개) 밖의 끝난 코드 | 닫음 | 4005 |
| `pair_rejected` | 코드는 맞았으나 기기 저장(디스크 쓰기)이 실패했다 — 코드는 소모되지 않는다 | 닫음 | 4005 |
| `device_limit` | 기기 5대가 차 있다 — 데스크톱에서 해지한 뒤 다시 | 닫음 | 4005 |
| `unknown_type` | 인증 뒤 모르는 타입 | 유지 | — |
| `auth_timeout` | 10초 안에 인증하지 않았다 | 닫음 | 4008 |
| `revoked` | 열린 연결의 기기가 해지됐다 | 닫음(0.5초 뒤 강제 종료) | 4003 |
| `unavailable` | 노출이 막혔다(`exposed` 아님) — 새 hello·pair 거절, 이미 열린 연결도 이 코드로 닫는다 | 닫음(0.5초 뒤 강제 종료) | 4009 |

앱 종료·스위치 끄기는 close 1001.

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
  **소유 기록이 없는 최초 등록(R2-A3)은 `<host>:8577` 에 어떤 항목도(남의 다른 경로·TCP 칸·Foreground) 없을 때만** — 하나라도 있으면 `foreign` 으로
  거절·안내한다(A6ⓒ). 같은 host:port 의 남의 경로와 같이 사는 것은 **이미 우리 `/` 였던 자리**(기록 일치)를 유지·제거·대상 교체할 때뿐이다(R1-A4).
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
