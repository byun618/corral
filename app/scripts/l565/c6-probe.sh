#!/bin/sh
# LIFE-565 C6 — pane 하나의 FORCE_HYPERLINK 관측. app/ 에서: sh scripts/l565/c6-probe.sh "<세션 인자 — 예: --session l565-c6 또는 빈 문자열>" <paneId> <표지>
# ① pane 셸에서 printenv(셸 rc 뒤 실제 값) ② 셸 프로세스 초기 env(ps eww, 토큰 경계) + 같은 명령의 양성 대조(HOME 토큰).
# ②는 herdr 가 띄운 로그인 셸(-zsh)에서 ps 가 env 를 못 낸다(양성 대조 HOME=0, g04b) — 참고로만 남기고 판정은 ①로 한다.
# 판정식 종료코드는 없다 — 출력 「L565C6-<표지> value=[…]」 을 행의 실제 값으로 적는다. 서버 호출은 c6-h.sh(격리 루트) 로만.
set -u
S=$1; P=$2; TAG=$3
H="sh $(pwd -P)/scripts/l565/c6-h.sh"
# shellcheck disable=SC2086
$H $S pane run "$P" "printf 'L565C6-$TAG value=[%s] printenv_rc=' \"\$(printenv FORCE_HYPERLINK)\"; printenv FORCE_HYPERLINK >/dev/null; echo \$?" >/dev/null
sleep 1.5
# shellcheck disable=SC2086
$H $S pane read "$P" --source recent --lines 8 | grep "^L565C6-$TAG value="
# shellcheck disable=SC2086
SP=$($H $S pane process-info --pane "$P" | sed -n 's/.*"shell_pid":\([0-9]*\).*/\1/p')
E=$(ps eww -o command= -p "$SP")
echo "shell_pid=$SP ps_eww: HOME 토큰(양성 대조)=$(printf '%s\n' "$E" | tr ' ' '\n' | grep -c '^HOME=') FORCE_HYPERLINK=1 토큰=$(printf '%s\n' "$E" | tr ' ' '\n' | grep -cx 'FORCE_HYPERLINK=1') FORCE_HYPERLINK 토큰 전체=$(printf '%s\n' "$E" | tr ' ' '\n' | grep -c '^FORCE_HYPERLINK=')"
