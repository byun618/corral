for i in 0 1 2 3 4 5 6 7; do
  printf '\033[3%dm fg%d \033[1m bold \033[22m\033[7m rev \033[27m\033[4%d;30m bg%d \033[0m plain\n' "$i" "$i" "$i" "$i"
done
