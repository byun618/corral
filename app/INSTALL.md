# corral 설치본 (로컬 빌드, LIFE-555 · LIFE-556)

arm64 macOS 전용. 서명은 ad-hoc 이고 자동 업데이트·brew cask·릴리스 채널은 없다(LIFE-446 T3·T4 취소, 2026-10-08) — 다른 Mac 에는 dmg 를 건네 설치한다.
받은 Mac 에서 첫 실행이 막히면 **시스템 설정 ▸ 개인정보 보호 및 보안** 에서 「그래도 열기」를 한 번 누른다.
**herdr 를 따로 설치할 필요가 없다** — 앱 안에 corral 전용 herdr(release 패치 빌드)가 들어 있다(LIFE-556).

## 출고 (LIFE-574 · APK LIFE-599 · release 브랜치 LIFE-703)

**main = 출고된 상태 = 설치본.** 설치본 버전 = 태그 `vX.Y.Z` = `app/package.json` 버전이다(`corral --version` 으로 태그를 특정한다).
모바일도 같다 — 폰 APK 의 versionName = 태그 버전(`mobile/app.config.ts` 가 `app/package.json` 을 읽는다).
**작업 브랜치에서 만든 dmg·APK 는 머지 전 확인용 dev 빌드이고, 정식본은 dmg·APK 모두 출고 태그에서 만든다** — 작업 관문에서 폰에 깐 브랜치 APK 는 출고 때 태그 APK 로 덮인다.
출고 대기열은 열린 PR 이고(게이트 ② 출고 승인 = PR 생성, `scripts/task-pr.sh`), 출고는 사용자가 끊는다 — "PR 이거이거 머지하고 빌드하자".
본체 세션이 본체 checkout 에서 `release` 스킬(`.agents/skills/release/SKILL.md`)대로 실행한다 — 릴리즈 노트 작성이 그 스킬 몫이다.

흐름은 **release 브랜치** 하나를 거친다(Git Flow 에서 develop 을 뺀 모양): main 에서 `release/vX.Y.Z` 를 자르고, 고른 PR 을 거기에 로컬 merge 로 모아
release worktree 에서 통합 확인한 뒤, release → main PR 하나를 머지하는 것이 출고다. 원래 PR 들(base 는 그대로 main)은 head 가 main 에 닿으면
GitHub 가 MERGED 로 바꾼다고 **가정한다**(간접 머지 — 기본 브랜치에서만, C14 실측 전). 확인이 안 되면 head 를 지우지 않고 exit 13 으로 멈춘다. release 브랜치는 출고 1회 수명이고 **한 번에 하나**다.

```sh
gh pr list                                              # 출고 대기열
scripts/release.sh cut [--bump minor|major | --version X.Y.Z] [--dry-run]   # ① 자르기 — release/vX.Y.Z + .claude/worktrees/release-vX.Y.Z + 버전 커밋(기본 patch, push 없음)
scripts/release.sh gather --prs "12 15" [--dry-run]     # ② 모으기 — 고른 순서대로 release 브랜치에 로컬 merge(merge commit)
#                                                         ③ 통합 확인 — release worktree 에서 빌드·실행(release 스킬 3)
scripts/release.sh ship --notes <노트 파일> [--dry-run]  # ④ 출고 — release→main 머지 · 태그 · Release · 본체 ff · 원래 PR 처리 · dmg · APK
scripts/release.sh finish [--leave-open]                # ⑤ 정리 — 출고 확인 뒤 release 브랜치(로컬·원격)·worktree 삭제
scripts/release.sh abort                                # 접기 — 출고 전 release 브랜치·worktree 만 삭제, PR 은 열린 채
```

**검사 없이 순서 머지다.** PR CI 는 아직 없다(후속 일감 LIFE-575, 맥미니 self-hosted 러너) — 검증 근거는 각 PR 의 판정문(리뷰·관문)과 release worktree 통합 확인이다.

