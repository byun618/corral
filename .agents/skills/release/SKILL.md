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
  **예외는 §4 회고 커밋 하나다** — 채택한 learnings·ADR 을 release worktree 에서 직접 커밋한다. 동결과 그 예외의 원본은 이 줄이고, 다른 문서는 이리로 가리킨다.

## 2. 모으기

- **모으기 전에 대상 PR 마다 PR CI 결과를 본다(읽기 전용)** — 다른 체크(GitGuardian 등)도 붙어 있어 PR CI 워크플로만 골라 본다:
  ```bash
  gh pr checks <번호> --repo byun618/corral --json workflow,bucket,link --jq '.[] | select(.workflow | contains("PR CI")) | [.bucket, .link] | @tsv'
  ```
  `pass` 면 모은다 · `fail`·`cancel` 이면 그 PR 을 이번 출고에서 빼거나 일감 브랜치에서 고쳐 push 한 뒤 다시 본다 · `pending` 이면 끝날 때까지 기다렸다 다시 본다 ·
  `skipping` 이면 fork PR 이라 잡이 빠진 것이다 ·
  출력이 없으면 이 PR 의 head 커밋에 PR CI run 이 없거나(push 직후 등록 전, workflow 가 생기기 전 커밋, main 대상이 아닌 PR) 워크플로 이름이 바뀐 것이다 — 통과가 아니다. 잠시 뒤 다시 보고, 그래도 없으면 판정문·통합 확인으로만 보고 출고 보고에 「CI 없음」으로 적는다. `release.sh` 는 이 결과를 보지 않는다(검사 없이 순서 머지).
- `scripts/release.sh gather --prs "<번호…>" --dry-run` → `scripts/release.sh gather --prs "<번호…>"` — 고른 순서대로 release 브랜치에 로컬 merge.
  거절(exit 2)이면 멈추고 원문을 보고한다.
- 충돌(exit 3)은 **release worktree 에서 바로 푼다** — 스크립트 안내대로 풀고 `git commit --no-edit`(메시지의 `Release-PR:` 줄이 모으기 기록) 뒤 남은 PR 로 다시.
  해소가 기능을 바꿀 만큼 크면 `merge --abort` 로 그 PR 을 빼고 그 작업의 코디에게 돌려보낸다.
  이미 모은 PR 을 빼려면 `abort` 후 다시 `cut`·나머지 `gather` — 충돌 해소는 다시 한다.
- **출고 중 수정**은 그 일감 브랜치에서 고쳐 push 하고(리뷰 근거를 일감에 남긴다) 같은 PR 을 다시 `gather` 한다 — release worktree 에서 직접 고치지 않는다(예외는 §1 — §4 회고 커밋).
  묶음 PR 이면 일감 브랜치는 feature 이고 고치는 쪽은 본체가 feature worktree 를 다시 열고 재기동한 묶음 코디다 — `task-coordinate/references/bundle.md` 6.

## 3. 통합 확인

- release worktree(`.claude/worktrees/release-vX.Y.Z`)에서 빌드·실행해 사용자가 확인한다 — `cd <worktree>/app && npm ci && npm run dev`(또는 「빌드」). throwaway `integration/` 브랜치를 따로 만들지 않는다.
- 빌드 산출물은 git 무시라 worktree 를 더럽히지 않는다. 추적 파일을 바꿨으면 출고 전에 되돌린다(`ship` 이 더러운 worktree 를 거절한다).

## 4. 회고 자리

통합 확인 뒤·릴리즈 노트 전에, 이번 출고에 실린 일감의 배움과 막힌 지점을 사용자와 정리한다 (LIFE-704).
결과물은 release 브랜치의 회고 커밋 하나와 비공개 결정 기록이다. learnings 의 형식·상한·승격과 ADR 의 번호·상태는 각 README 가 원본이다 —
여기서는 언제·무엇을 하는지만 적는다.

- **일감 폴더 찾기**: 모은 PR 의 head 브랜치 `LIFE-NNN-<슬러그>` = corral-specs 작업 폴더 이름이다.
  묶음 PR(head `feature/LIFE-MMM-<슬러그>`)이면 묶음 폴더 `verdict.md` 의 자식 판정 링크(묶음 코디 절차 `task-coordinate/references/bundle.md` 6)로 자식 일감 폴더를 모두 찾는다 —
  게이트 ② 기록은 자식마다 있다.
- **읽는다** — 일감 폴더마다 사용자와 같이:
  - 게이트 ② 기록(task-coordinate §8): `devlog.md`·`learnings-proposal.md`·`adr-draft-*.md`. 여러 일감을 하루치로 묶어 보는 것은 사람이 이때 한다.
  - 막힌 지점: `00-analysis.md` 「절차 어긋남」 절과 devlog 회고의 「방식 개선」 렌즈 — 스킬·규칙이 그 일감에서 어긋난 자리다.
  - 판정·리뷰: `02-kickoff.md`(인용한 learnings — 아래 「작동했나」의 대상)·`verdict.md`·`reviews.md` — 기준·리뷰가 무엇을 잡고 놓쳤나.
  - 기록이 없는 일감은 「없음」으로 적고 넘어간다.
- **정한다** — 제안마다 채택·기각·보류:
  - learnings 추가·승격·삭제와 낡은 영역 파일의 재검토(90일·상한) — `.agents/learnings/README.md` 대로.
    재검토 대상은 일감 기록에 기대지 않고 직접 찾는다: `.agents/learnings/` 의 영역 파일(README 제외) 머리의 `Last reviewed` 를 모두 훑어 90일 넘은 파일과 상한에 닿은 파일을 연다.
  - ADR 초안 채택 — `docs/adr/README.md` 대로 번호·상태를 붙인다.
  - **이전 learnings 가 이번에 작동했나** — 실린 일감의 킥오프가 인용한 항목(task-coordinate §1)이 실수를 막았는지·빗나갔는지 대조한다.
    빗나갔으면 고치거나 지운다.
  - **스킬·규칙 개선안**(막힌 지점·승격된 규칙의 `.agents/` 반영) — 짧은 승격 줄이 아니면 여기서 고치지 않고 별도 LIFE 일감 후보로 적는다.
    사용자가 고르면 일감을 만든다. 회고 커밋은 learnings·ADR 과 짧은 승격 줄만 싣는다.
