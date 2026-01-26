const $ = (id) => document.getElementById(id)
const logEl = $('log')
const video = $('video')
const canvas = $('canvas')

let pc = null
let statsTimer = null
let lastBytes = 0
let lastTs = 0
let selectedCodec = '-'
let connectionId = null

function log(...args) {
  const line = args
    .map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a)))
    .join(' ')
  const ts = new Date().toISOString().split('T')[1].replace('Z', '')
  logEl.textContent += `[${ts}] ${line}\n`
  logEl.scrollTop = logEl.scrollHeight
  console.log('[webrtc]', ...args)
}

function setKV(id, val) {
  $(id).textContent = val
}

function parseJSONSafely(txt, fallback) {
  try {
    return txt ? JSON.parse(txt) : fallback
  } catch (e) {
    log('JSON parse error:', e.message)
    return fallback
  }
}

async function start() {
  if (pc) {
    log('Start: existing PeerConnection found, stopping it first')
    await stop()
  }

  const config = {
    iceServers: parseJSONSafely($('iceservers').value, []),
  }

  pc = new RTCPeerConnection(config)
  window._pc = pc

  // События по этапам подключения
  pc.onicegatheringstatechange = () => {
    log('ICE gathering state changed:', pc.iceGatheringState)
  }

  pc.onicecandidate = (ev) => {
    if (ev.candidate) {
      log('New ICE candidate:', ev.candidate)
    } else {
      log('ICE candidate gathering completed (null candidate)')
    }
  }

  pc.onicecandidateerror = (ev) => {
    // log('ICE candidate error:', ev.errorText || ev.errorCode || 'unknown error')
  }

  pc.onsignalingstatechange = () => {
    log('Signaling state changed:', pc.signalingState)
  }

  pc.oniceconnectionstatechange = () => {
    setKV('iceState', pc.iceConnectionState)
    log('ICE connection state changed:', pc.iceConnectionState)
  }

  pc.ondtlsstatechange = () => {
    const st = pc.sctp ? 'data' : pc.connectionState
    setKV('dtlsState', st)
    log('DTLS state changed, connState=', pc.connectionState, 'derived=', st)
  }

  pc.onconnectionstatechange = () => {
    setKV('connState', pc.connectionState)
    log('PeerConnection overall connectionState changed:', pc.connectionState)
  }

  pc.onnegotiationneeded = () => {
    if (pc.connectionState === 'connected') {
      log('negotiation needed fired')
    } else {
      log('negotiation needed fired, not connected')
    }
  }

  const transceiver = pc.addTransceiver('video', { direction: 'recvonly' })
  log('Video transceiver added', transceiver)

  const kbps = parseInt($('mtu').value, 10)
  if (!isNaN(kbps))
    log(
      'Note: maxBitrate is typically sender-side; server may enforce ~',
      kbps,
      'kbps.'
    )

  pc.ontrack = (ev) => {
    console.log('ontrack:', ev.streams, ev.track)

    if (ev.streams.length > 0) {
      video.srcObject = ev.streams[0]
    } else {
      const stream = new MediaStream([ev.track])
      video.srcObject = stream
    }

    video.muted = true
    setTimeout(async () => {
      try {
        video.play()
      } catch (error) {
        console.error('play() error:', error)
      }
    }, 100)
  }

  const offer = await pc.createOffer()
  localStorage.setItem('offer', offer.sdp)

  await pc.setLocalDescription(offer)

  console.log('offer created, local SDP set')

  const url = 'http://localhost:3001/api/offer'

  const headers = parseJSONSafely($('headers').value, {})
  const method = $('method').value
  const ctype = $('contentType').value

  const body = JSON.stringify({ offer: { sdp: offer.sdp, type: offer.type } })
  log('Sending offer to signaling URL', {
    url,
    method,
    contentType: 'application/json',
    headers,
    bodyLength: body ? body.length : 0,
  })

  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body,
  })

  // handle answer SDP from the server
  const { answer, connectionId: _connectionId } = await res.json()
  connectionId = _connectionId

  console.log('answerSDP:')
  console.log(answer)

  console.log('set remote description from answer')
  await pc.setRemoteDescription(answer)

  const { negotiationNeeded } = await startStream(connectionId)

  if (negotiationNeeded) {
    renegotiate()
  }

  let counter = 0
  // check stats
  const intervalId = setInterval(async () => {
    if (counter > 8) {
      clearInterval(intervalId)
      return
    }

    const stats = await pc.getStats()
    let inboundVideo, candidatePair

    stats.forEach((r) => {
      if (r.type === 'inbound-rtp' && r.kind === 'video') {
        inboundVideo = r
      }
      if (
        r.type === 'candidate-pair' &&
        r.state === 'succeeded' &&
        r.nominated
      ) {
        candidatePair = r
      }
      // if (r.type === 'remote-candidate') {
      //   console.log('remote-candidate:', r)
      // }
    })

    let inbound
    stats.forEach((r) => {
      if (r.type === 'inbound-rtp' && r.kind === 'video') inbound = r
    })
    if (inbound?.codecId) {
      const codec = stats.get(inbound.codecId)
      console.log(
        'codec mimeType=',
        codec?.mimeType,
        'pt=',
        codec?.payloadType,
        'fmtp=',
        codec?.sdpFmtpLine
      )
    } else {
      console.error('No inbound-rtp video codec found')
    }

    if (candidatePair) {
      console.log(
        'ICE selected pair',
        'rtt',
        candidatePair.currentRoundTripTime,
        'local',
        candidatePair.localCandidateId,
        'remote',
        candidatePair.remoteCandidateId
      )
    }

    if (inboundVideo) {
      console.log(
        'INBOUND video:',
        'bytes',
        inboundVideo.bytesReceived,
        'packets',
        inboundVideo.packetsReceived,
        'framesDecoded',
        inboundVideo.framesDecoded,
        'keyFramesDecoded',
        inboundVideo.keyFramesDecoded,
        'framesDropped',
        inboundVideo.framesDropped,
        'jitter',
        inboundVideo.jitter
      )
    } else {
      console.log('No inbound-rtp video yet')
    }

    counter++
  }, 1000)
}

