#!/usr/bin/env bash
# LIFE-672 R7ⓑ — 설치본 corral 로그(corral.ndjson)의 explorer.git `ms` 를 교체 전·후로 비교한다. 읽기만 한다.
# app/scripts/l672/explorer-ms.sh --root <탐색기 root 절대경로> --swap <교체 시각: epoch ms 또는 ISO8601> [--log <ndjson>] [--n 30]
#   교체 전 = swap 이전 마지막 N개, 교체 후 = swap 이후 처음 N개 (같은 root, ok:true 만)
#   기준: 교체 후 중앙값 ≤ 교체 전 중앙값 × 1.5 (01-criteria R7). 어느 쪽이든 N개가 안 되면 「부족」 으로 판정하지 않는다.
# 종료: 0 기준 안 · 1 기준 밖 · 3 표본 부족 · 2 인자·파일 오류
set -euo pipefail
LOG="$HOME/Library/Application Support/corral/corral.ndjson"; ROOT=""; SWAP=""; N=30
while [ $# -gt 0 ]; do
  case "$1" in
    --log) LOG="$2"; shift 2 ;;
    --root) ROOT="$2"; shift 2 ;;
    --swap) SWAP="$2"; shift 2 ;;
    --n) N="$2"; shift 2 ;;
    *) echo "알 수 없는 인자: $1" >&2; exit 2 ;;
  esac
done
[ -n "$ROOT" ] && [ -n "$SWAP" ] || { echo "--root 와 --swap 이 필요하다" >&2; exit 2; }
[ -r "$LOG" ] || { echo "로그를 읽을 수 없다: $LOG" >&2; exit 2; }
exec python3 - "$LOG" "$ROOT" "$SWAP" "$N" <<'PYEOF'
import json, statistics, sys
from datetime import datetime
log, root, swap, n = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
if swap.isdigit():
    swap_ms = int(swap)
else:
    swap_ms = int(datetime.fromisoformat(swap.replace("Z", "+00:00")).timestamp() * 1000)
before, after, bad = [], [], 0
with open(log, encoding="utf-8", errors="replace") as f:
    for line in f:
        if '"explorer.git"' not in line:
            continue
        try:
            e = json.loads(line)
        except ValueError:
            bad += 1
            continue
        if e.get("tag") != "explorer.git" or e.get("root") != root or e.get("ok") is not True or not isinstance(e.get("ms"), (int, float)):
            continue
        (before if e["at"] < swap_ms else after).append((e["at"], e["ms"]))
b = [ms for _, ms in before[-n:]]
a = [ms for _, ms in after[:n]]
def desc(xs):
    if not xs:
        return "0개"
    s = sorted(xs)
    p95 = s[min(len(s) - 1, int(round(0.95 * (len(s) - 1))))]
    return f"{len(xs)}개 · 중앙값 {statistics.median(xs)}ms · p95 {p95}ms · 최소 {s[0]} · 최대 {s[-1]}"
print(f"로그 {log} · root {root} · 교체 {swap} ({swap_ms}) · N {n} · 깨진 줄 {bad}")
print(f"교체 전(마지막 {n}개): {desc(b)}" + (f" · {before[-n:][0][0]}~{before[-1][0]}" if b else ""))
print(f"교체 후(처음 {n}개): {desc(a)}" + (f" · {after[0][0]}~{after[:n][-1][0]}" if a else ""))
if len(b) < n or len(a) < n:
    print(f"판정 안 함 — 표본 부족(전 {len(b)}·후 {len(a)}, 각 {n}개 필요). 탐색기를 더 열어 두고 다시 돌린다")
    sys.exit(3)
mb, ma = statistics.median(b), statistics.median(a)
ok = ma <= mb * 1.5
print(f"기준 교체 후 중앙값 {ma} ≤ 교체 전 {mb} × 1.5 = {mb * 1.5:g} → {'안' if ok else '밖'}")
sys.exit(0 if ok else 1)
PYEOF
