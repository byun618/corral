#!/bin/sh
# LIFE-556 B3·B11 패키징 확인 — 빌드한 .app(또는 설치본) 하나를 읽기만 한다.
# 인자: <corral.app 경로> [<grep 금지 문자열>...] — 금지 문자열(빌드 root·레포 경로·홈)이 번들 안 어디에도 없어야 한다.
set -u
app="$1"; shift
res="$app/Contents/Resources"
echo "== 번들 안 동봉 파일"
ls -l "$res/backend" "$res/bin" | sed "s#$HOME#~#g"
echo "== PATH 비노출: shim 폴더(bin/)에는 corral 만"
ls "$res/bin"
[ ! -e "$res/bin/herdr" ] && echo "bin/herdr absent" || echo "bin/herdr PRESENT"
echo "== 동봉 herdr --version · sha256"
"$res/backend/herdr" --version
shasum -a 256 "$res/backend/herdr" | cut -d' ' -f1
echo "== 중첩 바이너리 서명 (codesign -dv)"
codesign -dv "$res/backend/herdr" 2>&1 | grep -E "^(Identifier|Format|Signature|CodeDirectory|TeamIdentifier)" 
echo "== codesign --verify --deep --strict"
codesign --verify --deep --strict "$app"; echo "verify exit $?"
echo "== 고지 파일"
head -3 "$res/backend/LICENSE-herdr" | sed 's/^/  /'
grep -c "herdr-bundle.patch" "$res/backend/NOTICE-herdr.md"
echo "== 금지 문자열 grep (번들 전체, 바이너리 포함)"
for needle in "$@"; do
  n=$(grep -rlaF "$needle" "$app" 2>/dev/null | wc -l | tr -d ' ')
  echo "files containing <needle $(printf %s "$needle" | shasum -a 256 | cut -c1-8)>: $n"
done
