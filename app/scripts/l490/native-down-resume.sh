#!/bin/sh
# LIFE-490 K8-D02 — native-down.sh 의 ⑥~⑦(읽기 전용 대조)만 다시 돈다. K8-D01 이 ②~⑤(종료·userData·herdr 복원·전=후 해시)를 통과한 뒤
# ⑥ 에서 전 snapshot 경로(up raw 폴더)를 못 찾아 멈췄다 — 복원은 다시 하지 않는다. 아래 본문은 native-down.sh ⑥~⑦ 그대로(PRED = up raw 폴더).
# 사용: sh native-down-resume.sh <ROOT> <raw 폴더> <up raw 폴더>
set -u
ROOT=$1; RAWD=$2; PRED=$3
HERE=$(cd "$(dirname "$0")/../l470" && pwd)
NODE="$HOME/.nvm/versions/node/v24.14.1/bin/node"
. "$(dirname "$0")/path-check.sh"
l490_real_dir "$ROOT" /tmp/l490n || { echo "✘ ROOT 는 /tmp/l490n 아래 정규형 실제 폴더만: $ROOT"; exit 2; }
fail() { echo "✘ $1"; echo "판정: 원복 대조 실패 — 멈췄다. 백업 $ROOT/backup·원자료 $RAWD 그대로"; exit 1; }
pass() { echo "✔ $1"; }
mkdir -p "$RAWD"
echo "# ⑥ codex config·provider 설정 대조 — **쓰지 않는다**(LIFE-511 r1 R1-06: 이 작업은 codex 를 띄우지 않는다, 킥오프 격리 3 읽기 전용)"
# l497 은 codex 를 시험 대상으로 띄워서 그 회차가 고친 config 를 되돌렸다. 여기서는 바뀌었으면 원인이 이 회차 밖(사용자·다른 세션)이라
# 되쓰면 남의 변경을 지운다 — 차이만 원자료로 남기고 실패로 보고한다. 백업은 비교용 사본일 뿐이다.
if [ -f "$ROOT/backup/codex-config.toml" ]; then
  if cmp -s "$ROOT/backup/codex-config.toml" "$HOME/.codex/config.toml"; then pass "codex config 그대로(쓰지 않음)"
  else diff "$ROOT/backup/codex-config.toml" "$HOME/.codex/config.toml" > "$RAWD/codex-config-diff.txt"; fail "codex config 가 회차 중 바뀌었다 — 되쓰지 않는다, 보고(차이 → codex-config-diff.txt)"; fi
fi
sh "$HERE/provider-hash.sh" > "$RAWD/provider-post.txt" || fail "provider 해시 읽기 실패"
cmp -s "$PRED/provider-pre.txt" "$RAWD/provider-post.txt" && pass "provider $(wc -l < "$RAWD/provider-post.txt" | tr -d ' ')파일 해시 전=후" || { diff "$PRED/provider-pre.txt" "$RAWD/provider-post.txt"; fail "provider 해시가 바뀌었다 — 되쓰지 않는다, 보고"; }

echo "# ⑥-b G6(q1 범위) — 읽기만이었다(corral settings.json 은 ④ 바이트 복원), 해시 전=후"
# fix1 R1-01 — 경로 합집합 대조·수집기 실패·빈/손상 snapshot 실패(g6-compare.mjs)
"$NODE" "$(dirname "$0")/g6-compare.mjs" "$PRED/g6-pre.txt" "$RAWD/g6-post.txt" > "$RAWD/g6-compare.txt"; G6RC=$?
cat "$RAWD/g6-compare.txt"
[ "$G6RC" -eq 0 ] && pass "G6 엄격 범위 전=후(g6-compare.mjs)" || fail "G6 대조 실패(exit $G6RC) — 되쓰지 않는다, 보고"

echo "# ⑥-c grok 런타임 목록 — 대조 아님(q1). 바뀐 줄은 K8ⓑ grok 기동의 자체 기록으로 RESULT 에"
sh "$(dirname "$0")/grok-runtime.sh" > "$RAWD/grok-runtime-post.txt"
diff "$PRED/grok-runtime-pre.txt" "$RAWD/grok-runtime-post.txt" > "$RAWD/grok-runtime-diff.txt" && echo "grok 런타임 변화 없음" || echo "grok 런타임 변화 $(grep -c '^[<>]' "$RAWD/grok-runtime-diff.txt")줄 → grok-runtime-diff.txt (되쓰지 않는다)"

echo "# ⑦ herdr default · 잔존"
HSTAT=$(/opt/homebrew/bin/herdr session list 2>&1 | awk '$1=="default"{print $2}')
[ "$HSTAT" = stopped ] && pass "herdr default stopped" || fail "herdr default $HSTAT"
ps -Ao pid=,ppid=,etime=,command= | grep -E 'l490|Electron.app/Contents/MacOS/Electron|/opt/homebrew/bin/herdr( --session default)? server$' | grep -v grep | cut -c1-200
echo "판정: 원복 통과"; exit 0
