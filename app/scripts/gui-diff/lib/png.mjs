// 최소 PNG 읽기/쓰기 + ROI 픽셀 대조 (G9). 의존성 없이 8비트 비인터레이스 PNG 만 다룬다 —
// 이 일감이 만드는 캡처가 그것뿐이다(`screencapture` = RGBA, CDP = RGB).
//
// 왜 필요한가: C3 설치본 대조에 **양성 대조**를 붙이려면 「같은 방법으로 알려진 차이를 검출하는가」를
// 보여야 한다. 그러려면 이미지를 픽셀로 읽고, **사본**에 알려진 크기의 변화를 심고, 같은 비교 함수로
// 원본↔원본(음성)·원본↔사본(양성)을 돌려야 한다. 설치본에는 입력도 재시작도 하지 않는다.
//
// 지원하지 않는 것(만나면 던진다 — 조용히 틀린 값을 내지 않는다): 16비트 심도, 인터레이스,
// 팔레트(color type 3). tRNS·iCCP 같은 보조 청크는 무시한다.

import zlib from 'node:zlib'

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 }

/** PNG 버퍼 → `{width, height, channels, data}` (행 우선, 필터 제거된 원시 바이트). */
export function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(SIG)) throw new Error('PNG 서명이 아니다')
  let offset = 8
  let header = null
  const idat = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const body = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        depth: body[8],
        colorType: body[9],
        interlace: body[12]
      }
    } else if (type === 'IDAT') idat.push(Buffer.from(body))
    else if (type === 'IEND') break
    offset += 12 + length
  }
  if (!header) throw new Error('IHDR 가 없다')
  if (header.depth !== 8) throw new Error(`8비트만 읽는다 (depth=${header.depth})`)
  if (header.interlace !== 0) throw new Error('인터레이스 PNG 는 읽지 않는다')
  const channels = CHANNELS[header.colorType]
  if (!channels) throw new Error(`지원하지 않는 color type ${header.colorType}`)

  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = header.width * channels
  const out = Buffer.alloc(stride * header.height)
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < header.height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const cur = Buffer.from(line)
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? cur[i - channels] : 0
      const b = prev[i]
      const c = i >= channels ? prev[i - channels] : 0
      switch (filter) {
        case 0:
          break
        case 1:
          cur[i] = (cur[i] + a) & 0xff
          break
        case 2:
          cur[i] = (cur[i] + b) & 0xff
          break
        case 3:
          cur[i] = (cur[i] + ((a + b) >> 1)) & 0xff
          break
        case 4: {
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          cur[i] = (cur[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff
          break
        }
        default:
          throw new Error(`알 수 없는 필터 ${filter}`)
      }
    }
    cur.copy(out, y * stride)
    prev = cur
  }
  return { width: header.width, height: header.height, channels, data: out }
}

/** `{width,height,channels,data}` → PNG 버퍼 (필터 0, 한 IDAT). 사본을 사람이 볼 수 있게 남긴다. */
export function encodePng(image) {
  const { width, height, channels, data } = image
  const colorType = Object.entries(CHANNELS).find(([, value]) => value === channels)?.[0]
  if (colorType === undefined) throw new Error(`쓸 수 없는 채널 수 ${channels}`)
  const stride = width * channels
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const chunk = (type, body) => {
    const out = Buffer.alloc(body.length + 12)
    out.writeUInt32BE(body.length, 0)
    out.write(type, 4, 'ascii')
    body.copy(out, 8)
    out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length)
    return out
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = Number(colorType)
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

/** ROI 가 이미지 안에 들어가는지. 밖이면 던진다 — 밖을 0 으로 채워 비교하면 「차이 없음」이 나온다. */
export function assertRoiInside(image, roi, label) {
  if (roi.x < 0 || roi.y < 0 || roi.w <= 0 || roi.h <= 0) throw new Error(`${label}: ROI 값이 이상하다 ${JSON.stringify(roi)}`)
  if (roi.x + roi.w > image.width || roi.y + roi.h > image.height) {
    throw new Error(`${label}: ROI ${JSON.stringify(roi)} 가 이미지 ${image.width}x${image.height} 밖이다`)
  }
}

const pixelAt = (image, x, y) => {
  const at = (y * image.width + x) * image.channels
  if (image.channels >= 3) return [image.data[at], image.data[at + 1], image.data[at + 2]]
  const gray = image.data[at]
  return [gray, gray, gray]
}

/**
 * **비교 방법 자체다** (C3). 두 이미지의 ROI 를 RGB 채널로 견준다. 알파는 보지 않는다 —
 * `screencapture` 는 RGBA, CDP 는 RGB 로 주므로 알파를 넣으면 채널 수 차이가 곧 차이가 된다.
 *
 * @returns `{pixels, maxDelta, meanDelta, differing, threshold}` — 판정은 호출자가 한다.
 */
export function compareRoi(left, right, roiLeft, roiRight, { threshold = 0 } = {}) {
  assertRoiInside(left, roiLeft, 'left')
  assertRoiInside(right, roiRight, 'right')
  if (roiLeft.w !== roiRight.w || roiLeft.h !== roiRight.h) {
    throw new Error(`ROI 크기가 다르다: ${roiLeft.w}x${roiLeft.h} vs ${roiRight.w}x${roiRight.h}`)
  }
  let maxDelta = 0
  let sum = 0
  let differing = 0
  for (let y = 0; y < roiLeft.h; y += 1) {
    for (let x = 0; x < roiLeft.w; x += 1) {
      const a = pixelAt(left, roiLeft.x + x, roiLeft.y + y)
      const b = pixelAt(right, roiRight.x + x, roiRight.y + y)
      const delta = Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]))
      sum += delta
      if (delta > maxDelta) maxDelta = delta
      if (delta > threshold) differing += 1
    }
  }
  const pixels = roiLeft.w * roiLeft.h
  return { pixels, maxDelta, meanDelta: Math.round((sum / pixels) * 1000) / 1000, differing, threshold }
}

