i=0
printf '\033[?1049h\033[2J'
while [ $i -lt 400 ]; do
  printf '\033[H\033[2J틱 %03d\n고정 줄 A\n고정 줄 B\n진행 %s\n' "$i" "$(printf '#%.0s' $(seq 1 $((i % 20 + 1))))"
  i=$((i + 1))
  sleep 0.2
done
