# J5 네이티브 — 원인 시각을 직접 기록해 3초를 계산하기 (LIFE-580 L3 네이티브 · L12ⓒ · R1 C1 · R2-A3·A4·A5 · R3-A2·A4)

격리 회차는 `three-sec.mjs` 를 쓴다. 거기서는 Node 클라이언트가 폰 자리를 맡고, 원인 시각은 보고 RPC 직전 시각이다.
네이티브(실제 폰)에서는 다음 세 가지로 계산한다:

- **원인 기록**: 설치본 런타임의 전용 셸 pane 에서 `native-cause.mjs` 가 남긴다.
- **폰 연결 기록**: 앱 「연결 기록」 → 「복사」.
- **맥 main 로그**(선택): 참고값과 순서 검사용.

계산은 `native-j5.mjs` 가 한다.

## 왜 원인 시각을 따로 기록하나 (R2-A4)

J5 ⓑ 는 「변화를 일으킨 시각 → 폰 수신」 이다. main 로그 `agent.push.applied` 는 herdr 프레임을 받아 store 에 적용한 **뒤**에 찍힌다.
그래서 보고 → herdr → main 사이 지연이 빠지고, 그것을 시작점으로 삼으면 ⓑ 가 짧게 나온다.

그래서 네이티브 판정 전이는 보고를 **우리가 직접 치고**, 그 호출 직전의 맥 시각을 원인으로 기록한다.

- 원인 시각이 없는 전이(보고 실패·사람이 만든 전이 등)는 ⓑ 를 **보류**하고 5회에 세지 않는다.
- `agent.push.applied` 는 「원인 → main 적용」 중간 참고값으로만 쓴다.

## 폰 기록에서 쓰는 줄

봉투 `at`(ISO) = 폰이 그 줄을 남긴 시각이다. detail 이 `at`·`event` 를 덮지 못한다(R2-A3 — 덮인 줄은 재시작 복원에서 버려졌다).

| event | 칸 | 뜻 |
| --- | --- | --- |
| `list_recv` | `seq` · `serverAt`(서버가 목록을 만든 시각) · `changedAt`(main 이 그 변화를 담은 상태를 낸 시각, 맥 시계) · `recvAt`(폰 수신, 폰 시계 = 봉투 `at`) · `offsetMs` · `rttMs` · `changes`(직전 목록 대비 점이 바뀐 채널 `id=dot,…`, 첫 목록은 전부, 사라짐 `id=-` — R3-A2) | 받은 목록 하나 |
| `clock` | `offsetMs` · `rttMs` · `pingId` · `sentAt` · `recvAt` · `serverAt` · `latestPingId` · `latestRecvAt` | 선택된 시계차 표본 |

`clock` 줄을 남기는 때와 그 칸들:

- 최근 8개 중 왕복이 가장 짧은 표본이 바뀔 때만 남긴다.
- `sentAt`·`recvAt`·`serverAt` 는 **선택된 표본**의 원시 시각이다(R2-A5). 방금 받은 pong 은 `latest*` 로 따로 남긴다.
- 대조식: `rttMs = recvAt − sentAt`, `offsetMs = round(serverAt − (sentAt + recvAt)/2)`.

`offsetMs`(서버 − 폰)는 ping 이 8초마다 가므로 연결 직후 첫 목록에서는 null 이다. **null 인 전이는 보류다.**
보정 오차의 상한은 `rttMs / 2` 다(계산 결과의 `errorBoundMs`).

## 계산 (`native-j5.mjs`)

- **짝 맞추기(R3-A2)**: 원인 줄의 **대상 채널(`target` = 그 pane id)·기대 상태(`expect`)** 로, 폰 `list_recv` 를 받은 순서대로 `changes` 를 접어
  **대상 채널의 점이 기대 상태로 바뀐 첫 목록**을 고른다(`transition-match.mjs` — 격리 `three-sec.mjs` 와 같은 규칙).
  그 목록은 원인 뒤·다음 원인 전에 만든 것(`serverAt`, 둘 다 맥 시계)이어야 한다. **다른 채널만 바뀐 목록은 짝이 아니다.**
  - 보류(5회에서 제외): 원인 줄에 대상·기대 상태 없음 · 원인 전 목록 없음 · 원인 직전에 이미 기대 상태(같은 상태 반복) · 대상 채널이 목록에 없음 ·
    `changes` 없는 기록(옛 앱).
  - 미수신(세는 회차 → 미달): 대상은 보이는데 다음 원인 전까지 기대 상태 목록이 없다.
  - 점 대응: working → `working` · idle → `idle`/`done` · blocked → `blocked`/`waiting`. `unknown` 은 J5 전이가 아니라 `native-cause` 가 받지 않는다.
