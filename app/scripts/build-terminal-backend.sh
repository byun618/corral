#!/bin/sh
# macOS arm64 proof build. Never installs to PATH or changes an installed herdr.
# CORRAL_BACKEND_PROFILE=release builds the binary corral.app bundles (LIFE-556); the default stays debug.
set -eu
profile="${CORRAL_BACKEND_PROFILE:-debug}"
case "$profile" in debug|release) ;; *) echo "CORRAL_BACKEND_PROFILE must be debug or release" >&2; exit 1 ;; esac
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
work="${CORRAL_BACKEND_BUILD_ROOT:?Set an isolated build directory}"
mkdir -p "$work"
work=$(CDPATH= cd -- "$work" && pwd -P)
# Toolchain and archives may live outside the build root so patch-digest cells share one download (LIFE-561 dev guard).
# Unset keeps the old layout: everything under the build root.
tools="${CORRAL_BACKEND_TOOLCHAIN_ROOT:-$work}"
mkdir -p "$tools"
tools=$(CDPATH= cd -- "$tools" && pwd -P)
export CARGO_HOME="$tools/cargo"
export RUSTUP_HOME="$tools/rustup"
export ZIG_GLOBAL_CACHE_DIR="$tools/zig-cache"
[ "$(uname -sm)" = "Darwin arm64" ] || { echo 'This build recipe is validated on macOS arm64 only' >&2; exit 1; }
[ -d /Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk ] || { echo 'Zig 0.15.2 needs a compatible SDK; this recipe pins local SDK 15.4' >&2; exit 1; }
if [ ! -f "$tools/herdr.tar.gz" ]; then curl -fSL https://codeload.github.com/herdrdev/herdr/tar.gz/refs/tags/v0.9.0 -o "$tools/herdr.tar.gz"; fi
if [ ! -f "$tools/zig.tar.xz" ]; then curl -fSL https://ziglang.org/download/0.15.2/zig-aarch64-macos-0.15.2.tar.xz -o "$tools/zig.tar.xz"; fi
(cd "$tools" && printf '%s\n' '1e83bff4b05834ed8281e16f1680e8f3e58375a94b2e3f2b3d021e28e293ef9a  herdr.tar.gz' '3cc2bab367e185cdfb27501c4b30b1b0653c28d9f73df8dc91488e66ece5fa6b  zig.tar.xz' | shasum -a 256 -c -)
# Patch order is fixed: stream, then guard (both touch pane/terminal runtime), then detect
# (manifests only), then bundle (release-only folder name and update lock — debug behaviour is unchanged),
# then shift-enter (legacy-pane Shift+Enter → CR in pane/terminal.rs, on top of stream+guard — LIFE-571),
# then restore (missing saved cwd → keep the pane without a shell or agent resume, upstream #4400 backport — LIFE-628),
# then claude-bg (the Claude integration hook stays silent in a Claude Code background session — LIFE-795).
# The digest covers all seven so a changed patch set forces a fresh build root.
patch_digest=$(cat "$repo_root/app/backend/herdr-stream.patch" "$repo_root/app/backend/herdr-guard.patch" "$repo_root/app/backend/herdr-detect.patch" "$repo_root/app/backend/herdr-bundle.patch" "$repo_root/app/backend/herdr-shift-enter.patch" "$repo_root/app/backend/herdr-restore.patch" "$repo_root/app/backend/herdr-claude-bg.patch" | shasum -a 256 | cut -d " " -f 1)
if [ ! -d "$work/herdr-0.9.0" ]; then
 tar -xzf "$tools/herdr.tar.gz" -C "$work"
 (cd "$work/herdr-0.9.0" && patch -p1 < "$repo_root/app/backend/herdr-stream.patch" && patch -p1 < "$repo_root/app/backend/herdr-guard.patch" && patch -p1 < "$repo_root/app/backend/herdr-detect.patch" && patch -p1 < "$repo_root/app/backend/herdr-bundle.patch" && patch -p1 < "$repo_root/app/backend/herdr-shift-enter.patch" && patch -p1 < "$repo_root/app/backend/herdr-restore.patch" && patch -p1 < "$repo_root/app/backend/herdr-claude-bg.patch")
 printf "%s\n" "$patch_digest" > "$work/herdr-0.9.0/.corral-patches"
