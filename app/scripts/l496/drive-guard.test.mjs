// LIFE-496 fix2 R2-03 — 드라이버 입력 안전장치. 경계 위반(fixture 밖 탭이 화면에 있음)은 삼키지 않고, 그 뒤에는 입력이 한 번도 나가지 않는다.
import { describe, expect, it } from 'vitest'
import { BoundaryError, guardedSender, orNull } from './drive-guard.mjs'

describe('drive-guard (R2-03)', () => {
  it('orNull — 시간 초과는 null, 경계 위반은 그대로 던진다', async () => {
    await expect(orNull(Promise.reject(new Error('시간 초과: x')))).resolves.toBeNull()
    await expect(orNull(Promise.reject(new BoundaryError('fixture 밖 탭')))).rejects.toBeInstanceOf(BoundaryError)
  })

  it('guardedSender — 확인이 실패하면 보내지 않는다(확인이 경계 위반을 던져도, ok:false 를 돌려줘도)', async () => {
    const sent = []
    const send = async (request) => sent.push(request)
    const viaThrow = guardedSender({ check: async () => { throw new BoundaryError('fixture 밖 탭') }, send })
    await expect(viaThrow({ cmd: 'type', text: 'x' })).rejects.toBeInstanceOf(BoundaryError)
    const viaVerdict = guardedSender({ check: async () => ({ ok: false, reason: '포커스 BODY' }), send })
    await expect(viaVerdict({ cmd: 'key', keyCode: 'Escape' })).rejects.toBeInstanceOf(BoundaryError)
    expect(sent).toEqual([])
    const ok = guardedSender({ check: async () => ({ ok: true }), send })
    await ok({ cmd: 'key', keyCode: 'Enter' })
    expect(sent).toEqual([{ cmd: 'key', keyCode: 'Enter' }])
  })

  it('t4 ⌘T 단계 모양 — 정착 대기 중 경계 위반이 나면 그 뒤 type·key 가 한 번도 나가지 않는다', async () => {
    const sent = []
    const send = async (request) => sent.push(request)
    let foreign = false
    const read = async () => {
      if (foreign) throw new BoundaryError('탭바에 fixture 밖 탭이 있다')
      return { focus: { isTerminal: true } }
    }
    const check = async () => {
      await read()
      return { ok: true }
    }
    const type = guardedSender({ check, send })
    const step = async () => {
      foreign = true // 정착 대기 중 화면이 사용자 워크스페이스로 넘어감
      const settled = await orNull(read())
      await type({ cmd: 'type', text: 'echo l496-cmdt' })
      await type({ cmd: 'key', keyCode: 'Escape' })
      return settled
    }
    await expect(step()).rejects.toBeInstanceOf(BoundaryError)
    expect(sent).toEqual([])
  })
})