**① cut** — origin/main 끝의 `app/package.json` 에서 다음 버전을 정하고(`--bump`·`--version`) 다음 버전 ≤ 지금 버전 · 원격 태그 존재 ·
열린 release 브랜치(로컬·원격 `release/v*`) 있음 · 다른 레포 안에서 부름 중 하나라도면 아무것도 만들지 않는다(exit 2). 만들면 release 브랜치에
버전 커밋 `release: vX.Y.Z`(`Release-Cut:` 줄)이 올라간다 — main 에 버전 커밋을 직접 올리지 않는다. 같은 버전으로 다시 치면 있는 것을 재사용하고
(worktree 를 잃었으면 다시 붙이고, 원격에만 있으면 로컬로 가져온다) 두 번째를 만들지 않는다. release PR 머지 뒤에는 main 버전이 이미 올라가
다음 버전을 계산하므로 **`cut --version X.Y.Z`(그 버전)** 로 붙인다 — 스크립트 안내가 그 명령을 낸다.

**② gather** — 고른 PR 전부를 먼저 본다: 닫힘·draft·포크·base 가 main 이 아님 중 하나라도면 release 브랜치 변경 0건(exit 2). 이때 head SHA 를 고정해
그 SHA 를 fetch·merge 하고, merge 커밋에 `Release-PR: <번호> <head SHA>` 줄을 남긴다 — **출고 집합은 이 기록이다**(ship 이 다시 고르지 않는다).
기록 줄은 gather 가 만든 커밋(둘째 부모 = 그 SHA 인 merge, 또는 제목 `release: #<번호> 기록`)에 있고 그 SHA 가 release 브랜치에 있을 때만 센다 — 아니면 어느 커밋인지 대고 exit 2.
이미 들어 있는 head 는 건너뛰므로 같은 명령을 몇 번 다시 쳐도 된다. release worktree 가 더럽거나 해소 중인 merge 가 있으면 거절한다.

**충돌이 나면 (gather exit 3)** — 그 PR 에서 멈추고(뒤 PR 은 모으지 않음) release worktree 에 충돌 상태를 남긴다. 그 자리에서 푼다:
```sh
cd .claude/worktrees/release-vX.Y.Z      # 충돌 파일을 고친다 — 확인이 필요하면 app/ 에서 npm run typecheck·npm test
git add -- <푼 파일>
git commit --no-edit                     # 메시지의 Release-PR 줄이 모으기 기록이다 — 그대로 둔다
scripts/release.sh gather --prs "<멈춘 PR> <뒤 PR …>"   # 이미 모은 PR 은 넣어도 건너뛴다(안내 메시지에 그대로 있다)
```
PR head 에는 해소가 없다 — 상관없다: 그 head 가 release→main 머지로 main 에 닿으면 PR 이 MERGED 가 된다. 해소가 기능을 바꿀 만큼 크면
`git merge --abort` 로 그 PR 을 빼고 나머지만 모은 뒤 그 작업의 코디에게 돌려보낸다.
**이미 모은 PR 을 빼려면** `abort` 후 다시 `cut` 하고 나머지만 `gather` 한다 — 앞서 푼 충돌 해소는 다시 해야 한다. LA 는 `검증 중` 그대로다.
해소 커밋을 `-m` 으로 만들어 `Release-PR:` 줄이 빠지면 그 PR 은 출고 집합 밖이다 — `ship --dry-run` 은 「⚠ 기록 없는 merge」로 보고만 하고,
실제 `ship` 은 출고 머지 전이면 거절한다(exit 2 + gather 안내). 같은 PR 을 다시 `gather` 하면 기록만 남긴다. 앞 PR 이 뒤 PR 의 head 를 이미 품은 경우(쌓인 PR)도 `gather` 가 기록만 남긴다.

**출고 중 수정** — 통합 확인에서 문제가 나오면 그 일감 브랜치에서 고쳐 push 하고(리뷰 근거를 일감에 남긴다) 같은 PR 을 다시 `gather` 한다 —
새 커밋만 merge 하고 기록을 갱신한다. release worktree 에서 직접 고치지 않는다. 자른 뒤엔 출고를 막는 수정만 넣는다(동결) — 새 작업은 다음 출고.