async function startStream() {
  const url = `http://localhost:3001/api/connection/${connectionId}/stream/start`

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ videoFile: '1_traffic.mp4' }),
  })

  const { answer, negotiationNeeded } = await res.json()

  return { answer, negotiationNeeded }
}

async function renegotiate() {
  const url = `http://localhost:3001/api/connection/${connectionId}/renegotiation-offer`
  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ offer }),
  })

  const { answer } = await res.json()
  await pc.setRemoteDescription(answer)
}

// ----------------------------
// ----------------------------
// ----------------------------

// Функция для дебага WebRTC
function debugWebRTC(label, data) {
  console.log(`[WebRTC Debug] ${label}:`, data)
}

// Функция для проверки всех типов статистики
function debugStatsTypes(stats) {
  const statsByType = {}
  stats.forEach((r) => {
    if (!statsByType[r.type]) {
      statsByType[r.type] = []
    }
    statsByType[r.type].push(r)
  })

  debugWebRTC('Stats types found', Object.keys(statsByType))
  debugWebRTC(
    'Stats count by type',
    Object.fromEntries(
      Object.entries(statsByType).map(([type, arr]) => [type, arr.length])
    )
  )
}

// Функция для проверки состояния соединения
function debugConnectionState() {
  if (!pc) return
  debugWebRTC('Connection state', {
    connectionState: pc.connectionState,
    iceConnectionState: pc.iceConnectionState,
    signalingState: pc.signalingState,
  })
}

