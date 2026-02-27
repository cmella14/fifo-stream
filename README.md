# fifo-stream

Multi-camera fault-tolerant video relay for football recording.

Receives SRT and RTMP signals from 5–8 cameras, relays them to Cloudflare Stream (RTMPS), and freezes the last captured frame to maintain synchronized recording if a camera drops.

## Architecture

```
[Camera 1] SRT/RTMP ──► StreamRelay-1 ──► rtmps://cloudflare/cam1
[Camera 2] SRT/RTMP ──► StreamRelay-2 ──► rtmps://cloudflare/cam2
...
[Camera N] SRT/RTMP ──► StreamRelay-N ──► rtmps://cloudflare/camN

State machine per relay: CONNECTING → LIVE → FROZEN → RECONNECTING → LIVE
```

## Requirements

- **Node.js** ≥ 18
- **FFmpeg** with SRT support (`apt install ffmpeg` on Ubuntu 22.04+)

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env and set your Cloudflare Stream keys

# 3. Configure cameras
# Edit streams.config.js — add/remove camera entries as needed

# 4. Start
npm start
```

## Configuration

### `.env`

| Variable | Description |
|---|---|
| `CF_KEY_CAM1`…`CF_KEY_CAMN` | Cloudflare Stream key per camera |
| `CF_RTMPS_URL` | Cloudflare ingest base URL (default: `rtmps://live.cloudflare.com/live`) |
| `PORT` | Health server port (default: `3000`) |
| `RECONNECT_INTERVAL_MS` | Seconds between reconnect probes (default: `5000`) |
| `LOG_LEVEL` | `debug` / `info` / `warn` / `error` (default: `info`) |

### `streams.config.js`

Each camera entry:

```js
{
  id: 'cam1',                        // unique ID, used in snapshots & logs
  name: 'Cámara 1 - Cenital',        // human-readable label
  input: {
    protocol: 'srt',                 // 'srt' or 'rtmp'
    port: 9001,                      // local listening port
  },
  output: {
    streamKey: process.env.CF_KEY_CAM1,
  },
  video: {
    width: 1920, height: 1080,       // used for smptebars fallback
    fps: 25,
    bitrate: '4000k',                // fallback encoder bitrate
    timecode: false,                 // optional: overlay local timecode
  },
}
```

## How it works

### Relay mode (LIVE)
FFmpeg listens on a local SRT or RTMP port, receives the camera signal, and relays it directly to Cloudflare Stream with `-c:v copy` (no re-encoding). Every 30 seconds it also writes a JPEG snapshot to `/tmp/lastframe-{id}.jpg`.

### Fallback mode (FROZEN)
When the relay FFmpeg process exits unexpectedly, the relay immediately:
1. Transitions to `FROZEN`
2. Launches a fallback FFmpeg that loops the last JPEG snapshot through `libx264` at the configured bitrate → Cloudflare. This keeps Cloudflare's recording timeline continuous.
3. If no snapshot exists (camera never connected), uses SMPTE color bars instead.

### Reconnect
Every `RECONNECT_INTERVAL_MS` the relay probes whether the source is reachable again. When it is, the fallback is killed and the main relay restarts (`RECONNECTING → LIVE`).

## Health endpoint

```
GET http://localhost:3000/health
```

Response:
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

HTTP 200 when all streams are LIVE, HTTP 207 when any stream is degraded.

## REST API

Manage streams at runtime. Dynamic streams are persisted to `streams.runtime.json` and restored on restart. Static streams defined in `streams.config.js` cannot be deleted via API.

### List all streams

```
GET /api/streams
```

### Get single stream

```
GET /api/streams/:id
```

### Create a stream

```
POST /api/streams
Content-Type: application/json

{
  "id": "cam6",
  "name": "Cámara 6 - Esquina",
  "input": { "protocol": "srt", "port": 9006 },
  "output": { "streamKey": "your-cloudflare-stream-key" },
  "video": { "width": 1920, "height": 1080, "fps": 25, "bitrate": "4000k" }
}
```

Returns `201` with the stream status on success, `409` if the id already exists, `400` on validation error.

`video.width`, `video.height`, and `video.timecode` are optional (defaults: 1920, 1080, false).

### Delete a stream

```
DELETE /api/streams/:id
```

Stops the relay immediately and removes it from persistence. Returns `404` if not found, `403` if it's a static stream.

## Multiview sync

Cloudflare records each stream on its own timeline. To sync during playback, use the recording start timestamps from the Cloudflare Stream API. Optionally enable timecode overlay per camera in `streams.config.js` (`video.timecode: true`).

## Ports

Default port layout (edit `streams.config.js` to change):

| Camera | Protocol | Port |
|---|---|---|
| cam1 | SRT | 9001 |
| cam2 | SRT | 9002 |
| cam3 | SRT | 9003 |
| cam4 | RTMP | 1935 |
| cam5 | RTMP | 1936 |

Open these ports in your firewall for cameras to connect.
