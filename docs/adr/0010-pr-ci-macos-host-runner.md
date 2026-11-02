---
status: accepted
date: 2026-11-02
decision-makers: 프로젝트 소유자(게이트 승인), 코디네이터(분석·추천)
---

# PR CI 는 맥미니 macOS 호스트 러너에서 전용 사용자로 돌리고, 지금은 참고 신호로 둔다

## Context and Problem Statement

main 반영이 검사 없이 순서 머지였다(LIFE-575). 앱이 macOS 전용이고 시험이 PTY·Unix 소켓에 기대며, 레포가 private 이라 ruleset·required check 를 걸 수 없다. 운영 서비스가 도는 맥미니 하나로 어디서 어떻게 CI 를 돌릴까?

## Decision Drivers

* 개발 환경과 같은 OS 에서 시험이 돌아야 한다
* 운영 자원(docker 소켓·서비스 비밀·ssh 키)에 잡 코드가 닿으면 안 된다
* private 동안 서버 쪽 강제가 불가능하다
* 운영 서버 부하·재부팅 위험을 늘리지 않는다

## Considered Options

* macOS 호스트 러너 + 전용 비관리자 사용자 + `UserName` LaunchDaemon
* colima 안 linux 컨테이너 러너(다른 레포와 같은 방식)
* GitHub-hosted 러너

## Decision Outcome

Chosen option: "macOS 호스트 러너 + 전용 사용자", because macOS 시험을 그대로 돌리면서 파일·Unix 소켓 경계로 운영 자원과 갈린다. 다른 레포의 컨테이너 러너와 다른 **예외**이고, 대안은 후속으로 다시 본다. CI 결과는 release 스킬이 읽기 전용으로 확인하는 참고 신호이고 `release.sh` 동작은 바꾸지 않는다.

### Consequences

* Good, because 실제 macOS 에서 전체 시험이 돌고, 깨진 PR 이 체크 실패로 보인다
* Bad, because 같은 호스트 TCP 포트(loopback 포함)는 막지 못하고 잡 코드가 러너 자격을 읽을 수 있다 — 공개(LIFE-729) 전에 막거나 hosted 로 옮겨야 한다
* Bad, because 잡이 운영 서버 CPU 를 쓴다(낮은 우선순위·작업자 상한으로 완화, 효과는 표본 수준)
* Bad, because private 동안 강제력이 없어 실패 PR 도 머지할 수 있다

### Confirmation

음성 PR 실패 확인, 러너 사용자 격리 관측, release 스킬 블록 추출 실행(LIFE-575). 공개 전 체크리스트는 homelab-infra 러너 README.

## Pros and Cons of the Options

### macOS 호스트 러너 + 전용 사용자

* Good, because 시험 환경이 개발과 같다
* Good, because colima VM 자원을 나누지 않는다
* Bad, because 컨테이너 수준 격리가 없다

### colima linux 컨테이너 러너

* Good, because 기존 러너와 운영 방식이 같다
* Bad, because macOS 앱 시험과 환경이 다르고, 기존 러너가 docker 소켓을 물어 격리도 약하다
* Bad, because colima VM(3 CPU·4GiB)을 운영과 나눈다

### GitHub-hosted 러너

* Good, because 운영 서버와 완전히 분리된다
* Bad, because private 레포는 과금·한도 대상이다. 공개 뒤에는 유력한 대안이다(LIFE-729)
