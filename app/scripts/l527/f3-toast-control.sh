#!/bin/zsh
# LIFE-527 fix1 F3 음성 대조 — toast-probe 가 F18 을 성공·예외 경로 모두에서 재고 false 면 exit 1 인가. 지문 파일은 임시 파일.
#   f3-toast-control.sh <폴더 이름> orca        — Orca 측정 뒤 정상 종료, 그 사이 임시 파일을 바꾼다 → 기대 exit 1 · verdicts.f18.pass false
#   f3-toast-control.sh <폴더 이름> orca-throw  — Orca 측정 뒤 예외, 임시 파일 그대로 → 기대 exit 1 · verdicts.f18 수집됨(pass true)
cd /Users/byun/repos/byun618/corral/.claude/worktrees/LIFE-527-titlebar-claude
D=specs/LIFE-527-titlebar/raw/claude/fix1/os/$1; mode=$2; K=/tmp/l527-f18ctl/kb-toast.json
mkdir -p $D /tmp/l527-f18ctl && echo '{"a":1}' > $K
$HOME/.nvm/versions/node/v24.14.1/bin/node app/scripts/l527/toast-probe.mjs --out $D --keybindings-file $K --stop-after $mode > $D/stdout.txt 2>&1 &
probe=$!
if [ "$mode" = orca ]; then
  for i in $(seq 1 90); do [ -f $D/orca-dev.log ] && break; /bin/sleep 1; done
  /bin/sleep 5; echo '{"a":2}' > $K
fi
wait $probe; code=$?
echo "toast-probe exit=$code" >> $D/stdout.txt
exit $code
