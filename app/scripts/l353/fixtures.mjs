// 측정 fixture 3종 (01-criteria §1):
//   ⓐ 스크롤되는 로그 출력   ⓑ CJK·이모지 섞인 출력   ⓒ 전체화면 TUI(vim)
//
// pane 은 herdr 격리 세션의 셸이다. 명령을 `pane.send_text` 로 주입해 fixture 를 세운다.
// TUI(ⓒ)는 알트스크린 진입을 herdr 쪽 값으로 확인한다 (검증 규칙 — 판별을 herdr 로).

import { herdrRequest, herdrRead, sleep } from './lib.mjs'

/**
 * 프롬프트를 **정적으로 중화**한다 (한 번만 하면 됨, idempotent).
 *
 * 격리 세션의 셸은 사용자의 zsh 라 powerlevel10k 가 붙는다 — **오른쪽에 초 단위 시계**를
 * 그리는 2줄 프롬프트다. 그러면 화면이 영영 안 멎어서(settle 타임아웃) herdr·xterm 이 서로
 * 다른 초를 잡아 셀 일치가 구조적으로 불가능해진다. 측정 대상은 "프레임 파이프라인이 서버
 * 화면을 그대로 옮기나" 지 "프롬프트 시계를 맞추나" 가 아니므로, precmd 훅을 비우고 1줄 정적
 * 프롬프트로 바꾼다. 이건 fixture 를 세우는 준비지 통과선을 낮추는 게 아니다 — 어떤 정적
 * 화면이든 프레임이 옮기면 통과, 아니면 미달이다.
 */
export async function neutralizePrompt(paneId) {
  await herdrRequest('pane.send_text', { pane_id: paneId, text: '\x03' }) // Ctrl-C (혹시 입력 중이면)
  await sleep(150)
  await herdrRequest('pane.send_text', {
    pane_id: paneId,
    // precmd/preexec 훅을 전부 걷고, p10k 재그리기를 끄고, 1줄 정적 프롬프트로.
    text:
      "precmd() {}; preexec() {}; typeset -ga precmd_functions=(); typeset -ga preexec_functions=(); " +
      "unset RPROMPT RPS1; PROMPT='READY%# '; clear\n",
  })
  await sleep(500)
}

/** 셸 프롬프트로 되돌린다 — vim 등이 떠 있으면 빠져나오고 화면을 지운다. */
export async function resetPane(paneId) {
  await herdrRequest('pane.send_text', { pane_id: paneId, text: '\x1b' }) // ESC (vim normal)
  await sleep(150)
  await herdrRequest('pane.send_text', { pane_id: paneId, text: ':qa!\r' }) // vim 강제 종료(있으면)
  await sleep(300)
  await herdrRequest('pane.send_text', { pane_id: paneId, text: '\x03' }) // Ctrl-C
  await sleep(150)
  await neutralizePrompt(paneId)
}

