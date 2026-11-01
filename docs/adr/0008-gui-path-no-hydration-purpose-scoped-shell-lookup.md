---
status: accepted
date: 2026-11-02
decision-makers: 코디네이터 제안(LIFE-520), 사용자 채택
---

# GUI 기동 앱의 PATH 는 그대로 두고, 로그인 셸 조회는 목적별로 한다

## Context and Problem Statement

Finder·Dock 으로 뜬 corral 은 launchd PATH(`/usr/bin:/bin:/usr/sbin:/sbin`)만 받아서 사용자가 깐 에이전트 CLI 를 못 본다(LIFE-520). Electron 앱의 흔한 해법은 기동 때 로그인 셸을 한 번 돌려 `process.env.PATH` 자체를 덮어쓰는 것(fix-path·shell-env 류)이다. corral 의 main env 는 동봉 herdr 서버와 pane 으로 상속되므로, 이 선택은 감지만이 아니라 터미널 계층에 닿는다.

## Decision Drivers

* main env 는 PTY·herdr 로 상속된다 — 바꾸면 영향 범위가 감지 기능 밖으로 번진다
* 에이전트 실행은 이미 pane 의 로그인 셸에서 된다(LIFE-555 실측)
* 로그인 셸 조회는 느리거나 매달릴 수 있다(Orca #5657) — 기동을 막으면 안 된다

## Considered Options

* 전역 수화 — 기동 때 로그인 셸 PATH 로 `process.env.PATH` 를 덮어쓴다
* 목적별 조회 — 필요한 기능이 로그인 셸에서 값을 받아 그 결과만 쓰고 `process.env` 는 두지 않는다

## Decision Outcome

Chosen option: "목적별 조회", because 감지 결과만 필요하고, env 를 바꾸면 PTY·herdr 계층까지 검증 범위가 커지며, 매달림을 그 기능 안의 시간 초과로 가둘 수 있다.

### Consequences

* Good, because 앱 env·pane env 가 기동 방식과 무관하게 지금과 같다 — 터미널 동작이 바뀌지 않는다
* Good, because 감지가 실패해도 화면은 기존 동작(고정 목록)으로 남는다
* Bad, because 로그인 셸 조회 코드가 목적별로 여러 벌이 된다(herdr·tailscale·CLI 설치·에이전트 감지 넷) — 공용화는 별도 일감

### Confirmation

에이전트 감지 일감의 범위 관문(diff 에 `process.env` 쓰기 0)과 코드 리뷰.

## Pros and Cons of the Options

### 전역 수화

* Good, because 한 번에 모든 자식 프로세스가 사용자 PATH 를 본다
* Bad, because pane·herdr env 가 기동 방식에 따라 달라지고, 느린 rc 가 기동 경로에 들어온다

### 목적별 조회

* Good, because 영향이 그 기능에 갇힌다
* Bad, because 조회 코드가 중복된다
