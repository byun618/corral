// 「오래된 값」 띠(R1-A4 · R2-A2) — 받은 목록이 있는데 그 뒤 목록 실패(읽지 못함·구독 거부·응답 없음). 목록·대화 자리 화면이 같이 쓴다.
// 기준 시각 = 그 목록을 받은 시각. 둘째 줄은 실패 안내(호환 불가면 업데이트 안내).
import { Text, View } from 'react-native'
import { clockLabel, failureText } from '../core/list-view'
import type { ListFailure } from '../core/list-store'
import { color, font } from './tokens'

export function StaleBand({ failure, receivedAt }: { failure: ListFailure; receivedAt: number }) {
  const text = failureText(failure)
  return (
    <View style={{ paddingHorizontal: 18, paddingVertical: 10, gap: 2, borderBottomWidth: 1, borderBottomColor: color.line }}>
      <Text style={{ fontSize: 13, fontFamily: font.medium, color: color.fg }}>{`목록이 최신이 아닙니다 · ${clockLabel(receivedAt)} 기준`}</Text>
      <Text style={{ fontSize: 12.5, lineHeight: 18, fontFamily: font.regular, color: color.fgMuted }}>{`${text.title} — ${text.body}`}</Text>
    </View>
  )
}
