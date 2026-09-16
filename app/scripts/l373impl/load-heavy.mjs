// 1차 스파이크와 **같은 무게**의 부하 (§10-R27-b) — pane 격자 전체를 매 프레임 다시 칠한다.
//
// `load.sh` 는 40×20 짜리 박스라 프레임이 가볍다. 스파이크의 P3·P4·P5 통과선은 100×30 ·
// 평균 28.4KB(셀당 9.5B) **전체 리페인트**로 만들어진 값이라, 그 자리에서 비교하려면 부하가
// 그만큼 무거워야 한다.
//
// 무게는 **색이 몇 칸마다 바뀌나**로 맞춘다 — herdr 가 corral 로 내보내는 ANSI 는 속성이 바뀔
// 때만 SGR 을 싣기 때문이다. `--every N` 은 N 칸마다 색을 바꾼다(1 이면 칸마다).
// 실제로 몇 바이트가 됐는지는 **앱 쪽 쓰기 링**(`bytes`)이 말한다 — 여기서 센 바이트가 아니다.
//
// 사용: node load-heavy.mjs --cols 100 --rows 30 --hz 30 --secs 120 --every 2 --tag p1
// pane 안에서 돌린다: `herdr --session … pane run <paneId> "node … load-heavy.mjs …"`

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}
const cols = Number(arg('cols', 100))
const rows = Number(arg('rows', 30))
const hz = Number(arg('hz', 30))
const secs = Number(arg('secs', 120))
const every = Number(arg('every', 2))
const tag = String(arg('tag', 'heavy'))
/**
 * `--rich 1` 이면 런마다 **전경+배경+굵기**를 싣는다 (기본은 전경만).
 *
 * 왜 따로 두나: 프레임 무게(셀당 바이트)와 **색 런 길이**는 다른 축인데, `--every` 하나로
 * 무게를 맞추면 둘이 같이 움직인다. 1차 스파이크의 보정 프레임은 `avgRun 5`(런 길이 평균 5)
 * 이면서 셀당 9.5 B 다 — 런은 길고 런마다 실리는 속성은 무겁다(테두리·배경 있는 diff 줄·
 * 굵은 상태바). `--every 5 --rich 1` 이 그 자리다.
 */
const rich = String(arg('rich', '0'))

/** 에이전트 TUI 모양의 글자들 — 셀마다 다른 글리프를 넣어 격자가 통째로 바뀌게 한다. */
const GLYPHS = '▏▎▍▌▋▊▉█░▒▓·=-+*#@'
const frameText = (phase) => {
  const out = []
  out.push('\x1b[H')
  for (let y = 0; y < rows; y++) {
    let line = ''
    for (let x = 0; x < cols; x++) {
      if (x % every === 0) {
        const color = ((x + y + phase) % 213) + 17
        const bold = ((x + y) & 1) === 0 ? 1 : 22
        // rich=2 는 **24비트 색**이다 — 1차 스파이크의 `gen-frames.mjs` 가 `rgb(...)` 팔레트를
        // 쓰므로 그쪽 셀당 9.5 B 는 truecolor 값이다. 런 길이를 그대로 두고 무게만 그 자리로 올린다.
        line +=
          rich === '2'
            ? `\x1b[${bold}m\x1b[38;2;${color};${(color * 3) % 256};${(color * 7) % 256}m\x1b[48;2;${(color * 5) % 256};${color};${(color * 11) % 256}m`
            : rich === '1'
              ? `\x1b[${bold}m\x1b[38;5;${color}m\x1b[48;5;${((color * 7) % 213) + 17}m`
              : `\x1b[38;5;${color}m`
      }
      line += GLYPHS[(x * 3 + y * 5 + phase) % GLYPHS.length]
    }
    out.push(line + '\x1b[0m')
    if (y < rows - 1) out.push('\r\n')
  }
  return out.join('')
}

// 프레임은 미리 만들어 둔다 — 생성 비용이 셸 쪽 지연으로 새면 부하가 목표 주기를 못 지킨다.
const frames = []
for (let phase = 0; phase < 24; phase++) frames.push(Buffer.from(frameText(phase), 'utf8'))
process.stderr.write(`${tag} 프레임 ${frames[0].length}B (${cols}x${rows}, every=${every}, rich=${rich}) hz=${hz}\n`)

const 끝 = Date.now() + secs * 1000
let i = 0
const 간격 = 1000 / hz
const tick = () => {
  if (Date.now() >= 끝) {
    process.stdout.write('\x1b[0m\r\n')
    process.exit(0)
  }
  process.stdout.write(frames[i % frames.length])
  i += 1
  setTimeout(tick, 간격)
}
tick()