/** 사본의 ROI 색을 **알려진 크기**만큼 옮긴다 (양성 대조용). 원본은 건드리지 않는다. */
export function mutateColor(image, roi, delta) {
  const copy = { ...image, data: Buffer.from(image.data) }
  assertRoiInside(copy, roi, 'mutate')
  for (let y = roi.y; y < roi.y + roi.h; y += 1) {
    for (let x = roi.x; x < roi.x + roi.w; x += 1) {
      const at = (y * copy.width + x) * copy.channels
      for (let channel = 0; channel < Math.min(3, copy.channels); channel += 1) {
        copy.data[at + channel] = Math.max(0, Math.min(255, copy.data[at + channel] + delta))
      }
    }
  }
  return copy
}

/** 사본의 ROI 내용을 오른쪽으로 `dx` 픽셀 민다 (기하 변화 검출 확인용). */
export function mutateShift(image, roi, dx) {
  const copy = { ...image, data: Buffer.from(image.data) }
  assertRoiInside(copy, roi, 'mutate')
  for (let y = roi.y; y < roi.y + roi.h; y += 1) {
    for (let x = roi.x + roi.w - 1; x >= roi.x; x -= 1) {
      const from = Math.max(roi.x, x - dx)
      const to = (y * copy.width + x) * copy.channels
      const src = (y * copy.width + from) * copy.channels
      for (let channel = 0; channel < copy.channels; channel += 1) copy.data[to + channel] = copy.data[src + channel]
    }
  }
  return copy
}

/**
 * **양성·음성 대조를 한 번에** (G9·C3). 같은 비교 함수로
 * ① 원본↔원본(음성 — 0 이어야 한다) ② 원본↔알려진 변화를 심은 **사본**(양성 — 검출돼야 한다)
 * 을 돌려, 그 ROI 에서 **어느 크기의 변화까지 보이는지**를 값으로 낸다.
 *
 * 균일한 배경 ROI 에서는 **이동을 검출하지 못한다** — 구조가 없으면 밀어도 픽셀이 그대로다.
 * 그것도 결과에 적는다(한계). 그래서 색 민감도는 배경 ROI, 기하 민감도는 구조가 있는 ROI 로 본다.
 */
export function evaluateRoiControls(image, roi, { colorDeltas = [1, 2, 4, 8], shifts = [1, 2, 4], threshold = 0 } = {}) {
  const negative = compareRoi(image, image, roi, roi, { threshold })
  const color = colorDeltas.map((delta) => {
    const result = compareRoi(image, mutateColor(image, roi, delta), roi, roi, { threshold })
    return { kind: 'color', delta, ...result, detected: result.differing > 0 }
  })
  const shift = shifts.map((dx) => {
    const result = compareRoi(image, mutateShift(image, roi, dx), roi, roi, { threshold })
    return { kind: 'shift', delta: dx, ...result, detected: result.differing > 0 }
  })
  const detectedColor = color.filter((entry) => entry.detected).map((entry) => entry.delta)
  const detectedShift = shift.filter((entry) => entry.detected).map((entry) => entry.delta)
  return {
    roi,
    negative,
    positives: [...color, ...shift],
    // 음성 대조가 0 이 아니면 그 ROI 로는 아무 판정도 못 한다 — 방법이 스스로 흔들린다는 뜻이다.
    negativeOk: negative.differing === 0 && negative.maxDelta === 0,
    minColorDelta: detectedColor.length > 0 ? Math.min(...detectedColor) : null,
    minShift: detectedShift.length > 0 ? Math.min(...detectedShift) : null,
    uniform: color.every((entry) => entry.detected) && detectedShift.length === 0
  }
}