fi
[ "$(cat "$work/herdr-0.9.0/.corral-patches")" = "$patch_digest" ] || { echo "Patch set changed; use a fresh CORRAL_BACKEND_BUILD_ROOT" >&2; exit 1; }
if [ ! -d "$tools/zig-aarch64-macos-0.15.2" ]; then tar -xf "$tools/zig.tar.xz" -C "$tools"; fi
if [ ! -x "$CARGO_HOME/bin/cargo" ]; then
 curl -fSL https://static.rust-lang.org/rustup/dist/aarch64-apple-darwin/rustup-init -o "$tools/rustup-init"
 chmod +x "$tools/rustup-init"
 "$tools/rustup-init" -y --no-modify-path --profile minimal --default-toolchain 1.96.1
fi
mkdir -p "$tools/build-bin"
cat > "$tools/build-bin/xcrun" <<'XCRUN'
#!/bin/sh
if [ "$1" = --sdk ] && [ "$2" = macosx ] && [ "$3" = --show-sdk-path ]; then
 echo /Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk
else
 exec /usr/bin/xcrun "$@"
fi
XCRUN
chmod +x "$tools/build-bin/xcrun"
export PATH="$tools/build-bin:$CARGO_HOME/bin:$PATH"
export ZIG="$tools/zig-aarch64-macos-0.15.2/zig"
started=$(date +%s)
if [ "$profile" = release ]; then
 # 번들에 들어가는 바이너리에 build root 경로(/tmp·CARGO_HOME)가 panic 위치 문자열로 박히지 않게 접두어를 바꾼다(B3).
 remap="--remap-path-prefix=$work=/corral-herdr-build"
 # 툴체인을 따로 둔 호출이면 CARGO_HOME 경로도 같은 접두어로 바꾼다 — 기존 호출(tools = work)의 RUSTFLAGS 는 그대로다.
 [ "$tools" = "$work" ] || remap="$remap --remap-path-prefix=$tools=/corral-herdr-build"
 RUSTFLAGS="$remap" cargo build --locked --release --manifest-path "$work/herdr-0.9.0/Cargo.toml"
else
 cargo build --locked --manifest-path "$work/herdr-0.9.0/Cargo.toml"
fi
build_seconds=$(( $(date +%s) - started ))
if [ "${CORRAL_BACKEND_TEST:-0}" = 1 ]; then
 cargo test --locked --manifest-path "$work/herdr-0.9.0/Cargo.toml" --bin herdr corral_terminal_ -- --nocapture --test-threads=1
 cargo test --locked --manifest-path "$work/herdr-0.9.0/Cargo.toml" --bin herdr trust_directory_requires_live_chooser -- --nocapture --test-threads=1
fi
printf 'Managed proof binary: %s\n' "$work/herdr-0.9.0/target/$profile/herdr"
node --input-type=module - "$repo_root" "$work" "$profile" "$build_seconds" <<'JS'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
const [root, work, profile, buildSeconds] = process.argv.slice(2)
const binary = path.join(work, `herdr-0.9.0/target/${profile}/herdr`)
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const source = JSON.parse(fs.readFileSync(path.join(root, 'app/backend/source.json')))
fs.writeFileSync(binary + '.json', JSON.stringify({ ...source, profile, buildSeconds: Number(buildSeconds), binaryBytes: fs.statSync(binary).size, binary, binarySHA256: hash(binary), patches: source.patches.map(name => ({ name, sha256: hash(path.join(root, 'app/backend', name)) })) }, null, 2) + '\n')
JS