**④ ship** — ⓐ 머지 전 점검: release worktree 깨끗함 · release 브랜치가 origin/main 을 품음(main 이 그새 움직였으면 멈추고
`git -C <release worktree> merge origin/main` 안내) · 끝의 `app/package.json` = 브랜치 버전 · **기록된 PR 마다 지금 head 가 release 브랜치에 있음**
(모은 뒤 head 가 움직였는데 다시 모으지 않았으면 어느 PR 인지 대고 거절 — 그대로 내보내면 그 PR 은 열린 채 남는다) · 노트 파일 ·
dmg 를 만들 거면 node(v24 기준, v22 는 경고, 그 밖은 거절)·clang · APK 를 만들 거면 그 전제(JDK 17 이상 — `JAVA_HOME` 의 java, 없으면 PATH 의 `java -version` ·
`ANDROID_HOME` 의 build-tools(apksigner·aapt2) · `eas whoami` 로그인 · 작업 폴더 자리(아래)) — 하나라도 어긋나면 push·머지 0건(exit 2).
ⓑ release 브랜치 push → release→main PR(열린 것이 있으면 재사용) → 머지 가능 판정 → **기록된 PR head 재확인**(움직였으면 머지하지 않고 exit 2, release PR 은 열린 채 —
다시 모은 뒤 같은 ship) → `gh pr merge --merge --match-head-commit <release 끝>` → 머지 커밋 부모 2개·둘째 부모 = release 끝·버전 확인.
재확인과 머지 사이에 남는 짧은 창의 head 이동은 막을 수 없다 — 그 PR 은 OPEN 으로 남고 ⓕ 가 exit 13 으로 받는다
ⓒ 주석 태그 `vX.Y.Z` = **main 끝(머지 커밋)** push — main 에 직접 push 하는 것은 이 태그뿐이다 ⓓ `--notes` 로 GitHub Release ⓔ 본체 checkout fast-forward(`release-ff.sh`)
ⓕ **원래 PR 처리**: 기록된 PR 의 상태를 다시 조회해 **MERGED 를 본 뒤에만** 원격 head 를 지운다(그 전에 지우면 PR 이 merged 가 아니라 closed 가 될 수 있다).
리허설은 `throwaway/` 아래 head 만 지운다(그 밖은 그대로 두고 알린다). 대기 시계는 **한 실행에 하나**다 — `RELEASE_INDIRECT_WAIT_S`(기본 120초, 간격 `RELEASE_INDIRECT_STEP_S` 10초)를 모든 PR 이 같이 쓰고, 시계가 다 돼도 PR 마다 최소 1회는 조회한다.
head 가 그 사이 다른 커밋으로 움직였으면 지우지 않는다(그 뒤 push 된 커밋이다). **head 삭제가 실패하면 미해결로 센다**(exit 13 — finish 가 release 브랜치를 지우지 않는다)
ⓖ 그 태그 위 깨끗한 임시 worktree(`.claude/worktrees/_release-*`)에서 `scripts/release-dmg.sh` 로 아래 「빌드」를 돌려 dmg 를 `app/dist/release/vX.Y.Z/` 에 둔다(`--skip-build` 면 생략)
ⓗ 같은 worktree 에서 `scripts/release-apk.sh` 로 모바일 APK(`preview` 프로필 로컬 빌드 — EAS 쿼터 소모 없음, 서명 = EAS 원격 자격증명)를 `app/dist/release/vX.Y.Z/corral-mobile-X.Y.Z.apk` 에 둔다
(**매 출고 기본**, `--skip-apk` 면 생략). `--skip-build` 는 dmg 만, `--skip-apk` 는 APK 만 뺀다.
**멱등**: 단계마다 원격 상태(원격 태그 · release PR 상태 · Release 유무)로 어디까지 됐는지 보고 이어 간다 — 같은 `ship` 명령을 다시 치면 끝난 단계는 건너뛴다.
Release 까지 끝난 뒤 다시 치면 빌드하지 않고 원래 PR 처리만 다시 본 뒤 dmg·APK 명령을 보여 준다. 「이미 태그됨」은 원격 태그가 출고 머지 커밋일 때만이다 —
다른 커밋(예: release 브랜치 끝)을 가리키면 출고하지 않고 exit 2 로 멈춘다(태그를 직접 확인). release PR 이 머지됐는데 태그가 없으면(exit 7 뒤) `gather` 는
더 모으지 않고 같은 `ship` 을 안내한다.

