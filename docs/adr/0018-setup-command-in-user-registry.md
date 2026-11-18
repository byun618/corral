---
status: accepted
date: 2026-11-18
decision-makers: 코디네이터(게이트 ⓪ 위임 결정) · 사용자(게이트 ① 채택)
---

# worktree setup 명령은 레포 파일이 아니라 사용자 레지스트리에 둔다

## Context and Problem Statement

새 worktree 를 만든 뒤 의존성 설치 같은 명령을 자동으로 돌려야 한다(LIFE-813 — 새 worktree 마다 mobile `npm ci` 누락으로 `npm test` 가 깨졌다). 명령을 어디에 적느냐가 곧 「누가 내 머신에서 명령을 돌릴 수 있나」 를 정한다. LIFE-412(취소)는 orca.yaml 호환을 포함한 넓은 범위였다.

## Decision Drivers

* 남의 레포를 클론해 worktree 를 만드는 순간 레포 작성자의 명령이 돌면 안 된다(신뢰 경계)
* 신뢰를 묻는 UI 를 새로 만들지 않는다
* CLI·GUI 「작업에서 시작」 이 같은 런타임 명령을 탄다
* Finder 로 띄운 앱(최소 PATH)에서도 `npm` 을 찾아야 한다

## Considered Options

* 사용자 레지스트리(`repos.json` 레포 레코드)의 `setupCommand` 칸, CLI `repo set-setup-command` 로 등록
* 레포 안 파일(`orca.yaml`·`conductor.json`·`.corral/setup`) — 처음 볼 때 신뢰를 묻는다
* 둘 다 — 레포 파일을 기본값으로, 레지스트리가 덮는다

## Decision Outcome

Chosen option: "사용자 레지스트리", because 명령의 출처가 언제나 이 머신의 사용자라 신뢰 질문이 생기지 않고(처음 보는 레포는 명령이 없어 아무것도 안 돈다), 등록·해제가 기존 `repo set-base-ref` 와 같은 꼴이다.

### Consequences

* Good, because 레포 내용이 명령이 되는 길이 없다 — 신뢰 UI·허용 목록이 필요 없다
* Good, because 해제하면 칸이 사라져 등록 칸 외 레지스트리 바이트가 그대로다
* Bad, because 팀원·다른 머신과 공유되지 않는다 — 머신마다 한 번 등록해야 한다
* Bad, because orca.yaml 등 다른 도구의 설정을 그대로 쓸 수 없다

### Confirmation

`app/src/runtime/workspace/setup.test.ts` 의 레포 파일 마커 시험(orca.yaml·conductor.json·.corral/ 가 있어도 실행 0) · `worktree create` 정책 시험(등록 없으면 `inherit` 이 아무것도 안 함). 레포 파일을 읽는 코드가 생기면 이 ADR 을 다시 연다.

## Pros and Cons of the Options

### 레포 안 파일 + 신뢰 질문

* Good, because 팀이 한 번 적으면 모두가 쓴다
* Bad, because 신뢰 질문 UI·기억 저장·파일 변경 시 재질문이 필요하고, CLI 비대화 경로에서 물을 수 없다

### 둘 다

* Good, because 공유와 개인 덮기를 모두 준다
* Bad, because 위 신뢰 경계 비용을 그대로 지고 우선순위 규칙까지 더한다

## More Information

LIFE-813(도입) · LIFE-412(취소된 넓은 범위). 레포 파일 지원이 다시 요구되면 신뢰 모델을 먼저 정하는 별도 일감으로.
