# l577 — 모바일 서버 repro·가짜 tailscale (LIFE-577)

폰 없이 corral 모바일 서버를 친다. 프로토콜·오류 코드 정본은 `app/src/main/mobile/SURFACE.md`.

| 파일 | 하는 일 |
| --- | --- |
| `repro.mjs` | Node WS 클라이언트 — pair → hello → ping, 거절 행렬(A3ⓑ). 출력은 NDJSON, 토큰·코드는 `<redacted>` |
| `fake-tailscale.mjs` | 가짜 tailscale CLI(E4) — 격리 회차·시험이 실제 serve 설정을 건드리지 않게 CLI 자리에 꽂는다 |
| `g-up.sh` · `g-down.sh` · `g-lib.mjs` · `g-run.mjs` | 최종 관문 격리 회차(A1~A9) — 개발 Electron 을 `/tmp/l577g-*` 에 띄우고 제어 소켓 DOM 합성으로 돌린다. `node scripts/l577/g-run.mjs <단계> <ROOT> <FAKE> [OUT]` |
| `native-a10.mjs` · `native-a10.md` | A10 네이티브 회차 걸음별 판정(읽기 전용 tailscale) + 체크리스트·멈춤·원복 |

## 사용법

```sh
cd app
# ① 페어링 → hello → ping. 토큰을 **새** 0600 파일로 남긴다(원자료에는 <redacted> 로만 찍힌다).
#    --token-out 경로가 이미 있으면(파일·심링크) pair 전에 exit 2 — 코드를 쓰지 않는다. 새 파일은 O_EXCL 로 만들고 umask 와 무관하게 0600.
#    단, pair 응답 뒤 저장 순간에 그 경로가 경합으로 생겨 `token-out` 이 실패해도(exit 1) 코드는 이미 소모되고 기기는 등록된다 —
#    그 기기를 설정 › Mobile 에서 해지하고 새 코드로 다시 페어링한다.
node scripts/l577/repro.mjs pair  --url ws://127.0.0.1:<서버포트>/ws --code <QR 코드> --name repro --token-out /tmp/l577x/token
# ② 저장한 토큰으로 hello → ping
node scripts/l577/repro.mjs hello --url wss://<mac>.ts.net:8577/ws --token-file /tmp/l577x/token
# ③ 거절 행렬 + 양성 대조. 옵션 준비물이 있으면 그 줄도 친다.
node scripts/l577/repro.mjs matrix --url <같은 URL> --token-file /tmp/l577x/token \
  [--revoked-token-file <해지한 기기 토큰>] [--used-code <이미 쓴 코드>] [--expired-code <10분 지난 코드>] \
  [--fresh-code <새 유효 코드 — 5번 틀린 뒤 정답이 거절되는지>] [--auth-timeout]
# ④ 서버 연결 수명(LIFE-578 E3) — 같은 기기 재인증 → 이전 연결 replaced(4006) · 새 연결 pong.
#    --idle-max-ms 를 주면 서버 ping 에 답하지 않는 연결이 그 안에 끊기는지도 본다(기본값 서버는 최대 40초).
node scripts/l577/repro.mjs lifetime --url <같은 URL> --token-file /tmp/l577x/token [--idle-max-ms 45000]
# ⑤ 대화방 목록 구독(LIFE-580) — hello → list.subscribe → 전체 스냅샷 + --watch-ms 동안 push. 줄에는 수·상태 점 분포만(제목·미리보기 글 없음).
#    --resubscribe 면 중간에 다시 구독해 전체를 다시 받는지(포그라운드 복귀), --ndjson-out 이면 받은 목록마다 시각 한 줄(3초 측정 원자료).
node scripts/l577/repro.mjs list --url <같은 URL> --token-file /tmp/l577x/token [--watch-ms 3000] [--resubscribe] [--ndjson-out /tmp/l580x/recv.ndjson]
```

- `--url` 은 `ws://127.0.0.1:<p>/ws`(loopback 직접 — 개발·격리) 또는 `wss://<mac>.ts.net:8577/ws`(tailscale serve 경유 — 네이티브 A10ⓒ).
  서버 포트는 설정 › Mobile 에는 안 보인다 — 계측 소켓 `{"cmd":"mobile-status"}` 의 `serverPort` 나 `lsof` 로 본다.
- 코드는 두 길: **사람 경로** — 설정 › Mobile › 「QR 만들기」 화면의 코드를 읽어 `--code` 에 넣는다.
  **자동 경로** — `CORRAL_CONTROL_SOCKET` 을 켠 실행에서 `{"cmd":"mobile-pairing"}` 응답의 `pairing.code`(계측 실행 전용, 평시엔 이 소켓이 없다).
  소켓 폴더가 내 소유·0700 이 아니면 `control_socket_not_private` 로 거절한다 — `mkdir -m 700` 한 폴더(예: `/tmp/l577x/ctl`)를 쓴다.
  해지는 화면의 「해지」 또는 `{"cmd":"mobile-revoke","id":"<기기 id>"}`.
- `pair` 실패는 코드 셋으로 갈린다(R5 A4ⓖ): `code_expired`(만료) · `code_used`(이미 씀) · `code_invalid`(그 밖 — 모르는 코드·5회 폐기·새 QR 로 무효화).
  행렬은 `ws:used-code`·`ws:expired-code`·`ws:unknown-code`·`ws:right-code-after-5-wrong` 줄이 각각 그 코드를 기대값으로 판별한다.
- 코드 실패 횟수: **모르는 코드**(`ws:unknown-code` · `ws:wrong-code-N`)는 그때 유효한 코드의 실패로 센다. 만료·이미 쓴 코드는 서버가 알아보고 세지 않는다.
  `--fresh-code`(5회 틀린 뒤 정답)는 `ws:unknown-code` 1회가 먼저 세지므로 4번째 틀림에서 폐기된다 — 줄 기대값(`code_invalid`)은 같다.
  `--used-code`·`--expired-code` 와는 여전히 **다른 실행**으로 친다(만료 코드는 시간을 기다려야 해서).
- `hello`·`pair` 줄은 응답의 `server.macName`(맥 이름, R5 A5ⓓ)이 비어 있지 않아야 통과하고 그 값을 줄에 그대로 찍는다 —
  컴퓨터 이름이 개인 값이면 원자료를 커밋하기 전에 가린다(01-criteria G5).
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
