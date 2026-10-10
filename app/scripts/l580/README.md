# l580 — 대화방 목록 측정 (LIFE-580)

격리 개발 Electron(`l577/g-up.sh` 를 `/tmp/l580g-*` 로)에 붙어 잰다. 설치본 corral·그 userData·실제 tailscale·사용자 herdr 세션 무접촉 —
tailscale 은 가짜 CLI(`FAKE=/tmp/l580g-f*`), herdr 은 g-up 이 띄운 이름 세션 `l577g-l580g-*` 만 친다(그 밖이면 `lib.mjs` 가 거부).

| 파일 | 하는 일 | 기준 |
| --- | --- | --- |
| `three-sec.mjs` | 에이전트 상태 보고(`pane.report_agent`)를 바꿔 가며 폰 자리 클라이언트가 받는 시각 — ⓐ `changedAt`→수신 ⓑ 보고 직전→수신, 전이 ≥ 20회 전부 ≤ 3초. 짝 = 대상 pane 점이 기대 상태로 바뀐 첫 목록(`transition-match.mjs`) | J5 · L3 격리 · R3-A2 |
| `k9-ab.mjs` | A(모바일 꺼짐)/B(켜짐+구독 1) 교대 3회 — 키 입력→화면 p50·p95(회당 36타) + main 루프 지연 p99 | J6 · L10ⓒ |
| `k9-ab.nodetest.mjs` | k9-ab 자체 시험 — 구동 실패·`--rounds 0`·push 0·스모크 소표본·루프 표본 0 이 통과하지 못하는지 + 정상 양성 대조(`npm test` 의 node:test 쪽) | R1-A1 |
| `push-cost.mjs` · `push-cost.nodetest.mjs` | main 로그 `mobile.list_built`·`mobile.list_push` 를 seq 로 묶어 buildMs+sendMs 합의 p95(표본 0 이면 실패) | L10ⓓ · R1 C3 |
| `native-j5.md` | 네이티브 J5 — 원인 시각 직접 기록 · 폰 연결 기록(`list_recv`·`clock`)으로 ⓐ·ⓑ 계산법 · L12ⓒ 체크리스트 | L3 네이티브 · R1 C1 · R2-A4 |
| `native-cause.mjs` · `native-cause.nodetest.mjs` | 전용 셸 pane 안에서 자기 pane 에 `herdr pane report-agent` 를 치고 호출 직전 맥 시각(`causeAt`)·대상 채널(`target`)·기대 상태(`expect`)·exit 를 NDJSON 으로(`--isolated` = 격리 소켓만). `--release` 는 정상 끝·예외·SIGINT·SIGTERM 에서 같은 pane·source·agent 만 한 번 거둔다(중단은 실패 줄) | R2-A4 · R3-A2·A4 |
| `transition-match.mjs` | 원인(대상·기대 상태·시각) → 대상 채널이 기대 상태로 바뀐 첫 목록. 같은 상태 반복·대상 없음·점 기록 없음은 보류 | R3-A2 |
| `native-j5.mjs` · `native-j5.nodetest.mjs` | 폰 기록 사본 + 원인 기록 [+ main 발췌] → 전이별 ⓐ·ⓑ, 짝 = 대상 채널이 기대 상태로 바뀐 첫 목록(`list_recv` `changes`), 원인·대상 확인 없는 전이 보류(5회에서 제외), 중단 줄 있으면 미달, `agent.push.applied` 는 참고값 | R2-A4 · R3-A2·A4 |
| `native-dryrun.mjs` | 위 절차의 격리 dry-run(격리 herdr 셸 pane · Node 폰 자리 · 계산기까지) | R2-A4 |
| `lib.mjs` | 루트 검사·격리 herdr RPC·모바일 켜고 끄기(**켠 뒤 설정 화면을 닫는다** — R1-A2)·폰 자리 클라이언트(페어링→hello→구독, ping/pong 시계차, 연결 닫힘 알림)·격리 레포 pane. `pairDevice` 는 페어링만(유효 코드는 한 번에 하나 — 동시 구독은 차례로 페어링한 토큰을 `phone({ token })` 에 넘긴다, 최종 관문 f06) | — |
| `l1-isolated.mjs` | 격리 런타임 CLI 로 레포·부모/자식/손자/고아 worktree·에이전트+셸 pane 을 만들고 ⓐ 스냅샷→push·seq 단조 ⓑ 셸 0건(양성 대조) ⓒ 그룹 재료 ⓓ 동시 구독 3 → `list_built` ≤ 1 | L1 최종 |
| `claude-mix.mjs` | 격리 인스턴스 안 **실제 claude pane**(수동 권한 모드)으로 권한·질문 대기를 일으켜 ① 지시 ② 대기 화면 ③ 답 세 전이의 ⓐ·ⓑ(`report-agent` 에는 blocked 사유가 없다) | L3 최종 |
| `l6-permission.mjs` | 실제 claude 권한 대기 1회 — 화면 대화상자 · main `digest.tool`·`agentState` · 폰 채널 미리보기를 한 순간에. `--leave-open` 은 대화상자를 연 채 끝낸다(에뮬레이터 캡처용) | L6 최종 |
| `l9-isolated.mjs` | ⓒ 해지·replaced 뒤 갱신 0(살아 있는 연결은 받음) ⓓ 목록 원문 전체에서 토큰·코드·화면 표식·셸 pane id 0(표식이 화면에 실제로 찍혔는지 양성 대조) | L9 최종 |
| `watch-list.mjs` | 폰 자리 하나로 받은 목록을 채널별 한 줄(점·대기·미리보기·깊이)로 찍는 탐침. 기기를 해지하지 않는다 — 끝나면 `revokeAll` | 탐침 |
| `scene.mjs` | 에뮬레이터 캡처용 격리 장면 — `build`(작업 alpha·alpha-sub·beta·shellonly·quiet) · `report 이름=상태` · `close`(herdr 에서 직접 → 보존 행) · `add`·`shell` | L4·L5·L7·L8 최종 |
| `shot.mjs` | 에뮬레이터 캡처 + 앱 바 둘째 줄 **고정 띠 가림**(덤프와 무관) + 덤프가 찾은 맥 이름 노드 덧칠. `--repaint` 는 찍은 캡처에 띠만 | G5 · 최종 f22·f30 |
| `list-fixture.mjs` | 가짜 서버 — hello 는 받고 `list.subscribe` 에 `silent`(무응답 → 앱 마감 실패) · `reject`(`unknown_type`) | L5ⓗ 최종 |
| `px.mjs` · `ttf-name.mjs` | 캡처 점 색 최빈값(토큰 대조) · TTF name 표 저작권·OFL 고지 | L5ⓕ · L11 최종 |
| `native-l12.md` | L12 네이티브 회차 체크리스트(ⓐ~ⓗ · 손 동작 · 볼 화면 · 모을 기록 · 명령) | L12 |

