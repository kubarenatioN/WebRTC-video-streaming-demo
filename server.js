import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import wrtc from '@roamhq/wrtc'
import { spawn } from 'child_process'
import cors from 'cors'
import express from 'express'
import { readdirSync, statSync } from 'fs'
import { createServer } from 'http'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
const { nonstandard, RTCIceCandidate, RTCPeerConnection, RTCSessionDescription } = wrtc

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const app = express()
app.use(cors())
const server = createServer(app)

// Конфигурация ICE сервера
const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }]

// Хранилище активных подключений
// Структура: connectionId -> { pc, answer, serverIceCandidates[], clientIceCandidatesProcessed }
const connections = new Map()

// Директория с видео файлами
const VIDEOS_DIR = join(__dirname, 'videos')

// Middleware для статических файлов
app.use(express.static(join(__dirname, 'public')))
app.use(express.json())

// Список доступных видео файлов
app.get('/api/videos', (req, res) => {
  try {
    const files = readdirSync(VIDEOS_DIR)
      .filter((file) => {
        const ext = file.split('.').pop().toLowerCase()
        return ['mp4', 'webm', 'ogg', 'mov'].includes(ext)
      })
      .map((file) => ({
        name: file,
        path: `/videos/${file}`,
        size: statSync(join(VIDEOS_DIR, file)).size,
      }))
    res.json(files)
  } catch (error) {
    res.status(500).json({ error: 'Failed to read videos directory' })
  }
})

// Endpoint для получения видео файла
app.use('/videos', express.static(VIDEOS_DIR))

// HTTP endpoints для WebRTC signaling

// POST /api/offer - отправка offer от клиента
app.post('/api/offer', async (req, res) => {
  try {
    const { offer, connectionId } = req.body

    if (!offer) {
      return res.status(400).json({ error: 'Offer is required' })
    }

    const connId = connectionId || Date.now().toString()

    // Создаем RTCPeerConnection на сервере
    const peerConnection = new RTCPeerConnection({ iceServers })
    const serverIceCandidates = []

    const _onconnectionstatechange = () => {
      console.log(`Connection state for ${connId} changed to:`, peerConnection.connectionState)

      if (peerConnection.connectionState === 'connected') {
        console.log(`WebRTC connection established for ${connId}`)
      }
    }

    const _onicecandidate = (event) => {
      if (event.candidate) {
        // Сохраняем кандидат в формате, который можно сериализовать в JSON
        // Извлекаем все поля вручную для правильной сериализации
        const candidateData = {
          candidate: event.candidate.candidate || '',
          sdpMLineIndex: event.candidate.sdpMLineIndex ?? null,
          sdpMid: event.candidate.sdpMid ?? null,
          usernameFragment: event.candidate.usernameFragment || null,
        }

        if (candidateData.candidate && candidateData.candidate.trim() !== '') {
          serverIceCandidates.push(candidateData)
        }
      } else {
        // null candidate означает, что все кандидаты собраны
        console.log(`All ICE candidates gathered for ${connId}, total: ${serverIceCandidates.length}`)
      }
    }

    const _onnegotiationneeded = (e) => {
      console.log('negotiation needed')
    }

    // Обработка ICE кандидатов от сервера
    peerConnection.onicecandidate = _onicecandidate

    // Обработка ошибок ICE
    peerConnection.onicecandidateerror = (event) => {
      const { errorText, errorCode, address } = event
      console.error(`ICE candidate error for ${connId}:`, errorText, errorCode, address)
    }

    // Обработка установления соединения
    peerConnection.onconnectionstatechange = _onconnectionstatechange

    peerConnection.onnegotiationneeded = _onnegotiationneeded

    // Устанавливаем offer от клиента ПЕРВЫМ
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer))

    const answer = await peerConnection.createAnswer()
    await peerConnection.setLocalDescription(answer)
    console.log('set local SDP on OFFER')
    console.log('Remote description set, signaling state:', peerConnection.signalingState)

    // Сохраняем соединение
    connections.set(connId, {
      pc: peerConnection,
      answer: peerConnection.localDescription,
      negotiationNeeded: false,
      serverIceCandidates,
      clientIceCandidatesProcessed: 0,
    })

    res.json({
      connectionId: connId,
      answer: peerConnection.localDescription,
    })
  } catch (error) {
    console.error('Error handling offer:', error)
    res.status(500).json({ error: error.message })
  }
})

// GET /api/connection/:id/answer - получение answer (для polling, если нужно)
app.get('/api/connection/:id/answer', (req, res) => {
  const { id } = req.params
  const connection = connections.get(id)

  if (!connection) {
    return res.status(404).json({ error: 'Connection not found' })
  }

  res.json({
    answer: connection.answer,
  })
})

