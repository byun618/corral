// Ghostty 구성 파일 후보 (LIFE-513 K1ⓐ). Orca v1.4.198 `src/main/ghostty/discovery.ts` 에서 옮겨 순서를 Ghostty 쪽으로 고쳤다(MIT, 고지 `./NOTICE.md`).
//
// Ghostty v1.3.1 `src/config/Config.zig` `loadDefaultFiles` 순서(00-analysis §4 D1 · raw/coordinator/c6):
//   <XDG>/ghostty/config → <XDG>/ghostty/config.ghostty → ~/Library/Application Support/com.mitchellh.ghostty/config → 같은 폴더 config.ghostty
//   (<XDG> = XDG_CONFIG_HOME 또는 ~/.config). 뒤 파일이 앞 파일을 덮는다.
// **Orca 198 은 같은 폴더 안에서 `config.ghostty` → `config` 순이라 `config` 가 이겼다** — Ghostty 는 반대다(소스 주석
// 「The legacy `config` file (without extension) is first loaded, then `config.ghostty`.」). corral 은 macOS 전용이라 다른 OS 분기는 옮기지 않았다.
import path from 'node:path'

export type GhosttyPathEnv = { home: string; xdgConfigHome?: string; ghosttyResourcesDir?: string }

export function ghosttyConfigDir(env: GhosttyPathEnv): string {
  const xdg = env.xdgConfigHome !== undefined && env.xdgConfigHome.length > 0 ? env.xdgConfigHome : path.join(env.home, '.config')
  return path.join(xdg, 'ghostty')
}

export function ghosttyConfigCandidates(env: GhosttyPathEnv): string[] {
  const appSupport = path.join(env.home, 'Library', 'Application Support', 'com.mitchellh.ghostty')
  return [ghosttyConfigDir(env), appSupport].flatMap((dir) => [path.join(dir, 'config'), path.join(dir, 'config.ghostty')])
}
