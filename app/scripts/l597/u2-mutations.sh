#!/bin/sh
# LIFE-597 U2ⓕ — 관리 밖 술어의 조건(ⓐ 명시 선택 · ⓑ 종류 결속 · ⓒ settle · ⓓ blocked · ⓔ 관리 pane 제외)을 하나씩 빼는 변이마다
# `corral_terminal_takes_an_unmanaged_pane_only_when_asked` 가 실패해야 한다. 대조군(변이 없음)은 통과해야 한다.
#
#   sh app/scripts/l597/u2-mutations.sh <패치를 적용한 herdr-0.9.0 트리> <결과 디렉터리>
#
# 트리는 **버리는 사본**이어야 한다(guard 칸 트리를 주지 않는다 — 원본 corral.rs 를 고쳐 쓰고, 끝에 되돌린다).
# 툴체인은 `herdr:guard` 의 공유 자리(<git-common-dir>/corral-herdr-dev/toolchain)를 쓴다.
set -eu
tree=$1 out=$2
[ -f "$tree/src/app/api/corral.rs" ] || { echo "not a patched herdr tree: $tree" >&2; exit 2; }
case "$tree" in *corral-herdr-dev/*) echo "refusing a guard cell tree — copy it first" >&2; exit 2;; esac
common=$(git rev-parse --path-format=absolute --git-common-dir)
tools="$common/corral-herdr-dev/toolchain"
export CARGO_HOME="$tools/cargo" RUSTUP_HOME="$tools/rustup" PATH="$tools/build-bin:$tools/cargo/bin:$PATH" ZIG="$tools/zig-aarch64-macos-0.15.2/zig"
mkdir -p "$out"
file="$tree/src/app/api/corral.rs"
cp "$file" "$out/corral.rs.orig"
trap 'cp "$out/corral.rs.orig" "$file"' EXIT

cat > "$out/mutate.py" <<'PY'
import sys
# 이름 → (찾을 문자열, 바꿀 문자열). 찾을 문자열은 원본에 정확히 한 번 있어야 한다(없으면 적용 no → 판정 실패).
MUTATIONS = {
    'a-opt-in': ('unmanaged_agent.zip(terminal)', 'unmanaged_agent.or(Some("claude")).zip(terminal)'),
    'b-kind': ('if terminal.effective_known_agent().map(crate::detect::agent_label) != Some(kind) { return Some("unmanaged_kind_mismatch"); }', 'let _ = kind;'),
    'c-settle': ('if !terminal.corral_agent_changed_at.is_some_and(|at| at.elapsed() >= crate::app::AGENT_START_SETTLE_DELAY) { return Some("unmanaged_settling"); }', ''),
    'd-blocked': ('if !matches!(observed.agent_status, AgentStatus::Idle | AgentStatus::Done) || unready.is_some()', 'if unready.is_some()'),
    'e-managed': ('.filter(|(_, terminal)| terminal.managed_agent_kind().is_none())', ''),
}
if sys.argv[1] == 'list':
    print(' '.join(MUTATIONS)); sys.exit(0)
path, name = sys.argv[2], sys.argv[1]
find, replace = MUTATIONS[name]
text = open(path).read()
if text.count(find) != 1:
    print('no'); sys.exit(0)
open(path, 'w').write(text.replace(find, replace)); print('yes')
PY

printf '| 변이 | 적용 | 시험 종료코드 | 기대 | 판정 |\n| --- | --- | --- | --- | --- |\n' > "$out/summary.md"
for name in control $(python3 "$out/mutate.py" list); do
  cp "$out/corral.rs.orig" "$file"
  applied=yes
  [ "$name" = control ] || applied=$(python3 "$out/mutate.py" "$name" "$file")
  set +e
  cargo test --locked --manifest-path "$tree/Cargo.toml" --bin herdr corral_terminal_takes_an_unmanaged_pane_only_when_asked -- --test-threads=1 > "$out/$name.log" 2>&1
  code=$?
  set -e
  if [ "$name" = control ]; then expect=0; ok=$([ $code -eq 0 ] && echo 통과 || echo 실패); else expect='≠0'; ok=$([ "$applied" = yes ] && [ $code -ne 0 ] && echo 통과 || echo 실패); fi
  printf '| %s | %s | %s | %s | %s |\n' "$name" "$applied" "$code" "$expect" "$ok" >> "$out/summary.md"
done
cat "$out/summary.md"
grep -q '| 실패 |' "$out/summary.md" && exit 1 || exit 0
