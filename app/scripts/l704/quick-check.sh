#!/usr/bin/env bash
# LIFE-704 빠른 확인 — 요구 → 실제 문구 위치 대조표(C1ⓒ·C2ⓕ·C3 문구), 공개 누출 스캔 + 양성 대조(C5ⓓ), diff 범위(C5ⓔ),
# AGENTS.md 줄 수(C5ⓒ), capability-check names·shape(C5ⓐ), l703 doc-check(C5ⓑ) 를 한 번에 돌린다.
# app/scripts/l704/quick-check.sh <원자료 폴더> [--extra <누출 패턴 파일>] [--base <비교 기준, 기본 main>]
#   출력: <폴더>/quick-check.txt (요약) · table.txt(대조표) · leak.txt · range.txt · capcheck-*.txt · l703/doc-check.txt. 하나라도 어긋나면 exit 1.
#   --extra: 한 줄에 하나씩 grep -E 패턴(공개 레포에 적을 수 없는 이름·원문 인용 등). 레포 밖에 둔다. 없으면 요약에 WARN — 이름·원문 인용은 검사하지 않은 것이다.
#   --base: 없는 ref 이거나 diff 가 비면 FAIL — 빈 diff 를 「누출 0·범위 안」 으로 읽지 않는다.
# node 는 v24 이상이 PATH 앞에 있어야 한다(capability-check).
set -uo pipefail
OUT="${1:?원자료 폴더}"; shift; mkdir -p "$OUT" || exit 1; OUT="$(cd "$OUT" && pwd)"
EXTRA=""; BASE=main
while [ $# -gt 0 ]; do
  case "$1" in
    --extra) EXTRA="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"; shift 2 ;;
    --base) BASE="$2"; shift 2 ;;
    *) echo "모르는 인자: $1" >&2; exit 2 ;;
  esac
done
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT" || exit 1
SUM="$OUT/quick-check.txt"; : > "$SUM"
BAD=0
say() { echo "$1" | tee -a "$SUM"; }
bad() { say "FAIL $1"; BAD=$((BAD + 1)); }
if ! git rev-parse -q --verify "$BASE^{commit}" >/dev/null; then
  say "FAIL --base $BASE 가 커밋이 아니다 — 비교 기준 없이는 diff 검사(누출·범위)가 빈 결과로 통과한다"; say "실패 1"; exit 1
fi
say "# l704 quick-check $(date '+%F %T') · HEAD $(git rev-parse --short HEAD) · base $BASE $(git rev-parse --short "$BASE")$(git diff --quiet HEAD -- . && git diff --cached --quiet || echo ' (+작업 트리 변경 — diff 는 커밋 기준)')"

