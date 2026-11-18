# ui learnings

Last reviewed: 2026-11-19

## 꼭 보여야 할 꼬리는 줄임 비율이 아니라 줄지 않는 칸으로 지킨다

- **Scope:** `app/src/renderer/**` 의 한 줄 말줄임 레이아웃(경로·이름 + 줄 번호·개수 같은 꼬리)
- **Learning:** flex 줄임은 비율 배분이라 `flex-shrink` 를 1000:1 로 줘도 작은 쪽이 0 이 되지 않고, 1px 미만으로 준 칸에서도 말줄임이 끝 글자를 가린다. 꼭 보여야 할 부분은 `flex: 0 0 auto; max-width: 100%` 꼬리 안에 넣고 줄어도 되는 부분만 줄인다.
- **Evidence:** LIFE-811 — 1000:1 로 디렉터리를 먼저 줄였더니 짧은 파일 이름이 늘 한 글자 잘렸다. 꼬리 고정으로 바꾼 뒤 잘림 0.
- **Disposition:** 같은 레이아웃 결함이 다시 나면 `.agents/rules/coding.md`.
