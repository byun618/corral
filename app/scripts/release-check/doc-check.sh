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

# ── 5. release.sh 언급 정합 — 남은 언급 줄 목록(사유는 사람이 보지만, 옛 사용법은 1 에서 이미 막았다) ──
say "── release.sh 언급(참고 — 하위 명령 없이 부르는 사용법은 1 에서 실패로 잡는다)"
git grep -n 'release\.sh' -- . ':!app/scripts/release-check' ':!app/src' ':!scripts/release.sh' | sed 's/^/  /' | tee -a "$R" >/dev/null
say "실패 $BAD"
[ "$BAD" = 0 ]