**⑤ finish** — 원격 태그가 이 release 의 출고 머지 커밋(origin/main 위 merge commit, 둘째 부모 = release 브랜치 끝)일 때(출고 확인)만 돈다. 원래 PR 처리를 한 번 더 하고(MERGED 면 head 삭제), 남은 PR 이 없으면
release 브랜치(로컬·원격)·worktree 를 지운다. release worktree 에 커밋 안 된 변경이 있으면 지우지 않는다. 재실행 안전.
**abort** — 출고 전(태그 없음·release PR 미머지)에만. release 브랜치(로컬·원격)·worktree 를 지운다 — 열려 있던 release PR 은 브랜치 삭제로 GitHub 가 닫고,
모았던 PR 은 열린 채 남는다. main·태그 변경 없음. worktree 가 더러우면 멈춘다.

| exit | 뜻 | 할 일 |
| --- | --- | --- |
| 0 | 완료 | 다음 하위 명령 |
| 1 | 인자·환경 오류(짝 안 맞는 리허설 인자·쓸 수 없는 글자·옛 `--prs` 단독 호출 포함) — ref·push 전에 멈춤 | 메시지대로 고쳐 다시 |
| 2 | 점검 거절 — 대부분 변경 0. 단 ship 의 머지 직전 head 재확인은 release 브랜치 push·release PR 생성 뒤(PR 은 열린 채), gather 는 앞 PR 을 모은 뒤 거절할 수 있다 | 사유(열린 release 브랜치·head 이동·main 이동·더러운 worktree·기록 이상 등)를 풀고 같은 명령 |
| 3 | 충돌 — gather: release worktree 에 남김 / ship: release PR 이 main 과 충돌 | 위 「충돌이 나면」 / release worktree 에서 `merge origin/main` 뒤 ship |
| 5 | release PR 머지 가능 판정이 안 나옴 | 잠시 뒤 같은 ship |
| 6 | release PR 머지 거절·머지 결과 이상(부모·버전) | PR 상태를 보고 같은 ship |
| 7 | 태그 만들기·push·main fetch 실패(머지는 끝남, 로컬 태그는 지움) | 같은 ship — 태그부터 이어 간다 |
| 8 | dmg 실패 또는 빌드용 임시 worktree 생성 실패(머지·태그·Release 끝) | 메시지의 「dmg 만 다시」 줄 → 그 뒤 「dmg 뒤 APK」 줄 |
| 9 | GitHub Release 실패(머지·태그 끝) | 같은 ship — Release 부터 이어 간다 |
| 10 | APK 실패(머지·태그·Release·dmg 끝) | 메시지의 「APK 만 다시」 줄 |
| 11 | release 브랜치 push·삭제 실패 | 원인을 보고 같은 명령 |
| 12 | release PR 생성·조회 실패 | 같은 ship — 열린 release PR 이 있으면 재사용 |
| 13 | 원래 PR 처리 미완 — MERGED 미확인 또는 head 조회·삭제 실패. 출고 자체(태그·Release·dmg·APK)는 끝남, 그 head 는 지우지 않음(못 지움) | 아래 「간접 머지가 안 될 때」 · 삭제 실패면 원인(권한·보호)을 풀고 finish |