# ── 1. 대조표 — 요구 id · 자리 · 방식(has 고정 문자열 / re 정규식 / not 없어야 함) · 패턴 ──
TC=.agents/skills/task-coordinate/SKILL.md
IM=.agents/skills/task-coordinate/references/implementation.md
RS=.agents/skills/release/SKILL.md
# 자리 → "<파일>\t<시작 정규식>\t<끝 정규식>" (끝은 그 줄을 빼고, 비면 파일 끝)
place() {
  case "$1" in
    L) printf '%s\t\t\n' .agents/learnings/README.md ;;
    AR) printf '%s\t\t\n' docs/adr/README.md ;;
    AT) printf '%s\t\t\n' docs/adr/template.md ;;
    S1) printf '%s\t%s\t%s\n' "$TC" '^## 1\. ' '^## 2\. ' ;;
    S8) printf '%s\t%s\t%s\n' "$TC" '^## 8\. ' '' ;;
    IM3) printf '%s\t%s\t%s\n' "$IM" '^## 3\. ' '^## 4\. ' ;;
    R1) printf '%s\t%s\t%s\n' "$RS" '^## 1\. ' '^## 2\. ' ;;
    R4) printf '%s\t%s\t%s\n' "$RS" '^## 4\. ' '^## 5\. ' ;;
    R2) printf '%s\t%s\t%s\n' "$RS" '^## 2\. ' '^## 3\. ' ;;
    R7) printf '%s\t%s\t%s\n' "$RS" '^## 7\. ' '' ;;
    INST) printf '%s\t%s\t%s\n' app/INSTALL.md '^## 출고' '^## 빌드' ;;
    RS) printf '%s\t\t\n' "$RS" ;;
    AG) printf '%s\t\t\n' AGENTS.md ;;
    AGF) printf '%s\t%s\t%s\n' AGENTS.md '^## 어디를 고치나' '^## 원본 관리' ;;
    AGO) printf '%s\t%s\t%s\n' AGENTS.md '^## 원본 관리' '' ;;
    *) return 1 ;;
  esac
}
# 자리의 줄을 "<줄번호>\t<본문>" 으로
lines_of() {
  local f s e; IFS=$'\t' read -r f s e <<<"$(place "$1")"
  [ -f "$f" ] || return 1
  awk -v s="$s" -v e="$e" '
    s == "" { on = 1 }
    s != "" && !on && $0 ~ s { on = 1; print NR "\t" $0; next }
    on && e != "" && $0 ~ e { exit }
    on { print NR "\t" $0 }' "$f"
}
# 표는 $(cat <<…) 가 아니라 read 로 읽는다 — macOS bash 3.2 는 명령 치환 안 here-doc 의 따옴표·괄호를 짝 맞추려 든다
IFS= read -r -d '' REQ <<'Q' || true
C1a-field-scope	L	has	**Scope:**
C1a-field-learning	L	has	**Learning:**
C1a-field-evidence	L	has	**Evidence:**
C1a-field-disposition	L	has	**Disposition:**
C1a-last-reviewed	L	has	Last reviewed: YYYY-MM-DD
C1a-cap-10-8kb	L	has	주제 10개·8KB
C1a-cap-cleanup-first	L	has	승격·병합·삭제한 뒤에야
C1a-compact-before-write	L	has	쓰기 전에 매번 압축
C1a-90d-per-file	L	has	90일 재검토는 파일 단위
C1a-promote-delete-same-change	L	has	승격하면 같은 변경에서 learnings 항목을 지운다
C1a-no-copy-two-places	L	has	두 곳 이상에 복사하지 않는다
C1a-generalize-no-chronology	L	has	사건 연대기를 쓰지 않는다
C1a-generalize-no-line-numbers	L	has	줄 번호
C1a-dest-one-off	L	re	^\| 그 작업에만 맞는 선호.*\| 저장하지 않는다 \|$
C1a-dest-regression	L	re	^\| 다시 깨지면 안 되는 .*\| 회귀 테스트 \|$
C1a-dest-adr	L	re	^\| 오래 갈 구조.*\| ADR
C1a-dest-rules	L	re	^\| 레포 전체 규칙 \| `\.agents/rules/`
C1a-dest-learnings	L	re	^\| 다시 쓸 만하지만 덜 검증된 .*\| learnings
C1a-dest-skill	L	re	^\| 도구가 이끄는 절차 \| 그 스킬
C1a-first-learnings-second-rules	L	has	같은 실수 첫 번째 = learnings, 두 번째 = rules 승격
C1a-promote-count-misfits	L	has	안 통하는 자리 세기
C1a-promote-scenarios	L	has	시나리오 열거
C1a-read-not-inject	L	has	모든 작업에 주입하지 않는다
C1a-read-title-scope-first	L	has	제목과 `Scope` 를 먼저 훑고
C1a-when-points-to-skills	L	has	제안 = task-coordinate §8 게이트 ②, 채택·승격·재검토 = release §4 회고
C1a-8kb-bytes	L	has	8KB(파일 바이트, `wc -c`
C1a-90d-fix-at-retro	L	has	**고치는 것은 출고 회고다**(release §4)
C1a-public-once	L	has	(`docs/adr/` 도 이 줄을 따른다)
C1b-tpl-title	AT	re	^# <
C1b-tpl-context	AT	re	^## Context and Problem Statement$
C1b-tpl-drivers	AT	re	^## Decision Drivers$
C1b-tpl-options	AT	re	^## Considered Options$
C1b-tpl-outcome	AT	re	^## Decision Outcome$
C1b-tpl-consequences	AT	re	^### Consequences$
C1b-tpl-confirmation	AT	re	^### Confirmation$
C1b-tpl-status	AT	re	^status: proposed
C1b-status-values	AR	has	`proposed` · `accepted` · `rejected` · `deprecated` · `superseded by ADR-NNNN`
C1b-accepted-immutable	AR	has	accepted 뒤에는 본문을 고치지 않는다
C1b-superseded-only	AR	has	`superseded by ADR-NNNN` 으로 바꾼다
C1b-number-at-adoption	AR	has	번호는 채택할 때 매긴다
C1b-when-points-to-skills	AR	has	초안은 게이트 ②(task-coordinate §8)에, 채택은 출고 회고(release §4)에
C1b-public-points	AR	has	공개 레포 주의는 `.agents/learnings/README.md`
C1b-not-restated	AR	not	corral-specs 원자료 경로
C2a-devlog-file	S8	has	**devlog** `devlog.md` (비공개)
C2a-devlog-dated	S8	has	날짜별 절(`## YYYY-MM-DD`)
C2a-view-human-draft	S8	has	**사람**(그날의 결정·승인·지시 원문 — LLM 초안
C2a-view-human-no-guess	S8	has	감정·의도를 추측해 쓰지 않는다
C2a-view-llm	S8	has	**LLM**(시도 → 실패 → 원인 → 해결)
C2a-view-directives	S8	has	**LLM 이 본 지시**(방향을 바꾼 지시, 반복된 지적, 모호했던 지시)
C2a-retro-3lens	S8	has	문제 정의(처음 정의가 맞았나) · 검증 설계(기준·관문이 결함을 잡았나)
C2a-retro-3lens-3	S8	has	방식 개선(다음엔 무엇을 바꾸나)
C2a-sources	S8	has	코디 세션 transcript 와 git log(작업 브랜치·corral-specs)로 대조한다
C2a-sources-reviews	S8	has	`reviews.md` 는 내용 대조에 쓴다 — 시각이 드물어 날짜 축이 되지 못한다
C2a-record-no-guess	S8	has	경로를 짐작하지 않는다(능력 계약 H6)
C2a-record-start	S8	has	시작 기록(`00-start.md`·`raw/start/` 의 기동·주입 응답)
C2a-record-codex	S8	has	Codex 는 날짜 샤드
C2a-record-ambiguous	S8	has	없거나 둘 이상이면 고르지 않고 devlog 에 공백으로 적는다
C2a-oracle	S8	has	매핑의 『세션 기록 오라클』로
C2a-no-full-load	S8	has	기록을 통째로 문맥에 싣지 않는다
C2a-oracle-observation	S8	has	오라클은 관측이라 devlog 사실의 증명이 아니다
C2a-human-gui-h2	S8	has	(H2 — 『화면 관측』으로만 회수된다)
C2a-no-home-path	S8	not	.claude/projects
C2a-compact	S8	has	compact 로 초반이 뭉개진다
C2b-human-before-finish	S8	has	**사람 절 확인은 정리 전에 끝낸다**
C2b-commit-with-step1	S8	has	**게이트 ② 기록·인계 문서·PR 원고를 corral-specs 에 커밋·push 한다**
C2c-not-in-pr	S8	has	PR 에 싣지 않는다. 채택은 출고 회고(release §4)
C2c-learnings-proposal	S8	has	**learnings 제안** `learnings-proposal.md`
C2c-adr-draft	S8	has	**ADR 초안** `adr-draft-<제목-케밥>.md`
C2c-adr-unnumbered	S8	has	번호 없이 `status: proposed`
C2d-worker-log-in-s8	S8	has	`raw/<도구>/worklog.md` 에서 읽는다
C2d-worker-log-rule	IM3	has	`raw/<도구>/worklog.md` 에 덧붙인다
C2d-not-ask-direction	S8	has	코디가 워커에게 묻는 데 쓰지 않는다
C2e-s1-learnings	S1	has	**learnings 를 골라 읽는다**
C2e-s1-title-scope	S1	has	주제 제목과 `Scope` 만 먼저 훑고
C3a-position	R4	has	통합 확인 뒤·릴리즈 노트 전에
C3a-before-ship	R4	has	`ship` 전에 끝낸다
C3b-read-devlog	R4	has	사용자와 같이 읽는다
C3b-adr-accept	R4	has	ADR 초안 채택 — `docs/adr/README.md` 대로 번호·상태를 붙인다
C3b-commit-release	R4	has	release worktree 에서 **비-merge 커밋 하나**
C3b-freeze-exception-r4	R4	has	동결의 예외다(§1)
C3b-freeze-exception-r1	R1	has	**예외는 §4 회고 커밋 하나다**
F1-r1-canonical	R1	has	동결과 그 예외의 원본은 이 줄이고
F1-r2-points	R2	has	직접 고치지 않는다(예외는 §1 — §4 회고 커밋)
F1-agents-points	AG	has	다시 모은다(예외는 release 스킬 §1)
F1-install-points	INST	has	동결의 예외(회고 커밋)는 release 스킬 §1 이 정한다
F1-install-flow	INST	has	③' 회고 — 채택한 learnings·ADR 을 release worktree 에서 커밋(release 스킬 4)
C3b-worked	R4	has	**이전 learnings 가 이번에 작동했나**
C3b-90d	R4	has	재검토(90일·상한) — `.agents/learnings/README.md` 대로
C3b-no-restate-limits	R4	not	쓰기 전 압축
C3b-big-separate	R4	has	별도 LIFE 일감 후보로 적는다
F3-read-proc-misfit	R4	has	`00-analysis.md` 「절차 어긋남」 절
F3-read-method-lens	R4	has	devlog 회고의 「방식 개선」 렌즈
F3-decide-improve	R4	has	**스킬·규칙 개선안**
F6-find-folder	R4	has	head 브랜치 `LIFE-NNN-<슬러그>` = corral-specs 작업 폴더 이름
F6-bundle-children	R4	has	묶음 폴더 `verdict.md` 의 자식 판정 링크
F6-record-commit-after-ship	R4	has	커밋은 출고(§6)가 끝난 뒤 마무리에서
F6-abort	R4	has	「접음 — 다음 출고 회고에서 다시 적용」
F6-r7-commit	R7	has	회고 결정 기록 `retro/vX.Y.Z.md` 가 있으면
C3b-record-one-place	R4	has	corral-specs `retro/vX.Y.Z.md` 한 파일
C3b-no-release-pr-line	R4	has	메시지에 `Release-PR:` 줄을 쓰지 않는다
C3c-no-changelog	RS	not	changelog
C3c-no-old-placeholder	R4	not	지금은 건너뛴다
AG-flow-7	AG	re	^\| 7 .*게이트 ②.*devlog\.md
AG-flow-8	AG	re	^\| 8 출고 — release/vX\.Y\.Z .*회고
AG-fix-learnings	AGF	has	.agents/learnings/<영역>.md
AG-fix-adr	AGF	has	docs/adr/
AG-stub-learnings	AGO	re	rules 스텁.*두 번째에 한 줄씩 — 첫 번째는 \.agents/learnings/
Q
TABLE="$OUT/table.txt"; : > "$TABLE"
printf '%s\t%s\t%s\t%s\n' 결과 요구 자리 위치 >> "$TABLE"
N=0; MISS=0
while IFS=$'\t' read -r id where mode pat; do
  [ -n "$id" ] || continue
  N=$((N + 1))
  f="$(place "$where" | cut -f1)"
  body="$(lines_of "$where")"
  case "$mode" in
    has) hit="$(printf '%s\n' "$body" | grep -F -- "$pat" | head -1)" ;;
    re) hit="$(printf '%s\n' "$body" | cut -f2- | grep -nE -- "$pat" | head -1)"
        [ -n "$hit" ] && hit="$(printf '%s\n' "$body" | sed -n "${hit%%:*}p")" ;;
    not) hit="$(printf '%s\n' "$body" | grep -F -- "$pat" | head -1)" ;;
  esac
  if [ "$mode" = not ]; then
    if [ -z "$hit" ] && [ -n "$body" ]; then printf 'ok\t%s\t%s\t(없음: %s)\n' "$id" "$f" "$pat" >> "$TABLE"
    else printf 'MISSING\t%s\t%s\t남음 %s:%s\n' "$id" "$f" "$f" "${hit%%$'\t'*}" >> "$TABLE"; MISS=$((MISS + 1)); fi
  elif [ -n "$hit" ]; then printf 'ok\t%s\t%s\t%s:%s\n' "$id" "$where" "$f" "${hit%%$'\t'*}" >> "$TABLE"
  else printf 'MISSING\t%s\t%s\t(%s 에 %s 없음)\n' "$id" "$where" "$f" "$pat" >> "$TABLE"; MISS=$((MISS + 1)); fi
