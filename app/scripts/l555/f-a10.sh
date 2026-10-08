#!/bin/sh
# LIFE-555 A10 최종 — lint·check:boundary 를 기준 commit(작업 브랜치 고정점 d981a699) 과 현재 둘 다 돌려 비교한다.
# 기준 쪽은 worktree 를 만들지 않는다: `git archive d981a699 app | tar -x` 로 /tmp 에 풀고 node_modules 는 현재 것을 심링크(같은 lockfile 의 의존성 + electron-builder 추가분).
# 신규 오류 = 현재 lint 오류 중 (파일·규칙·메시지) 키가 기준에 없는 것. 사용: sh f-a10.sh <원자료 폴더>
. "$(dirname "$0")/f-lib.sh"
OUT=$(cd "$1" && pwd -P); BASE=/tmp/l555f-base; REV=d981a6999468f5a42fa530e16fe2036538644640
export PATH="$(dirname "$N"):$PATH"
rm -rf "$BASE"; mkdir -p "$BASE"
# 파이프 끝 $? 로 판정하지 않는다(f13 에서 archive 실패를 tar 의 0 으로 읽었다) — 두 단계로 나눠 각각 받는다
git -C "$APPDIR/.." archive -o "$BASE.tar" "$REV" app; RC=$?; check base_archive "$RC" 0
tar -x -C "$BASE" -f "$BASE.tar"; RC=$?; check base_extract "$RC" 0; rm -f "$BASE.tar"
check base_has_app "$([ -f "$BASE/app/package.json" ] && echo yes)" yes
ln -s "$APPDIR/node_modules" "$BASE/app/node_modules"
lintjson() { (cd "$1" && npx eslint . -f json > "$2" 2> "$2.stderr"); }
lintjson "$BASE/app" "$OUT/a10-lint-base.json"; RB=$?; echo "base eslint exit=$RB"
lintjson "$APPDIR" "$OUT/a10-lint-head.json"; RH=$?; echo "head eslint exit=$RH"
# 파일 키는 실경로 기준 상대 경로 — /tmp 는 /private/tmp 의 링크라 문자열 접두사로 자르면 기준 쪽 키가 어긋난다(f14)
keys() { "$N" -e 'const fs=require("fs"),path=require("path");const r=JSON.parse(fs.readFileSync(process.argv[1]));const root=fs.realpathSync(process.argv[2]);const out=[];for(const f of r)for(const m of f.messages)if(m.severity===2)out.push(`${path.relative(root,fs.realpathSync(f.filePath))}|${m.ruleId}|${m.message}`);console.log(out.sort().join("\n"))' "$1" "$2"; }
keys "$OUT/a10-lint-base.json" "$BASE/app" > "$OUT/a10-lint-base-keys.txt"; keys "$OUT/a10-lint-head.json" "$APPDIR" > "$OUT/a10-lint-head-keys.txt"
echo "base errors=$(grep -c . "$OUT/a10-lint-base-keys.txt") head errors=$(grep -c . "$OUT/a10-lint-head-keys.txt")"
NEW=$(comm -13 "$OUT/a10-lint-base-keys.txt" "$OUT/a10-lint-head-keys.txt"); echo "## 신규 오류"; echo "${NEW:-none}"
check lint_new_errors "$(printf '%s' "$NEW" | grep -c .)" 0
# 양성 대조: 기준 키 목록에서 한 줄을 지운 목록과 비교하면 신규가 0 이 아니어야 한다(비교기가 차이를 잡는다)
FAKE=$(sed '1d' "$OUT/a10-lint-head-keys.txt" | comm -13 - "$OUT/a10-lint-head-keys.txt" | grep -c .)
control lint_new_errors "$FAKE" 0
echo "## check:boundary"
(cd "$BASE/app" && node scripts/check-boundary.mjs > "$OUT/a10-boundary-base.txt" 2>&1); BB=$?; echo "base boundary exit=$BB"
(cd "$APPDIR" && node scripts/check-boundary.mjs > "$OUT/a10-boundary-head.txt" 2>&1); BH=$?; echo "head boundary exit=$BH"
tail -3 "$OUT/a10-boundary-head.txt"
check boundary_head_exit0 "$BH" 0
check boundary_not_worse "$([ "$BH" -le "$BB" ] && echo yes)" yes
rm -rf "$BASE"
echo "fails=$FAILS"; exit $FAILS
