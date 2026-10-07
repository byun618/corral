#!/bin/sh
# LIFE-519 fix1 R1-claude-02 양성 대조 — socket-mode 테스트의 「listen 직후 소켓 있음」 단언이 판별력을 갖는지.
# 테스트 사본을 만들고 spy 가 원래 listen 을 부르기 **전에** 관측하게 바꾼다(= bind 가 listen 밖으로 밀린 회귀와 같은 관측: ENOENT 만).
# 그 사본은 새 단언 'listen() must have bound the endpoint' 로 실패해야 한다. 사본은 끝에 지운다(원복).
# 기대: exit 1 이고 출력에 그 단언 메시지가 있다. 사용(app/): sh scripts/l519/r1-02-control.sh
set -u
SRC=src/runtime/socket-mode.test.ts; COPY=src/runtime/socket-mode-r1control.test.ts
trap 'rm -f "$COPY"' EXIT
python3 - "$SRC" "$COPY" <<'PY'
import sys
s = open(sys.argv[1]).read()
old = "    const server = listen.apply(this, args)\n    try { seen.push"
new = "    try { seen.push"
assert old in s
s = s.replace(old, new)
s = s.replace("      return server\n", "      return listen.apply(this, args)\n") if "      return server\n" in s else s.replace("    return server\n", "    return listen.apply(this, args)\n")
open(sys.argv[2], 'w').write(s)
PY
echo "# 바꾼 사본 diff:"; diff "$SRC" "$COPY"
npx vitest run "$COPY" -t 'never shows group or other bits'; RC=$?
echo "# vitest exit $RC"
exit $RC