- **ⓐ** = `recvAt − (changedAt − offsetMs)`
- **ⓑ** = `recvAt − (causeAt − offsetMs)`
- **통과**: 원인·대상 확인·수신·보정이 다 있는 전이 ≥ 5 이고, 그 **전부** ⓐ·ⓑ ≤ 3000 ms. 원인 기록에 중단·예외 줄(R3-A4)이 있으면 미달.
- **ⓐ 의 보수 쪽**: 대상 변화가 그 앞의 다른 변화와 한 목록으로 묶이면 `changedAt` 이 원인보다 앞설 수 있다 — 그때 ⓐ 는 ⓑ 보다 길게 나온다(짧게 나오지 않는다).
- **`--main` 을 주면** 두 가지가 더 나온다. 판정에는 쓰지 않는다:
  - `causeToAppliedMs`(원인 → `agent.push.applied`) 참고값
  - 순서 검사: 같은 seq `mobile.list_push` 의 `at` 이 `changedAt` ~ `recvAt + offsetMs` 사이인지
- **다른 pane 변화**: 같은 런타임의 다른 에이전트가 그 사이 바뀌어도 짝은 대상 채널로만 고른다(r2 까지의 「다른 에이전트를 한가하게」 운영 가정은 필요 없다). 대상 채널이 기대 상태로 바뀐 목록을 폰이 받지 않았으면 미수신이다.

## 체크리스트 (L12ⓒ — 코디가 실행)

1. **전용 셸 pane.** 설치본 corral 에서 아무 작업 공간에 셸 탭을 하나 연다. 이 pane 이 대상 세션이다(목록 채널 id = 그 pane id). 그 pane 의 셸에서 레포 `app/` 로 간다. 거기 `HERDR_BIN_PATH`·`HERDR_SOCKET_PATH`·`HERDR_PANE_ID` 가 있어야 한다(`env | grep HERDR_`).
2. **폰 준비.** 폰이 붙은 뒤 8초 이상 기다린다. 폰 「연결 기록」 에 `clock` 줄이 하나 생긴 것을 본다. 폰 앱이 `list_recv` 에 `changes` 를 남기는 판(R3-A2 이후)인지 확인한다 — 없으면 전부 보류다.
3. **원인 기록.** `node scripts/l580/native-cause.mjs --out /tmp/l580n-<날짜>/cause.ndjson --sequence working,idle,blocked,working,idle,working --gap-ms 8000 --release`
   - 6회를 친다. 하나가 보류되어도 5회가 남게 하려는 것이다.
   - 각 줄에 `causeAt`·`pane`·`exit` 가 남는다.
   - `--release` 는 끝에 에이전트 표시를 거둔다. 도중에 멈춰야 하면 Ctrl-C(SIGINT)·SIGTERM — 같은 pane·source·agent 만 한 번 거두고,
     `interrupted`·`release` 줄을 남기고 exit 1 이다(그 회차는 실패). SIGKILL 은 정리하지 못한다 — 그때는 같은 pane 에서 `"$HERDR_BIN_PATH" pane release-agent "$HERDR_PANE_ID" --source l580-native-j5 --agent claude`.
   - 각 줄의 `target`(= 이 pane id)이 폰 목록 채널 id 와 같은지 본다(`w…:p…` 모양).
4. **폰 화면 확인.** 폰 목록에서 그 채널이 「작업 중 → 한가 → 대기 …」 로 바뀌는지 본다. B5 「방금」 캡처 1회.
5. **회수.**
   - 폰 「복사」 → `/tmp/l580n-<날짜>/phone.txt`.
   - 맥 main 로그에서 `mobile.list_*`·`agent.push.applied` 줄만 뽑아 `/tmp/l580n-<날짜>/main.ndjson` 에 둔다(선택).
   - 기기 이름·맥 이름은 가린다(G5).
6. **계산.** `node scripts/l580/native-j5.mjs --phone …/phone.txt --cause …/cause.ndjson [--main …/main.ndjson] --out …/j5-native.json`. 셀 수 있는 전이 ≥ 5 이고 전부 ⓐ·ⓑ ≤ 3000 ms 면 exit 0 이다.
7. **L10ⓓ.** push 비용은 같은 main 로그로 낸다: `node scripts/l580/push-cost.mjs --log <main 로그 사본> --since <관문 시작 ms>`. 표본이 0 이면 실패다.

워커 dry-run 은 격리 인스턴스에서 같은 두 스크립트로 했다(`native-dryrun.mjs` — 격리 herdr 소켓만, `--isolated` 가드). 설치본에서는 돌리지 않았다.
