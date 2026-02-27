'use strict';

const { Router } = require('express');

/**
 * REST API for managing stream relays at runtime.
 *
 * Mounted at /api by index.js — receives the StreamManager instance.
 */
function buildRouter(manager) {
  const router = Router();

  // ── GET /api/streams ──────────────────────────────────────────────────────
  // List all streams with their current state.
  router.get('/streams', (_req, res) => {
    res.json(manager.list());
  });

  // ── GET /api/streams/:id ──────────────────────────────────────────────────
  router.get('/streams/:id', (req, res) => {
    const stream = manager.get(req.params.id);
    if (!stream) return res.status(404).json({ error: 'Stream not found' });
    res.json(stream);
  });

  // ── POST /api/streams ─────────────────────────────────────────────────────
  // Create and start a new stream relay.
  //
  // Body:
  // {
  //   "id": "cam6",
  //   "name": "Cámara 6",
  //   "input": { "protocol": "srt", "port": 9006 },
  //   "output": { "streamKey": "abc123..." },
  //   "video": { "width": 1920, "height": 1080, "fps": 25, "bitrate": "4000k" }
  // }
  router.post('/streams', (req, res) => {
    const { id, name, input, output, video } = req.body ?? {};

    // Validation
    const errors = [];
    if (!id || typeof id !== 'string') errors.push('id (string) is required');
    if (!name || typeof name !== 'string') errors.push('name (string) is required');
    if (!input?.protocol || !['srt', 'rtmp'].includes(input.protocol))
      errors.push('input.protocol must be "srt" or "rtmp"');
    if (!input?.port || typeof input.port !== 'number')
      errors.push('input.port (number) is required');
    if (!output?.streamKey || typeof output.streamKey !== 'string')
      errors.push('output.streamKey (string) is required');
    if (!video?.fps || !video?.bitrate)
      errors.push('video.fps and video.bitrate are required');

    if (errors.length) {
      return res.status(400).json({ error: 'Validation failed', details: errors });
    }

    const cfg = {
      id: id.trim(),
      name: name.trim(),
      input: { protocol: input.protocol, port: input.port },
      output: { streamKey: output.streamKey.trim() },
      video: {
        width:   video.width   ?? 1920,
        height:  video.height  ?? 1080,
        fps:     video.fps,
        bitrate: video.bitrate,
        timecode: video.timecode ?? false,
      },
    };

    try {
      const status = manager.create(cfg);
      res.status(201).json(status);
    } catch (err) {
      if (err.code === 'DUPLICATE_ID') {
        return res.status(409).json({ error: err.message });
      }
      throw err;
    }
  });

  // ── DELETE /api/streams/:id ───────────────────────────────────────────────
  // Stop and remove a dynamic stream.
  router.delete('/streams/:id', (req, res) => {
    const result = manager.remove(req.params.id);

    if (!result.ok) {
      const status = result.reason === 'not_found' ? 404 : 403;
      const message = result.reason === 'static_stream'
        ? 'Static streams (from streams.config.js) cannot be deleted via API'
        : 'Stream not found';
      return res.status(status).json({ error: message });
    }

    res.status(200).json({ ok: true, id: req.params.id });
  });

  return router;
}

module.exports = buildRouter;
