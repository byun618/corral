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
| `/ws` 가 아닌 경로로의 업그레이드 · `GET` 이 아닌 업그레이드 | | `404` 후 소켓 닫음 |

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

인증 전에 `hello`·`pair` 가 아닌 것은 `not_authenticated` 로 닫는다. 인증 뒤 모르는 타입은 `unknown_type` 오류만 보내고 연결은 유지한다.
인증 뒤 `hello`·`pair` 를 다시 보내면 `bad_message`(연결 유지).

### 서버 → 클라이언트

| 타입 | 언제 | 모양 |
| --- | --- | --- |
| `hello` | hello 성공 | `{type:'hello', ok:true, protocol:1, server:{app:'corral', version:'<app.getVersion()>'}, device:{id,name}}` |
| `paired` | pair 성공 — 연결은 그대로 인증된다 | `{type:'paired', protocol:1, server:{…}, token:'<기기 토큰 — 이때 한 번만>', device:{id,name}}` |
| `pong` | ping | `{type:'pong', id, at:<ms>}` |
| `error` | 아래 표 | `{type:'error', code, message}` (`protocol_mismatch` 는 `supported:[1]` 도) |

## 4. 오류 코드

| code | 뜻 | 연결 | close 코드 |
| --- | --- | --- | --- |
| `bad_json` | JSON 이 아니다 | 인증 전 닫음 · 인증 뒤 유지 | 4004 |
| `bad_message` | 모양이 틀렸다(타입 없음·protocol 없음·바이너리) | 인증 전 닫음 · 인증 뒤 유지 | 4004 |
| `protocol_mismatch` | `protocol` 이 1 이 아니다 | 닫음 | 4002 |
| `unauthorized` | 토큰 없음·틀림·해지됨(구별하지 않는다) | 닫음 | 4001 |
| `not_authenticated` | 인증 전 hello·pair 아닌 메시지 | 닫음 | 4001 |
| `pair_rejected` | 코드 틀림·만료·사용됨·5회 실패로 폐기·코드 없음(구별하지 않는다) | 닫음 | 4005 |
| `device_limit` | 기기 5대가 차 있다 — 데스크톱에서 해지한 뒤 다시 | 닫음 | 4005 |
| `unknown_type` | 인증 뒤 모르는 타입 | 유지 | — |
| `auth_timeout` | 10초 안에 인증하지 않았다 | 닫음 | 4008 |
| `revoked` | 열린 연결의 기기가 해지됐다 | 닫음(0.5초 뒤 강제 종료) | 4003 |

앱 종료·스위치 끄기는 close 1001.

## 5. 페어링 QR 페이로드

QR 은 아래 JSON 문자열을 담는다. 같은 내용을 설정 › Mobile 에 텍스트로도 보여 준다.

```json
{"kind":"corral-pair","v":1,"url":"wss://<mac>.<tailnet>.ts.net:8577/ws","code":"ABCD2345"}
```

- 코드: 8자, 알파벳 `ABCDEFGHJKMNPQRTUVWXY23456789`(혼동 문자 I·L·O·S·Z·0·1 제외, 29자 ≈ 39비트). 대소문자·앞뒤 공백 무시.
- 10분 유효 · 1회 사용 · 5회 틀리면 폐기 · 유효 코드는 동시에 하나(새 QR 이 이전 코드를 무효화) · 스위치를 끄면 폐기.
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
  그래서 **경계는 페어링 토큰**이다 — 인증 전에는 아무 데이터도 없고, 코드 추측은 39비트 · 5회로 막힌다. `Origin` 은 검사하지 않는다(RN 클라이언트의 Origin 이 일정하지 않다).
- tailscale serve 가 붙이는 `Tailscale-User-*`·`X-Forwarded-For` 헤더는 쓰지 않는다 — loopback 에서는 위조할 수 있다(W6).
- serve 경유 요청은 전부 `127.0.0.1` 에서 오므로 IP 별 제한은 의미가 없다(E3) — 코드 실패 횟수는 코드 하나에 건다.
- tailnet 의 다른 기기는 `wss://…:8577` 에 닿는다. 그 역시 토큰이 경계다. Funnel 이 노드에 하나라도 켜지면 corral 항목을 내린다(60초 이하 주기 재확인, 현재 30초).
- `tailscale` argv 는 상수와 숫자(포트)만으로 조립한다. `serve reset`·`funnel` 을 부르는 경로가 없고, 제거는 소유권 기록과 serve 설정이 일치할 때만 `serve --yes --https=8577 --set-path=/ off`.
