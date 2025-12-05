import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import wrtc from '@roamhq/wrtc'
import { spawn } from 'child_process'
import express from 'express'
import { readdirSync, statSync } from 'fs'
import { createServer } from 'http'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
const { nonstandard, RTCIceCandidate, RTCPeerConnection, RTCSessionDescription } = wrtc

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const app = express()
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
    const { offer, connectionId, videoFile } = req.body

    if (!offer) {
      return res.status(400).json({ error: 'Offer is required' })
    }

    const connId = connectionId || Date.now().toString()
    console.log(`New connection request: ${connId}`)

    // Создаем RTCPeerConnection на сервере
    const peerConnection = new RTCPeerConnection({ iceServers })
    const serverIceCandidates = []

    // Обработка ICE кандидатов от сервера
    peerConnection.onicecandidate = (event) => {
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
          console.log(`\n\nServer ICE candidate for ${connId}: ${candidateData.candidate.substring(0, 60)}`)
          console.log(`--------------------------------`)
        }
      } else {
        // null candidate означает, что все кандидаты собраны
        console.log(`All ICE candidates gathered for ${connId}, total: ${serverIceCandidates.length}`)
      }
    }

    // Обработка ошибок ICE
    peerConnection.onicecandidateerror = (event) => {
      const { target, ...rest } = event
      console.error(`\n\nICE candidate error for ${connId}:`, rest)
      console.log(`--------------------------------`)
    }

    // Обработка установления соединения
    peerConnection.onconnectionstatechange = () => {
      console.log(`Connection state for ${connId}:`, peerConnection.connectionState)
      console.log(`--------------------------------`)
      if (peerConnection.connectionState === 'connected') {
        console.log(`////////////////////////////////////////////////////////////`)
        console.log(`WebRTC connection established for ${connId}`)

        // Проверяем состояние треков после подключения
        const senders = peerConnection.getSenders()
        console.log(`Senders count after connection: ${senders.length}`)
        // senders.forEach((sender, i) => {
        //   const track = sender.track
        //   console.log(`Sender ${i}: track=${track?.id}, kind=${track?.kind}, enabled=${track?.enabled}, readyState=${track?.readyState}`)
        // })

        // const transceivers = peerConnection.getTransceivers()
        // console.log(`Transceivers count after connection: ${transceivers.length}`)
        // transceivers.forEach((transceiver, i) => {
        //   console.log(`Transceiver ${i}: direction=${transceiver.direction}, mid=${transceiver.mid}, currentDirection=${transceiver.currentDirection}`)
        //   if (transceiver.sender && transceiver.sender.track) {
        //     const track = transceiver.sender.track
        //     console.log(`  Track: id=${track.id}, kind=${track.kind}, enabled=${track.enabled}, readyState=${track.readyState}`)
        //   }
        // })
      }
      console.log(`////////////////////////////////////////////////////////////`)
    }

    // Проверяем offer от клиента перед установкой
    console.log('Offer from client - type:', offer.type)
    if (offer.sdp) {
      const offerVideoMatches = offer.sdp.match(/m=video/g)
      const offerAudioMatches = offer.sdp.match(/m=audio/g)
      console.log(`Offer SDP media sections - video: ${offerVideoMatches ? offerVideoMatches.length : 0}, audio: ${offerAudioMatches ? offerAudioMatches.length : 0}`)
      if (!offerVideoMatches || offerVideoMatches.length === 0) {
        console.warn('WARNING: Offer from client does not contain video media section!')
        console.warn('Client may not be requesting video. Offer SDP preview:', offer.sdp.substring(0, 300))
      }
    }

    // Устанавливаем offer от клиента ПЕРВЫМ
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer))
    console.log('Remote description set, signaling state:', peerConnection.signalingState)

    // ВАЖНО: Если указан видео файл, добавляем видеотрек ПОСЛЕ установки remoteDescription
    // В состоянии "have-remote-offer" можно добавлять новые transceivers для отправки медиа
    let videoTrack = null
    if (videoFile) {
      try {
        const videoPath = join(VIDEOS_DIR, videoFile)

        // Проверяем существование файла
        try {
          statSync(videoPath)
        } catch {
          console.error(`Video file not found: ${videoFile}`)
          throw new Error(`Video file not found: ${videoFile}`)
        }

        console.log()
        console.log(`Creating video track after setting remote description: ${videoFile}`)
        console.log(`================================`)

        // Создаем видеотрек из файла
        videoTrack = await createVideoTrackFromFile(videoPath)

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

        // ВАЖНО: Используем существующий transceiver от клиента вместо создания нового
        // Клиент уже создал transceiver с recvonly, мы должны использовать его
        const transceivers = peerConnection.getTransceivers()
        // console.log(`Existing transceivers count: ${transceivers.length}`)
        // transceivers.forEach((t, i) => {
        //   console.log(`Transceiver ${i}: direction=${t.direction}, mid=${t.mid}, receiver.track.kind=${t.receiver?.track?.kind}`)
        // })

        // Ищем существующий video transceiver от клиента (recvonly)
        // После setRemoteDescription клиентский transceiver имеет direction='recvonly' и mid='0'
        // У него может еще не быть receiver.track, потому что трек придет только после установки соединения
        // Ищем по mid='0' и direction='recvonly'
        let videoTransceiver = transceivers.find((t) => t.mid === '0')

        // Если не нашли по mid, ищем по receiver.track (на случай, если трек уже есть)
        if (!videoTransceiver) {
          videoTransceiver = transceivers.find((t) => t.receiver && t.receiver.track && t.receiver.track.kind === 'video')
        }

        if (videoTransceiver) {
          console.log('Found existing video transceiver from client:', {
            direction: videoTransceiver.direction,
            mid: videoTransceiver.mid,
            currentDirection: videoTransceiver.currentDirection,
            receiverTrack: videoTransceiver.receiver?.track?.kind,
            hasSender: !!videoTransceiver.sender,
            senderTrack: videoTransceiver.sender?.track?.kind,
          })

          // Клиент создал recvonly, но для отправки медиа сервер должен изменить направление на sendonly или sendrecv
          // Если оставить recvonly, currentDirection станет inactive и медиа не будет передаваться
          // Изменяем направление на sendrecv (сервер отправляет, клиент получает)
          // videoTransceiver.direction = 'sendrecv'

          // !!!:
          videoTransceiver.direction = 'sendonly'
          console.log('Changed transceiver direction to sendrecv for media transmission')

          // Добавляем трек к существующему sender или создаем sender, если его нет
          if (videoTransceiver.sender) {
            // Если sender уже есть, используем replaceTrack (работает даже если трека нет)
            console.log('Using replaceTrack on existing sender')
            await videoTransceiver.sender.replaceTrack(videoTrack)
          } else {
            // Если sender нет, используем addTrack - он должен использовать существующий transceiver
            console.log('Transceiver has no sender, using addTrack (should reuse transceiver)')
            const sender = peerConnection.addTrack(videoTrack)
            console.log('addTrack returned sender:', sender.id)
          }

          // Проверяем результат
          console.log('---> Video transceiver after adding track:', {
            direction: videoTransceiver.direction,
            mid: videoTransceiver.mid,
            senderTrack: videoTransceiver.sender?.track?.id,
            currentDirection: videoTransceiver.currentDirection,
          })
        } else {
          // Если не нашли существующий, создаем новый (fallback)
          console.warn('WARNING: No existing video transceiver found, creating new one')
          const transceiver = peerConnection.addTransceiver(videoTrack, {
            direction: 'sendonly',
          })
          console.log('New video transceiver created:', {
            direction: transceiver.direction,
            mid: transceiver.mid,
          })
        }

        console.log('Senders count:', peerConnection.getSenders().length)
        console.log('Transceivers count:', peerConnection.getTransceivers().length)

        // Проверяем, что sender имеет трек
        const senders = peerConnection.getSenders()
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
      } catch (error) {
        console.warn('Could not add video track after remote description:', error.message)
        console.warn('Answer will be created without video track')
      }
    }

    // Проверяем transceivers перед созданием answer
    const transceiversBeforeAnswer = peerConnection.getTransceivers()
    // console.log(`Transceivers count before createAnswer: ${transceiversBeforeAnswer.length}`)
    // transceiversBeforeAnswer.forEach((t, i) => {
    //   console.log(
    //     `Transceiver ${i} before answer: direction=${t.direction}, mid=${t.mid}, currentDirection=${t.currentDirection}, kind=${
    //       t.receiver?.track?.kind || t.sender?.track?.kind || 'unknown'
    //     }`
    //   )
    // })

    // Создаем answer (теперь с видеотреком, если он был добавлен)
    // Используем опции для создания answer с правильными параметрами
    const answer = await peerConnection.createAnswer()

    // Детальное логирование SDP для диагностики
    console.log('Answer SDP preview (first 500 chars):', answer.sdp.substring(0, 500))
    console.log('Answer type:', answer.type)
    console.log('--------------------------------')
    console.log()

    // Проверяем transceivers перед установкой localDescription
    const transceiversBeforeSet = peerConnection.getTransceivers()
    console.log(`Transceivers before setLocalDescription: ${transceiversBeforeSet.length}`)
    transceiversBeforeSet.forEach((t, i) => {
      console.log(`Transceiver ${i} before setLocal: direction=${t.direction}, mid=${t.mid}, currentDirection=${t.currentDirection}`)
    })

    console.log('--------------------------------')
    console.log()

    await peerConnection.setLocalDescription(answer)

    // Проверяем transceivers после установки localDescription
    const transceiversAfterSet = peerConnection.getTransceivers()
    console.log(`Transceivers after setLocalDescription: ${transceiversAfterSet.length}`)
    transceiversAfterSet.forEach((t, i) => {
      console.log(`Transceiver ${i} after setLocal: direction=${t.direction}, mid=${t.mid}, currentDirection=${t.currentDirection}`)
    })

    console.log()
    console.log('--------------------------------')
    console.log()

    // Проверяем наличие медиа-секций в SDP
    const finalSdp = peerConnection.localDescription.sdp
    const videoMediaMatches = finalSdp.match(/m=video/g)
    const audioMediaMatches = finalSdp.match(/m=audio/g)
    console.log(`Final SDP media sections - video: ${videoMediaMatches ? videoMediaMatches.length : 0}, audio: ${audioMediaMatches ? audioMediaMatches.length : 0}`)

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

    console.log()
    console.log('--------------------------------')
    console.log()

    // Сохраняем соединение
    connections.set(connId, {
      pc: peerConnection,
      answer: peerConnection.localDescription,
      answerUpdated: false,
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
    hasUpdate: connection.answerUpdated || false,
  })
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

  console.log(`ICE candidates request for ${id}: total=${connection.serverIceCandidates.length}, lastSent=${lastIndex}, returning=${newCandidates.length}`)

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
    const { id } = req.params
    const { candidate } = req.body

    const connection = connections.get(id)
    if (!connection) {
      return res.status(404).json({ error: 'Connection not found' })
    }

    if (candidate) {
      const _c = new RTCIceCandidate(candidate)
      await connection.pc.addIceCandidate(_c)
      console.log(`Added client ICE candidate for ${id}`, _c)
    }

    res.json({ success: true })
  } catch (error) {
    console.error('Error adding ICE candidate:', error)
    res.status(500).json({ error: error.message })
  }
})