**간접 머지가 안 될 때 (exit 13)** — GitHub 문서는 「PR 의 head 커밋이 다른 PR 머지로 기본 브랜치에 닿으면 merged」라고만 적고 지연 상한은 없다.
메시지의 `gh pr view <번호> --json state,mergedAt,mergeCommit` 로 상태를 보고, 시간이 지나 MERGED 가 되면 `scripts/release.sh finish` 가 head 를 지우고 정리한다.
끝내 OPEN 이면: 그 head SHA 가 main 에 있는지(`git merge-base --is-ancestor <head SHA> origin/main`) 확인하고, 있으면 출고된 것이다 — 보고에 그 PR 을 적고
사용자 판단으로 PR 을 닫는다(head 브랜치 삭제는 그 뒤). 없으면 모은 뒤 head 가 움직인 것이다 — 다음 출고에서 다시 모은다.
확인을 마쳤으면 `scripts/release.sh finish --leave-open` 이 그 PR 들의 head 는 두고 release 브랜치·worktree 만 정리한다.
**리허설(throwaway base, 비기본 브랜치)에서는 13 이 정상일 수 있다** — GHES 3.12 문서가 간접 머지를 기본 브랜치로 한정한다(LIFE-703 00-analysis §4.1).

안내의 명령은 설명과 다른 줄에 홀로 있고 경로가 단일 따옴표로 인용돼 있어(한글·공백 경로도 화면 그대로 복사해 돈다) 어느 cwd 에서도 돈다. APK 만 다시:
```sh
<본체>/scripts/release-apk.sh --from-tag vX.Y.Z --tag-prefix v --out <본체>/app/dist/release/vX.Y.Z
```
`--from-tag` 는 원격에서 그 태그를 정확히 fetch 하고(로컬 태그가 없어도 된다) 매번 새 임시 worktree(`.claude/worktrees/_apk-<태그>-<시각>-<pid>`)에서 빌드한 뒤 그 worktree 만 지운다(다른 worktree 등록은 건드리지 않고, 못 지우면 남은 경로를 알린다) —
앞선 시도가 남긴 worktree 와 겹치지 않는다. 산출물 자리에 이미 APK 가 있으면 지우지 않고 그 아래 `retry-<시각>/` 에 새로 만든다. 같은 명령을 몇 번 다시 돌려도 된다.

끝나면 본체 세션이: 출고된 PR 의 일감마다 LA `완료` 전이(출고 머지 뒤 — D2, 설치를 기다리지 않는다) → dmg 를 아래 「설치」대로 설치 →
`corral --version` 이 새 버전인지 확인 → 폰에 APK 를 덮어 설치(아래 「폰 APK 설치」) → 남은 로컬 정리가 있으면 `scripts/task-finish.sh <LIFE-NNN-슬러그>` → `scripts/release.sh finish`.

**폰 APK 설치** — `scripts/release-apk-install.sh --serial <폰 시리얼> --apk app/dist/release/vX.Y.Z/corral-mobile-X.Y.Z.apk`.
① 시리얼이 필수다(기본값 없음 — 폰·에뮬레이터가 같이 붙어 있어도 엉뚱한 기기에 깔지 않는다. 시리얼은 `adb devices -l`)
② 설치 **전에** 기기 설치본(`pm path` → `adb pull`)과 새 APK 를 `apksigner verify` 로 확인해 양쪽 모두 서명자 정확히 1개이고 SHA-256 이 같을 때만 넘어간다 — **다르거나 복수 서명·verify 실패면 설치하지 않고 멈춘다**
③ 같을 때만 `adb install -r`(데이터·페어링 유지) ④ `dumpsys` 로 versionName·`lastUpdateTime` 이 바뀌었는지 보고 APK sha256 을 출력한다 — 출고 보고에 넣는다.
설치본을 지우고 새로 까는 길은 없다 — 지우면 페어링 토큰·기록이 사라진다. 서명이 다르거나 설치본이 없으면(첫 설치) 멈추고 사용자에게 보고한다(첫 설치는 `mobile/README.md` §3).

