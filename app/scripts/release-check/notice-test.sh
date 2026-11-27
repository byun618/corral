#!/usr/bin/env bash
# LIFE-729 C9ⓓⓔ 빠른 확인 — 제3자 고지 대조기(app/scripts/verify-notices.mjs · mobile/scripts/verify-notices.mjs)를 픽스처(notice-fixture.mjs)로 케이스별로 돌린다.
# app/scripts/release-check/notice-test.sh <원자료 폴더> [케이스 …]   (케이스 생략 = 전부, 목록은 ALL)
# 케이스마다: 깨끗한 픽스처는 exit 0(음성), 한 건을 빼거나 바꾼 픽스처는 exit 1 + 사유 문구(리터럴)를 단언한다(양성).
# stale-* 는 C9ⓔ — 의존을 올렸는데 고지를 다시 만들지 않은 빌드를 대조기가 멈추는지. wired 는 빌드 경로(package:mac·release-apk.sh)가 대조기를 부르는지.
# eas-archive 는 EAS 아카이브(.easignore — gitignore 의미, EAS CLI 는 ignore 패키지로 같은 규칙을 쓴다) 안에 APK 고지 훅이 읽는 파일이 다 드는지.
# 양성 대조: L703_MUTANT_SED 를 L703_MUTANT_TARGET(notice-dmg | notice-apk | notice-eas)의 사본에 적용한다(mutate.sh 가 쓴다).
# 임시 폴더는 /tmp/l729n.XXXXXX. 끝나면 지운다. 사용자 gradle 캐시·앱 무접촉(GRADLE_USER_HOME 은 픽스처).
set -uo pipefail

ALL="dmg-clean dmg-drop-asar dmg-drop-map dmg-drop-hash dmg-drop-vendored dmg-unmapped dmg-tie dmg-nomap dmg-nores dmg-unres dmg-rebased dmg-drop-crate dmg-drop-sym dmg-nosym
dmg-drop-std dmg-drop-cppns dmg-drop-native dmg-electron dmg-drop-chromium dmg-nofw dmg-notext dmg-txthead dmg-filesha dmg-stale dmg-nolist
apk-clean apk-class apk-noclass apk-drop-libcxx apk-so apk-appmodules apk-packagelist apk-version apk-asset apk-drop-font apk-drop-npm apk-tie apk-nowork apk-nomapfile
apk-emptymap apk-nores apk-unres apk-rebased apk-notext apk-reason apk-txthead apk-nocache apk-stale apk-nonotice wired eas-archive"
OUT="${1:?원자료 폴더}"; shift
CASES="${*:-$ALL}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
mkdir -p "$OUT" || exit 1
OUT="$(cd "$OUT" && pwd)"
WORK="$(mktemp -d /tmp/l729n.XXXXXX)" || { echo "mktemp 실패" >&2; exit 1; }
trap 'rm -rf "$WORK"' EXIT
SUMMARY="$OUT/summary.txt"; : > "$SUMMARY"
# 대조기 사본 — 변이는 사본에만. mobile 대조기는 ../../app/scripts/notices-lib.mjs 를 읽으므로 같은 꼴로 둔다
S="$WORK/src"; mkdir -p "$S/app/scripts" "$S/mobile/scripts"
cp "$ROOT/app/scripts/notices-lib.mjs" "$ROOT/app/scripts/verify-notices.mjs" "$S/app/scripts/"
cp "$ROOT/mobile/scripts/verify-notices.mjs" "$S/mobile/scripts/"
cp "$ROOT/.easignore" "$S/.easignore"
MUT_SED="${L703_MUTANT_SED:-}"
case "${L703_MUTANT_TARGET:-}" in
  notice-dmg) [ -n "$MUT_SED" ] && sed "$MUT_SED" "$ROOT/app/scripts/verify-notices.mjs" > "$S/app/scripts/verify-notices.mjs" ;;
  notice-apk) [ -n "$MUT_SED" ] && sed "$MUT_SED" "$ROOT/mobile/scripts/verify-notices.mjs" > "$S/mobile/scripts/verify-notices.mjs" ;;
  notice-eas) [ -n "$MUT_SED" ] && sed "$MUT_SED" "$ROOT/.easignore" > "$S/.easignore" ;;
