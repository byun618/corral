---
name: release
description: >-
  corral 출고. 사용자가 고른 열린 PR 을 순서대로 머지하고 버전 태그·GitHub Release(릴리즈 노트)·dmg·모바일 APK 를 만든 뒤
  LA 완료 전이·설치 확인(맥 dmg·폰 APK 덮어 설치)까지 한다. 본체 세션(본체 checkout, main)에서 "PR 이거이거 머지하고 빌드하자",
  "출고하자", "릴리즈하자" 같은 요청에 사용한다.
---

# release — 출고 (본체 세션에서 실행)

명령·exit 코드·충돌 해소의 상세는 `app/INSTALL.md` 「출고」가 원본이다. 이 문서는 순서와 릴리즈 노트 작성만 다룬다.
머지·태그·Release 생성은 `scripts/release.sh` 만 한다 — `gh pr merge`·`gh release create` 를 직접 부르지 않는다(실패 복구 안내를 따를 때만 예외).

## 1. 대상 확정

- `gh pr list` 로 대기열을 보이고, 사용자가 고른 PR 과 순서를 그대로 쓴다. 고르지 않았으면 묻는다.
- `scripts/release.sh --prs "<번호…>" --dry-run` — 대상·순서·다음 버전·태그·dmg·APK 계획(APK 전제 점검 결과 포함)을 확인한다. 거절(exit 2 등)이면 멈추고 원문을 보고한다.
- APK 는 **매 출고** 만든다(모바일이 안 바뀐 출고도 — 폰 버전 = 맥 버전). APK 전제(JDK·Android SDK·`eas` 로그인)가 이 맥에 없으면 사용자에게 묻고,
  빼기로 하면 `--skip-apk` — 보고에 「APK 없음」을 적는다. 브랜치 APK 는 dev 빌드, 정식본은 출고 태그 빌드다.

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
- 실패하면 멈추고 원문을 보고한다. exit 코드별 복구(3 충돌 · 7 태그 push · 8 dmg · 9 Release · 10 APK)는 `app/INSTALL.md` 「출고」와 스크립트 메시지를 따른다.
  8·10 은 태그 push 뒤라 출고를 다시 돌리지 않는다 — 메시지의 「dmg 만 다시」(그 뒤 「dmg 뒤 APK」)·「APK 만 다시」 아래 줄을 그대로 붙여 넣는다(`release-apk.sh --from-tag` — 여러 번 다시 돌려도 된다).

## 4. 마무리

1. 머지된 PR 의 일감마다 LA `issue_transition(seq: NNN, toStatusLabel: "완료", resolution: "completed")` — 실제 응답을 확인한다.
   설치를 기다리지 않는다. 부모 checkpoint 는 다른 미완 자식이 없는지 본 뒤 따로 판단한다.
2. dmg 설치(`app/INSTALL.md` 「설치」) → `corral --version` 이 새 버전인지 확인.
3. 폰 APK 덮어 설치 — `adb devices -l` 로 폰 시리얼을 고르고(에뮬레이터가 같이 붙어 있을 수 있다)
   `scripts/release-apk-install.sh --serial <폰 시리얼> --apk app/dist/release/<태그>/corral-mobile-X.Y.Z.apk`.
   스크립트가 설치본 서명과 새 APK 서명을 먼저 대조하고 같을 때만 `adb install -r` 한 뒤 versionName·`lastUpdateTime` 변화를 확인한다.
   **서명이 다르거나 설치본이 없어 멈추면 그대로 보고하고 사용자 판단을 받는다 — 앱을 지우고 다시 까는 길로 가지 않는다**(페어링 토큰·기록이 사라진다).
   폰이 연결돼 있지 않으면 설치를 미루고 그렇다고 보고한다.
4. 남은 로컬 정리가 있으면 `scripts/task-finish.sh <LIFE-NNN-슬러그>`.
5. 보고: 태그·Release URL·머지된 PR·LA 전이 결과·맥 설치 버전·폰 설치 결과(versionName·`lastUpdateTime`)·**APK 경로와 sha256**. 빠진 단계가 있으면 그렇다고 적는다.