done <<<"$REQ"
# 『질의응답』을 코디 → 워커 질문으로 쓰는 줄이 §8 에 없어야 한다(F4) — 그 능력을 부르는 줄은 「쓰지 않는다」와 같은 줄이어야 한다
QA="$(lines_of S8 | grep -F '『질의응답』' | grep -vF '쓰지 않는다' || true)"
N=$((N + 1))
if [ -z "$QA" ]; then printf 'ok\tC2d-qa-direction\tS8\t『질의응답』 줄은 모두 「쓰지 않는다」 줄\n' >> "$TABLE"
else printf 'MISSING\tC2d-qa-direction\tS8\t%s\n' "$QA" >> "$TABLE"; MISS=$((MISS + 1)); fi
# 목적지 분류 표가 정확히 6행인지
DROWS="$(awk '/^## 어디에 둘까/{on=1;next} on&&/^## /{exit} on&&/^\| /' .agents/learnings/README.md | grep -vcE '^\| (배움의 종류|---)')"
N=$((N + 1))
if [ "$DROWS" = 6 ]; then printf 'ok\tC1a-dest-6rows\tL\t목적지 표 6행\n' >> "$TABLE"
else printf 'MISSING\tC1a-dest-6rows\tL\t목적지 표 %s행\n' "$DROWS" >> "$TABLE"; MISS=$((MISS + 1)); fi
say "── 대조표: 요구 $N 줄 · 빠진 줄 $MISS (table.txt)"
[ "$MISS" = 0 ] || { bad "대조표 빠진 줄 $MISS"; grep '^MISSING' "$TABLE" | sed 's/^/  /' | tee -a "$SUM"; }

