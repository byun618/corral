#!/usr/bin/env bash
# LIFE-703 C10 문서 검사 — 옛 출고 사용법이 남았는지 grep 하고(남은 줄마다 사유), 새 문서의 필수 문구·순서·exit 코드 표 정합을 본다.
# app/scripts/release-check/doc-check.sh <원자료 폴더>   — 출력: <폴더>/doc-check.txt. 하나라도 어긋나면 exit 1
set -uo pipefail
OUT="${1:?원자료 폴더}"; mkdir -p "$OUT" || exit 1; OUT="$(cd "$OUT" && pwd)"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT" || exit 1
R="$OUT/doc-check.txt"; : > "$R"
BAD=0
say() { echo "$1" | tee -a "$R"; }
ok() { say "ok   $1"; }
bad() { say "FAIL $1"; BAD=$((BAD + 1)); }
say "# doc-check $(date '+%F %T') · HEAD $(git rev-parse --short HEAD)$(git diff --quiet HEAD -- . || echo ' (+작업 트리 변경)')"

# ── 1. 옛 사용법 grep — 추적 파일 전부(fixture 는 과거 기록이라 제외, app/scripts/release-check 는 이 검사 문구·하네스 자신이라 제외) ──
# 사유 목록: "경로:패턴" → 사유. 목록에 없는 줄이 나오면 실패
allowed() {
  case "$1" in
    "scripts/release.sh:"*"옛 'release.sh --prs"*) echo "옛 호출을 거절하는 안내 문구 자체" ;;
    ".agents/skills/release/SKILL.md:"*"throwaway \`integration/\` 브랜치를 따로 만들지 않는다"*) echo "출고 통합 확인이 integration/ 를 대체한다는 문장" ;;
    ".agents/rules/corral.md:"*"integration/<이름>-YYYYMMDD"*) echo "AGENTS.md 에서 옮긴 같은 줄(paddock 적용) — 출고 통합 확인은 release worktree 로 옮겼다고 같은 줄에 적음" ;;
    ".paddock/design.md:"*"integration/<이름>-YYYYMMDD"*) echo "paddock 적용 때 그 줄을 어디로 옮겼는지 적은 기록" ;;
    "AGENTS.md:"*"integration/<이름>-YYYYMMDD"*) echo "출고 밖의 통합 확인 몫 — 출고 통합 확인은 release worktree 로 옮겼다고 같은 줄에 적음" ;;
    "app/INSTALL.md:"*"「충돌이 나면 (gather exit 3)」"*|"app/INSTALL.md:"*"**충돌이 나면 (gather exit 3)**"*|"app/INSTALL.md:"*"위 「충돌이 나면」"*) echo "새 흐름의 충돌 절(release worktree 에서 해소)" ;;
    *) return 1 ;;
  esac
}
PAT='release\.sh"? --prs|release\.sh --prs|-B LIFE-NNN-<슬러그> origin/LIFE-NNN|원격 작업 브랜치로 (worktree 를 )?다시 만든다|버전 올림 커밋·태그만|충돌이 나면|integration/|exit 3 복구'
HITS="$(git grep -nE "$PAT" -- . ':!app/scripts/release-check' ':!app/src/renderer/src/fixtures' 2>/dev/null || true)"
say "── 옛 사용법 grep (패턴: $PAT)"
if [ -z "$HITS" ]; then say "  (0줄)"; fi
while IFS= read -r line; do
  [ -n "$line" ] || continue
  if why="$(allowed "$line")"; then say "  남김 — $why: $line"; else bad "옛 사용법이 남았다: $line"; fi
