#!/bin/sh
# LIFE-519 fix1 R1-claude-02 양성 대조 — socket-mode 테스트의 「listen 직후 소켓 있음」 단언이 판별력을 갖는지.
# 테스트 사본을 만들고 spy 가 원래 listen 을 부르기 **전에** 관측하게 바꾼다(= bind 가 listen 밖으로 밀린 회귀와 같은 관측: ENOENT 만).
# 그 사본은 새 단언 'listen() must have bound the endpoint' 로 실패해야 한다. 사본은 끝에 지운다(원복).
# 기대: exit 1(의도한 실패 = vitest exit 1 + 그 단언 메시지). 그 밖은 exit 2. 사용(app/): sh scripts/l519/r1-02-control.sh
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
LOG="${TMPDIR:-/tmp}/l519-r102.$$"; trap 'rm -f "$COPY" "$LOG"' EXIT
npx vitest run "$COPY" -t 'never shows group or other bits' > "$LOG" 2>&1; RC=$?
cat "$LOG"
echo "# vitest exit $RC"
# fix2 R2-claude-02 — 종료코드 1 **그리고** 의도한 단언 메시지가 있을 때만 「의도한 실패」(exit 1). 그 밖(통과·메시지 없음·다른 실패)은 exit 2.
if [ "$RC" = 1 ] && grep -qF "listen() must have bound the endpoint" "$LOG"; then echo "# 의도한 실패 — 새 단언이 공허한 관측을 잡았다"; exit 1; fi
echo "# 의도와 다른 결과(vitest exit $RC, 메시지 $(grep -cF 'listen() must have bound the endpoint' "$LOG")건) — 양성 대조 실패"; exit 2
