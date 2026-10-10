# l581 — 대화 화면 측정 (LIFE-581 최종 관문)

격리 개발 Electron(`l577/g-up.sh` 를 `/tmp/l581g-*` 로, 가짜 HOME `HOME=<ROOT>/home`)에 붙어 잰다. 설치본 corral·그 userData·실제 tailscale·사용자 herdr 세션·사용자 세션 기록 무접촉 —
tailscale 은 가짜 CLI(`FAKE=/tmp/l581g-f*`), herdr 은 g-up 이 띄운 이름 세션 `l577g-l581g-*` 만 친다(그 밖이면 `lib.mjs` 가 거부).
대화는 **합성 기록**(`rec.mjs`, 글은 지어낸 것 · 표지 `L581-…`)을 가짜 HOME 의 provider 기본 자리에 쓰고, 제품의 세션 참조 → 파일 찾기를 그대로 탄다.
실물 기록이 필요한 회차(Y1ⓓ·Y4ⓒ)는 `/tmp/l581w*` **사본**만 읽고, 원자료에는 개수·크기·해시만 남긴다(G5).

| 파일 | 하는 일 | 기준 |
| --- | --- | --- |
| `lib.mjs` | 루트 검사(`/tmp/l581g-*` · 가짜는 `/tmp/l581g-f*` — 루트 이름이 `l581g-f` 로 시작하면 거부) · 격리 herdr RPC · 새 workspace pane(`focus:false`) · 모바일 켜고 끄기·페어링·해지(580 `lib.mjs` 재수출) · 폰 자리(`phone` — hello → 목록 구독, `chat`·`older`·`unsubscribe`, ping/pong 시계차) | — |
| `rec.mjs` | 합성 기록(Claude·Codex·Grok 줄 모양 — `chat-fixture.ts` 와 같은 키) · `agentPane`(상태 보고 **먼저**, 그다음 `report_agent_session` — 순서가 거꾸로면 상태 보고가 무시된다) | — |
| `y1-census.ts` | 실물 사본 디렉터리 → 파일마다 줄 종류·원자·버림 사유·알 수 없는 줄·말풍선 누출·C15 묶음·누출 검사기 양성 대조. Claude 사본은 원래 파일 이름을 지킨다(sessionId 가 맞아야 한다) | Y1ⓓ |
| `three-sec.mjs` | 새 줄 → 폰 수신 ⓐ(서버 판독 `readAt` → 수신) ⓑ(append 직전 → 수신), provider 셋 × 종류 넷, ≥ 20회 | Y3 |
| `big-record.mjs` | 큰 사본(Claude 45 MB · Codex 40 MB)을 심볼릭 링크로 붙여 첫 페이지 `firstPageMs` · main 루프 p99, 회차마다 판독자 버림(`chat_reader_drop`) 확인 | Y4ⓒ |
| `reconnect.ts` | 앱의 실제 `ConnectionManager`·`ChatStore` 를 Node 에서 — 중계를 끊고 끊긴 동안 새 줄 ≥ 3 → 무조작 재연결 뒤 id 오라클(빠짐·남음·중복·불일치 0) | Y5ⓐ |
| `payload-grep.mjs` | 받은 프레임 원문 전체에서 생각·결과 표지·세션 참조·토큰·HOME 절대경로(날것·인코딩 1·2중) 0 + 양성 대조 셋 | Y9ⓓ |
| `gate-isolated.mjs` | 없는 채널·셸 pane → `not_listed` · 해지(4003)·교체(4006) 뒤 프레임 0(살아 있는 연결은 받음) | Y2ⓐⓑ · Y9ⓒ |
| `cost-zero.mjs` | 모바일 꺼짐 · 목록만 구독 동안 대화 판독 로그 0, 대조 구간(구독 **앞**부터 셈)에서 index ≥ 1 · push ≥ 1 | Y10ⓑ |
| `k9-chat-ab.mjs` | 580 J6 A/B 의 대화판 — A·B 둘 다 상태 보고 ≥ 1/초 + 대화 줄 ≥ 1/초, B 는 대화 구독 1 | Y10ⓒ |
| `scene.mjs` | 에뮬레이터 캡처용 장면(c01·c02·c08·c09·c10·c11·c13·c15·c16·c19) · `add`(줄 덧붙이기) · `close`(herdr 에서 직접 → 보존 행) | Y4ⓑ · Y5ⓓ · Y6 · Y7 |
| `shot.mjs` | 에뮬레이터 캡처(580 `shot.mjs` 복사) — `--list` 는 앱 바 둘째 줄 고정 띠 가림, `--chat` 은 가림 없음. 덤프가 실패하면 노드 덧칠은 0 — **캡처마다 눈으로 확인**(맥 이름이 행 제목에 들어간 보존 행은 손으로 덧칠했다) | G5 |
| `y6c-tokens.mjs` | 캡처 PNG 의 색·크기를 토큰과 대조(밀도 420 → 1dp = 2.625px, 반투명은 surface 위 합성값) · `probe` 로 좌표 고르기 | Y6ⓒ |
| `y9f-diff.sh` | 분기점 `f65c1428e` → HEAD 의 server·service·protocol diff 에서 HTTP·바인딩·Origin·업그레이드 줄 변경 0 + 양성 대조(본문엔 있다) | Y9ⓕ |
| `n12-follow.mjs` | 네이티브 n-12 「맨 아래 따라가기」 재현 — `build`(합성 Claude 대화 12쌍 · pane `n12-follow`) · `run --mode a\|b\|c\|d`(ⓐ 지시→1초 뒤 답 · ⓑ 3줄 답 · ⓒ 한 프레임 · ⓓ 같은 id 로 자라는 답), 회차마다 uiautomator 로 맨 아래(마지막 답 아래 간격 69 px)를 확인한 뒤 `--offset <dp>` 만큼 띄우고 무조작 → 3초 뒤 덤프 판정 「보임」·「버튼」(`새 메시지 ↓`)·「잘림」 + 캡처. 종료 0 전부 보임 · 1 하나라도 아님 · 2 못 셈 | n-12 |
| `r5a1-setup.py` · `r5a1-fixture.tsx` | R5-A1 제스처 재현용 사본 — 작업 폴더 `mobile/` 을 `/tmp/l581g-r5/m` 으로 복사(node_modules 링크)하고 app/ 을 합성 fixture 하나로(서버·인증·기록 없음, 리뷰어 r5 방식). `--conv <Conversation.tsx> --kind fix\|r5` — fix 는 로그만 덧붙이고(동작 무변경), r5 는 리뷰어 계측본 그대로. Metro 는 사본에서 `NODE_PATH=<mobile>/node_modules/react-native/node_modules CI=1` — **`CI=1` 은 감시를 끄니 코드를 바꿀 때마다 Metro 재시작 + 번들 grep** | R5-A1 |
| `r5a1-gesture.mjs` | fixture 위 제스처 회차 — `during`(끄는 중 답 → `--drag` px 에서 놓음) · `away` · `fling`(관성 중 답) · `still --offset`(정지 회귀) · `fold`(24줄 접힘 뒤 숨은 줄 → 맨 아래 유지 · 놓기). 결정 offset 은 Metro 로그 계측 `R5_SCROLL`, 기대 = ≤ 120 dp 「보임」 / 넘으면 「버튼」, 3 s·10 s 두 번 덤프. 종료 0 전부 기대대로 · 1 아님 · 2 못 셈 | R5-A1 |
| `apk-local.sh` | 로컬 preview APK — 작업 폴더·TMPDIR 를 심볼릭 링크 없는 `~/Library/Caches/l581fg` 로(`/tmp` 면 ninja 가 `libworklets.so` 를 못 찾는다 — 578 fg10·이 작업 F-K1) | Y11 |

