# fifo-stream

Multi-camera fault-tolerant video relay for football recording.

Receives SRT and RTMP signals from any number of cameras, relays them to Cloudflare Stream (RTMPS), and freezes the last captured frame to maintain a continuous recording if a camera drops. Streams are created and deleted at runtime via REST API.

## Architecture

```
[Camera 1] SRT/RTMP ──► StreamRelay-1 ──► rtmps://cloudflare/cam1
[Camera 2] SRT/RTMP ──► StreamRelay-2 ──► rtmps://cloudflare/cam2
...
[Camera N] SRT/RTMP ──► StreamRelay-N ──► rtmps://cloudflare/camN

State machine per relay: CONNECTING → LIVE → FROZEN → RECONNECTING → LIVE
```

No re-encoding in relay mode — FFmpeg passes video through with `-c:v copy`. Re-encoding only happens in fallback mode to loop the frozen frame.

## Requirements

- **Node.js** ≥ 18
- **FFmpeg** with SRT support

```bash
# Ubuntu 22.04+
apt install ffmpeg

# macOS
brew install ffmpeg
```

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env — set CF_RTMPS_URL if needed (default works for Cloudflare Stream)

# 3. Start
npm start
```

The server starts with no active streams. Add streams via the REST API.

## Configuration

### `.env`

| Variable | Default | Description |
|---|---|---|
| `CF_RTMPS_URL` | `rtmps://live.cloudflare.com/live` | Cloudflare ingest base URL |
| `PORT` | `3000` | HTTP server port |
| `RECONNECT_INTERVAL_MS` | `5000` | Interval between reconnect probes (ms) |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

### `streams.config.js`

Optional. Streams defined here are loaded at startup and cannot be deleted via API. Leave the array empty (default) to manage everything via API.

## REST API

All streams are managed at runtime. Dynamic streams persist across restarts via `streams.runtime.json`.

### List all streams

```
GET /api/streams
```

### Get a single stream

```
GET /api/streams/:id
```

### Create a stream

```
POST /api/streams
Content-Type: application/json
```

```json
{
  "id": "cam1",
  "name": "Cámara 1 - Cenital",
  "input": { "protocol": "srt", "port": 9001 },
  "output": { "streamKey": "your-cloudflare-stream-key" },
  "video": { "fps": 25, "bitrate": "4000k" }
}
```

| Field | Required | Description |
|---|---|---|
| `id` | yes | Unique identifier |
| `name` | yes | Human-readable label |
| `input.protocol` | yes | `"srt"` or `"rtmp"` |
| `input.port` | yes | Local port to listen on |
| `output.streamKey` | yes | Cloudflare Stream key |
| `video.fps` | yes | Frames per second |
| `video.bitrate` | yes | Fallback encoder bitrate (e.g. `"4000k"`) |
| `video.width` | no | Width for smptebars fallback (default: `1920`) |
| `video.height` | no | Height for smptebars fallback (default: `1080`) |
| `video.timecode` | no | Overlay local timecode on video (default: `false`) |

**Responses:** `201` created · `400` validation error · `409` id already exists

### Delete a stream

```
DELETE /api/streams/:id
```

Stops the relay immediately and removes it from persistence.

**Responses:** `200` deleted · `404` not found · `403` static stream (defined in `streams.config.js`)

## Health endpoint

```
GET /health
```

```json
{
  "status": "ok",
  "streams": [
    {
      "id": "cam1",
      "name": "Cámara 1 - Cenital",
      "state": "LIVE",
      "uptimeMs": 12345678,
      "reconnects": 0
    }
  ]
}
```

`HTTP 200` when all streams are LIVE — `HTTP 207` when any stream is degraded.

## How it works

### Relay mode (LIVE)
FFmpeg listens on a local SRT or RTMP port and relays the signal directly to Cloudflare with no re-encoding. Every 30 seconds it writes a JPEG snapshot to `/tmp/lastframe-{id}.jpg`.

### Fallback mode (FROZEN)
When the relay process exits unexpectedly:
1. State transitions to `FROZEN`
2. A fallback FFmpeg process immediately starts looping the last JPEG snapshot through `libx264` → Cloudflare, keeping the recording timeline continuous
3. If no snapshot exists (camera never connected), SMPTE color bars are used instead

### Reconnect
Every `RECONNECT_INTERVAL_MS` the relay probes the source. When it responds, the fallback is killed and the main relay restarts (`RECONNECTING → LIVE`).

## Multiview sync

Each stream is recorded independently on Cloudflare Stream. To synchronize playback across cameras, use the recording start timestamps from the Cloudflare Stream API. Enable per-camera timecode overlay with `video.timecode: true`.