// Функция для проверки всех inbound-rtp
function debugInboundRtp(stats) {
  const allInboundRtp = Array.from(stats).filter(
    (r) => r.type === 'inbound-rtp'
  )

  if (allInboundRtp.length === 0) {
    debugWebRTC('Inbound-RTP', 'NONE FOUND')
    return
  }

  debugWebRTC(
    'Inbound-RTP found',
    allInboundRtp.map((r) => ({
      kind: r.kind,
      codecId: r.codecId,
      bytesReceived: r.bytesReceived,
      packetsReceived: r.packetsReceived,
      framesDecoded: r.framesDecoded,
    }))
  )
}

// Функция для проверки всех codec
function debugCodecs(stats) {
  const allCodecs = Array.from(stats).filter((r) => r.type === 'codec')

  if (allCodecs.length === 0) {
    debugWebRTC('Codecs', 'NONE FOUND')
    return
  }

  debugWebRTC(
    'Codecs found',
    allCodecs.map((c) => ({
      id: c.id,
      mimeType: c.mimeType,
      payloadType: c.payloadType,
      sdpFmtpLine: c.sdpFmtpLine,
    }))
  )
}

// Функция для проверки transport
function debugTransport(stats) {
  const transports = Array.from(stats).filter((r) => r.type === 'transport')

  if (transports.length === 0) {
    debugWebRTC('Transport', 'NONE FOUND')
    return
  }

  debugWebRTC(
    'Transport',
    transports.map((t) => ({
      dtlsState: t.dtlsState,
      selectedCandidatePairId: t.selectedCandidatePairId,
      localCertificateId: t.localCertificateId,
      remoteCertificateId: t.remoteCertificateId,
    }))
  )
}

// Главная функция проверки статистики
async function checkStats() {
  if (!pc) return
  try {
    const stats = await pc.getStats()

    debugStatsTypes(stats)
    debugConnectionState()
    debugInboundRtp(stats)
    debugCodecs(stats)
    debugTransport(stats)
  } catch (e) {
    console.error('Stats check error:', e)
  }
}

// ----------------------------
// ----------------------------
// ----------------------------

async function stop() {
  log('--- Stop WebRTC session ---')
  if (statsTimer) {
    clearInterval(statsTimer)
    statsTimer = null
    log('Stats timer cleared')
  }
  if (pc) {
    try {
      log('Closing PeerConnection…')
      pc.getSenders().forEach((s) => {
        try {
          if (s.track) {
            log('Stopping sender track kind=', s.track.kind)
            s.track.stop()
          }
        } catch (e) {
          log('Error stopping sender track:', e.message)
        }
      })
      pc.getReceivers().forEach((r) => {
        try {
          if (r.track) {
            log('Stopping receiver track kind=', r.track.kind)
            r.track.stop()
          }
        } catch (e) {
          log('Error stopping receiver track:', e.message)
        }
      })
      pc.getTransceivers().forEach((t) => {
        try {
          if (t.stop) {
            t.stop()
            log('Transceiver stopped, mid=', t.mid)
          }
        } catch (e) {
          log('Error stopping transceiver:', e.message)
        }
      })
      pc.close()
      log('PeerConnection closed')
    } catch (e) {
      log('Error while closing PeerConnection:', e.message)
    }
    pc = null
  }
  video.srcObject = null
  lastBytes = 0
  lastTs = 0
  setKV('bitrate', '-')
  setKV('frames', '-')
  setKV('iceState', '-')
  setKV('dtlsState', '-')
  setKV('connState', '-')
  log('Stopped.')
}

function snapshot() {
  if (!video.videoWidth) {
    log('Нет кадра для snapshot')
    return
  }
  canvas.width = video.videoWidth
  canvas.height = video.videoHeight
  const ctx = canvas.getContext('2d')
  ctx.drawImage(video, 0, 0)
  const url = canvas.toDataURL('image/png')
  const a = document.createElement('a')
  a.href = url
  a.download = 'snapshot_' + Date.now() + '.png'
  a.click()
  log('Snapshot saved, resolution=', video.videoWidth + 'x' + video.videoHeight)
}

