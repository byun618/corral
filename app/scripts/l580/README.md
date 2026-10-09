# l580 — 대화방 목록 측정 (LIFE-580)

격리 개발 Electron(`l577/g-up.sh` 를 `/tmp/l580g-*` 로)에 붙어 잰다. 설치본 corral·그 userData·실제 tailscale·사용자 herdr 세션 무접촉 —
tailscale 은 가짜 CLI(`FAKE=/tmp/l580g-f*`), herdr 은 g-up 이 띄운 이름 세션 `l577g-l580g-*` 만 친다(그 밖이면 `lib.mjs` 가 거부).

| 파일 | 하는 일 | 기준 |
| --- | --- | --- |
| `three-sec.mjs` | 에이전트 상태 보고(`pane.report_agent`)를 바꿔 가며 폰 자리 클라이언트가 받는 시각 — ⓐ `changedAt`→수신 ⓑ 보고 직전→수신, 전이 ≥ 20회 전부 ≤ 3초 | J5 · L3 격리 |
| `k9-ab.mjs` | A(모바일 꺼짐)/B(켜짐+구독 1) 교대 3회 — 키 입력→화면 p50·p95(회당 36타) + main 루프 지연 p99 | J6 · L10ⓒ |
| `lib.mjs` | 루트 검사·격리 herdr RPC·모바일 켜고 끄기·폰 자리 클라이언트(페어링→hello→구독, ping/pong 시계차)·격리 레포 pane | — |

```sh
cd app && npm run build
sh scripts/l577/g-up.sh /tmp/l580g-a /tmp/l580g-fa
node scripts/l580/three-sec.mjs --root /tmp/l580g-a --fake /tmp/l580g-fa --out ../specs/LIFE-580-mobile-list/raw/claude/l3
node scripts/l580/k9-ab.mjs     --root /tmp/l580g-a --fake /tmp/l580g-fa --out ../specs/LIFE-580-mobile-list/raw/claude/l10c
sh scripts/l577/g-down.sh /tmp/l580g-a term herdr
```

- 루프 지연은 계측 소켓 `{"cmd":"loop-delay"}`(`app/src/main/control.ts`) — 첫 요청에 히스토그램을 켜고, 요청마다 지난 요청 이후 분포를 주고 비운다.
  계측 소켓(`CORRAL_CONTROL_SOCKET`)이 있는 실행에만 있다.
- K9 A/B 의 상태 변화 구동(다른 pane 의 working/idle 보고 ≥ 1회/초)은 **A·B 둘 다**에 건다 — 데스크톱이 그 변화를 그리는 비용은 양쪽에 같고, 차이는 모바일 쪽만 남는다.
- 원자료에는 토큰·코드·제목을 남기지 않는다(G5). 목록은 seq·시각·측정 채널의 점만 적는다.
- 종료 코드: 0 통과 · 1 미달 · 2 사용법 오류.
