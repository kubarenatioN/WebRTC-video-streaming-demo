# WebRTC Video Streaming Server

Node.js сервер для стриминга видео файлов через WebRTC. Сервер выступает в роли одного из пиров в WebRTC соединении и использует HTTP для signaling между клиентом и сервером.

## Содержание

- [Возможности](#возможности)
- [Требования](#требования)
- [Установка и запуск](#установка-и-запуск)
- [Архитектура и логика работы](#архитектура-и-логика-работы)
- [Флоу взаимодействия](#флоу-взаимодействия)
- [API Endpoints](#api-endpoints)
- [Структура проекта](#структура-проекта)
- [Технические детали](#технические-детали)
- [Разработка](#разработка)

## Возможности

- ✅ WebRTC сервер на Node.js с поддержкой ESM
- ✅ Стриминг видео и аудио файлов из локальной директории
- ✅ HTTP signaling между клиентом и сервером
- ✅ Современный веб-интерфейс для просмотра видео
- ✅ Автоматическая установка FFmpeg через npm
- ✅ Поддержка множественных подключений
- ✅ Синхронизированная передача видео и аудио

## Требования

- Node.js 18+ (с поддержкой ESM)
- FFmpeg устанавливается автоматически через npm зависимость `@ffmpeg-installer/ffmpeg` (не требует системной установки)

## Установка и запуск

### 1. Установка зависимостей

```bash
npm install
```

### 2. Подготовка видео файлов

Поместите видео файлы в директорию `videos/`:

- Поддерживаемые форматы: MP4, WebM, OGG, MOV
- Рекомендуемое разрешение: 640x480 или выше
- Рекомендуемый FPS: 30

### 3. Запуск сервера

**Производственный режим:**
```bash
npm start
```

**Режим разработки (с автоперезагрузкой):**
```bash
npm run dev
```

Сервер будет доступен по адресу: `http://localhost:3000`

### 4. Использование

1. Откройте браузер и перейдите по адресу `http://localhost:3000`
2. Выберите видео файл из списка в правой панели
3. Нажмите кнопку "Подключиться" для установления WebRTC соединения
4. После подключения видео начнет стримиться через WebRTC

## Архитектура и логика работы

### Основные файлы

**Core логика реализована в следующих файлах:**

- `server.js` - основной сервер с WebRTC поддержкой
- `public/index.html` - веб-клиент для просмотра видео

**Примечание:** Файлы с префиксом `-mse` (`server-mse.js`, `public/index-mse.html`) предназначены для более специфичных условий использования и могут не корректно работать на актуальной версии ветки `main`. Используйте их только если требуется функциональность Media Source Extensions (MSE).

### server.js - Логика сервера

Сервер реализует WebRTC peer на стороне Node.js и отвечает за:

1. **Управление подключениями:**
   - Хранение активных WebRTC соединений в `Map` (connectionId → connection object)
   - Создание `RTCPeerConnection` для каждого клиента
   - Обработка ICE кандидатов и SDP обмена

2. **Обработка видео и аудио:**
   - Функция `createVideoAndAudioTracksFromFile()` создает оба трека одновременно
   - Использует два синхронизированных FFmpeg процесса:
     - Видео: декодирование в YUV420p (640x480, 30fps)
     - Аудио: декодирование в PCM 16-bit (48kHz, стерео)
   - Создание `RTCVideoSource` и `RTCAudioSource` через `wrtc` библиотеку
   - Передача кадров/сэмплов в WebRTC треки в реальном времени

3. **HTTP API endpoints:**
   - `/api/offer` - получение SDP offer от клиента, создание answer
   - `/api/connection/:id/ice-candidates` - получение ICE кандидатов (polling)
   - `/api/connection/:id/ice-candidate` - отправка ICE кандидата от клиента
   - `/api/connection/:id/stream/start` - запуск стриминга видео
   - `/api/connection/:id/renegotiation-offer` - обработка renegotiation
   - `/api/connection/:id/negotiation-needed` - проверка необходимости renegotiation

4. **Transceiver управление:**
   - Поиск существующих transceiver от клиента (recvonly)
   - Изменение направления на `sendonly` для отправки медиа
   - Добавление треков в transceiver через `replaceTrack()`

### public/index.html - Логика клиента

Клиент реализует WebRTC peer в браузере и отвечает за:

1. **Инициализация соединения:**
   - Создание `RTCPeerConnection` с ICE серверами (STUN)
   - Добавление transceiver для видео (`recvonly`) и аудио (`recvonly`)
   - Создание и отправка SDP offer через `/api/offer`

2. **Обработка медиа потоков:**
   - Обработчик `ontrack` для получения видео и аудио треков
   - Автоматическое добавление треков в `<video>` элемент
   - Обработка событий треков (ended, mute, unmute)

3. **Signaling через HTTP:**
   - Polling для получения ICE кандидатов от сервера (каждые 500ms)
   - Отправка ICE кандидатов клиента на сервер
   - Проверка необходимости renegotiation
   - Выполнение renegotiation при необходимости

4. **Управление стримингом:**
   - Функция `startVideoStream()` вызывает `/api/connection/:id/stream/start`
   - Автоматический запуск стрима после установления соединения
   - Обработка renegotiation после добавления медиа треков

5. **UI взаимодействие:**
   - Загрузка списка доступных видео через `/api/videos`
   - Выбор видео файла из списка
   - Кнопки подключения/отключения
   - Отображение статуса соединения

## Флоу взаимодействия

### 1. Инициализация соединения

```
Клиент (index.html)                    Сервер (server.js)
     |                                        |
     |-- POST /api/offer -------------------->|
     |   { offer, connectionId, videoFile }    |
     |                                        |-- Создает RTCPeerConnection
     |                                        |-- Устанавливает remote offer
     |                                        |-- Если videoFile указан:
     |                                        |     - Создает видео/аудио треки
     |                                        |     - Добавляет в transceiver
     |                                        |     - Меняет direction на sendonly
     |                                        |-- Создает answer
     |                                        |-- Начинает сбор ICE кандидатов
     |<-- { connectionId, answer } -----------|
     |                                        |
     |-- setLocalDescription(offer)          |
     |-- setRemoteDescription(answer)        |
```

### 2. Обмен ICE кандидатами

```
Клиент                                    Сервер
  |                                         |
  |-- onicecandidate ---------------------->|
  |   POST /api/connection/:id/ice-candidate
  |   { candidate }                         |
  |                                         |-- addIceCandidate()
  |                                         |
  |<-- GET /api/connection/:id/ice-candidates (polling каждые 500ms)
  |   { candidates: [...] }                |
  |                                         |
  |-- addIceCandidate() для каждого        |
```

### 3. Установление соединения и запуск стрима

```
Клиент                                    Сервер
  |                                         |
  |-- onconnectionstatechange: 'connected'  |
  |                                         |
  |-- POST /api/connection/:id/stream/start|
  |   { videoFile }                         |
  |                                         |-- startStream()
  |                                         |     - Создает видео/аудио треки
  |                                         |     - Добавляет в transceiver
  |                                         |     - Устанавливает negotiationNeeded = true
  |<-- { negotiationNeeded: true } --------|
  |                                         |
  |-- renegotiate()                         |
  |   - createOffer()                       |
  |   - POST /api/connection/:id/renegotiation-offer
  |     { offer }                           |
  |                                         |-- setRemoteDescription(offer)
  |                                         |-- createAnswer()
  |                                         |-- setLocalDescription(answer)
  |<-- { answer } --------------------------|
  |                                         |
  |-- setRemoteDescription(answer)         |
```

### 4. Стриминг медиа данных

```
Сервер                                    Клиент
  |                                         |
  |-- FFmpeg декодирует видео/аудио        |
  |-- videoSource.onFrame()                 |
  |-- audioSource.onData()                  |
  |                                         |
  |-- WebRTC передает данные -------------->|
  |                                         |-- ontrack event
  |                                         |-- remoteVideo.srcObject = stream
  |                                         |-- Видео начинает воспроизводиться
```

### 5. Закрытие соединения

```
Клиент                                    Сервер
  |                                         |
  |-- DELETE /api/connection/:id --------->|
  |                                         |-- Останавливает FFmpeg процессы
  |                                         |-- pc.close()
  |                                         |-- Удаляет из connections Map
  |<-- { success: true } ------------------|
  |                                         |
  |-- peerConnection.close()               |
```

## API Endpoints

### GET /api/videos

Возвращает список доступных видео файлов.

**Ответ:**
```json
[
  {
    "name": "video.mp4",
    "path": "/videos/video.mp4",
    "size": 1048576
  }
]
```

### POST /api/offer

Отправка SDP offer от клиента для установления WebRTC соединения.

**Тело запроса:**
```json
{
  "offer": { "type": "offer", "sdp": "..." },
  "connectionId": "optional-id",
  "videoFile": "video.mp4"
}
```

**Ответ:**
```json
{
  "connectionId": "connection-id",
  "answer": { "type": "answer", "sdp": "..." }
}
```

**Логика:**
- Создает новый `RTCPeerConnection` на сервере
- Устанавливает remote offer
- Если `videoFile` указан, создает видео/аудио треки и добавляет их в transceiver
- Создает и возвращает answer

### GET /api/connection/:id/ice-candidates

Получение ICE кандидатов от сервера (используется для polling).

**Ответ:**
```json
{
  "candidates": [
    {
      "candidate": "candidate:...",
      "sdpMLineIndex": 0,
      "sdpMid": "0"
    }
  ],
  "hasMore": false
}
```

### POST /api/connection/:id/ice-candidate

Отправка ICE кандидата от клиента на сервер.

**Тело запроса:**
```json
{
  "candidate": {
    "candidate": "candidate:...",
    "sdpMLineIndex": 0,
    "sdpMid": "0"
  }
}
```

### POST /api/connection/:id/stream/start

Запуск стриминга видео файла.

**Тело запроса:**
```json
{
  "videoFile": "video.mp4"
}
```

**Ответ:**
```json
{
  "negotiationNeeded": true,
  "answer": { "type": "answer", "sdp": "..." }
}
```

**Логика:**
- Создает видео и аудио треки из файла
- Добавляет треки в существующие transceiver
- Устанавливает `negotiationNeeded = true`
- Возвращает флаг необходимости renegotiation

### POST /api/connection/:id/renegotiation-offer

Обработка renegotiation offer от клиента.

**Тело запроса:**
```json
{
  "offer": { "type": "offer", "sdp": "..." }
}
```

**Ответ:**
```json
{
  "answer": { "type": "answer", "sdp": "..." }
}
```

### GET /api/connection/:id/negotiation-needed

Проверка необходимости renegotiation (для polling).

**Ответ:**
```json
{
  "negotiationNeeded": true
}
```

### DELETE /api/connection/:id

Закрытие WebRTC соединения.

**Ответ:**
```json
{
  "success": true
}
```

**Логика:**
- Останавливает все FFmpeg процессы
- Закрывает `RTCPeerConnection`
- Удаляет соединение из `connections` Map

## Структура проекта

```
node-webrtc-server/
├── server.js              # Основной сервер с WebRTC поддержкой
├── server-mse.js          # Альтернативная версия с MSE (может быть устаревшей)
├── package.json           # Зависимости и скрипты
├── public/                # Статические файлы
│   ├── index.html         # Основной веб-клиент
│   ├── index-mse.html     # Альтернативная версия с MSE (может быть устаревшей)
│   └── main.js            # Дополнительные утилиты
├── videos/                # Директория с видео файлами
└── README.md              # Документация
```

## Технические детали

### WebRTC Implementation

Сервер использует библиотеку `@roamhq/wrtc` для реализации WebRTC в Node.js:

- `RTCPeerConnection` - для установления соединения
- `RTCVideoSource` - для создания видеотреков из файлов
- `RTCAudioSource` - для создания аудио треков из файлов
- `RTCSessionDescription` - для работы с SDP
- `RTCIceCandidate` - для работы с ICE кандидатами

### Обработка медиа

**Видео:**
- Декодирование через FFmpeg в формат YUV420p
- Разрешение: 640x480
- FPS: 30
- Передача кадров через `RTCVideoSource.onFrame()`

**Аудио:**
- Декодирование через FFmpeg в PCM 16-bit
- Sample rate: 48kHz (стандарт WebRTC)
- Каналы: стерео (2)
- Размер фрейма: 10ms (1920 байт)
- Передача сэмплов через `RTCAudioSource.onData()`

**Синхронизация:**
- Оба FFmpeg процесса запускаются с одинаковыми параметрами `-re` и `-ss`
- Обработка данных происходит параллельно
- Треки добавляются в соответствующие transceiver одновременно

### HTTP Signaling

Сервер использует HTTP для обмена signaling сообщениями:

- Клиент отправляет `offer` через POST `/api/offer`
- Сервер возвращает `answer` в ответе
- Клиент опрашивает сервер через GET `/api/connection/:id/ice-candidates` (polling каждые 500ms)
- Клиент отправляет свои ICE кандидаты через POST `/api/connection/:id/ice-candidate`
- Используется polling вместо WebSocket для простоты реализации

### Transceiver управление

1. Клиент создает transceiver с `direction: 'recvonly'` при подключении
2. Сервер находит существующий transceiver от клиента
3. Сервер меняет `direction` на `sendonly` для отправки медиа
4. Сервер добавляет трек через `transceiver.sender.replaceTrack()`
5. После добавления трека требуется renegotiation

## Разработка

### Запуск в режиме разработки

```bash
npm run dev
```

Это запустит сервер с автоперезагрузкой при изменении файлов (используется `nodemon`).

### Отладка

Для отладки WebRTC соединения можно использовать:

- Логи в консоли сервера (ICE кандидаты, состояние соединения)
- DevTools браузера (WebRTC internals, Network tab)
- Проверка SDP через `/api/offer` и `/api/connection/:id/renegotiation-offer`

### Ограничения

- Видео декодируется в реальном времени, что может требовать ресурсов CPU
- Рекомендуется использовать видео файлы с разрешением не выше 1080p
- FFmpeg бинарник устанавливается автоматически через npm (не требует системной установки)
- Каждое подключение создает два FFmpeg процесса (видео + аудио)

## Лицензия

MIT
