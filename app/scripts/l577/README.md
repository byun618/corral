# l577 — 모바일 서버 repro·가짜 tailscale (LIFE-577)

폰 없이 corral 모바일 서버를 친다. 프로토콜·오류 코드 정본은 `app/src/main/mobile/SURFACE.md`.

| 파일 | 하는 일 |
| --- | --- |
| `repro.mjs` | Node WS 클라이언트 — pair → hello → ping, 거절 행렬(A3ⓑ). 출력은 NDJSON, 토큰·코드는 `<redacted>` |
| `fake-tailscale.mjs` | 가짜 tailscale CLI(E4) — 격리 회차·시험이 실제 serve 설정을 건드리지 않게 CLI 자리에 꽂는다 |

## 사용법

```sh
cd app
# ① 페어링 → hello → ping. 토큰을 0600 파일로 남긴다(원자료에는 <redacted> 로만 찍힌다).
node scripts/l577/repro.mjs pair  --url ws://127.0.0.1:<서버포트>/ws --code <QR 코드> --name repro --token-out /tmp/l577x/token
# ② 저장한 토큰으로 hello → ping
node scripts/l577/repro.mjs hello --url wss://<mac>.ts.net:8577/ws --token-file /tmp/l577x/token
# ③ 거절 행렬 + 양성 대조. 옵션 준비물이 있으면 그 줄도 친다.
node scripts/l577/repro.mjs matrix --url <같은 URL> --token-file /tmp/l577x/token \
  [--revoked-token-file <해지한 기기 토큰>] [--used-code <이미 쓴 코드>] [--expired-code <10분 지난 코드>] \
  [--fresh-code <새 유효 코드 — 5번 틀린 뒤 정답이 거절되는지>] [--auth-timeout]
```

- `--url` 은 `ws://127.0.0.1:<p>/ws`(loopback 직접 — 개발·격리) 또는 `wss://<mac>.ts.net:8577/ws`(tailscale serve 경유 — 네이티브 A10ⓒ).
  서버 포트는 설정 › Mobile 에는 안 보인다 — 계측 소켓 `{"cmd":"mobile-status"}` 의 `serverPort` 나 `lsof` 로 본다.
- 코드는 두 길: **사람 경로** — 설정 › Mobile › 「QR 만들기」 화면의 코드를 읽어 `--code` 에 넣는다.
  **자동 경로** — `CORRAL_CONTROL_SOCKET` 을 켠 실행에서 `{"cmd":"mobile-pairing"}` 응답의 `pairing.code`(계측 실행 전용, 평시엔 이 소켓이 없다).
  해지는 화면의 「해지」 또는 `{"cmd":"mobile-revoke","id":"<기기 id>"}`.
- 틀린 `pair` 시도는 **그때 유효한 코드**의 실패 횟수로 센다. `--fresh-code`(5회 틀린 뒤 정답)는 `--used-code`·`--expired-code` 와 **다른 실행**으로 친다 —
  섞으면 그 두 줄이 새 코드의 실패 2회로 먼저 세진다.
- `matrix` 는 `--token-file` 이 없으면 양성 대조 줄을 실패로 남긴다 — 거절만 보고 통과시키지 않는다.
- 종료 코드: 0 전부 통과 · 1 실패 있음 · 2 사용법 오류. 출력을 그대로 `raw/` 에 리다이렉트하면 원자료다.

## 가짜 tailscale

```sh
mkdir -p /tmp/l577f && export FAKE_TAILSCALE_DIR=/tmp/l577f
echo '{"backendState":"Running","dnsName":"fake-mac.example.ts.net","certDomains":["fake-mac.example.ts.net"],"serve":{}}' > /tmp/l577f/state.json
CORRAL_USER_DATA=/tmp/l577u CORRAL_TAILSCALE_BIN=$PWD/scripts/l577/fake-tailscale.mjs npm run dev
```

`CORRAL_TAILSCALE_BIN` 이 있으면 corral 은 **그 경로만** 쓴다(없는 파일이면 「CLI 없음」 — 실제 CLI 로 내려가지 않는다).
`state.json` 칸: `backendState` · `dnsName` · `certDomains`(없거나 자기 이름이 없으면 HTTPS 꺼짐 — serve 추가가 블록한다) · `serve`(serve status 그대로) ·
`hang`(`status`·`serve-status`·`serve-add`·`serve-remove` 중 끝없이 멈출 것) · `failAdd`. 호출은 `calls.ndjson` 에 한 줄씩 남는다.

## 확장 — M2~M5 가 명령을 덧붙이는 방법

1. 서버: `app/src/main/mobile/protocol.ts` `CLIENT_TYPES`·`parseClientMessage` 에 타입을, `server.ts` 의 **인증 뒤 분기**(`connection.deviceId !== null` switch)에 처리를 더한다.
   인증 전 분기에는 더하지 않는다 — 인증 전에는 `hello`·`pair` 뿐이다. `SURFACE.md` 메시지 표에 한 줄.
2. repro: `repro.mjs` 에 `async function commandX(url)` 하나 — `--token-file` 로 hello 한 뒤 새 메시지를 보내고 `record(step, pass, expect, got)` 로 판정을 남긴다.
   `COMMANDS` 에 이름을 단다. 거절 행렬에 「인증 전 새 타입 → not_authenticated」 줄을 하나 더한다.
3. 시험: `app/src/main/mobile/repro.test.ts` 가 실제 서버에 이 스크립트를 돌린다 — 새 명령도 거기에 한 줄.