// GET /api/connection/:id/answer - получение answer (для polling, если нужно)
app.get('/api/connection/:id/negotiation-needed', (req, res) => {
  const { id } = req.params
  const connection = connections.get(id)

  if (!connection) {
    return res.status(404).json({ error: 'negotiationNeeded 404' })
  }

  res.json({
    negotiationNeeded: Boolean(connection.negotiationNeeded),
  })
})

// POST /api/connection/:id/renegotiation-offer - обработка renegotiation offer от клиента
app.post('/api/connection/:id/renegotiation-offer', async (req, res) => {
  try {
    const { id } = req.params
    const { offer } = req.body

    const connection = connections.get(id)
    if (!connection) {
      return res.status(404).json({ error: 'Connection not found' })
    }

    const pc = connection.pc

    // Устанавливаем новый offer от клиента
    await pc.setRemoteDescription(new RTCSessionDescription(offer))

    // Создаем новый answer (теперь это возможно, т.к. состояние have-remote-offer)
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)

    // Обновляем сохраненный answer
    connection.answer = pc.localDescription

    const ts = pc.getTransceivers()
    ts.forEach((t) => {
      console.log('transceiver:', transceiverToString(t))
    })

    console.log('Renegotiation completed for', id)
    console.log('New answer SDP contains video:', pc.localDescription.sdp.includes('m=video'))

    res.json({
      answer: pc.localDescription,
    })
  } catch (error) {
    console.error('Error handling renegotiation offer:', error)
    res.status(500).json({ error: error.message })
  }
})

// GET /api/connection/:id/ice-candidates - получение ICE кандидатов от сервера (polling)
app.get('/api/connection/:id/ice-candidates', (req, res) => {
  const { id } = req.params
  const connection = connections.get(id)

  if (!connection) {
    return res.status(404).json({ error: 'Connection not found' })
  }

  // Возвращаем новые кандидаты (те, которые еще не были отправлены)
  const lastIndex = connection.lastSentCandidateIndex || 0
  const newCandidates = connection.serverIceCandidates.slice(lastIndex)

  // console.log(`ICE candidates request for ${id}: total=${connection.serverIceCandidates.length}, lastSent=${lastIndex}, returning=${newCandidates.length}`)

  // Обновляем индекс последнего отправленного кандидата
  connection.lastSentCandidateIndex = connection.serverIceCandidates.length

  res.json({
    candidates: newCandidates,
    hasMore: false,
  })
})

// POST /api/connection/:id/ice-candidate - отправка ICE кандидата от клиента
app.post('/api/connection/:id/ice-candidate', async (req, res) => {
  try {
    console.log('ice candidate POST')

    const { id } = req.params
    const { candidate } = req.body

    const connection = connections.get(id)
    if (!connection) {
      return res.status(404).json({ error: 'Connection not found' })
    }

    if (candidate) {
      const _c = new RTCIceCandidate(candidate)
      await connection.pc.addIceCandidate(_c)
      // console.log(`Added client ICE candidate for ${id}`, _c)
    }

    res.json({ success: true })
  } catch (error) {
    console.error('Error adding ICE candidate:', error)
    res.status(500).json({ error: error.message })
  }
})

app.post('/api/connection/:id/stream/start', async (req, res) => {
  try {
    const { id } = req.params
    const { videoFile } = req.body

    const connection = connections.get(id)
    const pc = connection.pc
    let negotiationNeeded = false

    console.log('POST stream/start')

    try {
      const { negotiationNeeded: _negotiationNeeded } = await startStream(id, videoFile)
      negotiationNeeded = _negotiationNeeded
    } catch (error) {
      return res.status(404).json({ error: 'stream/start 404' })
    }

    res.json({
      answer: pc.localDescription,
      negotiationNeeded,
    })
  } catch (error) {
    console.error('Error starting video stream:', error)
    res.status(500).json({ error: error.message })
  }
})

app.post('/api/connection/:id/stream/pause', async (req, res) => {})

// DELETE /api/connection/:id - закрытие соединения
app.delete('/api/connection/:id', (req, res) => {
  const { id } = req.params
  const connection = connections.get(id)

  if (connection) {
    connection.pc.close()
    connections.delete(id)
    console.log(`Connection ${id} closed`)
    res.json({ success: true })
  } else {
    res.status(404).json({ error: 'Connection not found' })
  }
})