done <<H
$HITS
H
# 양성 대조 — 같은 grep 이 옛 문서에서는 걸리는지(패턴이 실제로 잡는지). 대상은 이 일감 직전 커밋으로 고정한다 — main 은 머지 뒤 새 문서가 되어 대조 구실을 못 한다
CTRL_REV=ab41bd84
CTRL="$(git show "$CTRL_REV:app/INSTALL.md" 2>/dev/null | grep -cE "$PAT" || true)"
[ "${CTRL:-0}" -gt 0 ] && ok "양성 대조: $CTRL_REV 의 app/INSTALL.md 에서 옛 사용법 ${CTRL}줄을 잡는다" || bad "양성 대조 실패: $CTRL_REV 의 INSTALL.md 에서 0줄(패턴 무효 또는 커밋 없음)"

# ── 2. release SKILL — 순서와 회고 자리 ──
S=.agents/skills/release/SKILL.md
order="$(grep -nE '^## [1-7]\. ' "$S" | sed -E 's/^[0-9]+:## //' | tr '\n' '|')"
want="1. 자르기 — 대상·버전 확정|2. 모으기|3. 통합 확인|4. 회고 자리|5. 릴리즈 노트 작성|6. 출고|7. 마무리|"
[ "$order" = "$want" ] && ok "SKILL 순서 $want" || bad "SKILL 순서: $order (기대 $want)"
sed -n '/^## 4\. 회고 자리/,/^## 5\./p' "$S" | grep -q 'LIFE-704' && ok "SKILL 회고 자리에 LIFE-704" || bad "SKILL 회고 자리에 LIFE-704 없음"
sed -n '/^## 3\. 통합 확인/,/^## 4\./p' "$S" | grep -q 'release-vX.Y.Z' && ok "SKILL 통합 확인에 release worktree 실행 방법" || bad "SKILL 통합 확인에 release worktree 없음"
for c in cut gather ship finish abort; do grep -q "release.sh $c" "$S" && ok "SKILL 에 release.sh $c" || bad "SKILL 에 release.sh $c 없음"; done

# ── 3. INSTALL 「출고」 — 새 명령·절·exit 표 ──
I=app/INSTALL.md
SEC="$(sed -n '/^## 출고/,/^## 빌드/p' "$I")"
for w in "scripts/release.sh cut" "scripts/release.sh gather" "scripts/release.sh ship" "scripts/release.sh finish" "scripts/release.sh abort" \
         "충돌이 나면 (gather exit 3)" "출고 중 수정" "간접 머지가 안 될 때" "--leave-open"; do
  echo "$SEC" | grep -qF -- "$w" && ok "INSTALL 「출고」에 $w" || bad "INSTALL 「출고」에 $w 없음"