function startPolling() {
  log('Starting stats polling…')
  statsTimer = setInterval(async () => {
    if (!pc) return
    try {
      const stats = await pc.getStats()
      stats.forEach((r) => {
        if (r.type === 'inbound-rtp' && r.kind === 'video') {
          const now = r.timestamp
          const bytes = r.bytesReceived
          if (lastTs && now > lastTs) {
            const bitrate =
              (8 * (bytes - lastBytes)) / ((now - lastTs) / 1000) / 1000 // kbps
            setKV('bitrate', bitrate.toFixed(0) + ' kbps')
          }
          lastBytes = bytes
          lastTs = now
          setKV('jitter', (r.jitter * 1000).toFixed(1) + ' ms')
          setKV(
            'frames',
            r.framesDecoded +
              ' (' +
              (r.frameWidth || '-') +
              '×' +
              (r.frameHeight || '-') +
              ')'
          )
        }
        if (
          r.type === 'codec' &&
          r.mimeType &&
          r.mimeType.toLowerCase().startsWith('video/')
        ) {
          selectedCodec = r.mimeType.split('/')[1]
          setKV(
            'codecInfo',
            selectedCodec + (r.sdpFmtpLine ? ' ' + r.sdpFmtpLine : '')
          )
        }
      })
    } catch (e) {
      log('getStats error:', e.message)
    }
  }, 1000)
}

function startPollingIceCandidates() {
  // Polling для ICE кандидатов
  const iceCandidatePollingInterval = setInterval(async () => {
    if (!connectionId) return

    // Проверяем состояние соединения
    const state = pc.connectionState
    if (state === 'closed' || state === 'failed' || state === 'disconnected') {
      stopPolling()
      return
    }

    // Проверяем, что remote description установлен перед добавлением кандидатов
    if (!pc.remoteDescription) {
      return
    }

    try {
      const response = await fetch(
        `http://localhost:3001/api/connection/${connectionId}/ice-candidates`
      )
      if (!response.ok) return

      const data = await response.json()
      console.log(data.candidates)

      if (data.candidates && data.candidates.length > 0) {
        for (const candidate of data.candidates) {
          try {
            // Проверяем, что кандидат не null и имеет правильный формат
            if (!candidate || !candidate.candidate) {
              continue
            }

            // Создаем RTCIceCandidate из объекта
            const iceCandidate = new RTCIceCandidate({
              ...candidate,
            })

            await pc.addIceCandidate(iceCandidate)
            console.log('Added server ICE candidate:', candidate.candidate)
          } catch (error) {
            console.error('Error adding ICE candidate:', error)
          }
        }
      }
    } catch (error) {
      console.error('Error polling ICE candidates:', error)
    }
  }, 1000) // Опрашиваем каждые 1000ms

  return iceCandidatePollingInterval
}

function stopPollingIceCandidates(id) {
  clearInterval(id)
}

async function _requestIceCandidates() {
  const res = await fetch('http://192.168.200.31:8444/0/0/live.ice', {
    method: 'POST',
    body: JSON.stringify({}),
  })

  const data = await res.json()

  console.log('ICE candidates from server', data)

  for (const candidate of data) {
    const c = new RTCIceCandidate({ candidate, sdpMid: '0', sdpMLineIndex: 0 })
    console.log('new ICE candidate from server', c)

    pc.addIceCandidate(c)
  }
}

$('btnStart').addEventListener('click', () => {
  log('Start button clicked')
  start().catch((e) => log('Start error:', e.message))
})
$('btnStop').addEventListener('click', () => {
  log('Stop button clicked')
  stop()
})
$('btnSnap').addEventListener('click', () => {
  log('Snapshot button clicked')
  snapshot()
})

// initial ICE servers value
$('iceservers').value = JSON.stringify(
  [{ urls: ['stun:stun.l.google.com:19302'] }],
  null,
  2
)
log('Page initialized, default ICE servers set')
