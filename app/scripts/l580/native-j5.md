# J5 네이티브 — 원인 시각을 직접 기록해 3초를 계산하기 (LIFE-580 L3 네이티브 · L12ⓒ · R1 C1 · R2-A3·A4·A5)

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
| `list_recv` | `seq` · `serverAt`(서버가 목록을 만든 시각) · `changedAt`(main 이 그 변화를 담은 상태를 낸 시각, 맥 시계) · `recvAt`(폰 수신, 폰 시계 = 봉투 `at`) · `offsetMs` · `rttMs` | 받은 목록 하나 |
| `clock` | `offsetMs` · `rttMs` · `pingId` · `sentAt` · `recvAt` · `serverAt` · `latestPingId` · `latestRecvAt` | 선택된 시계차 표본 |

`clock` 줄을 남기는 때와 그 칸들:

- 최근 8개 중 왕복이 가장 짧은 표본이 바뀔 때만 남긴다.
- `sentAt`·`recvAt`·`serverAt` 는 **선택된 표본**의 원시 시각이다(R2-A5). 방금 받은 pong 은 `latest*` 로 따로 남긴다.
- 대조식: `rttMs = recvAt − sentAt`, `offsetMs = round(serverAt − (sentAt + recvAt)/2)`.

`offsetMs`(서버 − 폰)는 ping 이 8초마다 가므로 연결 직후 첫 목록에서는 null 이다. **null 인 전이는 보류다.**
보정 오차의 상한은 `rttMs / 2` 다(계산 결과의 `errorBoundMs`).

## 계산 (`native-j5.mjs`)

- **짝 맞추기**: 원인마다, 그 원인 시각 이후 처음으로 만든 목록을 찾는다(`changedAt ≥ causeAt`, 둘 다 맥 시계). 그 목록은 **다음 원인 전에** 만든 것이어야 한다.
- **ⓐ** = `recvAt − (changedAt − offsetMs)`
- **ⓑ** = `recvAt − (causeAt − offsetMs)`
- **통과**: 원인·수신·보정이 다 있는 전이 ≥ 5 이고, 그 **전부** ⓐ·ⓑ ≤ 3000 ms.
- **`--main` 을 주면** 두 가지가 더 나온다. 판정에는 쓰지 않는다:
  - `causeToAppliedMs`(원인 → `agent.push.applied`) 참고값
  - 순서 검사: 같은 seq `mobile.list_push` 의 `at` 이 `changedAt` ~ `recvAt + offsetMs` 사이인지
- **한계**: 그 사이 같은 런타임의 다른 pane 상태가 바뀌면 `changedAt ≥ causeAt` 인 첫 목록이 다른 변화일 수 있다. 전이 동안 다른 에이전트를 한가하게 두고, 폰 화면에서 그 채널 점이 바뀌는 것을 함께 본다.

## 체크리스트 (L12ⓒ — 코디가 실행)

1. **전용 셸 pane.** 설치본 corral 에서 아무 작업 공간에 셸 탭을 하나 연다. 이 pane 이 대상 세션이다(목록 채널 id = 그 pane id). 그 pane 의 셸에서 레포 `app/` 로 간다. 거기 `HERDR_BIN_PATH`·`HERDR_SOCKET_PATH`·`HERDR_PANE_ID` 가 있어야 한다(`env | grep HERDR_`).
2. **폰 준비.** 폰이 붙은 뒤 8초 이상 기다린다. 폰 「연결 기록」 에 `clock` 줄이 하나 생긴 것을 본다. 다른 에이전트 pane 은 한가하게 둔다.
3. **원인 기록.** `node scripts/l580/native-cause.mjs --out /tmp/l580n-<날짜>/cause.ndjson --sequence working,idle,blocked,working,idle,working --gap-ms 8000 --release`
   - 6회를 친다. 하나가 보류되어도 5회가 남게 하려는 것이다.
   - 각 줄에 `causeAt`·`pane`·`exit` 가 남는다.
   - `--release` 는 끝에 에이전트 표시를 거둔다.
4. **폰 화면 확인.** 폰 목록에서 그 채널이 「작업 중 → 한가 → 대기 …」 로 바뀌는지 본다. B5 「방금」 캡처 1회.
5. **회수.**
   - 폰 「복사」 → `/tmp/l580n-<날짜>/phone.txt`.
   - 맥 main 로그에서 `mobile.list_*`·`agent.push.applied` 줄만 뽑아 `/tmp/l580n-<날짜>/main.ndjson` 에 둔다(선택).
   - 기기 이름·맥 이름은 가린다(G5).
6. **계산.** `node scripts/l580/native-j5.mjs --phone …/phone.txt --cause …/cause.ndjson [--main …/main.ndjson] --out …/j5-native.json`. 셀 수 있는 전이 ≥ 5 이고 전부 ⓐ·ⓑ ≤ 3000 ms 면 exit 0 이다.
7. **L10ⓓ.** push 비용은 같은 main 로그로 낸다: `node scripts/l580/push-cost.mjs --log <main 로그 사본> --since <관문 시작 ms>`. 표본이 0 이면 실패다.

워커 dry-run 은 격리 인스턴스에서 같은 두 스크립트로 했다(`native-dryrun.mjs` — 격리 herdr 소켓만, `--isolated` 가드). 설치본에서는 돌리지 않았다.