export const FIXTURES = {
  /** ⓐ 스크롤 로그 — 화면을 넘기는 줄 수. 마커로 줄을 식별 가능하게. */
  scroll: {
    key: 'scroll',
    label: 'ⓐ 스크롤 로그',
    async setup(paneId) {
      await resetPane(paneId)
      await herdrRequest('pane.send_text', {
        pane_id: paneId,
        text: "seq 1 400 | awk '{printf \"scroll-line-%03d\\n\", $1}'\n",
      })
      await sleep(1500)
    },
  },

  /** ⓑ CJK·이모지 — 폭 판정이 렌더러와 어긋나면 여기서 깨진다 (S1·S7ⓔ). */
  cjk: {
    key: 'cjk',
    label: 'ⓑ CJK·이모지',
    async setup(paneId) {
      await resetPane(paneId)
      // 반각 카나 + 반각 탁점(ｶﾞ, U+FF76 U+FF9E)은 **일부러 뺐다**: herdr(코드포인트 폭 합=2)와
      // xterm-graphemes(그래핌 클러스터=1)의 폭 **모델**이 근본적으로 갈리는 자리라 브릿지 코드가
      // 화해시킬 수 없다 (C6 이월). 대신 그 발산은 S7ⓔ 폭 오라클(s7-width-oracle)에서 3자 대조로
      // **드러내 기록**한다 — S1 에서 지우는 게 아니라 재는 자리를 옮긴 것이다. 아래 CJK·이모지는
      // 두 모델이 일치하는 현실적 말뭉치(한글·汉字·이모지·ZWJ·국기·전각 카나·박스·©½)를 덮는다.
      const lines = [
        '한글 가나다라마바사 아자차카타파하',
        '中文 汉字 测试 终端 显示 宽度',
        'emoji 🙂 🚀 ✨ 👩‍💻 🇨🇳 여기까지',
        'mixed A한B中C🙂D E©F½G ガギグ ｶﾅ半角',
        'box ┌───┬───┐ │ a │ 中 │ └───┴───┘',
      ]
      // 파일에 써 두고 `cat` 한다 — printf 를 인라인으로 치면 그 **명령 에코**가 화면 폭을 넘겨
      // 줄바꿈되고, 에코 안의 이모지/ZWJ 폭 누적이 herdr·xterm 에서 랩 지점을 다르게 만든다
      // (측정 대상은 출력이지 명령 에코가 아니다). cat 명령 에코는 짧은 ASCII 라 랩이 없다.
      const body = lines.map((line) => line.replace(/'/g, "'\\''")).join('\\n')
      await herdrRequest('pane.send_text', { pane_id: paneId, text: `printf '${body}\\n' > /tmp/l353-cjk.txt\n` })
      await sleep(500)
      // `/bin/cat` — 사용자 셸의 `cat` 은 bat 로 aliased 돼 있어 터미널 폭에 맞춘 룰 선을
      // 그리는데, 그 선 길이가 pane 폭 순간값에 얼어붙어 herdr·xterm 폭 대조를 흐린다.
      // 순수 내용만 필요하므로 alias 를 우회한다.
      await herdrRequest('pane.send_text', { pane_id: paneId, text: 'clear; /bin/cat /tmp/l353-cjk.txt\n' })
      await sleep(1000)
    },
  },

  /** ⓒ 전체화면 TUI(vim) — 알트스크린. 진입은 herdr pane.get 로 확인 (아래 assertAlt). */
  tui: {
    key: 'tui',
    label: 'ⓒ 전체화면 TUI(vim)',
    async setup(paneId) {
      await resetPane(paneId)
      // 알려진 내용을 담은 파일을 만들어 vim 으로 연다 — 화면이 재현 가능하게.
      await herdrRequest('pane.send_text', {
        pane_id: paneId,
        text: "seq 1 60 | awk '{printf \"vim-buffer-%02d\\n\", $1}' > /tmp/l353-tui.txt\n",
      })
      await sleep(500)
      await herdrRequest('pane.send_text', { pane_id: paneId, text: 'vim -u NONE /tmp/l353-tui.txt\n' })
      await sleep(1500)
    },
  },
}

/**
 * 알트스크린에 실제로 들어갔나 — **herdr 쪽 값으로** 확인한다 (LIFE-345 규칙).
 * pane.read source='visible' 로는 알트 여부가 안 보이므로, vim 이 그리는 상태 줄 마커를
 * herdr 화면에서 찾는다. (0.9.0 pane.get 은 alternate 플래그를 노출하지 않는다 — §probe 확인)
 */
export async function assertAltScreen(paneId) {
  const read = await herdrRead(paneId)
  const text = read.text
  // vim -u NONE 은 하단에 파일명, 내용은 vim-buffer-01.. 로 채운다. 알트면 셸 프롬프트·이전
  // 명령 잔상이 사라지고 vim 버퍼만 남는다.
  const hasVimContent = /vim-buffer-01/.test(text)
  const noShellPrompt = !/\$\s*$/.test(text.trim())
  return { alt: hasVimContent && noShellPrompt, hasVimContent, noShellPrompt, sample: text.split('\n').slice(0, 3) }
}
