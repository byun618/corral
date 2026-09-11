# ④ 티커 — 알트스크린 안에서 같은 자리를 계속 다시 그린다. 출력이 쏟아질 때의 비용(P1)용.
i=0
printf '\033[?1049h\033[2J'
while [ $i -lt 2000 ]; do
  printf '\033[H틱 %04d\n고정 줄 A\n고정 줄 B\n진행 %s\n' "$i" "$(printf '#%.0s' $(seq 1 $((i % 40 + 1))))"
  i=$((i + 1))
  sleep 0.05
done
