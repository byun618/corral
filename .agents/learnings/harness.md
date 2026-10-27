# harness learnings

Last reviewed: 2026-10-27

## 「응답에 X 가 있다」는 어느 명령의 응답인지까지 원자료로

- **Scope:** `.agents/harness/**`, 스킬이 매핑 응답 필드를 인용하는 자리
- **Learning:** 같은 매핑 안에서도 도구마다, 같은 도구에서도 명령마다 응답 필드가 다르다. 절차 문구에 응답 필드를 쓰기 전에 그 명령의 실제 응답 원자료를 연다. 표·요약만 보고 일반화하지 않는다.
- **Evidence:** LIFE-704 에서 세션 기록 경로를 r1 은 도구 단위로, fix2 는 매핑 단위로 일반화했다. 그러다 r4 에서 「기동 응답엔 없고 주입 응답에 늦게 온다」(Codex)로 뒤집혔다 — 같은 지적이 네 라운드 이어졌다.
- **Disposition:** `.agents/harness/capabilities.md` 작성 지침 — 다시 나면.
