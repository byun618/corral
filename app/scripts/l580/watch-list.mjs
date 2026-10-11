// LIFE-580 최종 관문 보조 — 격리 인스턴스에 폰 자리로 붙어 받은 목록을 채널 단위로 찍는다(id·kind·dot·waiting·preview 종류·미리보기 글).
// 제목은 찍지 않는다(G5 — 원자료 정책). `--for <ms>` 동안 보고 끝낸다. 모바일이 꺼져 있으면 켠다(`--enable`).
// 사용(app/): node scripts/l580/watch-list.mjs --root /tmp/l580g-x --fake /tmp/l580g-fx [--for 5000] [--enable] [--titles]
import { parseArgs } from 'node:util'
import { checkRoots, phone, setMobile, sleep } from './lib.mjs'

const { values: args } = parseArgs({ options: { root: { type: 'string' }, fake: { type: 'string' }, for: { type: 'string', default: '5000' }, enable: { type: 'boolean', default: false }, titles: { type: 'boolean', default: false } } })
checkRoots({ root: args.root, fake: args.fake })
if (args.enable) await setMobile(args.root, args.fake, true)
const client = await phone(args.root, {
  onList: ({ message, recvAt }) => {
    const rows = []
    if (message.list.available) {
      for (const repo of message.list.repos) for (const task of repo.tasks) for (const c of task.channels) rows.push({ id: c.id, kind: c.kind, dot: c.dot, status: c.status, waiting: c.waiting, preview: c.preview?.kind, text: c.preview?.text ?? null, depth: c.depth, ...(args.titles ? { title: c.title } : {}) })
    }
    console.log(JSON.stringify({ recvAt, seq: message.seq, available: message.list.available, waiting: message.list.waiting?.length ?? null, channels: rows }))
  },
})
await sleep(Number(args.for))
await client.close()
process.exit(0)
