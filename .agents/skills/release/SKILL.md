---
name: release
description: >-
  corral 출고. 사용자가 고른 열린 PR 을 순서대로 머지하고 버전 태그·GitHub Release(릴리즈 노트)·dmg 를 만든 뒤
  LA 완료 전이·설치 확인까지 한다. 본체 세션(본체 checkout, main)에서 "PR 이거이거 머지하고 빌드하자",
  "출고하자", "릴리즈하자" 같은 요청에 사용한다.
---

# release — 출고 (본체 세션에서 실행)

명령·exit 코드·충돌 해소의 상세는 `app/INSTALL.md` 「출고」가 원본이다. 이 문서는 순서와 릴리즈 노트 작성만 다룬다.
머지·태그·Release 생성은 `scripts/release.sh` 만 한다 — `gh pr merge`·`gh release create` 를 직접 부르지 않는다(실패 복구 안내를 따를 때만 예외).

## 1. 대상 확정

- `gh pr list` 로 대기열을 보이고, 사용자가 고른 PR 과 순서를 그대로 쓴다. 고르지 않았으면 묻는다.
- `scripts/release.sh --prs "<번호…>" --dry-run` — 대상·순서·다음 버전·태그를 확인한다. 거절(exit 2 등)이면 멈추고 원문을 보고한다.

## 2. 릴리즈 노트 작성

- 재료는 **고른 PR 의 제목·본문**이다: `gh pr view <번호> --json number,title,body`. 판정문·리뷰 기록은 읽지 않는다 —
  릴리즈 노트는 무엇이 배포됐는지를 말하지, 어떻게 검증했는지를 말하지 않는다. 본문이 빈약하면 그 PR 의 diff(`gh pr diff`)로 보충한다.
- **corral 을 쓰는 사람 기준으로** 다시 쓴다. PR 본문을 옮겨 붙이지 않는다.
  - 묶음: `## 새 기능` / `## 개선` / `## 버그 수정` — 해당 없는 절은 뺀다. 내부 도구·스크립트만 바뀐 것은 `## 내부` 에 짧게.
  - 항목 한 줄: 사용자에게 보이는 변화를 먼저, 끝에 `(LIFE-NNN, #PR)`.
  - 리뷰 라운드·게이트·판정표·브랜치 이름 같은 작업 절차는 쓰지 않는다.
- 노트 파일은 레포 밖(세션 scratch)에 둔다 — main 에는 버전 커밋만 올라간다. 노트의 원본은 GitHub Release 다.
- 쓴 노트를 사용자에게 보이고 진행한다. 출고 뒤 고칠 일이 생기면 `gh release edit <태그> --notes-file <파일>`.

## 3. 출고 실행

- `scripts/release.sh --prs "<번호…>" --notes <노트 파일>` (버전 지정이 있으면 `--bump`·`--version`).
- 실패하면 멈추고 원문을 보고한다. exit 코드별 복구(3 충돌 · 7 태그 push · 8 dmg · 9 Release)는 `app/INSTALL.md` 「출고」와 스크립트 메시지를 따른다.

## 4. 마무리

1. 머지된 PR 의 일감마다 LA `issue_transition(seq: NNN, toStatusLabel: "완료", resolution: "completed")` — 실제 응답을 확인한다.
   설치를 기다리지 않는다. 부모 checkpoint 는 다른 미완 자식이 없는지 본 뒤 따로 판단한다.
2. dmg 설치(`app/INSTALL.md` 「설치」) → `corral --version` 이 새 버전인지 확인.
3. 남은 로컬 정리가 있으면 `scripts/task-finish.sh <LIFE-NNN-슬러그>`.
4. 보고: 태그·Release URL·머지된 PR·LA 전이 결과·설치 버전. 빠진 단계가 있으면 그렇다고 적는다.
