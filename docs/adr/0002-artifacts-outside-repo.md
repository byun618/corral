---
status: accepted
date: 2026-10-27
decision-makers: 사용자(레포 소유자)
---

# 작업 산출물은 별도 비공개 저장소에 두고, 코드 레포에는 공개해도 되는 것만 둔다

## Context and Problem Statement

일감마다 분석·판정 문서와 실행 원자료를 코드 레포의 `specs/` 에 커밋해 왔다. 원자료가 커밋 대부분을 차지해 레포가 몇 주 만에 두 배로 커졌고,
원자료에 실제 키 모양 값이 섞여 이력째 공개할 수 없게 됐다(LIFE-705). 코드 레포를 공개할 수 있게 하려면 산출물을 어디에 둘 것인가.

## Decision Drivers

* 코드 레포를 시크릿 스캔 뒤 visibility 전환만으로 공개할 수 있어야 한다(LIFE-706)
* 원자료는 판정 근거라 지우지 않고 보관한다(validation 「원자료 보관」)
* 코디·워커·리뷰어가 worktree 와 상관없이 같은 산출물을 읽고 쓴다 — worktree 정리에 휩쓸리지 않는다
* 1인 운영 — 별도 아티팩트 서버·보존 정책 인프라를 두지 않는다

## Considered Options

* 코드 레포에 그대로 두기(`specs/` 커밋)
* 코드 레포에서 `specs/` 를 `.gitignore` 하고 로컬에만
* 별도 비공개 저장소(corral-specs)로 분리하고 기존 레포 이력은 그쪽에 보존, 코드 레포는 이력에서 `specs/` 를 걷어낸 새 레포

## Decision Outcome

Chosen option: "별도 비공개 저장소로 분리", because 원자료를 버전 관리 아래 보관하면서 코드 레포 이력에서 비공개 내용을 처음부터 없앤다.

### Consequences

* Good, because 코드 레포 이력에 산출물이 없어 공개 전 점검이 코드·메시지 스캔으로 줄어든다
* Good, because 산출물이 worktree 밖 한 곳(브랜치 하나)에 있어 세션 간 조율이 절대경로 파일로 된다
* Good, because 공개해도 될 배움·결정만 골라 코드 레포의 `.agents/learnings/`·`docs/adr/` 로 옮기는 자리가 생긴다(LIFE-704)
* Bad, because 두 레포를 같이 커밋해야 하고, 여러 일감이 한 working copy 를 공유해 자기 폴더만 지정해 커밋해야 한다
* Bad, because PR 본문의 판정문 위치는 링크가 아닌 텍스트다(공개 뒤 깨진 링크 방지)
* Bad, because 코드 레포 해시가 전부 바뀌었고 옛 태그·릴리즈 자산은 비공개 저장소에 남는다

### Confirmation

두 레포의 gitleaks pre-commit 훅, `scripts/task-finish.sh` 의 worktree `specs/` 잔류 가드, `scripts/task-pr.sh` 의 원고·판정문 위치 확인, 리뷰의 공개 누출 점검.

## Pros and Cons of the Options

### 코드 레포에 그대로 두기

* Good, because 한 레포·한 커밋으로 끝난다
* Bad, because 이력에 원자료·시크릿 모양 값이 남아 공개할 수 없고 크기가 계속 커진다

### `specs/` 를 `.gitignore` 하고 로컬에만

* Good, because 코드 레포가 가장 단순하다
* Bad, because 원자료가 버전 관리 밖이라 worktree 정리·디스크 사고에 잃는다

## More Information

LIFE-705(결정·전환), LIFE-706(공개 전환), LIFE-704(배움·결정의 공개 경로). 업계 비교: 스펙 md 는 레포에 두되 실행 원자료는 커밋하지 않는 방식(Spec Kit·OpenSpec·Kiro), 하네스만 레포에 두는 방식(VS Code).
다시 볼 조건: 산출물 중 공개해야 할 설계 근거가 늘어 `docs/` 로 옮기는 양이 커질 때.
