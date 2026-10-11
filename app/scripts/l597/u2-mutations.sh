#!/bin/sh
# LIFE-597 U2ⓕ — 관리 밖 갈래의 조건을 하나씩 빼는 변이마다 시험이 실패해야 한다. 대조군(변이 없음)은 통과해야 한다.
#   Rust(guard 술어): ⓐ 명시 선택 · ⓑ 종류 결속 · ⓒ settle · ⓓ blocked · ⓔ 관리 pane 제외
#                     + 리뷰 r1 추가: f handshake 광고 제거(R1-A1) · g 변화 시각 갱신 제거
#   앱:               h 항상 opt-in(관리 pane 에도 unmanaged_agent) · i handshake 광고를 읽지 않고 늘 안다고 봄(R1-A1)
#
#   sh app/scripts/l597/u2-mutations.sh <패치를 적용한 herdr-0.9.0 트리> <결과 디렉터리>
#
# Rust 트리는 **버리는 사본**이어야 한다(guard 칸 트리 거절). 앱 변이는 이 worktree 의 app/ 파일을 제자리에서 바꾸고 끝에(실패해도) 되돌린다 —
# 끝나면 git diff 가 변이 전과 같은지 확인한다. 툴체인은 `herdr:guard` 의 공유 자리를 쓴다. 앱 시험은 node v24 + 짧은 TMPDIR.
set -eu
tree=$1 out=$2
[ -f "$tree/src/app/api/corral.rs" ] || { echo "not a patched herdr tree: $tree" >&2; exit 2; }
case "$tree" in *corral-herdr-dev/*) echo "refusing a guard cell tree — copy it first" >&2; exit 2;; esac
repo=$(git rev-parse --show-toplevel)
common=$(git rev-parse --path-format=absolute --git-common-dir)
tools="$common/corral-herdr-dev/toolchain"
export CARGO_HOME="$tools/cargo" RUSTUP_HOME="$tools/rustup" PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$tools/build-bin:$tools/cargo/bin:$PATH" ZIG="$tools/zig-aarch64-macos-0.15.2/zig"
export TMPDIR="${TMPDIR_SHORT:-/tmp/l597m}"
mkdir -p "$out" "$TMPDIR"
backup="$TMPDIR/u2-backup"
mkdir -p "$backup"
cp "$tree/src/app/api/corral.rs" "$backup/corral.rs"
cp "$tree/src/app/actions.rs" "$backup/actions.rs"
cp "$repo/app/src/main/mobile/input.ts" "$backup/input.ts"
cp "$repo/app/src/main/adapter/internal/terminal-backend.ts" "$backup/terminal-backend.ts"
restore() {
  cp "$backup/corral.rs" "$tree/src/app/api/corral.rs"
  cp "$backup/actions.rs" "$tree/src/app/actions.rs"
  cp "$backup/input.ts" "$repo/app/src/main/mobile/input.ts"
  cp "$backup/terminal-backend.ts" "$repo/app/src/main/adapter/internal/terminal-backend.ts"
}
trap restore EXIT
git -C "$repo" diff --stat > "$out/git-diff-before.txt"

cat > "$out/mutate.py" <<'PY'
import sys
# 이름 → (층, 파일, 찾을 문자열, 바꿀 문자열). 파일은 rust = 트리 기준, app = 레포 기준. 찾을 문자열이 정확히 한 번 있어야 적용(yes).
MUTATIONS = {
    'a-opt-in': ('rust', 'src/app/api/corral.rs', 'unmanaged_agent.zip(terminal)', 'unmanaged_agent.or(Some("claude")).zip(terminal)'),
    'b-kind': ('rust', 'src/app/api/corral.rs', 'if terminal.effective_known_agent().map(crate::detect::agent_label) != Some(kind) { return Some("unmanaged_kind_mismatch"); }', 'let _ = kind;'),
    'c-settle': ('rust', 'src/app/api/corral.rs', 'if !terminal.corral_agent_changed_at.is_some_and(|at| at.elapsed() >= crate::app::AGENT_START_SETTLE_DELAY) { return Some("unmanaged_settling"); }', ''),
    'd-blocked': ('rust', 'src/app/api/corral.rs', 'if !matches!(observed.agent_status, AgentStatus::Idle | AgentStatus::Done) || unready.is_some()', 'if unready.is_some()'),
    'e-managed': ('rust', 'src/app/api/corral.rs', '.filter(|(_, terminal)| terminal.managed_agent_kind().is_none())', ''),
    'f-handshake': ('rust', 'src/app/api/corral.rs', '"agent_ops": 1, "unmanaged_prompt": 1}}', '"agent_ops": 1}}'),
    'g-timestamp': ('rust', 'src/app/actions.rs', 'terminal.corral_agent_changed_at = Some(now);', ''),
    'h-app-always-opt-in': ('app', 'app/src/main/mobile/input.ts', 'unmanagedAgent: second.unmanaged ? kind : null', 'unmanagedAgent: kind'),
    'i-app-handshake': ('app', 'app/src/main/adapter/internal/terminal-backend.ts', 'this.unmanagedPrompt = response.unmanaged_prompt === 1', 'this.unmanagedPrompt = true'),
}
if sys.argv[1] == 'list':
    print(' '.join(MUTATIONS)); sys.exit(0)
if sys.argv[1] == 'layer':
    print(MUTATIONS[sys.argv[2]][0]); sys.exit(0)
name, tree, repo = sys.argv[1], sys.argv[2], sys.argv[3]
layer, rel, find, replace = MUTATIONS[name]
path = f'{tree if layer == "rust" else repo}/{rel}'
text = open(path).read()
if text.count(find) != 1:
    print('no'); sys.exit(0)
open(path, 'w').write(text.replace(find, replace)); print('yes')
PY

rust_test() { cargo test --locked --manifest-path "$tree/Cargo.toml" --bin herdr corral_terminal_ -- --test-threads=1; }
app_test() { (cd "$repo/app" && npx vitest run src/main/mobile/input.test.ts src/main/adapter/internal/unmanaged-handshake.test.ts); }

printf '| 변이 | 층 | 적용 | 시험 종료코드 | 기대 | 판정 |\n| --- | --- | --- | --- | --- | --- |\n' > "$out/summary.md"
for name in control-rust control-app $(python3 "$out/mutate.py" list); do
  restore
  case "$name" in
    control-rust) layer=rust applied=yes ;;
    control-app) layer=app applied=yes ;;
    *) layer=$(python3 "$out/mutate.py" layer "$name"); applied=$(python3 "$out/mutate.py" "$name" "$tree" "$repo") ;;
  esac
  set +e
  if [ "$layer" = rust ]; then rust_test > "$out/$name.log" 2>&1; else app_test > "$out/$name.log" 2>&1; fi
  code=$?
  set -e
  case "$name" in
    control-*) expect=0; ok=$([ $code -eq 0 ] && echo 통과 || echo 실패) ;;
    *) expect='≠0'; ok=$([ "$applied" = yes ] && [ $code -ne 0 ] && echo 통과 || echo 실패) ;;
  esac
  printf '| %s | %s | %s | %s | %s | %s |\n' "$name" "$layer" "$applied" "$code" "$expect" "$ok" >> "$out/summary.md"
done
restore
git -C "$repo" diff --stat > "$out/git-diff-after.txt"
cmp -s "$out/git-diff-before.txt" "$out/git-diff-after.txt" || { echo "worktree not restored" >&2; exit 3; }
rm -rf "$backup"
cat "$out/summary.md"
grep -q '| 실패 |' "$out/summary.md" && exit 1 || exit 0
