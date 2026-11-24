---
status: accepted
date: 2026-11-24
decision-makers: 코디네이터(게이트 ⓪ 사용자 승인) · 사용자(출고 회고 채택)
---

# 소스 제어 원격 git 은 묻지 않고 빨리 실패한다 — 새 세션·프롬프트 끔·GUI 자격 입력 없음

## Context and Problem Statement

소스 제어 보기의 가져오기·끌어오기·밀어넣기(LIFE-831)는 앱 main 프로세스에서 git 을 띄운다.
git 이 자격(https 사용자 이름·비밀번호, ssh passphrase·호스트 키 확인)을 물으면 묻는 곳이 앱의 제어 터미널(터미널에서 띄운 dev 앱)이나 아무 데도 없는 곳이 된다.
그러면 진행 표시가 끝나지 않고, 사용자 터미널에 프롬프트가 새어 나간다.
구현 중 양성 대조가 이를 확인했다: tty 를 물려받은 일반 fetch 는 `GIT_TERMINAL_PROMPT=0` 이어도 ssh 호스트 키 질문에서 멈췄다.

## Decision Drivers

* 진행 중 원격 동작이 사람 입력 없이 반드시 끝나야 한다 — 취소·10 분 상한·앱 종료 정리가 성립하려면.
* 사용자의 기존 자격 설정(credential helper·ssh-agent·키체인)은 그대로 쓴다. 앱이 새 자격 저장소를 만들지 않는다.
* 범위: 게이트 ⓪ 에서 GUI 자격 입력(askpass)을 범위 밖으로 정했다.

## Considered Options

* 묻지 않고 빨리 실패 — 새 세션(제어 터미널 없음)으로 띄우고, 프롬프트 환경변수를 끄고, askpass 를 두지 않는다. 실패는 분류 안내 + 원문.
* GUI askpass — 앱이 `GIT_ASKPASS`·`SSH_ASKPASS` 로 대화상자를 띄워 묻는다.
* 앱 tty 를 물려준다(아무것도 안 함).

## Decision Outcome

Chosen option: "묻지 않고 빨리 실패", because 이 안만 사람 입력 없이 동작이 끝난다는 보장(취소·상한·종료 정리의 전제)을 지키면서 사용자 기존 자격을 그대로 쓴다.

### Consequences

* Good, because 인증·호스트 키 실패가 1 초 안팎에 안내로 끝난다(관문 실측). 사용자 터미널로 프롬프트가 새지 않는다.
* Good, because 원격 git 이 자기 프로세스 그룹 리더가 되어, 취소·상한·앱 종료 때 그룹째 끊을 수 있다.
* Bad, because 자격이 저장돼 있지 않은 원격(처음 쓰는 https 원격, passphrase 가 agent 에 없는 ssh 키)은 앱에서 쓸 수 없다. 사용자가 터미널에서 한 번 자격을 넣어야 한다.
* Bad, because 앱이 비정상 종료(충돌·SIGKILL)하면 진행 중이던 원격 git 이 고아로 남을 수 있다. 새 세션이라 앱과 함께 죽지 않는다.

### Confirmation

* 단위·통합 시험: 원격 git 의 env·argv 고정(프롬프트 끔·askpass 키 없음), 인증 실패·호스트 키 분류.
* 관문: dev 앱(tty 부모)에서 git 자식의 `tty = ??`·자기 세션 리더, ssh 호스트 키 실패가 프롬프트 없이 끝나는지 본다.

## Pros and Cons of the Options

### 묻지 않고 빨리 실패

* Good, because 끝남이 보장되고 구현·시험이 단순하다.
* Bad, because 자격이 없는 원격은 터미널을 거쳐야 한다.

### GUI askpass

* Good, because 자격이 없는 원격도 앱에서 끝까지 쓸 수 있다.
* Bad, because 자격을 다루는 대화상자·저장 정책·취소 경로가 새로 생긴다. 대화상자 대기 중 상한·취소의 의미도 다시 정해야 한다.

### 앱 tty 를 물려준다

* Good, because 아무 코드도 필요 없다.
* Bad, because 터미널에서 띄운 앱에서는 프롬프트가 사용자 터미널로 새고 동작이 멈춘다. 설치본에서는 묻는 곳이 없어 멈춘다.

## More Information

* LIFE-831(이 결정), LIFE-829(쓰기 git 의 로그인 셸 PATH — 원격 git 도 같은 PATH 로 pre-push 훅이 도구를 찾는다).
* 다시 볼 조건: 「처음 쓰는 원격도 앱에서」 요구가 생기면 GUI askpass 안을 다시 연다.