done
# exit 표 = release.sh 가 쓰는 코드 전부(die 의 끝 숫자 + 기본 1 + 0)
# exit 표 = release.sh 가 쓰는 코드 전부(die 줄 끝의 숫자 + 기본 1 + 0)
USED="$( { echo 0; echo 1; grep -E 'die ' scripts/release.sh | grep -oE '" [0-9]+( +;;)?( +#[^"]*)?$' | grep -oE '^" [0-9]+' | grep -oE '[0-9]+'; } | sort -un | tr '\n' ' ')"
TABLE="$(echo "$SEC" | grep -oE '^\| [0-9]+ \|' | grep -oE '[0-9]+' | sort -un | tr '\n' ' ')"
say "  release.sh 가 쓰는 exit: $USED · INSTALL 표: $TABLE"
[ "$USED" = "$TABLE" ] && ok "exit 표 = 스크립트가 쓰는 코드" || bad "exit 표 불일치 — 스크립트 $USED · 표 $TABLE"
HDR="$(sed -n '/^# 종료코드/,/^# 재실행/p' scripts/release.sh | grep -oE '(^|· |#   )[0-9]+ ' | grep -oE '[0-9]+' | sort -un | tr '\n' ' ')"
[ "$HDR" = "$TABLE" ] && ok "release.sh 머리 주석 종료코드 = INSTALL 표" || bad "머리 주석 $HDR · 표 $TABLE"

# ── 4. AGENTS.md — 흐름 표 8행 · release 브랜치 예외 · main 직접 push(태그만) · 200줄 ──
A=AGENTS.md
L="$(wc -l < "$A" | tr -d ' ')"; [ "$L" -le 200 ] && ok "AGENTS.md ${L}줄 ≤ 200" || bad "AGENTS.md ${L}줄"
grep -qE '^\| 8 머지 뒤 마무리 — .*task-close' "$A" && grep -qF '회고(release §4)' .agents/skills/task-close/SKILL.md && ok "흐름 표 8행 task-close → 출고 방식 슬롯이 release 스킬" || bad "흐름 표 8행"
PR=.agents/rules/corral.md   # 브랜치·출고 규약은 paddock 적용(2026-11-24) 때 AGENTS.md 에서 이리 옮겼다
grep -qF '**release 브랜치 release/vX.Y.Z**' "$PR" && grep -q '한 번에 하나' "$PR" && ok "브랜치 규약 release 예외(1회 수명·한 번에 하나)" || bad "브랜치 규약 release 예외"
grep -q 'main 에 직접 올라가는 것은 release.sh 의 태그뿐' "$PR" && ok "main 직접 push = 태그만" || bad "main 직접 push 문구"
grep -q '출고 통합 확인은 release worktree' "$PR" && ok "integration/ 줄 정리" || bad "integration/ 줄"

# ── 6. Release 올리기(LIFE-729) — README 「받아서 쓰기」 필수 문구·순서 · INSTALL·SKILL 의 올리기 단계 · 안내 문구 = 스크립트 출력 ──
RM="$(sed -n '/^## 받아서 쓰기/,/^## 설치·빌드/p' README.md)"
for w in "releases" "shasum -a 256 -c corral-*-arm64.dmg.sha256" "개인정보 보호 및 보안" "그래도 열기" "xattr -dr com.apple.quarantine /Applications/corral.app" \
         "Install 'corral' Command in PATH" "herdr 는 앱에 들어 있다" "Apple Silicon" "ad-hoc" "공증 없음" "자동 업데이트 없음" \
         "corral-mobile-X.Y.Z.apk" "Tailscale" "paddock" "비공개"; do
  echo "$RM" | grep -qF -- "$w" && ok "README 「받아서 쓰기」에 $w" || bad "README 「받아서 쓰기」에 $w 없음"
done
# 첫 실행 차단은 받은 경로로 가른다(LIFE-729 C5ⓒ — gh 로 받은 파일에 quarantine 없음 관측)
for w in "브라우저로 받았다면 첫 실행을 macOS 가 막는다" '`gh release download` 로 받은 파일에는 이 표시가 붙지 않는다'; do
  echo "$RM" | grep -qF -- "$w" && ok "README 받은 경로별 첫 실행: $w" || bad "README 받은 경로별 첫 실행 문구 없음: $w"
done
GL="$(echo "$RM" | grep -nF '그래도 열기' | head -1 | cut -d: -f1)"; XL="$(echo "$RM" | grep -nF 'xattr -dr' | head -1 | cut -d: -f1)"
[ -n "$GL" ] && [ -n "$XL" ] && [ "$GL" -lt "$XL" ] && ok "README 「그래도 열기」(1순위)가 xattr 보다 앞" || bad "README 「그래도 열기」·xattr 순서 (그래도 열기 ${GL:-없음} · xattr ${XL:-없음})"
# 체크섬 파일 이름 = release-upload.sh 가 만드는 이름(<바이너리>.sha256)
grep -qF '"$WORK/$f.sha256"' scripts/release-upload.sh && ok "체크섬 파일 이름 <바이너리>.sha256 = release-upload.sh" || bad "release-upload.sh 체크섬 파일 이름이 README 와 다르다"
for w in "scripts/release-upload.sh" "올리기만 다시" "--no-apk" "같은 이름·다른 digest" "`--apk` 없이는 아무것도 올리지 않는다" "--apk <경로>"; do
  echo "$SEC" | grep -qF -- "$w" && ok "INSTALL 「출고」에 $w" || bad "INSTALL 「출고」에 $w 없음"
done
for w in "올리기만 다시:" "APK 만 다시 → Release 에 올리기:" "\$APK_RERUN && \$UPLOAD_ALL" "dmg·APK 뒤 Release 에 올리기:"; do
  grep -qF -- "$w" scripts/release.sh && ok "release.sh 안내 문구 $w" || bad "release.sh 안내 문구 $w 없음"
done
grep -qF 'scripts/release-upload.sh --tag vX.Y.Z --dir app/dist/release/vX.Y.Z' "$S" && grep -qF '14(올리기 실패)' "$S" && ok "SKILL 에 올리기 명령 블록·14 복구" || bad "SKILL 에 올리기 명령 블록·14 복구 없음"
# 재시도 APK(R1-1) — 안내 문구 = 스크립트 출력, SKILL 복구 줄
grep -qF '새 APK 는 retry-<시각>/ 에 생긴다' scripts/release.sh && grep -qF '재시도 APK 가 있다(retry-*/)' scripts/release-upload.sh && ok "재시도 APK 안내 = release.sh·release-upload.sh" || bad "재시도 APK 안내 문구가 스크립트에 없다"
grep -qF '`retry-<시각>/` 에 만들었으면 올리기는 아무것도 올리지 않고' "$S" && ok "SKILL 에 재시도 APK 고르기" || bad "SKILL 에 재시도 APK 고르기 없음"
# exit 10 은 APK·올리기를 && 로 묶은 한 줄(리뷰 r2 R2-1) — INSTALL 표·SKILL
echo "$SEC" | grep -qF '「APK 만 다시 → Release 에 올리기」 한 줄' && grep -qF '「APK 만 다시 → Release 에 올리기」 아래 한 줄' "$S" && ok "exit 10 묶은 한 줄 = INSTALL·SKILL" || bad "exit 10 묶은 한 줄 문구가 INSTALL·SKILL 에 없다"

# ── 7. 제3자 고지 위치(LIFE-729 C9ⓕ) — README 「라이선스」·INSTALL 이 적은 자리 = 패키징·생성기가 싣는 자리 ──
RL="$(sed -n '/^## 라이선스/,$p' README.md)"
for w in "corral.app/Contents/Resources/licenses/third-party/THIRD-PARTY-NOTICES.txt" "electron/LICENSES.chromium.html" "assets/licenses/third-party/THIRD-PARTY-NOTICES.txt" "third-party.json"; do
  echo "$RL" | grep -qF -- "$w" && ok "README 「라이선스」에 $w" || bad "README 「라이선스」에 $w 없음"
done
grep -qF '/Applications/corral.app/Contents/Resources/licenses/third-party/' app/INSTALL.md && grep -qF 'scripts/verify-notices.mjs' app/INSTALL.md && ok "INSTALL 에 제3자 고지 위치·대조" || bad "INSTALL 에 제3자 고지 위치·대조 없음"
grep -qF '공개 배포를 다시 열 때 다룬다' app/INSTALL.md && bad "INSTALL 에 옛 「의존 crate 고지는 공개 배포를 다시 열 때 다룬다」 가 남았다" || ok "INSTALL 옛 고지 미룸 문장 없음"
grep -qF '    to: licenses/third-party' app/electron-builder.yml && ok "dmg 고지 자리 = electron-builder.yml(licenses/third-party)" || bad "electron-builder.yml 의 고지 자리가 문서와 다르다"
grep -qF "'app/src/main/assets/licenses/third-party'" mobile/scripts/build-notices.mjs && grep -qF "const NOTICE = 'assets/licenses/third-party/'" mobile/scripts/verify-notices.mjs && ok "APK 고지 자리 = 생성기·대조기(assets/licenses/third-party)" || bad "APK 고지 자리가 생성기·대조기와 문서가 다르다"
grep -qF 'licenses/third-party/THIRD-PARTY-NOTICES.txt' app/scripts/bundle-herdr.mjs && ok "NOTICE-herdr.md 가 crate 고지 자리를 가리킨다" || bad "NOTICE-herdr.md(bundle-herdr.mjs) 가 crate 고지 자리를 가리키지 않는다"

# ── 8. README 보강(LIFE-729 C10) — 절 순서 · 준비물 값 · 「처음 쓰기」 UI 문구 = 렌더러 소스의 실제 문자열 · 스크린샷 ──
L_PRE="$(grep -n '^## 준비물$' README.md | cut -d: -f1)"; L_GET="$(grep -n '^## 받아서 쓰기$' README.md | cut -d: -f1)"; L_FIRST="$(grep -n '^## 처음 쓰기$' README.md | cut -d: -f1)"
[ -n "$L_PRE" ] && [ -n "$L_GET" ] && [ -n "$L_FIRST" ] && [ "$L_PRE" -lt "$L_GET" ] && [ "$L_GET" -lt "$L_FIRST" ] && ok "README 절 순서 준비물 → 받아서 쓰기 → 처음 쓰기" || bad "README 절 순서 (준비물 ${L_PRE:-없음} · 받아서 쓰기 ${L_GET:-없음} · 처음 쓰기 ${L_FIRST:-없음})"
RP="$(sed -n '/^## 준비물$/,/^## 받아서 쓰기$/p' README.md)"
# 최소 macOS = 빌드 산출물 Info.plist 의 LSMinimumSystemVersion(13.0 — 근거는 작업 원자료, 실빌드 값은 최종 관문에서 다시 본다)
for w in "macOS 13 이상" '`LSMinimumSystemVersion`)이 13.0' "macOS 26" "git" "Claude Code" "Codex" "Grok" "따로 설치하고 로그인" "Tailscale"; do
  echo "$RP" | grep -qF -- "$w" && ok "README 「준비물」에 $w" || bad "README 「준비물」에 $w 없음"
done
RF="$(sed -n '/^## 처음 쓰기$/,/^## 설치·빌드$/p' README.md)"
# 「처음 쓰기」 가 인용한 화면 문구 → 그 문구가 든 렌더러 소스(문구가 바뀌면 여기서 걸린다)
while IFS='|' read -r w f; do
  echo "$RF" | grep -qF -- "$w" && grep -qF -- "$w" "$f" && ok "「처음 쓰기」 화면 문구 = $f: $w" || bad "「처음 쓰기」 화면 문구가 README·$f 에 함께 없다: $w"
done <<'UI'
등록된 레포가 없다. 위의 「+」 로 폴더를 고른다.|app/src/renderer/src/components/Sidebar.tsx
프로젝트 추가|app/src/renderer/src/components/ReposSectionHeader.tsx
워크트리 생성|app/src/renderer/src/components/RepoRowActions.tsx
브랜치|app/src/renderer/src/components/CreateWorktreeModal.tsx
새 탭|app/src/renderer/src/components/TerminalChrome.tsx
감지된 agents가 없습니다|app/src/renderer/src/components/TabCreateMenu.tsx
UI
SHOT=docs/images/corral-screenshot.png
grep -qF "]($SHOT)" README.md && [ -f "$SHOT" ] && [ "$(wc -c < "$SHOT")" -le 512000 ] && ok "스크린샷 $SHOT — README 가 가리키고 500KB 이하($(wc -c < "$SHOT" | tr -d ' ') B)" || bad "스크린샷 $SHOT 이 없거나 README 가 안 가리키거나 500KB 초과"

# ── 5. release.sh 언급 정합 — 남은 언급 줄 목록(사유는 사람이 보지만, 옛 사용법은 1 에서 이미 막았다) ──
say "── release.sh 언급(참고 — 하위 명령 없이 부르는 사용법은 1 에서 실패로 잡는다)"
git grep -n 'release\.sh' -- . ':!app/scripts/release-check' ':!app/src' ':!scripts/release.sh' | sed 's/^/  /' | tee -a "$R" >/dev/null
say "실패 $BAD"
[ "$BAD" = 0 ]
