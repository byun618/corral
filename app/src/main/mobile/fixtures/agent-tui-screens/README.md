# 에이전트 TUI 화면 캡처

Claude Code·Codex·Grok 의 질문·권한·입력창 화면을 터미널에서 그대로 떠 둔 것 — `input.test.ts`·`keys.test.ts` 의 화면 파서(질문 판독·초안 판별)가 읽는다.
출처: LIFE-582(모바일에서 에이전트 질문에 답하기)의 격리 herdr 실측 회차. 사용자 이름·로컬 경로·구독 플랜 표기는 같은 길이 자리표시자(`user`·`example`·`demo`·`Claude API`)로 바꿨다 — 열 폭이 판정에 쓰이므로 길이를 지킨다.

| 폴더 | 담은 것 |
| --- | --- |
| `question-prompts/` | 세 provider 의 질문 상자·권한 질문·입력 중 화면(ANSI 제거 텍스트) |
| `narrow-pane/` | 150~40열 pane 에서 같은 질문이 줄 바뀐 화면(ANSI 포함)과 그 회차의 질문 기록(`*-question.json`) |
| `grok-ghost-snapshots/` | Grok 입력창에 자동완성 제안만 떠 있는 화면 스냅샷(ndjson, 마지막 줄의 `screen`) |
| `grok-ghost-ansi/` | Grok 입력창의 제안·수락·붙여넣기·여러 줄 화면(raw ANSI) — 제안만이면 빈 입력, 나머지는 초안 |