# ── 2. 공개 누출 스캔 — 이번 diff 의 추가 줄 + 새 공개 폴더 전체 ──
LEAK="$OUT/leak.txt"; : > "$LEAK"
# 괄호 식 안에서 「[」 바로 뒤에 「.」 이 오면 BSD sed 가 대조 기호로 읽는다 — 「[」 를 맨 뒤에 둔다
ere_quote() { sed 's/[]*.^$+?(){}|\\[]/\\&/g'; }
# 패턴은 자기 자신에 걸리지 않게 문자 클래스로 쓴다. 신원 패턴(홈·계정·메일)은 실행 환경에서 만든다 — 이 파일에 적지 않는다
IFS= read -r -d '' PATS <<'P' || true
home-path	/Users/[A-Za-z]
home-tilde	~/[A-Za-z.]
home-var	\$\{?HOME\}?/
specs-raw	corral-specs/LIFE-[0-9]
raw-tool-path	raw/(claude|codex|grok|coordinator|review|start)/[A-Za-z0-9]
uuid	[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}
corral-id	(run|task|ctx|msg)_[0-9a-f]{12}
handle	t1\.ey[A-Za-z0-9_-]{20}
P
PATS="${PATS%$'\n'}"$'\n'"home-env	$(printf '%s' "$HOME" | ere_quote)"
PATS="$PATS"$'\n'"account	(^|[^A-Za-z])$(id -un)([^A-Za-z0-9]|$)"
EM="$(git config user.email || true)"; [ -n "$EM" ] && PATS="$PATS"$'\n'"email	$(printf '%s' "$EM" | ere_quote)"
if [ -n "$EXTRA" ]; then
  n=0; while IFS= read -r p; do [ -n "$p" ] || continue; n=$((n + 1)); PATS="$PATS"$'\n'"extra$n	$p"; done < "$EXTRA"
