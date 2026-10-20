#!/bin/sh
# LIFE-636 G6 — 원자료·코드 diff 에서 토큰·개인 값 검색. 0건이어야 exit 0.
#
# 범주: 토큰 접두사(sk-ant- · JWT eyJ… · xai- 뒤 긴 값) · Bearer 뒤 실제 값 · 사용자 email · 그 밖 email · account_id/user_id/email 칸에 실제 같은 값.
# 사용자 email 은 **소스에 적지 않는다** — 실행 때 `git config user.email` 에서 읽는다(r1 R1-1ⓐ, 스크립트가 자기 자신에 걸리지 않게).
# 스크립트 자신은 diff 검색에서 뺀다(패턴 문자열이 걸리지 않게).
# 양성 대조(r1 R1-1ⓑ): 범주마다 가짜 값을 넣은 임시 파일(/tmp/l636g6.*)을 **같은 검사**에 넣어 범주마다 1건 이상 잡혀야 한다 — 못 잡으면 exit 2.
# 검색 대상 줄 수가 0 이면 exit 3(ⓒ — 아무것도 안 읽고 0건이 되는 길을 막는다). raw 줄·diff 추가 줄을 따로 세어 둘 중 하나라도 0 이면 exit 3,
# 기준 ref 가 commit 이 아니면 exit 5, git diff 실패면 exit 6(r2 R2-1).
# 뺄 모양(사유 = quick-r1/q16): corral 자체 pane handle `t1.eyJ…`(provider 토큰 아님) · 문서 자리표시자 `"..."` · 시험 자리표시자(@example.com · *SECRET*).
# 사용(레포 루트): sh app/scripts/l636/g6-search.sh <기준 commit>
set -u
BASE=${1:?base}
RAW=specs/LIFE-636-statusbar-usage/raw
SELF=app/scripts/l636/g6-search.sh
# 기준 ref 가 commit 이 아니면 바로 실패(r2 R2-1 — 잘못된 ref 면 diff 절반이 말없이 빠졌다).
if ! git rev-parse --verify --quiet "$BASE^{commit}" >/dev/null; then echo "기준 ref 가 commit 이 아님: $BASE — 실패"; exit 5; fi
if [ ! -d "$RAW" ]; then echo "원자료 폴더 없음: $RAW (레포 루트에서 실행) — 실패"; exit 3; fi
USER_EMAIL=$(git config user.email || true)
if [ -z "$USER_EMAIL" ]; then echo "user.email 없음 — 사용자 email 범주를 검사할 수 없다"; exit 4; fi

EMAIL_RE='[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
FIELD_RE='"(account_id|user_id|accountId|userId|email)"[[:space:]]*:[[:space:]]*"[^"<]'

# 정규화: corral handle 을 자리표시자로 바꾸고 `"..."` 자리표시자 줄을 뺀다(내용을 지우지 않고 검색에서만).
normalize() {
  sed -E 's/t1\.eyJ[A-Za-z0-9_.-]+/<corral-handle>/g' | grep -vE '"(account_id|user_id|email)"[[:space:]]*:[[:space:]]*"\.\.\."'
}

# 범주별 건수를 `<범주>=<n>` 줄로. 첫 인자 = 검색할 파일, 둘째 = 보여 줄 예시 수.
scan() {
  file=$1; show=$2
  count() { label=$1; n=$2; echo "$label=$n"; }
  count sk-ant "$(grep -cE -- 'sk-ant-[A-Za-z0-9_-]{8,}' "$file")"
  count jwt "$(grep -cE -- 'eyJ[A-Za-z0-9_-]{16,}' "$file")"
  count xai "$(grep -cE -- 'xai-[A-Za-z0-9]{20,}' "$file")"
  count bearer "$(grep -cE -- 'Bearer [A-Za-z0-9._-]{20,}' "$file")"
  count user-email "$(grep -cF -- "$USER_EMAIL" "$file")"
  count other-email "$(grep -E -- "$EMAIL_RE" "$file" | grep -vF -- "$USER_EMAIL" | grep -vcE '@example\.com|noreply@anthropic\.com|support\.claude\.com')"
  count id-field "$(grep -E -- "$FIELD_RE" "$file" | grep -vcE 'SECRET|example\.com')"
  if [ "$show" -gt 0 ]; then
    grep -nE -- "sk-ant-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{16,}|xai-[A-Za-z0-9]{20,}|Bearer [A-Za-z0-9._-]{20,}|$EMAIL_RE" "$file" | grep -vE '@example\.com|noreply@anthropic\.com|support\.claude\.com' | cut -c1-160 | head -"$show" | sed 's/^/  hit: /'
  fi
}

total() { awk -F= '/^[a-z-]+=[0-9]+$/ { sum += $2 } END { print sum + 0 }'; }

# --- 양성 대조 ---
CONTROL=$(mktemp /tmp/l636g6.control.XXXXXX)
{
  echo 'token sk-ant-oat01-FAKEFAKEFAKEFAKE'
  echo 'jwt eyJhbGciOiJIUzI1NiJ9FAKEFAKEFAKE.e30.x'
  echo 'grok xai-FAKEFAKEFAKEFAKEFAKEFAKE'
  echo 'Authorization: Bearer FAKEFAKEFAKEFAKEFAKEFAKE'
  echo "mail $USER_EMAIL"
  echo 'mail someone.else@corral-control.test'
  echo '{"account_id": "acct-control-1"}'
} | normalize > "$CONTROL"
CONTROL_OUT=$(scan "$CONTROL" 0)
rm -f "$CONTROL"
echo "# 양성 대조 (범주마다 >= 1 이어야 한다)"
echo "$CONTROL_OUT" | sed 's/^/control /'
missed=$(echo "$CONTROL_OUT" | awk -F= '$2 == 0 { print $1 }')
if [ -n "$missed" ]; then echo "양성 대조 실패 — 못 잡은 범주: $missed"; exit 2; fi

# --- 실제 검색 ---
# raw 와 diff 를 따로 모아 따로 센다(r2 R2-1) — diff 가 실패하거나 추가 줄이 0 이면 실패.
TMP=$(mktemp /tmp/l636g6.scan.XXXXXX)
RAWF=$(mktemp /tmp/l636g6.raw.XXXXXX)
DIFFF=$(mktemp /tmp/l636g6.diff.XXXXXX)
cleanup() { rm -f "$TMP" "$RAWF" "$DIFFF"; }
grep -rIn . "$RAW" > "$RAWF"
if ! git diff "$BASE" -- app ":(exclude)$SELF" > "$DIFFF"; then cleanup; echo "git diff 실패 — 실패"; exit 6; fi
RAW_LINES=$(wc -l < "$RAWF" | tr -d ' ')
DIFF_ADDED=$(grep -c '^+' "$DIFFF")
{ cat "$RAWF"; grep '^+' "$DIFFF"; } | normalize > "$TMP"
LINES=$(wc -l < "$TMP" | tr -d ' ')
echo "# 실제 검색 — raw/ 전체 + 기준 이후 app/ diff 추가 줄(이 스크립트 제외)"
echo "raw lines: $RAW_LINES"
echo "diff added lines: $DIFF_ADDED"
echo "lines scanned: $LINES"
if [ "$RAW_LINES" -eq 0 ] || [ "$DIFF_ADDED" -eq 0 ]; then cleanup; echo "raw 또는 diff 추가 줄이 0 — 실패"; exit 3; fi
OUT=$(scan "$TMP" 5)
cleanup
echo "$OUT"
HITS=$(echo "$OUT" | total)
echo "total hits=$HITS"
[ "$HITS" -eq 0 ]