// POST /api/connection/:id/video - запрос на стриминг видео
app.post('/api/connection/:id/video', async (req, res) => {
  try {
    const { id } = req.params
    const { videoFile } = req.body

    const connection = connections.get(id)
    if (!connection) {
      return res.status(404).json({ error: 'Connection not found' })
    }

    if (!videoFile) {
      return res.status(400).json({ error: 'Video file is required' })
    }

    await startVideoStreaming(connection.pc, videoFile, id)
    res.json({ success: true })
  } catch (error) {
    console.error('Error starting video stream:', error)
    res.status(500).json({ error: error.message })
  }
})

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
              console.log(`Processing frame ${frameCount}, track readyState: ${track.readyState}, track enabled: ${track.enabled}`)
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

// Упрощенная функция конвертации YUV420p в RGBA
function convertYUV420pToRGBA(yuvBuffer, width, height) {
  const rgba = new Uint8ClampedArray(width * height * 4)
  const ySize = width * height
  const uvSize = (width / 2) * (height / 2)

  // YUV420p структура: Y плоскость, затем U плоскость, затем V плоскость
  const yPlane = yuvBuffer.subarray(0, ySize)
  const uPlane = yuvBuffer.subarray(ySize, ySize + uvSize)
  const vPlane = yuvBuffer.subarray(ySize + uvSize, ySize + uvSize * 2)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const yIndex = y * width + x
      const uvX = Math.floor(x / 2)
      const uvY = Math.floor(y / 2)
      const uvIndex = uvY * Math.floor(width / 2) + uvX

      const Y = yPlane[yIndex]
      const U = uPlane[uvIndex] - 128
      const V = vPlane[uvIndex] - 128

      // YUV to RGB conversion (ITU-R BT.601)
      let R = Y + 1.402 * V
      let G = Y - 0.344 * U - 0.714 * V
      let B = Y + 1.772 * U

      R = Math.max(0, Math.min(255, Math.round(R)))
      G = Math.max(0, Math.min(255, Math.round(G)))
      B = Math.max(0, Math.min(255, Math.round(B)))

      const rgbaIndex = (y * width + x) * 4
      rgba[rgbaIndex] = R
      rgba[rgbaIndex + 1] = G
      rgba[rgbaIndex + 2] = B
      rgba[rgbaIndex + 3] = 255 // Alpha
    }
  }

  return rgba
}

// Функция для начала стриминга видео
// ПРИМЕЧАНИЕ: Эта функция больше не используется для добавления трека,
// так как трек теперь добавляется ПЕРЕД созданием answer в POST /api/offer
// Оставлена для совместимости и возможного использования в будущем
async function startVideoStreaming(peerConnection, videoFile, connectionId) {
  console.log(`Video streaming already started for ${videoFile} (track added before answer creation)`)
  // Видеотрек уже добавлен в POST /api/offer перед созданием answer
  // Здесь можно добавить дополнительную логику, если нужно
}

// Запуск сервера
const PORT = process.env.PORT || 3000
server.listen(PORT, () => {
  console.log(`WebRTC server running on http://localhost:${PORT}`)
  console.log(`Videos directory: ${VIDEOS_DIR}`)

  // Проверяем существование директории с видео
  try {
    const files = readdirSync(VIDEOS_DIR)
    console.log(`Found ${files.length} files in videos directory`)
  } catch (error) {
    console.warn(`Videos directory not found. Creating ${VIDEOS_DIR}`)
  }
})
