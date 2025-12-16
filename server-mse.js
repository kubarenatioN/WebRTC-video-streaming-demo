import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import wrtc from '@roamhq/wrtc'
import { spawn } from 'child_process'
import cors from 'cors'
import express from 'express'
import { readdirSync, statSync } from 'fs'
import { createServer } from 'http'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
const {
  nonstandard,
  RTCIceCandidate,
  RTCPeerConnection,
  RTCSessionDescription,
} = wrtc

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const app = express()
app.use(cors())
const server = createServer(app)

// Конфигурация ICE сервера
const iceServers = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
]

// Хранилище активных подключений
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
      console.log(
        `Connection state for ${connId}:`,
        peerConnection.connectionState
      )

      if (peerConnection.connectionState === 'connected') {
        console.log(`connectionState: connected, for ${connId}`)
      }
    }

    const _onicecandidate = (event) => {
      if (event.candidate) {
        // console.log('on ice candidate', event.candidate.candidate)

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
        console.log(
          `All ICE candidates gathered for ${connId}, total: ${serverIceCandidates.length}`
        )
      }
    }

    const _onnegotiationneeded = (e) => {
      console.log('negotiation needed', e.type)
    }

    // Обработка ICE кандидатов от сервера
    peerConnection.onicecandidate = _onicecandidate

    // Обработка ошибок ICE
    peerConnection.onicecandidateerror = (event) => {
      // const { errorText, errorCode, address } = event
      // console.error(
      //   `ICE candidate error for ${connId}:`,
      //   errorText,
      //   errorCode,
      //   address
      // )
    }

    // Обработка установления соединения
    peerConnection.onconnectionstatechange = _onconnectionstatechange

    peerConnection.onnegotiationneeded = _onnegotiationneeded

    // await waitForIceGathering(peerConnection)

    // Устанавливаем offer от клиента ПЕРВЫМ
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer))

    // После setRemoteDescription transceivers уже созданы на основе offer
    // Меняем direction ПЕРЕД createAnswer, чтобы включить его в answer сразу
    const transceivers = peerConnection.getTransceivers()
    const videoTransceiver = transceivers.find(
      (t) => t.receiver?.track?.kind === 'video'
    )

    if (videoTransceiver) {
      // Клиент создал recvonly, но сервер должен отправлять видео
      // Меняем направление на sendonly ПЕРЕД createAnswer
      videoTransceiver.direction = 'sendonly'
    }

    console.log(
      1,
      'Set video transceiver direction to sendonly before creating answer:',
      transceiverToString(videoTransceiver)
    )

    let answer = await peerConnection.createAnswer()
    answer = setSdpSetupPassive(answer)
    await peerConnection.setLocalDescription(answer)

    setTimeout(() => {
      console.log(
        2,
        'After createAnswer, video transceiver direction:',
        transceiverToString(videoTransceiver)
      )
    }, 1200)

    // Сохраняем соединение
    connections.set(connId, {
      pc: peerConnection,
      serverIceCandidates: [],
      lastSentCandidateIndex: 0,
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

    _handleNegotiation(pc, offer)

    console.log('Renegotiation completed for', id)

    logTransceivers(pc, 'transceivers on renegotiation offer:')

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

  // console.log(
  //   `ICE candidates request for ${id}: total=${connection.serverIceCandidates.length}, lastSent=${lastIndex}, returning=${newCandidates.length}`
  // )

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
    console.log('ICE candidate POST\n')

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

// Play stream
app.post('/api/connection/:id/stream/play', async (req, res) => {
  try {
    const { id } = req.params
    const { videoFile, from } = req.body
    const connection = connections.get(id)

    console.log('POST stream/play')

    if (!connection) {
      return res.status(404).json({ error: 'No connection: stream/play' })
    }

    const pc = connection.pc

    // Определяем видео файл: если указан новый - используем его, иначе берем из connection
    const fileToUse = videoFile || connection.videoFile
    if (!fileToUse) {
      return res.status(400).json({
        error: 'Video file not specified and no previous video file found',
      })
    }

    const videoPath = videoFile
      ? join(VIDEOS_DIR, videoFile) // Новый файл - создаем путь
      : connection.videoPath // Resume - используем сохраненный путь

    // Получаем длительность видео файла
    let videoFileDuration
    try {
      videoFileDuration = await getVideoDuration(videoPath)
    } catch (error) {
      console.error('Error getting video duration:', error)
      return res
        .status(500)
        .json({ error: `Failed to get video duration: ${error.message}` })
    }

    // Преобразуем Unix timestamp (from) в позицию внутри видео
    let startTime = 0
    if (from) {
      // from - это Unix timestamp, преобразуем его в позицию внутри видео
      // Используем модуло для получения позиции в диапазоне [0, duration)
      startTime = from % videoFileDuration

      // Проверяем, что позиция в допустимом диапазоне
      if (startTime < 0 || startTime >= videoFileDuration) {
        return res.status(400).json({
          error: `Start time ${startTime} is out of range [0, ${videoFileDuration})`,
        })
      }
    } else {
      // Если from не указан, используем сохраненную позицию паузы или 0
      startTime = 0
    }

    console.log({
      videoFile: fileToUse,
      from,
      startTime,
      duration: videoFileDuration,
    })

    try {
      const { negotiationNeeded } = await playStream(id, videoFile, startTime)

      res.json({
        answer: pc.localDescription,
        negotiationNeeded,
      })
    } catch (error) {
      console.log('play stream error:', error)
      return res.status(404).json({ error: error.message || 'stream/play 404' })
    }
  } catch (error) {
    console.error('Error playing video stream:', error)
    res.status(500).json({ error: error.message })
  }
})

app.post('/api/connection/:id/stream/pause', async (req, res) => {
  try {
    const { id } = req.params
    const { currentTime } = req.body
    const connection = connections.get(id)

    if (!connection) {
      return res.status(404).json({ error: 'Connection not found' })
    }

    console.log('stream/pause at time from client:', currentTime)

    await pauseStream(id, currentTime)
    res.json({ success: true })
  } catch (error) {
    console.error('Error pausing stream:', error)
    res.status(500).json({ error: error.message })
  }
})

// DELETE /api/connection/:id - закрытие соединения
app.delete('/api/connection/:id', (req, res) => {
  const { id } = req.params
  const connection = connections.get(id)

  if (connection) {
    // Останавливаем FFmpeg если он запущен
    if (connection.ffmpeg && !connection.ffmpeg.killed) {
      connection.ffmpeg.kill()
    }

    connection.pc.close()
    connections.delete(id)
    console.log(`Connection ${id} closed`)
    res.json({ success: true })
  } else {
    res.status(404).json({ error: 'Connection not found' })
  }
})

//
// ----------------------------
// ----------------------------

async function pauseStream(conId, currentTime) {
  const connection = connections.get(conId)

  if (!connection) {
    throw new Error('Connection not found')
  }

  if (!connection.videoTrack) {
    throw new Error('No active stream to pause')
  }

  connection.isPaused = true

  // Останавливаем FFmpeg процесс - используем kill() вместо SIGSTOP
  // SIGSTOP может привести к проблемам при последующем kill()
  if (connection.ffmpeg && !connection.ffmpeg.killed) {
    connection.ffmpeg.kill() // Полностью убиваем процесс
  }

  connection.videoTrack.enabled = false

  console.log(`Stream paused for connection ${conId} at ${currentTime}s`)

  return { success: true }
}

async function playStream(conId, videoFile, startTime) {
  const connection = connections.get(conId)
  const pc = connection.pc

  if (!connection) {
    throw new Error('Connection not found')
  }

  if (!videoFile) {
    throw new Error('Video file not specified and no previous video file found')
  }

  // Определяем время начала
  const timeToStart = startTime !== undefined ? startTime : 0

  const videoPath = join(VIDEOS_DIR, videoFile)

  // Если указан новый файл, сохраняем его для будущего использования
  if (videoFile) {
    connection.videoFile = videoFile
    connection.videoPath = videoPath

    // Проверяем существование файла только для нового файла
    try {
      statSync(videoPath)
    } catch {
      console.error(`Video file not found: ${videoFile}`)
      throw new Error(`Video file not found: ${videoFile}`)
    }
  } else {
    // Для resume проверяем, что videoPath существует
    if (!connection.videoPath) {
      throw new Error('No video path found for resume')
    }
  }

  // ВАЖНО: Сбрасываем isPaused ДО создания нового трека,
  // чтобы новый FFmpeg процесс не пропускал кадры
  connection.isPaused = false

  // Убиваем старый FFmpeg процесс, если он есть
  if (connection.ffmpeg && !connection.ffmpeg.killed) {
    connection.ffmpeg.kill()
    // Даем процессу время завершиться
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  // Создаем видеотрек из файла с указанным временем начала
  const {
    track: videoTrack,
    videoSource,
    ffmpeg,
  } = await createVideoTrackFromFile(videoPath, connection, timeToStart)

  console.log('video track created:', {
    id: videoTrack.id,
    enabled: videoTrack.enabled,
    readyState: videoTrack.readyState,
  })

  if (videoTrack.readyState !== 'live') {
    console.warn(
      `Video track readyState is '${videoTrack.readyState}', expected 'live'`
    )
  }

  if (!videoTrack.enabled) {
    console.warn('Video track is disabled, enabling it')
    videoTrack.enabled = true
  }

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

  // Ищем существующий transceiver от клиента
  const videoTransceiver = transceivers.find(
    (t) => t.receiver?.track?.kind === 'video'
  )

  if (videoTransceiver) {
    // Direction уже должен быть установлен в sendonly при обработке offer
    // Проверяем и логируем, но не меняем (чтобы избежать negotiation needed)
    if (videoTransceiver.direction !== 'sendonly') {
      console.warn(
        'Video transceiver direction is not sendonly, was:',
        videoTransceiver.direction
      )
      // Не меняем direction здесь, чтобы избежать negotiation needed
    } else {
      console.log('Video transceiver direction is sendonly, OK')
    }

    if (videoTransceiver.sender) {
      // Заменяем трек в существующем sender
      await videoTransceiver.sender.replaceTrack(videoTrack)

      // ВАЖНО: Проверяем, что трек действительно заменен
      const replacedTrack = videoTransceiver.sender.track
      console.log('After replaceTrack:', {
        senderTrackId: replacedTrack?.id,
        senderTrackEnabled: replacedTrack?.enabled,
        senderTrackReadyState: replacedTrack?.readyState,
        transceiverDirection: videoTransceiver.direction,
        transceiverCurrentDirection: videoTransceiver.currentDirection,
      })

      // Убеждаемся, что новый трек включен
      if (replacedTrack && !replacedTrack.enabled) {
        console.warn('Replaced track is disabled, enabling it')
        replacedTrack.enabled = true
      }
    } else {
      console.log('Sender does not exist, adding new track')
      const sender = pc.addTrack(videoTrack)
      console.log('Sender added:', sender.id)
    }
  }

  // Обновляем connection
  connection.videoTrack = videoTrack
  connection.videoSource = videoSource
  connection.ffmpeg = ffmpeg

  console.log(
    `Stream playing for connection ${conId} from ${timeToStart}s (${videoFile})`
  )

  return { negotiationNeeded: false }
}

async function _handleNegotiation(pc, offer) {
  // Устанавливаем новый offer от клиента
  await pc.setRemoteDescription(new RTCSessionDescription(offer))

  // Создаем новый answer (теперь это возможно, т.к. состояние have-remote-offer)
  let answer = await pc.createAnswer()
  answer = setSdpSetupPassive(answer)

  await pc.setLocalDescription(answer)
}

// Функция для установки setup:passive в SDP
function setSdpSetupPassive(sdpDescription) {
  let sdp = sdpDescription.sdp

  // Заменяем существующие атрибуты setup
  sdp = sdp.replace(/a=setup:(active|actpass|passive)/gi, 'a=setup:passive')

  // Если атрибут setup отсутствует, добавляем его после a=fingerprint
  // Ищем последний a=fingerprint в SDP
  const fingerprintRegex = /(a=fingerprint:[^\r\n]+)/g
  const fingerprints = sdp.match(fingerprintRegex)

  if (fingerprints && !sdp.includes('a=setup:')) {
    // Добавляем после последнего fingerprint
    const lastFingerprint = fingerprints[fingerprints.length - 1]
    sdp = sdp.replace(
      new RegExp(`(${lastFingerprint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`),
      `$1\r\na=setup:passive`
    )
  }

  return {
    type: sdpDescription.type,
    sdp: sdp,
  }
}

// Запуск сервера
const PORT = process.env.PORT || 3001
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
async function createVideoTrackFromFile(videoPath, connection, startTime = 0) {
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

      const ffmpegArgs = [
        '-re', // Читать с реальной скоростью
      ]

      // Если указано время начала, добавляем параметр -ss
      if (startTime > 0) {
        ffmpegArgs.push('-ss', startTime.toString())
      }

      ffmpegArgs.push(
        '-i',
        videoPath,
        '-vf',
        'scale=640:480',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'yuv420p',
        '-r',
        '30',
        '-'
      )

      const ffmpeg = spawn(ffmpegInstaller.path, ffmpegArgs)

      const frameSize = (width * height * 3) / 2 // YUV420p формат: width * height * 1.5
      let frameBuffer = Buffer.alloc(0)
      let frameCount = 0

      ffmpeg.stdout.on('data', (chunk) => {
        frameBuffer = Buffer.concat([frameBuffer, chunk])

        while (frameBuffer.length >= frameSize) {
          const frame = frameBuffer.slice(0, frameSize)
          frameBuffer = frameBuffer.slice(frameSize)

          // Проверяем флаг паузы через замыкание
          if (connection && connection.isPaused) {
            // Пропускаем кадры во время паузы, но продолжаем читать из буфера
            continue
          }

          try {
            // Проверяем размер кадра
            if (frame.length !== frameSize) {
              console.warn(
                `Frame ${frameCount} size mismatch: expected ${frameSize}, got ${frame.length}. Skipping.`
              )
              continue
            }

            frameCount++

            // Логируем первые несколько кадров и затем каждые 100 кадров
            // if (
            //   frameCount <= 5 ||
            //   frameCount % 200 === 0 ||
            //   frameCount === frameSize - 1
            // ) {
            //   console.log(`Processing frame ${frameCount}, track readyState: ${track.readyState}, track enabled: ${track.enabled}`)
            // }

            // RTCVideoSource.onFrame ожидает данные в формате I420 (YUV420p)
            // Преобразуем Buffer в Uint8ClampedArray
            const yuvData = new Uint8ClampedArray(frame)

            // Проверяем, что размер данных правильный перед передачей
            if (yuvData.byteLength !== frameSize) {
              console.warn(
                `Uint8ClampedArray size mismatch: expected ${frameSize}, got ${yuvData.byteLength}`
              )
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
              console.error(
                `Error processing frame ${frameCount}:`,
                err.message
              )
            }
          }
        }
      })

      ffmpeg.on('error', (error) => {
        console.error('FFmpeg error:', error)
        reject(error)
      })

      ffmpeg.on('close', (code) => {
        console.log(
          `FFmpeg process exited with code ${code}, total frames processed: ${frameCount}`
        )
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

      ffmpeg.stderr.on('data', () => {
        // Игнорируем
      })

      // Разрешаем промис сразу после создания трека, не дожидаясь данных
      console.log(
        'Video track created, waiting for FFmpeg to start sending frames...'
      )
      resolve({ track, videoSource, ffmpeg })
    } catch (error) {
      reject(error)
    }
  })
}

function transceiverToString(transceiver) {
  return {
    direction: transceiver.direction,
    currentDirection: transceiver.currentDirection,
    mid: transceiver.mid,
    hasReceiver: !!transceiver.receiver?.track,
    receiverTrack: transceiver.receiver?.track?.kind,
    hasSender: !!transceiver.sender?.track,
    senderTrack: transceiver.sender?.track?.kind,
  }
}

function logTransceivers(pc, msg = 'transceivers:') {
  console.log(msg)

  pc.getTransceivers().forEach((t) => {
    console.log('transceiver:', transceiverToString(t))
  })
}

// Функция для получения длительности видео файла в секундах
async function getVideoDuration(videoPath) {
  return new Promise((resolve, reject) => {
    // Используем ffmpeg для получения информации о длительности
    // FFmpeg выводит информацию о длительности в stderr при попытке обработки файла
    const ffmpeg = spawn(ffmpegInstaller.path, [
      '-i',
      videoPath,
      '-f',
      'null',
      '-',
    ])

    let stderrOutput = ''

    // Длительность выводится в stderr
    ffmpeg.stderr.on('data', (data) => {
      stderrOutput += data.toString()
    })

    ffmpeg.on('error', (error) => {
      reject(new Error(`FFmpeg error: ${error.message}`))
    })

    ffmpeg.on('close', (code) => {
      // FFmpeg возвращает ненулевой код при использовании -f null,
      // но информация о длительности все равно выводится в stderr

      // Парсим длительность из stderr
      // Формат: Duration: HH:MM:SS.mmm
      const durationMatch = stderrOutput.match(
        /Duration:\s*(\d{2}):(\d{2}):(\d{2})\.(\d{2})/
      )

      if (!durationMatch) {
        reject(new Error('Could not parse video duration from ffmpeg output'))
        return
      }

      const hours = parseInt(durationMatch[1], 10)
      const minutes = parseInt(durationMatch[2], 10)
      const seconds = parseInt(durationMatch[3], 10)
      const centiseconds = parseInt(durationMatch[4], 10)

      const duration =
        hours * 3600 + minutes * 60 + seconds + centiseconds / 100
      resolve(duration)
    })
  })
}

function waitForIceGathering(pc) {
  // Wait for local ICE gathering to complete
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') {
      resolve()
      return
    }

    const checkState = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', checkState)
        resolve()
      }
    }

    pc.addEventListener('icegatheringstatechange', checkState)

    // Timeout fallback
    setTimeout(() => {
      pc.removeEventListener('icegatheringstatechange', checkState)
      resolve()
    }, 5000)
  })
}