- **자르기·모으기·머지·태그는 `release.sh` 로만 한다.** 브랜치 보호(required check)는 Free 플랜 private 레포에서 쓸 수 없어(403) 서버가 막지 않는다 —
  웹 UI 머지(release PR 포함 — 웹으로 머지하면 태그·Release·dmg·APK 가 안 돈다)·main 직접 push 를 하지 않는 것은 규약이다. squash·rebase 머지는 레포 설정에서 꺼 두었다(merge commit 만).
- 태그 밖에서 dmg 를 만들어야 하면(개발 빌드) 「빌드」를 손으로 돌린다 — 그 dmg 는 출고본이 아니다. 출고 dmg 는 `release-dmg.sh` 가 HEAD = 태그·깨끗한 트리·
  태그 버전 = package.json 버전을 확인할 때만 만든다(`--check-only` 로 가드만 본다).
- 리허설: 모든 하위 명령에 `--base throwaway/<이름> --tag-prefix rehearsal-<이름>-v` 를 준다 — release 브랜치는 `throwaway/<이름>-release/rehearsal-…X.Y.Z`,
  worktree 는 `.claude/worktrees/release-rehearsal-…X.Y.Z`, Release 는 prerelease. **둘은 짝으로만 받는다** — 한쪽만 주거나 접두가 어긋나면
  ref·push 전에 거절한다(exit 1, 실 출고는 둘 다 기본값 `main`·`v`).
- `release-dmg.sh` 는 태그가 원격(origin)에도 같은 커밋으로 있을 때만 빌드한다. `release-apk.sh` 도 같은 가드(깨끗한 트리 · HEAD = 태그 · 태그 버전 = `app/package.json` ·
  원격 태그 같은 커밋)를 `npm ci`·`eas` 보다 먼저 보고, 빌드 뒤 APK 의 패키지·versionName(= 태그 버전)·서명(EAS 원격 자격증명 `483a15fa…1a617a`)을 확인한다. `--check-only` 는 가드·전제만,
  `--preflight` 는 전제만 본다(`release.sh ship` 이 머지 전에 부른다).
