# LIFE-519 K7 — 잔존 점검(보고만). 실행 K7-1 은 같은 내용을 /tmp/l519t/k7.sh 로 돌렸다(이 파일은 그 사본).
echo "# ps -Ao pid,ppid,etime,command — l519 · 이 빌드 Electron · herdr default · observe.mjs · corral serve"
ps -Ao pid,ppid,etime,command | grep -E 'l519|LIFE-519-socket-chmod-claude/app/node_modules/electron|herdr --session (default|l519)|observe\.mjs|corral\.mjs serve' | grep -v -e grep -e k7.sh -e run.sh
echo "# 고아(PPID 1) 중 위 패턴"
ps -Ao pid=,ppid=,command= | awk '$2==1' | grep -E 'l519|LIFE-519-socket-chmod-claude/app/node_modules/electron|herdr --session (default|l519)|observe\.mjs' | grep -v grep
echo "# /tmp/l519* 아래 남은 소켓"
find /tmp/l519* /private/tmp/l519* -type s 2>/dev/null
echo "# /tmp/l519* 최상위"
ls -d /tmp/l519* 
N=$(ps -Ao pid=,command= | grep -E 'l519w|l519n|LIFE-519-socket-chmod-claude/app/node_modules/electron|herdr --session (default|l519)|observe\.mjs' | grep -v -e grep -e k7.sh -e run.sh | wc -l | tr -d ' ')
echo "프로세스 잔존 $N"; [ "$N" = 0 ]
