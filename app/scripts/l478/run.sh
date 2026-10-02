#!/bin/sh
# LIFE-478 실행 회차 래퍼 — 원장(runs.md)에 시작 시 `실행 중` 행을 적고, 끝나면 그 행의 종료코드·통과/실패를 채운다.
# 전후 부하(pgrep -x yes · uptime)를 load.md 에 덧붙인다(G6). 실패 회차도 지우지 않는다.
# 사용: sh app/scripts/l478/run.sh <실행 id> <기준 항목> <원자료 경로(repo 기준)> <기대 종료코드> -- <명령...>
set -u
id=$1; crit=$2; raw=$3; want=$4; shift 5
root=$(git rev-parse --show-toplevel)
ledger="$root/specs/LIFE-478-sidebar-card-menus/raw/claude/runs.md"
load="$root/specs/LIFE-478-sidebar-card-menus/raw/claude/load.md"
cmd=$(printf '%s ' "$@" | sed 's/ $//')
stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }
printf '\n## %s (%s)\n- 전 %s pgrep -x yes: [%s] uptime: %s\n' "$id" "$crit" "$(stamp)" "$(pgrep -x yes | tr '\n' ' ')" "$(uptime)" >> "$load"
printf '| %s | %s | `%s` | %s | 실행 중 | %s | 실행 중 |\n' "$id" "$crit" "$cmd" "$want" "$raw" >> "$ledger"
mkdir -p "$root/$raw"
( cd "$root" && "$@" ) > "$root/$raw/stdout.log" 2>&1
code=$?
printf -- '- 후 %s pgrep -x yes: [%s] uptime: %s\n' "$(stamp)" "$(pgrep -x yes | tr '\n' ' ')" "$(uptime)" >> "$load"
verdict=실패; [ "$code" = "$want" ] && verdict=통과
python3 - "$ledger" "$id" "$code" "$verdict" <<'PY'
import sys
path, rid, code, verdict = sys.argv[1:]
lines = open(path).read().split('\n')
for i in range(len(lines) - 1, -1, -1):
    if lines[i].startswith(f'| {rid} |') and lines[i].endswith('| 실행 중 |'):
        cells = lines[i].split(' | ')
        cells[4] = code
        lines[i] = ' | '.join(cells[:-1]) + f' | {verdict} |'
        break
open(path, 'w').write('\n'.join(lines))
PY
echo "$id exit=$code verdict=$verdict"
exit $code
