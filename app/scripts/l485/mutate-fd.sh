#!/bin/sh
# LIFE-485 fix3 F10 (r3 R3-03) 양성 대조 — spawnServer 의 writeSync 실패 분기에서 `fs.closeSync(fd)` 줄을 지우면
# 그 테스트가 실패해야 한다. 원본은 사본으로 되돌리고 되돌린 해시를 대조한다. 테스트 실패 = exit 1(기대값).
APP=$(cd "$(dirname "$0")/../.." && pwd); F="$APP/src/main/adapter/internal/server.ts"
export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH" TMPDIR=/tmp/l485t
H0=$(shasum -a 256 "$F" | cut -d' ' -f1); cp "$F" /tmp/l485t/server.ts.orig
/usr/bin/python3 - "$F" <<'PY'
import sys; p=sys.argv[1]; s=open(p).read()
a="    // 열었는데 쓰지 못했다 — fd 를 닫고 돌아간다(r2 R2-08).\n    fs.closeSync(fd)\n"
assert s.count(a)==1; open(p,'w').write(s.replace(a,"    // 열었는데 쓰지 못했다 — fd 를 닫고 돌아간다(r2 R2-08).\n"))
PY
echo "## 변이: closeSync 줄 삭제 · diff"; diff /tmp/l485t/server.ts.orig "$F"
(cd "$APP" && npx vitest run src/main/adapter/internal/server.test.ts -t 'writeSync 실패 분기' 2>&1 | grep -E '✓|×|FAIL|Tests |expected' | head -10); RC=$?
(cd "$APP" && npx vitest run src/main/adapter/internal/server.test.ts -t 'writeSync 실패 분기' >/dev/null 2>&1); RC=$?
cp /tmp/l485t/server.ts.orig "$F"
H1=$(shasum -a 256 "$F" | cut -d' ' -f1); echo "## 원복 해시 $H0 → $H1"
[ "$H0" = "$H1" ] || { echo "원복 실패"; exit 3; }
echo "## 변이 상태 vitest exit $RC"; exit $RC
