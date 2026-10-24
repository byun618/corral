#!/bin/zsh
# LIFE-675 g1 회차 하나(l693/run.sh 를 옮김): 포커스 완충 기동 → g.mjs → 완충 정지 → 격리 확인(로그 지우기 전) → ROOT 정리.
# 사용(app/ 에서): zsh scripts/l675/run.sh <impl|base> <회차 번호> <CDP 포트>
set -u
build=$1; n=$2; port=$3
app=${0:A:h:h:h}
raw=${app:h}/specs/LIFE-675-resource-move-hidden/raw/claude
export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH" TMPDIR=/tmp/l675w
cd $app
ROOT=/tmp/l675q-$build-$n
name=g1/$build-$n
lsof -nP -iTCP:$port -sTCP:LISTEN >/dev/null && { echo "포트 $port 사용 중"; exit 2; }
rm -rf $ROOT $ROOT-app; mkdir -p $ROOT; chmod 700 $ROOT
sh scripts/l675/refocus.sh $ROOT $raw/g1-refocus.log &
rf=$!
echo "# GUI 시작 $(date -u +%FT%TZ) · $name · refocus pid $rf" >> $raw/g1-isolation-check.txt
node scripts/l675/g.mjs --build $build --root $ROOT --port $port --out $raw/$name.txt
code=$?
touch $ROOT/refocus.stop; wait $rf
{
  echo "## $name · $(date -u +%FT%TZ) · g.mjs exit $code"
  echo "앱 pid(app.pid): $(cat $ROOT/app.pid 2>/dev/null) · herdr pid: $(cat $ROOT/herdr.pid 2>/dev/null)"
  log=$ROOT/ud/corral.ndjson
  if [[ -f $log ]]; then
    echo "input.raw 건수(키 입력 기록 — 이 관문은 키를 보내지 않는다): $(grep -c '"input.raw"' $log)"
  else echo "로그 없음 $log"; fi
  echo "보낸 입력: $(cat $raw/$name/sent-input.json 2>/dev/null | tr -d '\n ')"
  echo "되돌림(이 회차): $(grep "# refocus stop .* root=$ROOT " $raw/g1-refocus.log | tail -1 | sed 's/.*refocused=//')"
  echo "남은 프로세스(pgrep -fl $ROOT): $(pgrep -fl -- $ROOT | wc -l | tr -d ' ')"
} >> $raw/g1-isolation-check.txt 2>&1
rm -rf $ROOT $ROOT-app
exit $code
