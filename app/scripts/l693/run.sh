#!/bin/zsh
# LIFE-693 g1 회차 하나: 포커스 완충 기동 → g.mjs → 완충 정지 → 격리 확인(로그 지우기 전) → ROOT 정리.
# 사용(app/ 에서): zsh scripts/l693/run.sh <orphan|tabs> <impl|base> <회차 번호> <CDP 포트>
set -u
scenario=$1; build=$2; n=$3; port=$4
app=${0:A:h:h:h}
raw=${app:h}/specs/LIFE-693-confirm-scroll/raw/claude
export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH" TMPDIR=/tmp/l693w
cd $app
ROOT=/tmp/l693q-$scenario-$build-$n
name=g1/$scenario-$build-$n
lsof -nP -iTCP:$port -sTCP:LISTEN >/dev/null && { echo "포트 $port 사용 중"; exit 2; }
rm -rf $ROOT $ROOT-app; mkdir -p $ROOT; chmod 700 $ROOT
sh scripts/l693/refocus.sh $ROOT $raw/g1-refocus.log &
rf=$!
node scripts/l693/g.mjs --scenario $scenario --build $build --root $ROOT --port $port --out $raw/$name.txt
code=$?
touch $ROOT/refocus.stop; wait $rf
{
  echo "## $name · $(date -u +%FT%TZ) · g.mjs exit $code"
  log=$ROOT/ud/corral.ndjson
  if [[ -f $log ]]; then
    echo "input.raw 건수: $(grep -c '"input.raw"' $log)"
    grep '"input.raw"' $log | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const l of s.split("\n").filter(Boolean)){const j=JSON.parse(l);console.log("  ",j.ts,j.type,j.key,"shift="+j.shift,"meta="+j.meta)}})'
  else echo "로그 없음 $log"; fi
  echo "보낸 키(CDP): $(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).keys.join(",")||"(없음)")' $raw/$name/sent-input.json 2>/dev/null)"
  echo "측정 중 창 포커스(windowFocused=true) 건수: $(cat $raw/$name/*.json 2>/dev/null | grep -c '"windowFocused": true') / 측정 $(ls $raw/$name/*.json 2>/dev/null | grep -vc 'wheel\|herdr\|sent\|confirm\|k3b')"
  echo "되돌림(이 회차): $(grep "# refocus stop .* root=$ROOT " $raw/g1-refocus.log | tail -1 | sed 's/.*refocused=//')"
  echo "남은 프로세스(pgrep -fl $ROOT): $(pgrep -fl -- $ROOT | wc -l | tr -d ' ')"
} >> $raw/g1-isolation-check.txt 2>&1
rm -rf $ROOT $ROOT-app
exit $code
