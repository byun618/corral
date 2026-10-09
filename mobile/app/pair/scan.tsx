// A2 QR 찍기 · A5 카메라 권한 거부 · 붙여넣기 보조 경로(E2).
// 페이로드는 네트워크 전에 검사한다(P3ⓔ) — corral QR 이 아니면 안내만, 서버에 닿지 않는다. 한 번 넘긴 QR 은 다시 넘기지 않는다(P3ⓕ).
import { CameraView, useCameraPermissions } from 'expo-camera'
import * as Clipboard from 'expo-clipboard'
import { useRouter } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { Linking, Pressable, Text, View } from 'react-native'
import { parsePairingPayload, type PayloadProblem } from '../../src/core/payload'
import { connection } from '../../src/runtime/connection'
import { Header } from '../../src/ui/Header'
import { PairingError } from '../../src/ui/PairingError'
import { Screen } from '../../src/ui/Screen'

function problemText(problem: PayloadProblem, source: 'qr' | 'paste'): string {
  const what = source === 'qr' ? '이 QR 은' : '붙여넣은 내용은'
  switch (problem) {
    case 'not_corral':
      return `${what} corral 페어링 ${source === 'qr' ? 'QR 이' : '텍스트가'} 아닙니다. 맥의 설정 › Mobile 에서 「QR 만들기」 로 만든 것을 써 주세요.`
    case 'unknown_version':
      return `${what} 이 앱이 모르는 형식입니다 — 폰 앱을 업데이트해 주세요.`
    case 'bad_url':
      return `${what} 맥 주소 모양이 맞지 않습니다(wss://…ts.net:8577/ws 이어야 합니다).`
    case 'bad_code':
      return `${what} 페어링 코드 모양이 맞지 않습니다. 맥에서 새 QR 을 만들어 주세요.`
  }
}

export default function PairScan() {
  const router = useRouter()
  const [permission, requestPermission] = useCameraPermissions()
  const [notice, setNotice] = useState<string | null>(null)
  const consumed = useRef(false)
  const lastRejected = useRef<string | null>(null)
  const asked = useRef(false)
  const [denied, setDenied] = useState(false)
  const ask = () => {
    void requestPermission().then((result) => setDenied(!result.granted))
  }

  // 화면에 들어올 때 한 번만 묻는다 — 거절 뒤 다시 묻기는 사용자가 「권한 허용」 을 누를 때만.
  useEffect(() => {
    if (permission === null || permission.granted || !permission.canAskAgain || asked.current) return
    asked.current = true
    void requestPermission().then((result) => setDenied(!result.granted))
  }, [permission, requestPermission])

  const submit = (text: string, source: 'qr' | 'paste') => {
    if (consumed.current) return
    const parsed = parsePairingPayload(text)
    if (!parsed.ok) {
      if (source === 'qr' && lastRejected.current === text) return
      lastRejected.current = text
      setNotice(problemText(parsed.problem, source))
      return
    }
    consumed.current = true
    connection.pair(parsed.target)
    router.replace('/pair/progress')
  }

  const paste = async () => {
    const text = await Clipboard.getStringAsync()
    submit(text, 'paste')
  }

  // A5 — 거절됨. Android 가 더 묻지 않으면(canAskAgain 거짓) 시스템 설정으로, 아직 물을 수 있으면 다시 묻기.
  if (permission !== null && !permission.granted && (!permission.canAskAgain || denied)) {
    return (
      <Screen>
        <PairingError
          title="카메라를 쓸 수 없습니다"
          body="QR 을 찍으려면 카메라 권한이 필요합니다. 설정에서 corral 의 카메라를 허용한 뒤 돌아오세요. 카메라 없이 맥의 페어링 텍스트를 복사해 붙여 넣을 수도 있습니다."
          primary={
            permission.canAskAgain
              ? { label: '권한 허용', onPress: ask }
              : { label: '설정 열기', onPress: () => void Linking.openSettings() }
          }
          secondary={{ label: '페어링 텍스트 붙여넣기', onPress: () => void paste() }}
        />
        {notice !== null ? <Text className="px-padx pb-4 text-preview text-error">{notice}</Text> : null}
      </Screen>
    )
  }

  return (
    <Screen>
      <Header title="QR 찍기" onBack={() => router.back()} />
      <View className="flex-1 gap-5 px-padx pb-6">
        <View className="aspect-square w-full overflow-hidden rounded-[20px] border border-line bg-window">
          {permission?.granted ? (
            <CameraView
              style={{ flex: 1 }}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={(result) => submit(result.data, 'qr')}
            />
          ) : (
            <View className="flex-1 items-center justify-center">
              <Text className="text-preview text-fg-dim">카메라 권한을 기다리는 중</Text>
            </View>
          )}
        </View>
        <View className="gap-2">
          <Text className="text-body leading-[22px] text-fg">맥 corral 의 「설정 › Mobile」 에 뜬 QR 을 네모 안에 맞춰 주세요</Text>
          <Text className="text-preview text-fg-muted">코드는 10분 동안 한 번만 쓸 수 있습니다</Text>
        </View>
        {notice !== null ? (
          <View className="rounded-card border border-line bg-window p-4">
            <Text className="text-preview leading-[20px] text-error">{notice}</Text>
          </View>
        ) : null}
        <View className="flex-1" />
        <Pressable accessibilityRole="button" onPress={() => void paste()} className="h-12 items-center justify-center rounded-pill border border-line-strong active:opacity-70">
          <Text className="text-body text-fg">페어링 텍스트 붙여넣기</Text>
        </Pressable>
        <Text className="text-small leading-[18px] text-fg-dim">카메라가 안 되면 맥의 설정 › Mobile 에 QR 과 함께 보이는 페어링 텍스트를 복사해 폰으로 옮긴 뒤 누르세요.</Text>
      </View>
    </Screen>
  )
}