fi
# 스캔 대상: "<자리>\t<본문>" 줄
targets() {
  git diff -U0 "$BASE...HEAD" | awk '
    /^\+\+\+ b\// { f = substr($0, 7); next }
    /^@@/ { split($3, a, ","); n = substr(a[1], 2) + 0; next }
    /^\+/ && !/^\+\+\+/ { print f ":" n "\t" substr($0, 2); n++ }'
  git ls-files -- .agents/learnings docs/adr | while IFS= read -r f; do awk -v f="$f" '{ print f ":" NR "\t" $0 }' "$f"; done
}
scan() { # $1 = 대상 줄 파일 → 걸린 줄 수를 낸다
  local hits=0 name p
  while IFS=$'\t' read -r name p; do
    [ -n "$name" ] || continue
    [ -n "$p" ] || { echo "  [$name] 빈 패턴 — 전부 걸리므로 거절"; continue; }
    while IFS= read -r h; do
      [ -n "$h" ] || continue
      echo "  [$name] ${h%%$'\t'*}" ; hits=$((hits + 1))
    done < <(cut -f2- -d$'\t' "$1" | grep -nE -- "$p" | cut -d: -f1 | while read -r k; do sed -n "${k}p" "$1"; done)
  done <<<"$PATS"
  return 0
}
targets | sort -u > "$OUT/leak-targets.txt"
say "── 누출 스캔: 대상 $(wc -l < "$OUT/leak-targets.txt" | tr -d ' ')줄(diff 추가 줄 + .agents/learnings·docs/adr 전체) · 패턴 $(printf '%s\n' "$PATS" | grep -c .)개$( [ -n "$EXTRA" ] && echo ' (+--extra)')"
[ -n "$EXTRA" ] || say "WARN --extra 없음 — 사용자 이름·원문 인용은 검사하지 않았다(그 칸은 이 회차로 판정하지 않는다)"
DIFFADD="$(git diff -U0 "$BASE...HEAD" | grep -c '^+[^+]' || true)"
[ "$DIFFADD" -gt 0 ] || bad "diff 추가 줄 0 ($BASE...HEAD) — 비교 기준이 틀렸거나 커밋이 없다"
scan "$OUT/leak-targets.txt" > "$LEAK"
LH="$(grep -c . "$LEAK" || true)"
if [ "$LH" = 0 ]; then say "ok   누출 0건"; else bad "누출 ${LH}건"; sed 's/^/  /' "$LEAK" | tee -a "$SUM"; fi
# 양성 대조 — 패턴마다 심은 표본 한 줄이 잡혀야 한다
PC="$OUT/leak-positive.txt"; : > "$PC"
PCS="$OUT/leak-positive-sample.txt"; : > "$PCS"
add() { printf 'sample:%s\t%s\n' "$1" "$2" >> "$PCS"; }
# 표본은 조각을 이어 만든다 — 이 파일 자체가 공개 레포에 들어가므로 완성된 표본 문자열을 적지 않는다(적으면 1 의 스캔에 자기가 걸린다)
H8=0123abcd
add home-path "see /Users""/someone/x"; add home-tilde "see ~""/repos/x"; add specs-raw "corral-specs/LIFE-""123-x/raw"
add raw-tool-path "raw/claude""/DONE.md"; add uuid "$H8-${H8:0:4}-${H8:4:4}-${H8:0:4}-$H8${H8:0:4}"; add corral-id "ctx_""$H8${H8:0:4}"
add handle "t1.ey""JABCDEFGHIJKLMNOPQRSTUVWXYZ"; add home-env "$HOME""/x"; add home-var "see "'$'"HOME""/x"; add home-var-brace "see "'$'"{HOME}""/x"; add account "by $(id -un) here"
[ -n "$EM" ] && add email "mail $EM"
if [ -n "$EXTRA" ]; then n=0; while IFS= read -r p; do [ -n "$p" ] || continue; n=$((n + 1)); add "extra$n" "$(printf '%s' "$p" | sed 's/\\//g')"; done < "$EXTRA"; fi
scan "$PCS" > "$PC"
MISSPC=0
# 표본 id = 그 표본을 잡아야 할 패턴 이름 — 다른 패턴이 같은 표본을 잡아도 대신 세지 않는다(LIFE-704 r1 지적 4)
while IFS=$'\t' read -r loc _; do
  want="${loc#sample:}"; want="${want%-brace}"
  grep -qF "[$want] $loc" "$PC" || { echo "  양성 대조 놓침: $loc (패턴 $want 가 못 잡음)" | tee -a "$SUM"; MISSPC=$((MISSPC + 1)); }
