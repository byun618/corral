#!/bin/sh
# LIFE-636 G6 — 원자료·코드 diff 에서 토큰·개인 값 검색. 0건이어야 exit 0.
# 패턴: 토큰 접두사(sk-ant- · JWT eyJ… · xai- 뒤 긴 값) · Bearer 뒤 실제 값 · 사용자 email · 일반 email(시험 자리표시자 example.com 은 뺀다)
#       · account_id/user_id 칸에 실제 같은 값(<redacted>·시험 자리표시자는 뺀다).
# 사용(레포 루트): sh app/scripts/l636/g6-search.sh <기준 commit>
set -u
BASE=${1:?base}
RAW=specs/LIFE-636-statusbar-usage/raw
TMP=$(mktemp /tmp/l636-g6.XXXXXX)
# 뺄 모양(사유는 quick-r1/q16 실패 회차 분석): corral 자체 pane handle `t1.eyJ…`(provider 토큰 아님 — 코디 raw/start·raw/grok 의 terminal handle)
# · 문서 자리표시자 `"..."`. 둘 다 내용을 지우지 않고 검색에서만 뺀다.
{ grep -rIn . "$RAW" ; git diff "$BASE" -- app | grep '^+' ; } | sed -E 's/t1\.eyJ[A-Za-z0-9_.-]+/<corral-handle>/g' | grep -vE '"(account_id|user_id|email)"[[:space:]]*:[[:space:]]*"\.\.\."' > "$TMP"
hits=0
show() { label=$1; pattern=$2; n=$(grep -cE -- "$pattern" "$TMP"); echo "$label: $n"; grep -nE -- "$pattern" "$TMP" | cut -c1-200 | head -5; hits=$((hits + n)); }
show 'sk-ant- 토큰' 'sk-ant-[A-Za-z0-9_-]{8,}'
show 'JWT(eyJ…)' 'eyJ[A-Za-z0-9_-]{16,}'
show 'xai- 토큰' 'xai-[A-Za-z0-9]{20,}'
show 'Bearer 실제 값' 'Bearer [A-Za-z0-9._-]{20,}'
show '사용자 email' 'byun618@'
# 일반 email — 시험 자리표시자(@example.com)·커밋 꼬리(noreply@anthropic.com)는 뺀다
n=$(grep -E -- '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' "$TMP" | grep -vcE '@example\.com|noreply@anthropic\.com|support\.claude\.com')
echo "그 밖 email: $n"; grep -E -- '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' "$TMP" | grep -vE '@example\.com|noreply@anthropic\.com|support\.claude\.com' | cut -c1-200 | head -5; hits=$((hits + n))
n=$(grep -E -- '"(account_id|user_id|accountId|userId|email)"[[:space:]]*:[[:space:]]*"[^"<]' "$TMP" | grep -vcE 'SECRET|example\.com')
echo "account_id·user_id·email 칸 값: $n"; grep -E -- '"(account_id|user_id|accountId|userId|email)"[[:space:]]*:[[:space:]]*"[^"<]' "$TMP" | grep -vE 'SECRET|example\.com' | cut -c1-200 | head -5; hits=$((hits + n))
echo "lines scanned: $(wc -l < "$TMP" | tr -d ' ')"
rm -f "$TMP"
echo "total hits=$hits"
[ "$hits" -eq 0 ]
