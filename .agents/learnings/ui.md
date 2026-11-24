# ui learnings

Last reviewed: 2026-11-24

## 꼭 보여야 할 꼬리는 줄임 비율이 아니라 줄지 않는 칸으로 지킨다

- **Scope:** `app/src/renderer/**` 의 한 줄 말줄임 레이아웃(경로·이름 + 줄 번호·개수 같은 꼬리)
- **Learning:** flex 줄임은 비율 배분이라 `flex-shrink` 를 1000:1 로 줘도 작은 쪽이 0 이 되지 않고, 1px 미만으로 준 칸에서도 말줄임이 끝 글자를 가린다. 꼭 보여야 할 부분은 `flex: 0 0 auto; max-width: 100%` 꼬리 안에 넣고 줄어도 되는 부분만 줄인다.
- **Evidence:** LIFE-811 — 1000:1 로 디렉터리를 먼저 줄였더니 짧은 파일 이름이 늘 한 글자 잘렸다. 꼬리 고정으로 바꾼 뒤 잘림 0.
- **Disposition:** 같은 레이아웃 결함이 다시 나면 `.agents/rules/coding.md`.

## macOS 홀드형 단축키는 수식 키 keyup 과 키 반복으로 판정하고, 뗀 뒤 남은 반복을 막는다

- **Scope:** `app/src/renderer/src/hooks/**`(키 길) · `app/src/main/index.ts`(before-input-event)
- **Learning:** macOS 는 ⌘ 를 누른 채인 글쇠의 keyup 을 버린다 — 홀드 끝은 누를 때 잡은 수식 키의 keyup 으로, 길이는 마지막 키 반복 시각으로 잰다. 수식 키를 먼저 떼면 아직 눌린 글쇠의 반복이 다른 단축키나 글자로 바뀌므로, 그 글쇠의 keyup 까지 반복을 삼키고 main 에서도 「수식 키가 줄어든 반복」만 막는다(더해진 경우는 막으면 Chromium 이 keyUp 을 삼켜 뗌이 사라진다).
- **Evidence:** LIFE-834 — 리뷰 세 라운드에서 세 모양으로 나왔다(⌘ 먼저 뗌·Esc 뒤 뗌·⇧ 먼저 뗌).
- **Disposition:** 다음 홀드형 단축키가 생기면 ADR 또는 `.agents/rules/coding.md`.