esac
echo "# notice-test $(date '+%F %T') · node $(node -v) · app verify sha1 $(shasum < "$ROOT/app/scripts/verify-notices.mjs" | cut -c1-12) · apk verify sha1 $(shasum < "$ROOT/mobile/scripts/verify-notices.mjs" | cut -c1-12)${L703_MUTANT:+ · 변이 $L703_MUTANT}" | tee -a "$SUMMARY"

FAILS=0
check() { local d="$1"; shift; if "$@" >/dev/null 2>&1; then echo "  ok   $d" >> "$LOG"; else echo "  FAIL $d" >> "$LOG"; CASE_FAIL=1; fi; }
has() { grep -qF -- "$1" "$LAST"; }
eq() { [ "$1" = "$2" ] || { echo "    기대 '$2' · 실제 '$1'" >> "$LOG"; return 1; }; }
# dmg <변형> — 픽스처를 만들고 대조기 사본을 돌린다. RC·LAST
dmg() { local d="$WORK/$CASE"; node "$HERE/notice-fixture.mjs" dmg "$d" "$1" >> "$LOG" 2>&1 || { echo "  FAIL 픽스처" >> "$LOG"; CASE_FAIL=1; }
  LAST="$OUT/$CASE.out"; node "$S/app/scripts/verify-notices.mjs" "$d/corral.app" --build "$d/build" > "$LAST" 2>&1; RC=$?; }
apk() { local d="$WORK/$CASE" v="$1"; shift; node "$HERE/notice-fixture.mjs" apk "$d" "$v" >> "$LOG" 2>&1 || { echo "  FAIL 픽스처" >> "$LOG"; CASE_FAIL=1; }
  LAST="$OUT/$CASE.out"; GRADLE_USER_HOME="$d/gradle" node "$S/mobile/scripts/verify-notices.mjs" "$d/app.apk" --mobile "$d/mobile" "$@" > "$LAST" 2>&1; RC=$?; }
W_() { echo "--work $WORK/$CASE/work"; }
ok0() { check "exit 0" eq "$RC" 0; check "통과 줄" has "✔ 고지 대조 통과"; }
bad1() { check "exit 1" eq "$RC" 1; check "사유: $1" has "$1"; }

