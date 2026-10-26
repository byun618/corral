---
name: release
description: >-
  corral 출고. main 에서 release/vX.Y.Z 브랜치·worktree 를 자르고, 사용자가 고른 열린 PR 을 거기에 모아 통합 확인한 뒤
  release → main 머지로 버전 태그·GitHub Release(릴리즈 노트)·dmg·모바일 APK 를 만들고 LA 완료 전이·설치 확인(맥 dmg·폰 APK 덮어 설치)·
  release 브랜치 정리까지 한다. 본체 세션(본체 checkout, main)에서 "PR 이거이거 머지하고 빌드하자", "출고하자", "릴리즈하자" 같은 요청에 사용한다.
---

# release — 출고 (본체 세션에서 실행)

명령·exit 코드·충돌 해소의 상세는 `app/INSTALL.md` 「출고」가 원본이다. 이 문서는 순서와 릴리즈 노트 작성만 다룬다.
자르기·모으기·머지·태그·Release 생성은 `scripts/release.sh` 만 한다 — `gh pr merge`·`gh release create` 를 직접 부르지 않는다(스크립트 안내를 따를 때만 예외).
흐름: **자르기 → 모으기 → 통합 확인 → 회고 자리 → 릴리즈 노트 → 출고 → 마무리.** release 브랜치는 출고 1회 수명이고 한 번에 하나다.

## 1. 자르기 — 대상·버전 확정

- `gh pr list` 로 대기열을 보이고, 사용자가 고른 PR 과 순서를 그대로 쓴다. 고르지 않았으면 묻는다.
- 버전은 **자를 때** 정한다: 지정이 없으면 patch. 고른 PR 에 새 기능이 있으면(PR 제목·본문에서 판단) 자르기 전에 patch / minor 를 묻고,
  minor 면 `--bump minor`. 버그 수정·개선만이면 patch (LIFE-572 가 0.3.0 대신 v0.2.3 으로 나간 전례).
- `scripts/release.sh cut --dry-run` 으로 이름·버전을 보고 `scripts/release.sh cut [--bump minor]` — `release/vX.Y.Z` 브랜치와
  `.claude/worktrees/release-vX.Y.Z` worktree, 버전 커밋이 생긴다(push 없음). 열린 release 브랜치가 이미 있으면 거절된다 — 그것을 끝내거나 접는다.
- 자른 뒤엔 **출고를 막는 수정만** 넣는다(동결). 새 작업은 새 일감 → 다음 출고.

## 2. 모으기

- `scripts/release.sh gather --prs "<번호…>" --dry-run` → `scripts/release.sh gather --prs "<번호…>"` — 고른 순서대로 release 브랜치에 로컬 merge.
  거절(exit 2)이면 멈추고 원문을 보고한다.
- 충돌(exit 3)은 **release worktree 에서 바로 푼다** — 스크립트 안내대로 풀고 `git commit --no-edit`(메시지의 `Release-PR:` 줄이 모으기 기록) 뒤 남은 PR 로 다시.
  해소가 기능을 바꿀 만큼 크면 `merge --abort` 로 그 PR 을 빼고 그 작업의 코디에게 돌려보낸다.
- **출고 중 수정**은 그 일감 브랜치에서 고쳐 push 하고(리뷰 근거를 일감에 남긴다) 같은 PR 을 다시 `gather` 한다 — release worktree 에서 직접 고치지 않는다.

## 3. 통합 확인

- release worktree(`.claude/worktrees/release-vX.Y.Z`)에서 빌드·실행해 사용자가 확인한다 — `cd <worktree>/app && npm ci && npm run dev`(또는 「빌드」). throwaway `integration/` 브랜치를 따로 만들지 않는다.
- 빌드 산출물은 git 무시라 worktree 를 더럽히지 않는다. 추적 파일을 바꿨으면 출고 전에 되돌린다(`ship` 이 더러운 worktree 를 거절한다).

## 4. 회고 자리

- (LIFE-704 가 채운다 — devlog·changelog 를 release 브랜치에 커밋하는 자리. 지금은 건너뛴다.)

## 5. 릴리즈 노트 작성

- 재료는 **모은 PR 의 제목·본문**이다: `gh pr view <번호> --json number,title,body`. 판정문·리뷰 기록은 읽지 않는다 —
  릴리즈 노트는 무엇이 배포됐는지를 말하지, 어떻게 검증했는지를 말하지 않는다. 본문이 빈약하면 그 PR 의 diff(`gh pr diff`)로 보충한다.
