// 중단 버튼 (LIFE-582 — 579 C7 장전 · C10 · C6, design-handoff §1 Q8 · §2 StopButton 4상태) — 대화 머리 오른쪽. 보이는 조건은 `core/input.ts stopView`.
// 첫 누름에 장전(빨갛게 차며 `한 번 더 → 중단`), 3초 안에 다시 누르면 중단, 지나면 복귀. 모달 없음.
import { useEffect, useRef, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { STOP_ARM_MS, type StopView } from '../core/input'
import { color, font } from './tokens'

export function StopButton({ view, onStop }: { view: StopView; onStop: () => void }) {
  const [armed, setArmed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current)
  }, [])
  // 버튼이 숨거나 잠기면 장전도 푼다 — 다시 나타났을 때 한 번에 멈추지 않게.
  useEffect(() => {
    if (view === 'enabled') return
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
    setArmed(false)
  }, [view])
  if (view === 'hidden') return null
  const disabled = view === 'disabled'
  const press = (): void => {
    if (disabled) return
    if (!armed) {
      setArmed(true)
      timer.current = setTimeout(() => {
        timer.current = null
        setArmed(false)
      }, STOP_ARM_MS)
      return
    }
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
    setArmed(false)
    onStop()
  }
  const fill = armed ? color.error : 'transparent'
  const border = disabled ? color.line : armed ? color.error : color.errorTint50
  const ink = disabled ? color.fgFaint : armed ? color.surface : color.error
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={armed ? '한 번 더 누르면 중단' : '이 턴 멈추기'}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={press}
      className="active:opacity-80"
      style={{ height: 40, flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 14, borderRadius: 20, borderWidth: 1, borderColor: border, backgroundColor: fill }}
    >
      <View style={{ width: 9, height: 9, borderRadius: 1.5, backgroundColor: ink }} />
      <Text style={{ fontSize: 13.5, color: ink, fontFamily: font.semibold }}>{armed ? '한 번 더 → 중단' : '이 턴 멈추기'}</Text>
    </Pressable>
  )
}