for CASE in $CASES; do
  LOG="$OUT/$CASE.log"; : > "$LOG"; CASE_FAIL=0; RC=-
  case "$CASE" in
    dmg-clean) dmg clean; ok0 ;;
    dmg-drop-asar) dmg drop:foo; bad1 "✖ npm 고지 누락: foo@1.0.0 (asar:node_modules/foo/package.json)" ;;
    dmg-drop-map) dmg drop:baz; bad1 "✖ npm 고지 누락: baz@2.0.0 (sourcemap:out/main/index.js)" ;;
    dmg-drop-hash) dmg drop:bar; bad1 "✖ npm 고지 누락: bar@3.0.0 (hash:out/renderer/assets/a.woff2)" ;;
    dmg-drop-vendored) dmg "drop:Geist (font)"; bad1 "✖ 반입 자산 고지가 없다: Geist (font) (out/renderer/assets/g.woff2)" ;;
    dmg-unmapped) dmg unmapped; bad1 "✖ 출처를 못 찾은 번들 파일: out/renderer/assets/mystery.bin" ;;
    dmg-tie) dmg tie; bad1 "✖ 빌드 트리의 out/main/index.js 가 앱 안 파일과 다르다" ;;
    dmg-nomap) dmg nomap; bad1 "✖ 소스맵 sources 를 하나도 못 읽었다" ;;
    dmg-nores) dmg nores; bad1 "✖ 소스맵 sources 1 중 npm 패키지로 해석된 것이 0" ;;
    dmg-unres) dmg unres; bad1 "✖ 소스맵 sources 의 npm 패키지(package.json)를 못 찾았다 1건 — 예: out/main/index.js: ../../node_modules/ghost/index.js" ;;
    dmg-rebased) dmg rebased; ok0; check "조상 폴더 해석 보고" has "· 맵 위치 기준이 어긋나 빌드 트리 조상 폴더에서 실제 파일로 찾은 sources 1"; check "baz 를 소스맵으로 봄" has "npm 해석 1)" ;;
    dmg-drop-crate) dmg drop:tokio; bad1 "✖ crate 고지 누락: tokio@1.2.3 (herdr 문자열의 소스 경로)" ;;
    dmg-drop-sym) dmg drop:serde; bad1 "✖ crate 고지 누락: serde (herdr 심볼)" ;;
    dmg-nosym) dmg nosym; bad1 "✖ herdr 에서 crate 표지(심볼·소스 경로)를 못 읽었다" ;;
    dmg-drop-std) dmg "drop:Rust standard library"; bad1 "✖ Rust 표준 라이브러리 고지 누락 (심볼 core)" ;;
    dmg-drop-cppns) dmg drop:simdutf; bad1 "✖ 비-Rust 고지 누락: simdutf (herdr 심볼 simdutf::)" ;;
    dmg-drop-native) dmg "drop:libghostty-vt (Ghostty)"; bad1 "✖ 비-Rust 고지 누락: libghostty-vt (Ghostty) (herdr 심볼)" ;;
    dmg-electron) dmg electron; bad1 "✖ Electron 고지 누락·버전 다름: Electron Framework 44.3.0" ;;
    dmg-drop-chromium) dmg "drop:Chromium and its third-party components (in Electron)"; bad1 "✖ Chromium 고지 누락·버전 다름: 44.3.0" ;;
    dmg-nofw) dmg nofw; bad1 "✖ Electron Framework 가 없다" ;;
    dmg-notext) dmg notext; bad1 "✖ 원문 없음: npm bar@3.0.0" ;;
    dmg-txthead) dmg txthead; bad1 "✖ THIRD-PARTY-NOTICES.txt 에 머리줄이 없다: Electron 44.3.0" ;;
    dmg-filesha) dmg filesha; bad1 "✖ 고지 원문 파일이 목록의 sha256 과 다르거나 없다: electron/LICENSES.chromium.html" ;;
    dmg-stale) dmg stale; bad1 "✖ npm 고지 누락: foo@1.1.0 (asar:node_modules/foo/package.json)" ;;
    dmg-nolist) dmg clean; rm "$WORK/$CASE/corral.app/Contents/Resources/licenses/third-party/third-party.json"
      node "$S/app/scripts/verify-notices.mjs" "$WORK/$CASE/corral.app" --build "$WORK/$CASE/build" > "$LAST" 2>&1; RC=$?; bad1 "✖ 고지 목록이 없다" ;;
    apk-clean) apk clean $(W_); ok0 ;;
    apk-class) apk class $(W_); bad1 "✖ 주인을 못 찾은 dex 클래스: org.unknown.* 1개" ;;
    apk-noclass) apk noclass $(W_); bad1 "✖ dex 클래스·고지 아티팩트를 하나도 못 읽었다" ;;
    apk-drop-libcxx) apk "drop:LLVM libc++ (Android NDK libc++_shared.so)" $(W_); bad1 "✖ NDK libc++ 고지 누락 (lib/arm64-v8a/libc++_shared.so)" ;;
    apk-so) apk so $(W_); bad1 "✖ 주인을 못 찾은 네이티브 라이브러리: lib/arm64-v8a/libmystery.so" ;;
    apk-appmodules) apk appmodules $(W_); bad1 "✖ 네이티브 라이브러리 주인이 고지에 없다: react-native (lib/arm64-v8a/libappmodules.so)" ;;
    apk-packagelist) apk packagelist $(W_); bad1 "✖ 클래스 주인이 고지에 없다: react-native (com/facebook/react/PackageList)" ;;
    apk-version) apk drop:com.example:lib $(W_); bad1 "✖ maven 고지 누락·버전 다름: com.example:lib@1.0 (META-INF/com.example_lib.version)" ;;
    apk-asset) apk asset $(W_); bad1 "✖ 주인을 못 찾은 asset: assets/mystery.dat" ;;
    apk-drop-font) apk "drop:Geist (font)" $(W_); bad1 "✖ asset 주인이 고지에 없다: Geist (font) (assets/fonts/Geist_400Regular.ttf)" ;;
    apk-drop-npm) apk drop:jsdep $(W_); bad1 "✖ npm 고지 누락: jsdep@1.0.0 (JS 번들 소스맵)" ;;
    apk-tie) apk tie $(W_); bad1 "✖ 작업 폴더의 번들이 APK 의 assets/index.android.bundle 과 다르다" ;;
    apk-nowork) apk clean; bad1 "✖ JS 번들 대조에 --work(EAS 작업 폴더)가 필요하다" ;;
    apk-nomapfile) apk nomapfile $(W_); bad1 "✖ 작업 폴더에서 번들·소스맵을 하나씩 찾지 못했다(번들 1 · 소스맵 0)" ;;
    apk-emptymap) apk emptymap $(W_); bad1 "✖ 소스맵 sources 가 비었다" ;;
    apk-nores) apk nores $(W_); bad1 "✖ 소스맵 sources 1 중 npm 패키지로 해석된 것이 0" ;;
    apk-unres) apk unres $(W_); bad1 "✖ 소스맵 sources 의 npm 패키지(package.json)를 못 찾았다 1건 — 예: ../../../../../../../node_modules/ghost/index.js" ;;
    apk-rebased) apk rebased $(W_); ok0; check "조상 폴더 해석 보고" has "· 맵 위치 기준이 어긋나 작업 폴더 조상 폴더에서 실제 파일로 찾은 sources 1"; check "jsdep 를 소스맵으로 봄" has "npm 해석 1)" ;;
    apk-notext) apk notext $(W_); bad1 "✖ 원문도 사유도 없다: maven com.example:closed@2.0" ;;
    apk-reason) apk reason $(W_); ok0; check "사유 보고" has "· 원문 없음(사유 기록): com.example:closed@2.0 — SPDX 로 옮길 수 없는 라이선스" ;;
    apk-txthead) apk txthead $(W_); bad1 "✖ THIRD-PARTY-NOTICES.txt 에 머리줄이 없다: LLVM libc++ (Android NDK libc++_shared.so) NDK 27" ;;
    apk-nocache) apk nocache $(W_); bad1 "✖ 고지된 maven 모듈의 아티팩트가 gradle 캐시에 없다 — 대조 불가: com.example:ghost@9.9" ;;
    apk-stale) apk stale $(W_); bad1 "✖ maven 고지 누락·버전 다름: com.example:lib@1.1 (META-INF/com.example_lib.version)" ;;
    apk-nonotice) apk nonotice $(W_); bad1 "✖ APK 에 고지가 없다" ;;
    wired) # 빌드 경로가 생성기·대조기를 부른다 — package:mac 은 electron-builder 앞에 생성·뒤에 대조, release-apk.sh 는 서명 확인 뒤·작업 폴더 정리 전에 대조
      LAST="$ROOT/app/package.json"; RC=0
      PM="$(sed -n 's/.*"package:mac": "\(.*\)",*$/\1/p' "$ROOT/app/package.json")"
      check "package:mac: 생성 → electron-builder → 대조 순서" eq "$(echo "$PM" | grep -c 'build-notices\.mjs .*electron-builder --mac --arm64 && node scripts/verify-notices\.mjs dist/mac-arm64/corral\.app$')" 1
      check "electron-builder 가 build/notices 를 싣는다" eq "$(grep -c '^  - from: build/notices$' "$ROOT/app/electron-builder.yml")" 1
      check "mobile 빌드 훅이 생성기" eq "$(grep -c '"eas-build-post-install": "node scripts/build-notices.mjs"' "$ROOT/mobile/package.json")" 1
      A="$ROOT/scripts/release-apk.sh"
      check "release-apk.sh 가 대조(실패면 die)" eq "$(grep -c '^node mobile/scripts/verify-notices.mjs "\$APK" --work "\$WORK/build" --mobile "\$ROOT/mobile" || die ' "$A")" 1
      check "대조가 서명 확인 뒤·작업 폴더 정리 전" eq "$(awk '/^\[ "\$CERT" = /{c=NR} /^node mobile\/scripts\/verify-notices/{v=NR} /^if is_own_work "\$WORK"; then rm -rf/{r=NR} END{print (c && v > c && r > v) ? 1 : 0}' "$A")" 1 ;;
    eas-archive) # R3-1 — 훅(eas-build-post-install)은 EAS 가 .easignore 로 만든 아카이브 안에서 돈다. 훅의 import 사슬·런타임 입력이 아카이브에 드는가
      LAST="$OUT/$CASE.out"; RC=0; E="$WORK/$CASE/tree"; mkdir -p "$E"
      # 필요한 파일 = build-notices.mjs 에서 상대 import 를 따라간 사슬 + 그 lib 가 읽는 SPDX 원문 + 훅이 읽는 레포 파일
      node -e '
        const fs = require("fs"), path = require("path"), root = process.argv[1], seen = new Set()
        const go = (rel) => { if (seen.has(rel)) return; seen.add(rel)
          for (const m of fs.readFileSync(path.join(root, rel), "utf8").matchAll(/from \x27(\.{1,2}\/[^\x27]+)\x27/g)) go(path.relative(root, path.resolve(path.dirname(path.join(root, rel)), m[1]))) }
        go("mobile/scripts/build-notices.mjs"); console.log([...seen].join("\n"))' "$ROOT" > "$WORK/$CASE/need.txt" 2>> "$LOG"
      { git -C "$ROOT" ls-files app/scripts/spdx; echo app/package.json; echo mobile/scripts/notices.init.gradle; } >> "$WORK/$CASE/need.txt"
      check "import 사슬이 공용 lib 까지 닿는다" eq "$(grep -cx 'app/scripts/notices-lib.mjs' "$WORK/$CASE/need.txt")" 1
      # 빠져야 하는 대조 경로 — 판정 장치가 실제로 거르는지(양성 대조)
      CTRL="app/src/main/index.ts app/scripts/build-notices.mjs app/scripts/release-check/notice-test.sh mobile/node_modules/x/package.json"
      for f in $(cat "$WORK/$CASE/need.txt") $CTRL; do mkdir -p "$E/$(dirname "$f")"; : > "$E/$f"; done
      cp "$S/.easignore" "$E/.gitignore"
      git -C "$E" init -q && git -C "$E" -c core.excludesFile=/dev/null ls-files --others --exclude-standard > "$WORK/$CASE/in.txt" 2>> "$LOG"
      # EAS 의 두 복사 길 — 기본(requireCommit 없음)은 파일 트리를 규칙으로 걸러 복사(위 --others 꼴), requireCommit 이면 clone 뒤 `ls-files --exclude-from --ignored --cached` 로 지운다(아래)
      git -C "$E" add -Af . && git -C "$E" -c core.excludesFile=/dev/null ls-files --cached --ignored --exclude-from=.gitignore > "$WORK/$CASE/del.txt" 2>> "$LOG"
      : > "$LAST"; MISS=0
      while read -r f; do if grep -qxF -- "$f" "$WORK/$CASE/in.txt" && ! grep -qxF -- "$f" "$WORK/$CASE/del.txt"; then echo "포함 $f" >> "$LAST"; else echo "빠짐 $f" >> "$LAST"; MISS=$((MISS + 1)); fi; done < "$WORK/$CASE/need.txt"
      LEAK=0; for f in $CTRL; do { grep -qxF -- "$f" "$WORK/$CASE/in.txt" || ! grep -qxF -- "$f" "$WORK/$CASE/del.txt"; } && { echo "새는 대조 경로 $f" >> "$LAST"; LEAK=$((LEAK + 1)); }; done
      check "훅 입력이 아카이브에서 빠지지 않는다($(grep -c '' "$WORK/$CASE/need.txt")개, 두 복사 길)" eq "$MISS" 0
      check "대조 경로는 빠진다(판정 장치 양성, 두 복사 길)" eq "$LEAK" 0 ;;
    *) echo "모르는 케이스 $CASE" >&2; exit 64 ;;
  esac
  if [ "$CASE_FAIL" = 0 ]; then R=PASS; else R=FAIL; FAILS=$((FAILS + 1)); fi
  echo "$CASE $R last-exit=$RC log=$LOG" | tee -a "$SUMMARY"
done
echo "총 실패 케이스 $FAILS" | tee -a "$SUMMARY"
[ "$FAILS" = 0 ]
