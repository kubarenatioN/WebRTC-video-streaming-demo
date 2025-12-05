import { spawn } from 'child_process'
import express from 'express'
import { readdirSync, statSync } from 'fs'
import { createServer } from 'http'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { nonstandard, RTCIceCandidate, RTCPeerConnection, RTCSessionDescription } from 'wrtc'

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
        serverIceCandidates.push(event.candidate)
        console.log(`Server ICE candidate for ${connId}`)
      }
    }

    // Обработка ошибок ICE
    peerConnection.onicecandidateerror = (event) => {
      console.error(`ICE candidate error for ${connId}:`, event)
    }

    // Обработка установления соединения
    peerConnection.onconnectionstatechange = () => {
      console.log(`Connection state for ${connId}:`, peerConnection.connectionState)
      if (peerConnection.connectionState === 'connected') {
        console.log(`WebRTC connection established for ${connId}`)
      }
    }

    // Устанавливаем offer от клиента
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer))

    // Создаем answer
    const answer = await peerConnection.createAnswer()
    await peerConnection.setLocalDescription(answer)

    // Сохраняем соединение
    connections.set(connId, {
      pc: peerConnection,
      answer: peerConnection.localDescription,
      answerUpdated: false,
      serverIceCandidates,
      clientIceCandidatesProcessed: 0,
    })

    // Если указан видео файл, начинаем стриминг
    if (videoFile) {
      startVideoStreaming(peerConnection, videoFile, connId)
    }

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
  const newCandidates = connection.serverIceCandidates.slice(connection.lastSentCandidateIndex || 0)

  if (connection.lastSentCandidateIndex === undefined) {
    connection.lastSentCandidateIndex = 0
  }
  connection.lastSentCandidateIndex = connection.serverIceCandidates.length

  res.json({
    candidates: newCandidates,
    hasMore: false, // В будущем можно добавить логику для определения
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
      await connection.pc.addIceCandidate(new RTCIceCandidate(candidate))
      console.log(`Added client ICE candidate for ${id}`)
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

      const videoSource = new RTCVideoSource()
      const track = videoSource.createTrack()

      // Используем ffmpeg для декодирования видео
      const ffmpeg = spawn('ffmpeg', [
        '-re', // Читать с реальной скоростью
        '-i',
        videoPath,
        '-f',
        'rawvideo',
        '-pix_fmt',
        'yuv420p',
        '-s',
        '640x480', // Разрешение
        '-r',
        '30', // 30 FPS
        '-', // Вывод в stdout
      ])

      const width = 640
      const height = 480
      const frameSize = (width * height * 3) / 2 // YUV420p формат
      let frameBuffer = Buffer.alloc(0)

      ffmpeg.stdout.on('data', (chunk) => {
        frameBuffer = Buffer.concat([frameBuffer, chunk])

        while (frameBuffer.length >= frameSize) {
          const frame = frameBuffer.slice(0, frameSize)
          frameBuffer = frameBuffer.slice(frameSize)

          // Конвертируем YUV420p в RGB для передачи
          // Создаем ImageData-подобный объект
          try {
            // Для YUV420p нужно конвертировать в RGBA
            const rgbaFrame = convertYUV420pToRGBA(frame, width, height)

            videoSource.onFrame({
              width,
              height,
              data: rgbaFrame,
            })
          } catch (err) {
            console.error('Error processing frame:', err)
          }
        }
      })

      ffmpeg.on('error', (error) => {
        console.error('FFmpeg error:', error)
        reject(error)
      })

      ffmpeg.on('close', (code) => {
        if (code !== 0 && code !== null) {
          console.log(`FFmpeg process exited with code ${code}`)
        }
      })

      // Игнорируем stderr от ffmpeg (там обычно информация о прогрессе)
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
async function startVideoStreaming(peerConnection, videoFile, connectionId) {
  try {
    const videoPath = join(VIDEOS_DIR, videoFile)

    // Проверяем существование файла
    try {
      statSync(videoPath)
    } catch {
      console.error(`Video file not found: ${videoFile}`)
      return
    }

    console.log(`Starting video stream: ${videoFile}`)

    try {
      // Создаем видеотрек из файла
      const videoTrack = await createVideoTrackFromFile(videoPath)

      // Добавляем трек в peer connection
      peerConnection.addTrack(videoTrack)
      console.log('Video track added to peer connection')

      // Создаем новый offer с видеотреком
      const offer = await peerConnection.createOffer()
      await peerConnection.setLocalDescription(offer)

      // Обновляем answer в хранилище для клиента
      const connection = Array.from(connections.entries()).find(([id, conn]) => conn.pc === peerConnection)
      if (connection) {
        connection[1].answer = peerConnection.localDescription
        connection[1].answerUpdated = true
      }
    } catch (error) {
      console.warn('Could not create video track from file:', error.message)
      console.warn('Make sure ffmpeg is installed and video file is valid')

      // Fallback: отправляем информацию о видео через DataChannel
      const dataChannel = peerConnection.createDataChannel('video-info', {
        ordered: true,
      })

      dataChannel.onopen = () => {
        console.log('DataChannel opened for video info')
        dataChannel.send(
          JSON.stringify({
            type: 'video-info',
            file: videoFile,
            url: `/videos/${videoFile}`,
          })
        )
      }
    }
  } catch (error) {
    console.error('Error starting video stream:', error)
  }
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
