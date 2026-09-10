# ① 로그형 — 색·굵기·반전·밑줄이 섞인 평범한 출력. 알트스크린에 들어가지 않는다.
for i in 0 1 2 3 4 5 6 7; do
  printf '\033[3%dm fg%d \033[1m bold \033[22m\033[7m rev \033[27m\033[4%d;30m bg%d \033[0m\033[4m under\033[24m plain\n' "$i" "$i" "$i" "$i"
done
