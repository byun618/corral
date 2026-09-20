#!/bin/sh
# macOS arm64 proof build. Never installs to PATH or changes an installed herdr.
set -eu
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
work="${CORRAL_BACKEND_BUILD_ROOT:?Set an isolated build directory}"
mkdir -p "$work"
work=$(CDPATH= cd -- "$work" && pwd -P)
export CARGO_HOME="$work/cargo"
export RUSTUP_HOME="$work/rustup"
export ZIG_GLOBAL_CACHE_DIR="$work/zig-cache"
[ "$(uname -sm)" = "Darwin arm64" ] || { echo 'This build recipe is validated on macOS arm64 only' >&2; exit 1; }
[ -d /Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk ] || { echo 'Zig 0.15.2 needs a compatible SDK; this recipe pins local SDK 15.4' >&2; exit 1; }
if [ ! -f "$work/herdr.tar.gz" ]; then curl -fSL https://codeload.github.com/herdrdev/herdr/tar.gz/refs/tags/v0.9.0 -o "$work/herdr.tar.gz"; fi
if [ ! -f "$work/zig.tar.xz" ]; then curl -fSL https://ziglang.org/download/0.15.2/zig-aarch64-macos-0.15.2.tar.xz -o "$work/zig.tar.xz"; fi
(cd "$work" && printf '%s\n' '1e83bff4b05834ed8281e16f1680e8f3e58375a94b2e3f2b3d021e28e293ef9a  herdr.tar.gz' '3cc2bab367e185cdfb27501c4b30b1b0653c28d9f73df8dc91488e66ece5fa6b  zig.tar.xz' | shasum -a 256 -c -)
patch_digest=$(cat "$repo_root/app/backend/herdr-stream.patch" "$repo_root/app/backend/herdr-guard.patch" | shasum -a 256 | cut -d " " -f 1)
if [ ! -d "$work/herdr-0.9.0" ]; then
 tar -xzf "$work/herdr.tar.gz" -C "$work"
 (cd "$work/herdr-0.9.0" && patch -p1 < "$repo_root/app/backend/herdr-stream.patch" && patch -p1 < "$repo_root/app/backend/herdr-guard.patch")
 printf "%s\n" "$patch_digest" > "$work/herdr-0.9.0/.corral-patches"
fi
[ "$(cat "$work/herdr-0.9.0/.corral-patches")" = "$patch_digest" ] || { echo "Patch set changed; use a fresh CORRAL_BACKEND_BUILD_ROOT" >&2; exit 1; }
if [ ! -d "$work/zig-aarch64-macos-0.15.2" ]; then tar -xf "$work/zig.tar.xz" -C "$work"; fi
if [ ! -x "$CARGO_HOME/bin/cargo" ]; then
 curl -fSL https://static.rust-lang.org/rustup/dist/aarch64-apple-darwin/rustup-init -o "$work/rustup-init"
 chmod +x "$work/rustup-init"
 "$work/rustup-init" -y --no-modify-path --profile minimal --default-toolchain 1.96.1
fi
mkdir -p "$work/build-bin"
cat > "$work/build-bin/xcrun" <<'XCRUN'
#!/bin/sh
if [ "$1" = --sdk ] && [ "$2" = macosx ] && [ "$3" = --show-sdk-path ]; then
 echo /Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk
else
 exec /usr/bin/xcrun "$@"
fi
XCRUN
chmod +x "$work/build-bin/xcrun"
export PATH="$work/build-bin:$CARGO_HOME/bin:$PATH"
export ZIG="$work/zig-aarch64-macos-0.15.2/zig"
cargo build --locked --manifest-path "$work/herdr-0.9.0/Cargo.toml"
if [ "${CORRAL_BACKEND_TEST:-0}" = 1 ]; then
 cargo test --locked --manifest-path "$work/herdr-0.9.0/Cargo.toml" --bin herdr corral_terminal_ -- --nocapture --test-threads=1
fi
printf 'Managed proof binary: %s\n' "$work/herdr-0.9.0/target/debug/herdr"
node --input-type=module - "$repo_root" "$work" <<'JS'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
const [root, work] = process.argv.slice(2)
const binary = path.join(work, 'herdr-0.9.0/target/debug/herdr')
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const source = JSON.parse(fs.readFileSync(path.join(root, 'app/backend/source.json')))
fs.writeFileSync(binary + '.json', JSON.stringify({ ...source, binary, binarySHA256: hash(binary), patches: source.patches.map(name => ({ name, sha256: hash(path.join(root, 'app/backend', name)) })) }, null, 2) + '\n')
JS
