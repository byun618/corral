// LIFE-581 R5-A1 에뮬레이터 fixture — 리뷰어 r5 `native-fixture.tsx` 에 SOON(300 ms 뒤 답)·FOLD(30줄 답)·GROW(같은 id 에 숨은 줄 추가)·SWAP(r6 목록 빠짐→복귀) 를 더했다. 글은 전부 합성.
// `r5a1-setup.py` 가 사본의 app/index.tsx 로 둔다(작업 폴더 mobile/ 에는 들어가지 않는다).
// app 타입 검사 밖(tsconfig.node.json exclude — 사본의 `../src` 로만 풀린다). 합성 채널·스냅숏 모양은 리뷰어 fixture 그대로 any 로 둔다.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { Conversation } from '../src/ui/Conversation'

const channel: any = { id: 'r5', key: 's:r5', status: 'live', kind: 'claude', title: 'R5 fixture', dot: 'idle', dotUnseen: 'idle', depth: 0, origin: null, spawnedBy: null, parent: null, preview: { kind: 'none' }, waiting: null, model: null, timeAt: null, activityAt: 0, outcome: null }
const seed = Array.from({ length: 36 }, (_, i) => ({ id: i + 1, kind: i % 2 ? 'reply' : 'prompt', at: 0, body: { text: `Seed ${i + 1}\nSecond line\nR5-SEED-${i + 1}-END`, clipped: null } }))
const lines = (id: number, n: number) => Array.from({ length: n }, (_, i) => `R5-FOLD-${id} line ${i + 1}`).join('\n') + `\nR5-FOLD-${id}-END`

export default function App() {
  const [chat, setChat] = useState<any>({ channel: 'r5', phase: { kind: 'ready' }, gen: 'g1', cursor: 1, items: seed, hasOlder: false, loadingOlder: false, receivedAt: 0, stale: null, dropped: 0, tailRev: 1 })
  const [key, setKey] = useState(0)
  const push = () =>
    setChat((c: any) => {
      const id = c.items[c.items.length - 1].id + 1
      console.log('R5_PUSH', id, Date.now())
      return { ...c, tailRev: c.tailRev + 1, items: [...c.items, { id, kind: 'reply', at: 0, body: { text: `R5-NEW-${id}\nSecond line\nThird line\nR5-NEW-${id}-END`, clipped: null } }] }
    })
  const fold = () =>
    setChat((c: any) => {
      const id = c.items[c.items.length - 1].id + 1
      console.log('R5_FOLD', id, 30, Date.now())
      return { ...c, tailRev: c.tailRev + 1, items: [...c.items, { id, kind: 'reply', at: 0, body: { text: lines(id, 30), clipped: null } }] }
    })
  const grow = () =>
    setChat((c: any) => {
      const last = c.items[c.items.length - 1]
      const n = last.body.text.split('\n').length + 4
      console.log('R5_GROW', last.id, n, Date.now())
      return { ...c, tailRev: c.tailRev + 1, items: [...c.items.slice(0, -1), { ...last, body: { text: lines(last.id, n), clipped: null } }] }
    })
  const button = (label: string, onPress: () => void) => (
    <Pressable onPress={onPress}>
      <Text style={{ color: 'white' }}>{label}</Text>
    </Pressable>
  )
  return (
    <View style={{ flex: 1, backgroundColor: '#111', paddingTop: 44, paddingBottom: 30 }}>
      <View style={{ height: 56, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around' }}>
        {button('RESET', () => {
          setChat((c: any) => ({ ...c, items: seed, tailRev: 1 }))
          setKey((k) => k + 1)
          console.log('R5_RESET')
        })}
        {button('DELAY', () => {
          console.log('R5_SCHEDULE', 1800, Date.now())
          setTimeout(push, 1800)
        })}
        {button('SOON', () => {
          console.log('R5_SCHEDULE', 300, Date.now())
          setTimeout(push, 300)
        })}
        {button('PUSH', push)}
      </View>
      <View style={{ height: 56, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around' }}>
        {button('FOLD', fold)}
        {button('GROW', grow)}
        {button('SWAP', () => {
          // r6 R6-A1 — 리뷰어 `native-fixture-2.tsx` 그대로: 0.3 s 뒤 읽기 실패(목록 빠짐) → 1.8 s 뒤 같은 Conversation 에 새 목록
          console.log('R6_SWAP_SCHEDULE')
          setTimeout(() => {
            console.log('R6_REMOVE')
            setChat((c: any) => ({ ...c, phase: { kind: 'unavailable', reason: 'unreadable', retrying: false } }))
          }, 300)
          setTimeout(() => {
            console.log('R6_RESTORE')
            setChat((c: any) => ({ ...c, phase: { kind: 'ready' }, items: seed, tailRev: c.tailRev + 1 }))
          }, 1800)
        })}
      </View>
      <Conversation key={key} channel={channel} chat={chat} unknown={false} dim={false} onOlder={() => {}} onRetry={() => {}} />
    </View>
  )
}