async function startStream(conId, videoFile) {
  const connection = connections.get(conId)
  const pc = connection.pc

  if (!connection) {
    throw new Error('Connection not found')
  }

  const videoPath = join(VIDEOS_DIR, videoFile)

  // Проверяем существование файла
  try {
    statSync(videoPath)
  } catch {
    console.error(`Video file not found: ${videoFile}`)
    throw new Error(`Video file not found: ${videoFile}`)
  }

  // Создаем видеотрек из файла
  const videoTrack = await createVideoTrackFromFile(videoPath)

  // Убеждаемся, что трек активен
  console.log('Video track initial state:', {
    id: videoTrack.id,
    kind: videoTrack.kind,
    enabled: videoTrack.enabled,
    readyState: videoTrack.readyState,
    muted: videoTrack.muted,
  })

  if (videoTrack.readyState !== 'live') {
    console.warn(`Video track readyState is '${videoTrack.readyState}', expected 'live'`)
  }
  if (!videoTrack.enabled) {
    console.warn('Video track is disabled, enabling it')
    videoTrack.enabled = true
  }

  // Проверяем состояние трека через небольшую задержку (FFmpeg может еще не начать отправлять кадры)
  setTimeout(() => {
    console.log('Video track state after 1 second:', {
      id: videoTrack.id,
      enabled: videoTrack.enabled,
      readyState: videoTrack.readyState,
      muted: videoTrack.muted,
    })
  }, 1000)

  // Добавляем обработчики событий трека для отладки
  videoTrack.onended = () => {
    console.log(`Video track ${videoTrack.id} ended`)
  }
  videoTrack.onmute = () => {
    console.log(`Video track ${videoTrack.id} muted`)
  }
  videoTrack.onunmute = () => {
    console.log(`Video track ${videoTrack.id} unmuted`)
  }

  const transceivers = pc.getTransceivers()
  // transceivers.forEach((t) => {
  //   console.log('transceiver:', transceiverToString(t))
  // })

  // Ищем существующий transceiver от клиента
  const videoTransceiver = transceivers.find((t) => t.receiver?.track?.kind === 'video')

  if (videoTransceiver) {
    console.log('1. Found existing video transceiver from client:', transceiverToString(videoTransceiver))

    // Клиент создал recvonly, но для отправки медиа сервер должен изменить направление на sendonly или sendrecv
    // Если оставить recvonly, currentDirection станет inactive и медиа не будет передаваться
    // Изменяем направление на sendonly (сервер отправляет, клиент получает)
    videoTransceiver.direction = 'sendonly'

    if (videoTransceiver.sender) {
      // set track for sender
      await videoTransceiver.sender.replaceTrack(videoTrack)
    } else {
      console.log('Sender does not exist, adding new track')
      const sender = pc.addTrack(videoTrack)
      console.log('Sender added:', sender.id)
    }

    // Проверяем результат
    console.log('2. Video transceiver after adding track:', transceiverToString(videoTransceiver))
  }

  // Проверяем, что sender имеет трек
  const senders = pc.getSenders()
  const videoSender = senders.find((s) => s.track && s.track.kind === 'video')
  if (videoSender) {
    console.log('Video sender found:', {
      trackId: videoSender.track.id,
      trackKind: videoSender.track.kind,
      trackEnabled: videoSender.track.enabled,
      trackReadyState: videoSender.track.readyState,
    })
  } else {
    console.warn('WARNING: No video sender found after adding transceiver!')
  }

  // После добавления трека, устанавливаем флаг что нужна renegotiation
  connection.negotiationNeeded = true

  // Проверяем наличие медиа-секций в SDP
  // const finalSdp = pc.localDescription.sdp
  // checkMediaSections(finalSdp)

  return { negotiationNeeded: true }
}

async function pauseStream() {}

// Запуск сервера
const PORT = process.env.PORT || 3000
server.listen(PORT, () => {
  console.log(`WebRTC server running on http://localhost:${PORT}`)
  console.log(`Videos directory: ${VIDEOS_DIR}`)

  // Проверяем существование директории с видео
  try {
    const files = readdirSync(VIDEOS_DIR)
    console.log(`Found ${files.length} files in videos directory`)
    console.log('\n\n\n')
  } catch (error) {
    console.warn(`Videos directory not found. Creating ${VIDEOS_DIR}`)
  }
})

