# harness learnings

Last reviewed: 2026-10-27

## 「응답에 X 가 있다」는 어느 명령의 응답인지까지 원자료로

- **Scope:** `.agents/harness/**`, 스킬이 매핑 응답 필드를 인용하는 자리
- **Learning:** 같은 매핑 안에서도 도구마다, 같은 도구에서도 명령마다 응답 필드가 다르다. 절차 문구에 응답 필드를 쓰기 전에 그 명령의 실제 응답 원자료를 연다. 표·요약만 보고 일반화하지 않는다.
- **Evidence:** LIFE-704 에서 세션 기록 경로를 r1 은 도구 단위로, fix2 는 매핑 단위로 일반화했다. 그러다 r4 에서 「기동 응답엔 없고 주입 응답에 늦게 온다」(Codex)로 뒤집혔다 — 같은 지적이 네 라운드 이어졌다.
- **Disposition:** `.agents/harness/capabilities.md` 작성 지침 — 다시 나면.

## corral 감독 기동의 codex 는 업데이트 확인을 끌 수 없다

- **Scope:** `.agents/harness/corral.md` 『감독 워커 기동』·『세션 기동』 — codex
- **Learning:** corral 이 만드는 codex argv 에는 `-c check_for_update_on_startup=false` 가 없고 넘길 플래그도 없다. 업데이트 안내가 뜨는 버전 간격에서는 모델과 무관하게 기동이 120초 `outcome_unknown`·주입 미확정으로 멈출 수 있다 — Codex 워커·리뷰어를 띄우기 전에 이 가능성을 본다.
- **Evidence:** LIFE-713 에서 codex-cli 0.162.1 → 0.164.0 안내 화면 아래 감독 기동 3회(카탈로그에 있는 모델 포함)가 모두 같은 상태로 멈췄다. 원인(안내 화면·기동 지연·배달 계층)은 가르지 못했다.
- **Disposition:** corral 매핑 『감독 워커 기동』 「상황 → 행동」 — 원인을 가르는 별도 일감 후보(corral 이 codex 기동 `-c` 를 받게 하거나 매핑에 우회 경로).