```sh
cd app && npm run build
sh scripts/l577/g-up.sh /tmp/l580g-a /tmp/l580g-fa
node scripts/l580/three-sec.mjs --root /tmp/l580g-a --fake /tmp/l580g-fa --out ../specs/LIFE-580-mobile-list/raw/claude/l3
node scripts/l580/k9-ab.mjs     --root /tmp/l580g-a --fake /tmp/l580g-fa --out ../specs/LIFE-580-mobile-list/raw/claude/l10c [--rounds 3] [--samples 36] [--a-idle-ref]
sh scripts/l577/g-down.sh /tmp/l580g-a term herdr
```

- 루프 지연은 계측 소켓 `{"cmd":"loop-delay"}`(`app/src/main/control.ts`) — 첫 요청에 히스토그램을 켜고, 요청마다 지난 요청 이후 분포를 주고 비운다.
  계측 소켓(`CORRAL_CONTROL_SOCKET`)이 있는 실행에만 있다.
- K9 A/B 의 상태 변화 구동(다른 pane 의 working/idle 보고 ≥ 1회/초)은 **A·B 둘 다**에 건다 — 데스크톱이 그 변화를 그리는 비용은 양쪽에 같고, 차이는 모바일 쪽만 남는다.
- 원자료에는 토큰·코드·제목을 남기지 않는다(G5). 목록은 seq·시각·측정 채널의 점만 적는다.
- 종료 코드: 0 통과 · 1 미달 · 2 사용법 오류.
- K9 판정(R1-A1): A·B 각 ≥ 3회·회당 36 유한 latency, 상태 보고 실패 0(실패하면 그 자리에서 실행 실패), 구간 안 성공 보고 ≥ 1/s,
  B 는 구간 안 전이 **전부**를 3초 안에 받았고 구독 연결이 유지됐다, 회차마다 루프 표본 > 0 — 그 뒤에 수치 규칙. `--rounds`·`--samples` 를 줄인
  스모크는 표본이 나와도 늘 미달이다(판정 회차 아님). `--a-idle-ref` = A 무구동 참고 회차 1회(결과 `reference`, 판정 밖 — 코디 해석 재량 4).