- **corral 을 쓰는 사람 기준으로** 다시 쓴다. PR 본문을 옮겨 붙이지 않는다.
  - 묶음: `## 새 기능` / `## 개선` / `## 버그 수정` — 해당 없는 절은 뺀다. 내부 도구·스크립트만 바뀐 것은 `## 내부` 에 짧게.
  - 항목 한 줄: 사용자에게 보이는 변화를 먼저, 끝에 `(LIFE-NNN, #PR)`.
  - 리뷰 라운드·게이트·판정표·브랜치 이름 같은 작업 절차는 쓰지 않는다.
- 노트 파일은 레포 밖(세션 scratch)에 둔다. 노트의 원본은 GitHub Release 다.
- 쓴 노트를 사용자에게 보이고 진행한다. 출고 뒤 고칠 일이 생기면 `gh release edit <태그> --notes-file <파일>`.

## 6. 출고

- `scripts/release.sh ship --notes <노트 파일> --dry-run` → `scripts/release.sh ship --notes <노트 파일>` — release 브랜치 push → release→main PR 머지
  → 태그 → GitHub Release → 본체 ff → 원래 PR 처리 → dmg → APK. PR 집합은 release 브랜치 기록에서 읽는다(다시 고르지 않는다).
- APK 는 **매 출고** 만든다(모바일이 안 바뀐 출고도 — 폰 버전 = 맥 버전). APK 전제(JDK·Android SDK·`eas` 로그인)가 이 맥에 없으면 사용자에게 묻고,
  빼기로 하면 `--skip-apk` — 보고에 「APK 없음」을 적는다. 브랜치 APK 는 dev 빌드, 정식본은 출고 태그 빌드다.
- 실패하면 멈추고 원문을 보고한다. exit 코드별 복구는 `app/INSTALL.md` 「출고」 표와 스크립트 메시지를 따른다 —
  7·9·11·12 는 같은 `ship` 명령 재실행이 이어 간다. 8·10 은 메시지의 「dmg 만 다시」·「APK 만 다시」 아래 줄을 그대로 붙여 넣는다.
  13(원래 PR 이 MERGED 로 확인 안 됨)은 출고 자체는 끝난 상태다 — 보고하고 마무리를 진행하되 5번 정리는 MERGED 확인 뒤.

## 7. 마무리

1. 출고된 PR 의 일감마다 LA `issue_transition(seq: NNN, toStatusLabel: "완료", resolution: "completed")` — 실제 응답을 확인한다.
   설치를 기다리지 않는다. 부모 checkpoint 는 다른 미완 자식이 없는지 본 뒤 따로 판단한다.
2. dmg 설치(`app/INSTALL.md` 「설치」) → `corral --version` 이 새 버전인지 확인.
3. 폰 APK 덮어 설치 — `adb devices -l` 로 폰 시리얼을 고르고(에뮬레이터가 같이 붙어 있을 수 있다)
   `scripts/release-apk-install.sh --serial <폰 시리얼> --apk app/dist/release/<태그>/corral-mobile-X.Y.Z.apk`.
   스크립트가 설치본 서명과 새 APK 서명을 먼저 대조하고 같을 때만 `adb install -r` 한 뒤 versionName·`lastUpdateTime` 변화를 확인한다.
   **서명이 다르거나 설치본이 없어 멈추면 그대로 보고하고 사용자 판단을 받는다 — 앱을 지우고 다시 까는 길로 가지 않는다**(페어링 토큰·기록이 사라진다).
   폰이 연결돼 있지 않으면 설치를 미루고 그렇다고 보고한다.
4. 남은 작업 로컬 정리가 있으면 `scripts/task-finish.sh <LIFE-NNN-슬러그>`.
5. `scripts/release.sh finish` — 원래 PR 이 MERGED 인지 다시 보고(head 삭제) release 브랜치(로컬·원격)·worktree 를 지운다. 13 이면 남겨 두고 보고한다.
6. 보고: 태그·Release URL·출고된 PR(MERGED 여부)·LA 전이 결과·맥 설치 버전·폰 설치 결과(versionName·`lastUpdateTime`)·**APK 경로와 sha256**·release 브랜치 정리. 빠진 단계가 있으면 그렇다고 적는다.

출고를 접을 때(출고 전): `scripts/release.sh abort` — release 브랜치·worktree 만 지우고 PR 은 열린 채 남는다.
