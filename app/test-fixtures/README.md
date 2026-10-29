# test-fixtures — 시험 전용 사본 (제품 번들·제품 소스 트리 밖)

- `group-tree.0aad74da.ts` — 기준 빌드(LIFE-682 `0aad74da`)의 `app/src/renderer/src/group-tree.ts` 바이트 사본. `src/renderer/src/file-tabs.diff.test.ts` 가 하위 방향(S10 — 기준 빌드가 diff 탭 id 든 배치를 읽는다)을 단위로 본다(LIFE-683 fix r1 R1-06).
  본 증거는 최종 관문의 기준 빌드 실기동 회차이고, 그 뒤 지워도 된다.
