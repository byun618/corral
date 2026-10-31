# 에이전트 TUI 화면 캡처

Claude Code·Codex·Grok 의 질문·권한·입력창 화면을 터미널에서 그대로 떠 둔 것 — `input.test.ts`·`keys.test.ts` 의 화면 파서(질문 판독·초안 판별)가 읽는다.
출처: LIFE-582(모바일에서 에이전트 질문에 답하기)의 격리 herdr 실측 회차. 사용자 이름·로컬 경로·구독 플랜 표기는 같은 길이 자리표시자(`user`·`example`·`demo`·`Claude API`)로 바꿨다 — 열 폭이 판정에 쓰이므로 길이를 지킨다.

| 폴더 | 담은 것 |
| --- | --- |
| `question-prompts/` | 세 provider 의 질문 상자·권한 질문·입력 중 화면(ANSI 제거 텍스트) |
| `narrow-pane/` | 150~40열 pane 에서 같은 질문이 줄 바뀐 화면(ANSI 포함)과 그 회차의 질문 기록(`*-question.json`) |
| `bar-prefix/` | Claude Code 2.1.296 이 긴 문항 글 줄마다 앞에 `│ `(빈 문단은 `│` 단독 줄)를 그린 질문 상자(ANSI 제거 텍스트)와 그 회차의 질문 기록(`questions.json`) — LIFE-754 |
| `grok-ghost-snapshots/` | Grok 입력창에 자동완성 제안만 떠 있는 화면 스냅샷(ndjson, 마지막 줄의 `screen`) |
| `grok-ghost-ansi/` | Grok 입력창의 제안·수락·붙여넣기·여러 줄 화면(raw ANSI) — 제안만이면 빈 입력, 나머지는 초안 |

파일 이름 접두사:

- `a-`·`ca-`·`ga-` — 캡처한 provider: Claude Code · Codex · Grok. `perm-screens.txt` 는 세 provider 의 권한 질문 화면을 `== w1:pN` 줄로 이어 붙인 것
- `q1`~`q6` — 질문 시나리오 번호: q1 하나 고르기 · q2 여러 개 고르기(multiSelect) · q3 여러 문항 · q4 여러 개 + 직접 입력 · q6 preview 레이아웃(q5 는 테스트가 읽지 않아 두지 않았다)
- 뒤 꼬리 — `screen` 질문 상자가 뜬 화면 · `open` Codex 질문을 연 화면 · `typed`·`other-typed` 직접 입력 글을 친 화면 · `after13` 1·3 번을 누른 뒤 · `q2` 둘째 문항 · `review` 제출 전 검토 화면
- `grok-ghost-gm`·`grok-ghost-gu` — Grok pane 이름: `gm` = corral 이 관리하는(managed) 기동, `gu` = 관리 밖(unmanaged) 기동
- `narrow-pane/` 의 숫자 — pane 열 폭(150·100·80·60·40). `codex-collapsed-{empty,long,short}` = Codex 질문이 접힌 화면 — 입력칸이 빔 · 여러 줄로 감긴 긴 초안 · 짧은 초안
- `bar-prefix/` 의 이름 — `<모양>-<열 폭>`: `long` 두 줄로 줄 바뀐 글 · `para` 빈 줄 든 두 문단 · `preview` preview 레이아웃(`-60` 은 같은 화면을 60열로 줄임) · `multi` multiSelect · `tabs-q2` 문항 둘의 둘째(첫 문항 답함). `questions.json` = 화면 이름 → 그 회차 AskUserQuestion input 의 `questions`(LIFE-754 격리 tmux 실측, `claude-haiku-5-5`). `preview-*` 는 캡처 회차가 기록 전에 닫혀, 같은 문항 글·선택지 글을 다시 물은 회차의 기록이다(preview 상자 내용은 다르다 — 대조는 문항 글·선택지 글만)
