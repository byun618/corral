// A3 붙는 중 → A4 성공 / A6–A9 실패(+ 코드 무효·저장 실패·기기 가득·노출 막힘). 상태는 연결 관리자의 pair 상태 하나에서 나온다.
import { useRouter } from 'expo-router'
import { ActivityIndicator, Text, View } from 'react-native'
import type { PairState } from '../../src/core/connection'
import { connection, useConnection } from '../../src/runtime/connection'
import { Button } from '../../src/ui/Button'
import { PairingError, type PairingErrorProps } from '../../src/ui/PairingError'
import { Screen } from '../../src/ui/Screen'
import { color, mono } from '../../src/ui/tokens'

type Failed = Extract<PairState, { kind: 'failed' }>

function errorView(failed: Failed, appVersion: string, go: { rescan: () => void; intro: () => void; retry: () => void }): PairingErrorProps {
  const rescan = { label: '다시 찍기', onPress: go.rescan }
  const intro = { label: '안내로 돌아가기', onPress: go.intro }
  // 코드가 소모되지 않은 실패 — 같은 대상으로 다시(QR 을 다시 찍지 않는다). 대상은 연결 관리자 메모리에만 있다.
  const retry = { label: '다시 시도', onPress: go.retry }
  switch (failed.reason) {
    case 'code_expired':
      return {
        title: '코드가 만료되었습니다',
        body: 'QR 코드는 10분 동안만 쓸 수 있습니다. 맥의 설정 › Mobile 에서 「QR 만들기」 를 다시 누른 뒤 찍어 주세요.',
        primary: rescan,
        secondary: intro,
      }
    case 'code_used':
      return {
        title: '이미 쓴 코드입니다',
        body: '이 QR 은 한 번만 쓸 수 있고, 이미 기기 등록에 쓰였습니다. 내가 등록하지 않았다면 맥의 설정 › Mobile 에서 기기 목록을 확인하세요.',
        primary: rescan,
        secondary: intro,
      }
    case 'code_invalid':
      return {
        title: '코드가 맞지 않습니다',
        body: '이 코드는 지금 쓸 수 없습니다 — 맥에서 새 QR 을 만들었거나, 여러 번 틀려 폐기됐거나, Mobile 을 껐다 켰을 수 있습니다. 맥에서 「QR 만들기」 를 다시 누른 뒤 찍어 주세요.',
        primary: rescan,
        secondary: intro,
      }
    case 'pair_rejected':
      return {
        title: '맥이 기기를 저장하지 못했습니다',
        body: '맥에서 기기 정보를 저장하다 실패했습니다. 코드는 아직 쓰이지 않았습니다 — 다시 시도해 주세요.',
        primary: retry,
        secondary: rescan,
      }
    case 'device_limit':
      return {
        title: '기기가 가득 찼습니다',
        body: '맥에 등록할 수 있는 기기는 5대입니다. 맥의 설정 › Mobile 에서 쓰지 않는 기기를 해지한 뒤 새 QR 을 찍어 주세요.',
        primary: rescan,
        secondary: intro,
      }
    case 'unavailable':
      return {
        title: '맥이 지금 폰 연결을 받지 않습니다',
        body: '맥의 설정 › Mobile 이 켜져 있고 노출 상태가 정상인지 확인해 주세요(Tailscale HTTPS 인증서 · Funnel 꺼짐).',
        primary: retry,
        secondary: rescan,
      }
    case 'unreachable':
      return {
        title: '맥에 닿지 않습니다',
        body: `${failed.host} 에 연결하지 못했습니다. 아래를 확인해 주세요.`,
        list: [
          '폰의 Tailscale 이 켜져 있나요',
          '맥이 켜져 있고 잠자기 상태가 아닌가요',
          '맥에서 corral 이 실행 중이고 설정 › Mobile 이 켜져 있나요',
          '폰 Tailscale 앱의 「Use Tailscale DNS」 가 켜져 있나요',
        ],
        primary: retry,
        secondary: rescan,
      }
    case 'protocol_mismatch':
      return {
        title: '버전이 맞지 않습니다',
        body: '맥의 corral 과 이 앱의 연결 방식(프로토콜)이 다릅니다. 오래된 쪽을 업데이트한 뒤 다시 찍어 주세요.',
        monoText: `이 앱 ${appVersion} · 프로토콜 1\n맥 corral · 프로토콜 ${failed.supported.length > 0 ? failed.supported.join(', ') : '알 수 없음'}`,
        primary: rescan,
        secondary: intro,
      }
    case 'save_failed':
      return {
        title: '폰에 저장하지 못했습니다',
        body: '기기 토큰을 폰의 보안 저장소에 넣지 못했습니다. 맥의 기기 목록에 이 폰이 생겼다면 해지한 뒤 새 QR 로 다시 찍어 주세요.',
        primary: rescan,
        secondary: intro,
      }
  }
}

export default function PairProgress() {
  const router = useRouter()
  const { pair, appVersion } = useConnection()
  const go = {
    rescan: () => {
      connection.resetPair()
      router.replace('/pair/scan')
    },
    intro: () => {
      connection.resetPair()
      router.replace('/pair')
    },
    retry: () => connection.retryPair(),
  }
  switch (pair.kind) {
    case 'idle':
    case 'pairing':
      return (
        <Screen>
          <View className="flex-1 justify-between px-padx pb-6 pt-16">
            <View className="items-center gap-5">
              <ActivityIndicator size="large" color={color.fgMuted} />
              <Text className="text-screen font-semibold text-fg">맥에 연결하는 중</Text>
              <Text className="text-[13px] text-fg-muted" style={{ fontFamily: mono }}>
                {pair.kind === 'pairing' ? pair.host : ''}
              </Text>
              <Text className="text-preview text-fg-dim">{pair.kind === 'pairing' && pair.saving ? '기기 등록 → 폰에 저장하는 중' : '코드 확인 → 기기 등록'}</Text>
            </View>
            {/* 토큰 저장이 떠난 뒤에는 취소를 받지 않는다 — 저장은 짧다(R2-A1). */}
            {pair.kind === 'pairing' && pair.saving ? null : <Button kind="secondary" label="취소" onPress={go.intro} />}
          </View>
        </Screen>
      )
    case 'paired':
      return (
        <Screen>
          <View className="flex-1 justify-between px-padx pb-6 pt-16">
            <View className="items-center gap-4">
              <View className="h-16 w-16 items-center justify-center rounded-full border-2 border-accent">
                <Text className="text-[28px] text-accent">✓</Text>
              </View>
              <Text className="text-center text-screen font-semibold text-fg">{pair.macName} 와 연결했습니다</Text>
              <Text className="text-[13px] text-fg-muted" style={{ fontFamily: mono }}>
                corral {pair.serverVersion} · 앱 {appVersion}
              </Text>
              <Text className="text-center text-preview leading-[20px] text-fg-dim">다음부터는 앱을 열면 바로 붙습니다. 맥의 corral 이 켜져 있어야 합니다.</Text>
            </View>
            <Button
              label="대화방 보기"
              onPress={() => {
                connection.resetPair()
                // 페어링 스택(A1·A3/A4)을 걷고 홈을 바닥에 둔다 — 뒤로 가기가 안내 화면으로 가지 않게(R2-A3).
                if (router.canDismiss()) router.dismissAll()
                router.replace('/home')
              }}
            />
          </View>
        </Screen>
      )
    case 'failed':
      return (
        <Screen>
          <PairingError {...errorView(pair, appVersion, go)} />
        </Screen>
      )
  }
}
