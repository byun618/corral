#!/usr/bin/env bash
# LIFE-672 R8 — 네이티브 관문: release-ff.sh 를 실제 본체 checkout 에 N번(기본 20) 돌려 회차마다 한 줄을 남긴다.
# app/scripts/l672/native-r8.sh --repo <본체 checkout> --out <원자료 폴더> [--n 20] [--base main] [--gap 2]
# 회차 한 줄: index.lock 존재·inode·mtime(전/후) · HEAD · origin/<base> · release-ff 문구 · 종료코드 · 대기 경로 탔는지
# **회차 시작 전에 lock 이 있으면 그 자리에서 멈추고 아무것도 하지 않는다**(release-ff.sh 도 부르지 않는다, 종료 3).
# 이 스크립트에는 lock 을 만들거나 지우는 코드가 없다 — stat 으로 보기만 한다. ff 는 release-ff.sh 가 하고 그 스크립트도 lock 을 지우지 않는다.
# 종료: 0 N회 모두 release-ff 종료 0 · 1 비0 회차 있음 · 3 시작 전 lock 이 있어 멈춤 · 2 인자 오류
set -uo pipefail
REPO=""; OUT=""; N=20; BASE=main; GAP=2
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --n) N="$2"; shift 2 ;;
    --base) BASE="$2"; shift 2 ;;
    --gap) GAP="$2"; shift 2 ;;
    *) echo "알 수 없는 인자: $1" >&2; exit 2 ;;
  esac
done
[ -n "$REPO" ] && [ -n "$OUT" ] || { echo "--repo 와 --out 이 필요하다" >&2; exit 2; }
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
FF="$ROOT/scripts/release-ff.sh"
mkdir -p "$OUT" || exit 2
LOCK="$(git -C "$REPO" rev-parse --path-format=absolute --git-path index.lock)" || { echo "git rev-parse 실패: $REPO" >&2; exit 2; }
LINES="$OUT/runs.tsv"
lockstat() { if [ -e "$LOCK" ]; then stat -f '있음 inode=%i mtime=%m size=%z' "$LOCK" 2>/dev/null || echo "있음(stat 실패)"; else echo "없음"; fi; }
rev() { git -C "$REPO" rev-parse --short "$1" 2>/dev/null || echo "?"; }
echo "# native-r8 $(date '+%F %T') · repo $REPO · lock $LOCK · N $N · base $BASE · release-ff.sh sha1 $(shasum "$FF" | cut -c1-12) · git $(git --version | cut -d' ' -f3)" | tee "$OUT/summary.txt"
printf 'run\t시각\tlock 전\tlock 후\tHEAD 전\tHEAD 후\torigin 후\t종료코드\t대기 경로\t초\t문구\n' > "$LINES"
FAILS=0
for i in $(seq 1 "$N"); do
  before="$(lockstat)"
  if [ "$before" != "없음" ]; then
    printf '%s\t%s\t%s\t-\t-\t-\t-\t-\t-\t-\t멈춤 — 시작 전 lock 이 있다(아무것도 하지 않음)\n' "$i" "$(date '+%T')" "$before" >> "$LINES"
    echo "회차 $i: 시작 전 index.lock 이 있다($before) — 멈춘다. lock 은 건드리지 않았다" | tee -a "$OUT/summary.txt"
    exit 3
  fi
  hb="$(rev HEAD)"; t0="$(python3 -c 'import time; print(time.time())')"
  "$FF" --repo "$REPO" --base "$BASE" > "$OUT/run-$i.txt" 2>&1; rc=$?
  t1="$(python3 -c 'import time; print(time.time())')"
  after="$(lockstat)"
  # 대기 경로 = release-ff 가 lock 을 보고 기다렸거나 ff 를 두 번 이상 시도했다(문구의 「index.lock 대기」 / 「잡혀 있다」)
  waited=아니오; grep -qE 'index\.lock 대기|잡혀 있다' "$OUT/run-$i.txt" && waited=예
  msg="$(grep -v '^$' "$OUT/run-$i.txt" | tr '\t\n' '  ' | cut -c1-300)"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$i" "$(date '+%T')" "$before" "$after" "$hb" "$(rev HEAD)" "$(rev "origin/$BASE")" "$rc" "$waited" \
    "$(python3 -c "print(round($t1 - $t0, 2))")" "$msg" >> "$LINES"
  [ "$rc" = 0 ] || FAILS=$((FAILS + 1))
  [ "$i" = "$N" ] || sleep "$GAP"
done
echo "끝 $(date '+%F %T') · 종료 0 회차 $((N - FAILS))/$N · 대기 경로 $(awk -F'\t' 'NR>1 && $9=="예"' "$LINES" | wc -l | tr -d ' ')회 · 회차 표 $LINES" | tee -a "$OUT/summary.txt"
[ "$FAILS" = 0 ]
