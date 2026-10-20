#!/bin/zsh
# R6ⓒ 독립 표본 — <초> 동안 약 50ms 마다 ps 표를 떠서, 앱 main(<pid>)의 자식 중 이름이 ps 인 프로세스 pid 를 모은다(고유 개수 출력).
# 사용: zsh ps-children.sh <app main pid> <초>
P=$1; END=$(( $(date +%s) + $2 )); typeset -A seen; n=0
while [ $(date +%s) -lt $END ]; do
  for pid in $(ps -axo pid=,ppid=,comm= | awk -v p="$P" '$2==p && $3 ~ /(^|\/)ps$/ {print $1}'); do seen[$pid]=1; done
  n=$((n+1)); sleep 0.05
done
echo "samples=$n unique_ps_children=${#seen} pids=${(k)seen}"