// Функция для создания видеотрека из видео файла
async function createVideoTrackFromFile(videoPath) {
  return new Promise((resolve, reject) => {
    try {
      // Используем nonstandard API из wrtc для создания видеотрека
      const { RTCVideoSource } = nonstandard

      if (!RTCVideoSource) {
        reject(new Error('RTCVideoSource not available in this wrtc version'))
        return
      }

      // Фиксированное разрешение для WebRTC стриминга
      const width = 640
      const height = 480

      const videoSource = new RTCVideoSource()
      const track = videoSource.createTrack()

      // Используем локальный бинарник ffmpeg из npm пакета
      // Масштабируем исходное видео до фиксированного разрешения 640x480
      const ffmpeg = spawn(ffmpegInstaller.path, [
        '-re', // Читать с реальной скоростью
        '-i',
        videoPath,
        '-vf',
        'scale=640:480', // Масштабирование до фиксированного разрешения
        '-f',
        'rawvideo',
        '-pix_fmt',
        'yuv420p', // Формат пикселей: YUV420p (I420)
        '-r',
        '30', // 30 FPS
        '-', // Вывод в stdout
      ])

      const frameSize = (width * height * 3) / 2 // YUV420p формат: width * height * 1.5
      let frameBuffer = Buffer.alloc(0)
      let frameCount = 0

      ffmpeg.stdout.on('data', (chunk) => {
        frameBuffer = Buffer.concat([frameBuffer, chunk])

        while (frameBuffer.length >= frameSize) {
          const frame = frameBuffer.slice(0, frameSize)
          frameBuffer = frameBuffer.slice(frameSize)

          try {
            // Проверяем размер кадра
            if (frame.length !== frameSize) {
              console.warn(`Frame ${frameCount} size mismatch: expected ${frameSize}, got ${frame.length}. Skipping.`)
              continue
            }

            frameCount++

            // Логируем первые несколько кадров и затем каждые 100 кадров
            if (frameCount <= 5 || frameCount % 200 === 0 || frameCount === frameSize - 1) {
              // console.log(`Processing frame ${frameCount}, track readyState: ${track.readyState}, track enabled: ${track.enabled}`)
            }

            // RTCVideoSource.onFrame ожидает данные в формате I420 (YUV420p)
            // Преобразуем Buffer в Uint8ClampedArray
            const yuvData = new Uint8ClampedArray(frame)

            // Проверяем, что размер данных правильный перед передачей
            if (yuvData.byteLength !== frameSize) {
              console.warn(`Uint8ClampedArray size mismatch: expected ${frameSize}, got ${yuvData.byteLength}`)
              continue
            }

            videoSource.onFrame({
              width,
              height,
              data: yuvData,
            })
          } catch (err) {
            // Логируем все ошибки для первых 10 кадров, затем только каждую 100-ю
            if (frameCount <= 10 || frameCount % 100 === 0) {
              console.error(`Error processing frame ${frameCount}:`, err.message)
            }
          }
        }
      })

      ffmpeg.on('error', (error) => {
        console.error('FFmpeg error:', error)
        reject(error)
      })

      ffmpeg.on('close', (code) => {
        console.log(`FFmpeg process exited with code ${code}, total frames processed: ${frameCount}`)
        if (code !== 0 && code !== null) {
          reject(new Error(`FFmpeg exited with code ${code}`))
        }
      })

      ffmpeg.stderr.on('data', (data) => {
        // Логируем первые несколько строк stderr для отладки
        // const stderrStr = data.toString()
        // if (frameCount < 5) {
        //   console.log('FFmpeg stderr:', stderrStr.substring(0, 200))
        // }
      })

      // Разрешаем промис сразу после создания трека, не дожидаясь данных
      console.log('Video track created, waiting for FFmpeg to start sending frames...')
      ffmpeg.stderr.on('data', () => {
        // Игнорируем
      })

      resolve(track)
    } catch (error) {
      reject(error)
    }
  })
}

function checkMediaSections(sdp) {
  // Проверяем наличие медиа-секций в SDP
  const finalSdp = sdp

  if (finalSdp && !finalSdp.includes('m=video')) {
    console.warn('WARNING: Answer SDP does not contain video media section!')
    console.warn('Full SDP:', finalSdp)
  } else {
    console.log('Answer SDP contains video media section')
    // Логируем секцию видео
    const videoSection = finalSdp.match(/m=video[\s\S]*?(?=m=|$)/)
    if (videoSection) {
      console.log('Video section:', videoSection[0].substring(0, 300))
    }
  }
}

function transceiverToString(transceiver) {
  return {
    direction: transceiver.direction,
    mid: transceiver.mid,
    currentDirection: transceiver.currentDirection,
    hasReceiver: !!transceiver.receiver?.track,
    receiverTrack: transceiver.receiver?.track?.kind,
    hasSender: !!transceiver.sender?.track,
    senderTrack: transceiver.sender?.track?.kind,
  }
}