- APK 작업 폴더는 **셸 TMPDIR 에 맡기지 않는다** — macOS `/tmp`(→ `/private/tmp` 심링크) 아래에서 CMake·ninja 가 경로를 섞어 실패한 적이 있다(LIFE-594, reanimated #9151).
  `release-apk.sh` 는 사용자 임시 폴더(`getconf DARWIN_USER_TEMP_DIR`, 바꾸려면 `CORRAL_APK_WORK_BASE`)에 실경로 작업 폴더를 만들어 `EAS_LOCAL_BUILD_WORKINGDIR`·`TMPDIR` 로 준다 —
  셸이 vitest 관행대로 `TMPDIR=/tmp/…` 를 물려줘도 빌드는 그것을 쓰지 않는다. 자리가 없거나 쓸 수 없거나 경로에 공백이 있으면 빌드 전에 거절한다. 작업 폴더(`corral-apk-XXXXXX`)를 만들지 못하면 `npm ci`·`eas` 전에 멈춘다.
  EAS 의 작업 폴더 자동 정리는 끄고(`EAS_LOCAL_BUILD_SKIP_CLEANUP=1`) 성공했을 때만 이번에 만든 그 폴더를 지운다 — 빌드·확인이 실패하면 작업 폴더를 남기고 경로를 알려 준다.
- `JAVA_HOME`·`ANDROID_HOME`·`CORRAL_APK_WORK_BASE` 는 절대경로여야 한다 — 상대경로면 사전 점검에서 거절한다(머지 전 exit 2). 사전 점검(본체 cwd)과 태그 worktree 빌드가 같은 곳을 봐야 해서다.
- 서명 확인은 `apksigner verify` 성공 + 서명자 정확히 1개 + SHA-256 일치일 때만 통과한다(출고 정책 = EAS 단일 키) — 빌드 뒤 확인과 폰 설치 전 대조 모두 같다.
- PR CI 는 아직 없다 — 후속 일감 LIFE-575. 원격 CD(main 머지 시 GitHub Actions 로 태그·dmg·APK)는 LIFE-707 — 지금 CD 는 로컬 `release.sh ship` 이다.
  574 구현 r0 의 ubuntu workflow 초안은 구현 브랜치 커밋 `ffb08b9` 에 남아 있다(계정 결제 잠금으로 한 번도 돌지 못했다). 분리 전 커밋이라 corral-specs 레포에서 본다(LIFE-705).
- 오프라인 하네스: `app/scripts/l703/release-test.sh <원자료 폴더>`(로컬 bare 원격 + 가짜 gh 로 하위 명령 분기·exit 코드) · `mutate.sh`(가드를 빼면 케이스가 실패로 바뀌는지).
- 574 출고 전후 과도기(565·566·564 와 첫 출고 순서)는 `corral-specs/LIFE-574-pr-release/transition.md`.

## 빌드

전제: **clang(Xcode 명령줄 도구, `xcode-select --install`)** — `npm run build`·`npm run dev`·`package:mac` 이 Resource Manager 메모리 도우미(`helper/corral-footprint.c`)를 `scripts/build-footprint.mjs` 로 빌드한다(LIFE-676). 없으면 빌드가 멈춘다.

```sh
cd app
npm ci
# 1) 동봉 herdr release 빌드 — 격리 build root 에 툴체인·소스·바이너리가 생긴다(레포·홈에 깔지 않는다)
export CORRAL_BACKEND_BUILD_ROOT="$(mktemp -d /tmp/corral-herdr-release-XXXXXX)"
CORRAL_BACKEND_PROFILE=release sh scripts/build-terminal-backend.sh
# 2) 앱 패키징 — typecheck → electron-vite build → CLI 번들 → 동봉 herdr 검증·배치(scripts/bundle-herdr.mjs) → electron-builder
npm run package:mac
```

`package:mac` 은 `CORRAL_BACKEND_BUILD_ROOT` 의 release 영수증이 지금 `backend/source.json`(패치 목록·sha256)과 맞지 않으면 멈춘다.

산출물은 `app/dist/`(git 무시)에 나온다 — `corral-<version>-arm64.dmg`·`corral-<version>-arm64-mac.zip`, 풀린 번들은 `dist/mac-arm64/corral.app`.
bundle id `io.github.byun618.corral`, 앱·실행 파일 이름 `corral`.

## 설치

1. dmg 를 열고 `corral.app` 을 `/Applications` 로 끌어 놓는다.
2. 앱을 열고 메뉴 **corral ▸ Install 'corral' Command in PATH…** 를 한 번 실행한다 — `~/.local/bin/corral` 에 앱 shim
   (`Contents/Resources/bin/corral`) 심링크 하나를 만든다. 손으로 `ln -s` 하지 않아도 된다.
   - 셸 설정 파일(`~/.zshrc` 등)은 고치지 않는다. `~/.local/bin` 이 로그인 셸 PATH 에 없으면 추가할 한 줄을 대화상자로 알려 준다.
   - 그 자리에 이미 다른 `corral`(다른 대상 심링크·일반 파일)이 있으면 지금 있는 것을 보여 주고 **확인해야만** 바꾼다.
   - PATH 앞쪽의 다른 `corral` 이 가리면 그 경로를 알려 준다.
   - 되돌리기: **corral ▸ Uninstall 'corral' Command…** — 이 앱을 가리키는 심링크일 때만 지운다.
   CLI 는 앱 내장 Node 로 돌아서 셸의 node 버전·유무와 무관하다.
3. 확인: **새 터미널**에서 `command -v corral` 이 `~/.local/bin/corral` 이고 `corral --version` 이 앱 버전과 같다.

**주의 — `npm link` 된 레포 CLI 가 가릴 수 있다.** 레포 `app/` 을 `npm link` 해 둔 node 버전(예: nvm node v22)의 bin 이
PATH 에서 `~/.local/bin` 보다 앞이면, 그 node 를 쓰는 셸에서는 `corral` 이 레포 CLI 로 해소된다(00-analysis G2).
`command -v corral` 로 어느 쪽이 잡히는지 확인하고, 설치본을 쓰려면 `npm unlink -g corral` 하거나 PATH 순서를 바꾼다.

## 동작

- `corral open` — 설치본 CLI 는 같은 번들의 앱(`/Applications/corral.app/Contents/MacOS/corral`)을 띄운다. 레포·`node_modules` 를 보지 않는다.
  레포 빌드 CLI(`node app/cli/corral.mjs open`)는 종전대로 레포 Electron 을 띄운다.
- userData 는 기존 레포 실행과 같은 `~/Library/Application Support/corral` — 이주 없음.
- 에이전트 세션(Claude Code 등) 안에서 `corral open` 해도 세션 마커(`CLAUDECODE`·`CLAUDE_CODE_*` …)는 앱·herdr 서버로 넘어가지 않는다.
- **herdr 는 앱에 들어 있다** (`Contents/Resources/backend/herdr`, LIFE-556). 앱이 그 바이너리로 herdr 서버를 스스로 띄우고 GUI 와 CLI 의
  `terminal`·`orchestration` 이 같은 서버(그 `default` 세션)를 쓴다 — `CORRAL_BACKEND_SOCKET`·`CORRAL_SESSION`·`profile.json` 을 손댈 필요가 없다.
  명시 바인딩(env·`profile.json` 의 `backend`)이 있으면 종전대로 그것이 먼저다.
  설치본은 그 `default` 세션 하나에 고정된다 — 동봉 herdr 에 다른 이름 세션이 돌고 있어도 GUI·CLI 는 그쪽으로 옮겨 가지 않는다.
  - 설정·상태·세션·소켓 폴더는 `~/.config/corral-herdr`·`~/.local/state/corral-herdr` 다 — 따로 설치한 herdr(`~/.config/herdr`)와 나뉜다.
  - herdr 가 만드는 git worktree 의 기본 위치는 `~/.corral-herdr/worktrees` 다 — 따로 설치한 herdr 의 `~/.herdr/worktrees` 와 나뉜다.
  - 동봉 herdr 는 PATH 에 `herdr` 로 올라가지 않고(shim 폴더 `bin/` 과 다른 `backend/` 에 있다), 스스로 업데이트하지 않는다(앱을 새로 설치해 올린다).
  - 앱을 닫아도 herdr 서버는 남는다(터미널 영속). 앱이 꺼진 상태에서 CLI `terminal`·`orchestration` 은 런타임이 없어 동작하지 않는다.
- **전환 안내 (brew herdr 를 쓰던 경우)**: 설치본은 따로 설치한 herdr 의 `default` 세션에 더 붙지 않는다 — 거기 열려 있던 터미널은
  넘어오지 않으니 한 번 다시 연다. brew herdr 는 corral 에 더 필요 없으므로 지워도 된다(`brew uninstall herdr`). 그 서버가 돌고 있으면 먼저 `herdr server stop`.
- **Apache-2.0 고지**: 동봉 herdr 의 라이선스 사본과 상류·수정 사실 고지는 `/Applications/corral.app/Contents/Resources/backend/` 의
  `LICENSE-herdr`·`NOTICE-herdr.md` 에 있다. 의존 crate 고지는 공개 배포를 다시 열 때 다룬다(LIFE-446 T3 취소).

## 지우기

메뉴 **Uninstall 'corral' Command…** 로 심링크를 지운 뒤 앱을 지운다. 동봉 herdr 서버가 남아 있으면 앱을 지우기 전에 끈다.

```sh
/Applications/corral.app/Contents/Resources/backend/herdr server stop   # 동봉 서버 (pane 프로세스가 끝난다)
rm -rf /Applications/corral.app
```

userData(`~/Library/Application Support/corral`)와 동봉 herdr 폴더(`~/.config/corral-herdr`·`~/.local/state/corral-herdr`), herdr 로 만든 worktree(`~/.corral-herdr/worktrees` — 사용자 작업 트리)는 남는다.
