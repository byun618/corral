# corral 앱

herdr 세션에 붙어 workspace 목록을 실시간으로 보여 주는 Electron + React 앱 (LIFE-344 부트스트랩).
터미널 렌더링은 아직 없다 — 오른쪽은 자리만 잡아 둔 플레이스홀더다 (Step 2 ②).

## 띄우기

**Node 22.12 이상이 필요하다** (`.nvmrc` = 22.22.2) — Electron 44 의 `engines` 가 그렇다.

`npm install` 은 Electron 바이너리(~130MB)까지 받는다. electron 44 패키지에는 `scripts` 가
아예 없어서 (바이너리를 `electron` 명령을 **처음 실행할 때** 늦게 받는다) 그대로 두면
`npm run dev` 가 `Error: Electron uninstall` 로 죽는다. 그래서 이 앱의 `postinstall` 이
`node node_modules/electron/install.js` 를 부른다 — 설치가 1회로 끝나게.

```sh
cd app
nvm use         # .nvmrc → Node 22
npm install     # 설치 1회
npm run dev     # 개발 모드 (창이 뜬다)
```

`npm run dev` 는 electron-vite 개발 서버 + Electron 을 함께 띄운다.
붙을 세션은 기본이 `default` 이고, 다른 세션에 붙으려면 `CORRAL_SESSION=<이름> npm run dev`.
창 왼쪽 위 목록에서 세션을 눌러 바꿔도 된다.

## 명령

| 명령 | 하는 일 |
| --- | --- |
| `npm run dev` | 개발 모드 (HMR) |
| `npm run build` | 타입체크 + 프로덕션 빌드 → `out/` |
| `npm start` | 빌드 산출물 미리보기 |
| `npm run typecheck` | main·preload 와 renderer 를 각각 tsc |
| `npm run lint` | eslint |

## 구조

```
src/main/            Electron main — 소켓을 소유하는 쪽
  herdr/
    line-socket.ts   NDJSON 줄 프레이밍 + 소켓 수명 (EOF 감지)
    request.ts       요청 1건 = 커넥션 1개. 앱이 보내는 메서드는 화이트리스트
    subscription.ts  push 전용 커넥션 — 요청을 보내는 공개 메서드가 없다
    store.ts         id 키 맵. create=set / close=delete 라 멱등이 설계로 나온다
    session-link.ts  부트스트랩(구독→ack→버퍼→snapshot→적용) + 복구 루프
  sessions.ts        세션 발견 (CLI 재조회. 이 층에는 구독이 없다)
  control.ts         계측용 제어 채널 — CORRAL_CONTROL_SOCKET 을 준 실행에만 열린다
src/preload/         contextBridge 로 채널별 메서드만 노출 (CJS 로 번들)
src/renderer/        React. 왼쪽 repo>workspace>pane 3단 목록 + 오른쪽 터미널 자리
scripts/             판정 근거를 만드는 측정 하네스 (m-*.mjs)
```

렌더러가 소켓을 열지 않는 것은 취향이 아니다. `sandbox: true` 인 렌더러/preload 의 require
화이트리스트에 `net` 이 없다 — 소켓은 main 만 다룰 수 있다.

## 환경변수

| 변수 | 쓰임 |
| --- | --- |
| `CORRAL_SESSION` | 처음 붙을 세션 이름 (없으면 `default`) |
| `CORRAL_LOG` | 구조화 로그(NDJSON) 경로. 기본은 `<userData>/corral.ndjson` |
| `CORRAL_SHOT_DIR` | `capturePage` 스크린샷 저장 폴더 |
| `CORRAL_CONTROL_SOCKET` | 계측 제어 채널 소켓 경로. **104 bytes 를 넘으면 안 된다** (아래) |
| `CORRAL_VERIFY_CONVERGE` | `1` 이면 부트스트랩 직후 스냅샷을 다시 받아 수렴을 자가 검사 |
| `CORRAL_PROBE_REQUESTS` | live 직후 `ping` 을 N 회 보낸다 (구독이 안 끊기는지 확인용) |
| `CORRAL_INJECT_DUP` | `1` 이면 버퍼 이벤트를 일부러 두 번 적용 (멱등성 확인용) |
| `CORRAL_INJECT_BAD_SUB` | `1` 이면 구독 목록에 모르는 타입을 하나 섞는다 (거부 처리 확인용) |

> **유닉스 소켓 경로 길이**: macOS 는 104 bytes 가 한계다. Electron(Node 24)은 105 bytes 부터
> `EINVAL` 로 죽고, Node 20 은 조용히 잘라 엉뚱한 파일을 만든다. corral 은 붙기·바인드 전에
> 길이를 재고 넘으면 식별 가능한 실패로 남긴다 — herdr 세션 소켓 경로에도 같은 한계가 걸린다.

## 측정 하네스

판정 근거(`specs/LIFE-344-bootstrap/raw/claude/`)를 만드는 스크립트다. 흔들기(생성·종료)는
**격리 세션에서만** 돈다 — 세션 이름이 `life344-` 로 시작하지 않으면 코드가 거부한다.
`m-l2r.mjs` 만 사용자의 `default` 세션에 붙는데, 앱도 하네스도 **읽기 메서드만** 보낸다.

```sh
node scripts/m-s.mjs         # S2·S3·S4  빌드 · 렌더러 격리 · 타입체크/린트
node scripts/m-k1.mjs        # K1        부트스트랩 순서와 수렴 일치
node scripts/m-k2.mjs        # K2·K3     커넥션 분리 · 요청 1건 = 커넥션 1개
node scripts/m-k4.mjs        # K4        중복 이벤트 주입
node scripts/m-k5.mjs        # K5        구독 타입 거부 처리
node scripts/m-k6.mjs        # K6        서버 kill → 자동 복구 (격리 세션 서버를 죽인다)
node scripts/m-k7.mjs        # K7        ENOENT/ECONNREFUSED · 백오프+jitter
node scripts/m-l.mjs         # L1~L5     세션·workspace·pane 목록 · 실시간 반영 · 선택
node scripts/m-l2r.mjs       # L2r       repo 그룹핑 (default 세션에 **읽기로만** 붙는다)
node scripts/m-restart.mjs   # 세션 재기동 경로 비교
node scripts/m-sockpath.mjs  # 소켓 경로 길이 한계
```

격리 세션은 먼저 띄워 둔다:

```sh
script -q /dev/null herdr session attach life344-probe &   # 헤드리스 (0.1초)
```
