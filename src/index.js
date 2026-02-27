'use strict';

require('dotenv').config();

const express = require('express');
const StreamManager = require('./StreamManager');
const buildApiRouter = require('./api');
const logger = require('./logger');

const PORT = parseInt(process.env.PORT, 10) || 3000;

// ─── Load static stream configs ──────────────────────────────────────────────

let staticStreams;
try {
  staticStreams = require('../streams.config');
} catch (err) {
  logger.error('Failed to load streams.config.js', { err: err.message });
  process.exit(1);
}

if (!Array.isArray(staticStreams)) {
  logger.error('streams.config.js must export an array');
  process.exit(1);
}

for (const cfg of staticStreams) {
  if (!cfg.output?.streamKey) {
    logger.error('Missing streamKey for static stream', { id: cfg.id });
    process.exit(1);
  }
}

// ─── Start stream manager ─────────────────────────────────────────────────────

const manager = new StreamManager(staticStreams);
manager.startAll();

// ─── HTTP server ──────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// Health endpoint
app.get('/health', (_req, res) => {
  const streams = manager.list();
  const allLive = streams.every((s) => s.state === 'LIVE');

  res.status(allLive ? 200 : 207).json({
    status: allLive ? 'ok' : 'degraded',
    streams,
  });
});

// REST API
app.use('/api', buildApiRouter(manager));

const server = app.listen(PORT, () => {
  logger.info(`Server listening on port ${PORT}`, {
    health: `http://localhost:${PORT}/health`,
    api:    `http://localhost:${PORT}/api/streams`,
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    logger.error(`Port ${PORT} is already in use. Set a different PORT in .env`);
  } else {
    logger.error('Server error', { err: err.message });
  }
  process.exit(1);
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────

function shutdown(signal) {
  logger.info(`Received ${signal}, shutting down…`);
  manager.stopAll();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
