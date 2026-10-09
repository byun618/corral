# J5 네이티브 — 폰 기록 + 서버 로그로 3초 계산하기 (LIFE-580 L3 네이티브 · R1 C1)

격리 회차의 `three-sec.mjs` 는 폰 자리를 Node 클라이언트가 맡는다. 네이티브(실제 폰, L12ⓒ)에서는 폰이 클라이언트라서
**폰 연결 기록**(앱 「연결 기록」 → 「복사」)과 **맥 main 로그**(설치본 userData 의 `corral.ndjson`)로 계산한다.
폰과 맥은 시계가 다르다. 그래서 폰 기록에 남은 ping/pong 시계차를 보정값으로 쓴다.

## 폰 기록에서 쓰는 줄

`formatLine` 모양은 `{at, event, ...detail}` 이다. **detail 의 `at` 이 바깥 `at` 을 덮는다**(`list_recv` 는 `at` 에 서버 시각을 싣는다).
그래서 폰 수신 시각은 `recvAt` 칸으로 따로 남긴다.

| event | 칸 | 뜻 |
| --- | --- | --- |
| `list_recv` | `seq` · `at`(서버가 목록을 만든 시각) · `changedAt`(main 이 그 변화를 담은 상태를 낸 시각) · `recvAt`(폰이 받은 시각, 폰 시계) · `offsetMs` · `rttMs` | 받은 목록 하나 |
| `clock` | `offsetMs`(서버 − 폰) · `rttMs` · `serverAt` · `sentAt` · `recvAt` | 시계차 표본. 최근 8개 중 왕복이 가장 짧은 표본이 바뀔 때만 기록한다 |
| `list_subscribe` · `list_failed` · `list_drop` | | 구독·실패·버림 |

- `offsetMs` = pong 의 서버 시각 `at` − (ping 보낸 시각 + pong 받은 시각)/2. 즉 서버 시계 − 폰 시계이고, 왕복 중앙 기준이다.
  ping 은 8초마다 간다. 연결 직후 첫 목록은 표본이 아직 없어서 `offsetMs: null` 이다. **null 인 회차는 계산에 쓰지 않는다**(전이 표본은 그 뒤에 만든다).
- 보정 오차의 상한은 그 표본의 `rttMs / 2` 다. 판정표 근거 칸에 회차별 `rttMs` 를 같이 적는다.

## 계산

- **ⓐ main 이 낸 시각 → 폰 수신** = `recvAt − (changedAt − offsetMs)`. 폰 기록 한 줄로 끝난다(`changedAt` 은 서버 시계라서 offset 으로 폰 시계로 옮긴다).
- **ⓑ 변화를 일으킨 시각 → 폰 수신** = `recvAt − (원인 시각을 폰 시계로 옮긴 값)`. 원인 시각은 맥 쪽에서 찾는다.
  - 상태 보고·herdr push 로 생긴 전이: main 로그 `agent.push.applied {changed:true}` 중 그 목록의 `changedAt` 직전 줄의 `at`(서버 시계).
    폰 시계로 옮기면 `at − offsetMs` 다. 이 시각은 herdr 가 상태를 알아챈 뒤라서 **ⓑ 를 짧게 잴 수 있다** — 판정표에 그 사실을 적는다.
  - 사용자가 맥에서 프롬프트를 보낸 전이(질문 대기 등): 사용자(또는 코디)가 누른 시각을 맥 시계로 기록한다(화면 녹화의 시계, 또는 `date +%s%3N` 을 누르기 직전에 실행).
    그 값에서 `offsetMs` 를 빼 폰 시계로 옮긴다.
- 서버 송신 대조: 같은 seq 의 main 로그 `mobile.list_push {seq, sendMs}` 의 `at` 이 `changedAt` 이상이고 `recvAt + offsetMs` 이하인지 본다(순서 검사).

## 체크리스트

1. 관문 전에 폰 「연결 기록」 을 비우지 않는다. 연결 직후 8초 이상 기다려 `clock` 줄이 하나 생긴 것을 본다.
2. 전이를 5회 이상 만든다(L12ⓒ). 질문 대기·권한 대기·작업 중 → 한가·완료를 섞는다. 원인 시각을 회차마다 적는다.
3. 폰 「복사」 → 원자료 파일. 맥 `corral.ndjson` 에서는 `mobile.list_*` 와 `agent.push.applied` 줄만 뽑아 원자료로 남긴다. 기기 이름·맥 이름은 가린다(G5).
4. 회차별로 ⓐ·ⓑ·`rttMs` 를 표로 만들고, **전부 3초 이하**인지 본다(최대값 기준).
5. L10ⓓ push 비용은 같은 main 로그로 낸다: `node scripts/l580/push-cost.mjs --log <corral.ndjson 사본> --since <관문 시작 ms>`. 표본이 0 이면 실패다.