- **커밋한다**: 채택분을 release worktree 에서 **비-merge 커밋 하나**로 커밋한다(`docs(release): vX.Y.Z 회고` 류). 동결의 예외다(§1).
  - 메시지에 `Release-PR:` 줄을 쓰지 않는다 — `ship` 이 모으기 기록 밖의 그 줄을 위조 기록으로 거절한다.
  - `ship` 전에 끝낸다 — 커밋하지 않은 회고 변경이 남으면 `ship` 이 더러운 worktree 로 거절한다. 채택분이 없으면 커밋하지 않는다.
- **결정 기록(비공개)**: 채택·기각·보류와 그 이유, 「작동했나」 대조, 개선 일감 후보를 corral-specs `retro/vX.Y.Z.md` 한 파일에 이때 쓴다.
  커밋은 출고(§6)가 끝난 뒤 마무리에서 본체 세션이 그 파일만 지정해 한다(AGENTS.md 「산출물 규칙」의 루트 공용 파일과 같은 방식) —
  `retro/` 의 새 파일은 미추적이라 `git add -- retro/vX.Y.Z.md` 를 먼저 한다.
  출고를 접으면(`abort`) 회고 커밋은 release 브랜치와 함께 사라진다 — 접기 전에 그 커밋의 diff(사용자와 다듬은 learnings·ADR 최종 문구)를 기록에 붙이고,
  기록 머리에 「접음 — 다음 출고 회고에서 다시 적용」을 적어 커밋한다. 다음 회고가 그 기록에서 이어 간다.
  그래서 회고를 시작할 때 `retro/` 에서 「접음」 머리를 가진 기록을 먼저 찾는다 — 다시 자르며 버전이 바뀌면 파일 이름이 다르다.
  이어받으면 그 기록 머리를 「이어받음 vX.Y.Z」(이어받은 출고 버전)로 바꿔 같이 커밋한다 — 다음 회고가 다시 찾지 않게.
  공개 쪽에는 결정 결과만 남는다.

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
  원래 PR 의 MERGED 는 기본 브랜치에서의 간접 머지를 가정한 것이다(C14 실측 전) — 확인 안 되면 13.
  13(원래 PR 이 MERGED 로 확인 안 됨)은 출고 자체는 끝난 상태다 — 보고하고 마무리를 진행하되 5번 정리는 MERGED 확인 뒤.

## 7. 마무리

1. 출고된 PR 의 일감마다 LA `issue_transition(seq: NNN, toStatusLabel: "완료", resolution: "completed")` — 실제 응답을 확인한다.
   설치를 기다리지 않는다. 부모 checkpoint 는 다른 미완 자식이 없는지 본 뒤 따로 판단한다.
   묶음 PR(head `feature/LIFE-MMM-<슬러그>`)이면 묶음 폴더 `handoff-main.md` 의 실린 자식 일감도 전이한다 — head 에는 체크포인트 번호만 있다.
2. dmg 설치(`app/INSTALL.md` 「설치」) → `corral --version` 이 새 버전인지 확인.
3. 폰 APK 덮어 설치 — `adb devices -l` 로 폰 시리얼을 고르고(에뮬레이터가 같이 붙어 있을 수 있다)
   `scripts/release-apk-install.sh --serial <폰 시리얼> --apk app/dist/release/<태그>/corral-mobile-X.Y.Z.apk`.
   스크립트가 설치본 서명과 새 APK 서명을 먼저 대조하고 같을 때만 `adb install -r` 한 뒤 versionName·`lastUpdateTime` 변화를 확인한다.
   **서명이 다르거나 설치본이 없어 멈추면 그대로 보고하고 사용자 판단을 받는다 — 앱을 지우고 다시 까는 길로 가지 않는다**(페어링 토큰·기록이 사라진다).
   폰이 연결돼 있지 않으면 설치를 미루고 그렇다고 보고한다.
4. 남은 작업 로컬 정리가 있으면 `scripts/task-finish.sh <LIFE-NNN-슬러그>`.
   묶음 PR(head `feature/LIFE-MMM-<슬러그>`)의 feature worktree·로컬 feature 브랜치가 남았으면 `scripts/task-finish.sh feature/LIFE-MMM-<슬러그>` — 정리는 묶음 코디가 PR 생성 직후 하므로(`task-coordinate/references/bundle.md` 6) 이것은 안전망이다.
5. `scripts/release.sh finish` — 원래 PR 이 MERGED 인지 다시 보고(head 삭제) release 브랜치(로컬·원격)·worktree 를 지운다. 13 이면 남겨 두고 보고한다.
6. 회고 결정 기록이 있으면 §4 「결정 기록」 대로 corral-specs 에 커밋·push 한다.
7. 보고: 태그·Release URL·출고된 PR(MERGED 여부)·LA 전이 결과·맥 설치 버전·폰 설치 결과(versionName·`lastUpdateTime`)·**APK 경로와 sha256**·release 브랜치 정리. 빠진 단계가 있으면 그렇다고 적는다.

출고를 접을 때(출고 전): `scripts/release.sh abort` — release 브랜치·worktree 만 지우고 PR 은 열린 채 남는다. 회고를 했으면 결정 기록 처리는 §4.