## 돌리는 법

```sh
cd app && npm run build                                       # 개발 Electron 은 out/ 을 싣는다
export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH" TMPDIR=/tmp/l581t   # node v24 · 짧은 TMPDIR
sh scripts/l577/g-up.sh /tmp/l581g-a /tmp/l581g-fa HOME=/tmp/l581g-a/home      # 회차마다 새 루트(userData 새로)
node scripts/l581/three-sec.mjs --root /tmp/l581g-a --fake /tmp/l581g-fa --out <dir> --runs 24
sh scripts/l577/g-down.sh /tmp/l581g-a term herdr                               # 끝나면 내리고 PPID 1 고아 확인
```

나머지도 같은 꼴(`--root`·`--fake`·`--out`) — 각 파일 머리 주석에 사용법·통과 조건·종료 코드(0 통과 · 1 미달 · 2 사용법). 실제 명령·회차는 `specs/LIFE-581-mobile-chat/raw/claude/runs.md` 「최종 관문」.

## 구간 정의

- **Y3 ⓐ** 서버가 그 줄을 읽은 시각(`chat.items.readAt`, 서버 시계) → 폰 자리 수신(`recvAt` + ping/pong 시계차) — 변경 고르기·변환·직렬화·전송·파싱.
- **Y3 ⓑ** 이 스크립트가 append **직전**에 찍은 시각 → 폰 수신 — ⓐ + 판독기 폴링(`CHAT_POLL_MS` 250 ms) 대기. 짝 = 회차 표지가 처음 들어 있는 `chat.items`.
- **Y4ⓒ firstPageMs** main 로그 `mobile.chat_page.firstPageMs` = 구독 입구 → 첫 페이지 프레임 준비(색인 포함). 루프 p99 = 계측 소켓 `loop-delay`(구독 직전 비움 → 첫 페이지 직후 읽음, 10 ms 해상도).
- **Y10ⓒ** 키 입력 → 화면 반영 p50·p95(580 `judgeK9` 그대로) + main 루프 지연 p99.

## 원자료 자리

`specs/LIFE-581-mobile-chat/raw/claude/final/` — 실행마다 `F-*.txt`(머리 = id·시각·node·cwd·커밋, 끝 = `# exit N`) · 스크립트 JSON(`y3/` `y4c/` `y5a/` `y9d/` `y10b/` `y10c/` `y2-y9c/` `y6c/` · `y1-census-b.json`) · 캡처 `screens/` · C6 탐침 `c6-explain.json`.
받은 프레임 원문(`<ROOT>/payload.txt`)·사본·APK·dmg 는 커밋하지 않는다(해시만).