done < "$PCS"
TOTPC="$(grep -c . "$PCS")"
[ "$MISSPC" = 0 ] && say "ok   양성 대조: 심은 표본 ${TOTPC}개 전부 잡음 (leak-positive.txt)" || bad "양성 대조 놓침 ${MISSPC}/${TOTPC}"

# ── 3. diff 범위 — 00-analysis §5 「넣는다」 안, 제품 코드 무변경 ──
RANGE="$OUT/range.txt"
git diff --stat "$BASE...HEAD" > "$RANGE"
[ -s "$RANGE" ] || bad "diff --stat 이 비었다 ($BASE...HEAD)"
OUTSIDE="$(git diff --name-only "$BASE...HEAD" | grep -vE '^(AGENTS\.md|\.agents/learnings/|docs/adr/|\.agents/skills/task-coordinate/(SKILL\.md|references/implementation\.md)|\.agents/skills/release/SKILL\.md|app/INSTALL\.md|app/scripts/l704/)' || true)"
say "── diff 범위 ($BASE...HEAD): $(tail -1 "$RANGE")"
[ -z "$OUTSIDE" ] && say "ok   범위 안 (제품 코드 app/src·mobile 무변경, app/INSTALL.md 는 r1 F1 정합 줄)" || { bad "범위 밖 파일"; echo "$OUTSIDE" | sed 's/^/  /' | tee -a "$SUM"; }

# ── 4. AGENTS.md 줄 수 ──
L="$(wc -l < AGENTS.md | tr -d ' ')"; [ "$L" -le 200 ] && say "ok   AGENTS.md ${L}줄 ≤ 200" || bad "AGENTS.md ${L}줄"

# ── 5. capability-check names·shape · l703 doc-check ──
for m in names shape; do
  node .agents/harness/capability-check.mjs "$m" > "$OUT/capcheck-$m.txt" 2>&1; rc=$?
  echo "exit $rc" >> "$OUT/capcheck-$m.txt"
  [ "$rc" = 0 ] && say "ok   capability-check $m (exit 0)" || bad "capability-check $m exit $rc"
done
bash app/scripts/l703/doc-check.sh "$OUT/l703" > /dev/null 2>&1; rc=$?
say "     l703 doc-check: ok $(grep -c '^ok' "$OUT/l703/doc-check.txt") · FAIL $(grep -c '^FAIL' "$OUT/l703/doc-check.txt") (exit $rc)"
[ "$rc" = 0 ] || bad "l703 doc-check exit $rc"

say "실패 $BAD"
[ "$BAD" = 0 ]
