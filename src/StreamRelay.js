'use strict';

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { buildRelayArgs, buildFallbackArgs } = require('./ffmpeg');
const logger = require('./logger');

const STATES = {
  CONNECTING:    'CONNECTING',
  LIVE:          'LIVE',
  FROZEN:        'FROZEN',
  RECONNECTING:  'RECONNECTING',
};

const RECONNECT_INTERVAL_MS   = parseInt(process.env.RECONNECT_INTERVAL_MS, 10)   || 5000;
const RECONNECT_LIVE_TIMEOUT_MS = parseInt(process.env.RECONNECT_LIVE_TIMEOUT_MS, 10) || 10000;

class StreamRelay extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.log = logger.child({ stream: cfg.id });

    this.state = STATES.CONNECTING;
    this.startedAt = Date.now();
    this.reconnects = 0;

    this._relayProc = null;
    this._fallbackProc = null;
    this._reconnectTimer = null;
    this._reconnectLiveTimer = null;
    this._fallbackRestartTimer = null;
    this._stopped = false;
  }

  /** Start the relay (call once). */
  start() {
    this.log.info('Starting relay', { protocol: this.cfg.input.protocol, port: this.cfg.input.port });
    this._launchRelay();
  }

  /** Gracefully stop everything. */
  stop() {
    this._stopped = true;
    this._clearReconnectTimer();
    this._clearReconnectLiveTimer();
    this._clearFallbackRestartTimer();
    this._killProc(this._relayProc, 'relay');
    this._killProc(this._fallbackProc, 'fallback');
    this._relayProc = null;
    this._fallbackProc = null;
    this.log.info('Relay stopped');
  }

  /** Public state snapshot for health endpoint. */
  getStatus() {
    return {
      id: this.cfg.id,
      name: this.cfg.name,
      state: this.state,
      uptimeMs: Date.now() - this.startedAt,
      reconnects: this.reconnects,
    };
  }

  // ─── private ────────────────────────────────────────────────────────────────

  _setState(next) {
    if (this.state === next) return;
    this.log.info('State transition', { from: this.state, to: next });
    this.state = next;
    this.emit('stateChange', { id: this.cfg.id, state: next });
  }

  /** Returns a loggable version of ffmpeg args with the stream key redacted. */
  _redactArgs(args) {
    const key = this.cfg.output?.streamKey;
    const str = ['ffmpeg', ...args].join(' ');
    return key ? str.replace(key, '***') : str;
  }

  _launchRelay() {
    if (this._stopped) return;
    this._setState(STATES.CONNECTING);

    const args = buildRelayArgs(this.cfg);
    this.log.debug('Launching relay', { args: this._redactArgs(args) });

    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    this._relayProc = proc;

    let wentLive = false;

    proc.stderr.on('data', (chunk) => {
      const line = chunk.toString().trim();
      if (!line) return;

      // FFmpeg starts pushing once it connects to the source and begins output
      if (!wentLive && (line.includes('Output #0') || line.includes('frame='))) {
        wentLive = true;
        this._clearReconnectLiveTimer();
        this._setState(STATES.LIVE);
      }
      this.log.debug('ffmpeg[relay]', { line });
    });

    proc.on('exit', (code, signal) => {
      if (this._stopped) return;
      this.log.warn('Relay exited', { code, signal });
      this._relayProc = null;
      this._onRelayDown();
    });

    proc.on('error', (err) => {
      if (this._stopped) return;
      this.log.error('Relay process error', { err: err.message });
      this._relayProc = null;
      this._onRelayDown();
    });
  }

  _onRelayDown() {
    this._setState(STATES.FROZEN);
    this._launchFallback();
    this._scheduleReconnect();
  }

  _launchFallback() {
    if (this._stopped) return;
    this._clearFallbackRestartTimer();
    this._killProc(this._fallbackProc, 'fallback');

    const args = buildFallbackArgs(this.cfg);

    this.log.info('Launching fallback (black video)');
    this.log.debug('ffmpeg[fallback] args', { args: this._redactArgs(args) });

    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    this._fallbackProc = proc;

    proc.stderr.on('data', (chunk) => {
      this.log.debug('ffmpeg[fallback]', { line: chunk.toString().trim() });
    });

    proc.on('exit', (code, signal) => {
      if (this._stopped || this._fallbackProc !== proc) return;
      this.log.warn('Fallback exited unexpectedly, restarting', { code, signal });
      this._fallbackProc = null;
      // Restart fallback after a brief delay to avoid tight spin
      this._fallbackRestartTimer = setTimeout(() => {
        this._fallbackRestartTimer = null;
        this._launchFallback();
      }, 2000);
    });

    proc.on('error', (err) => {
      if (this._stopped) return;
      this.log.error('Fallback process error', { err: err.message });
      this._fallbackProc = null;
      this._fallbackRestartTimer = setTimeout(() => {
        this._fallbackRestartTimer = null;
        this._launchFallback();
      }, 2000);
    });
  }

  _scheduleReconnect() {
    this._clearReconnectTimer();
    this._reconnectTimer = setTimeout(() => this._attemptReconnect(), RECONNECT_INTERVAL_MS);
  }

  _attemptReconnect() {
    if (this._stopped) return;
    this.log.info('Attempting reconnect — opening port and waiting for camera');
    this.reconnects++;
    this._setState(STATES.RECONNECTING);
    this._clearReconnectTimer();

    // Kill fallback and start relay — relay opens the port and waits for the camera
    this._killProc(this._fallbackProc, 'fallback');
    this._fallbackProc = null;
    this._launchRelay();

    // If relay doesn't go LIVE within the timeout, revert to FROZEN and try again
    this._reconnectLiveTimer = setTimeout(() => {
      if (this.state !== STATES.LIVE) {
        this.log.info('Reconnect window expired — reverting to FROZEN');
        this._killProc(this._relayProc, 'relay');
        this._relayProc = null;
        this._onRelayDown();
      }
    }, RECONNECT_LIVE_TIMEOUT_MS);
  }

  _clearReconnectTimer() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  _clearReconnectLiveTimer() {
    if (this._reconnectLiveTimer) {
      clearTimeout(this._reconnectLiveTimer);
      this._reconnectLiveTimer = null;
    }
  }

  _clearFallbackRestartTimer() {
    if (this._fallbackRestartTimer) {
      clearTimeout(this._fallbackRestartTimer);
      this._fallbackRestartTimer = null;
    }
  }

  _killProc(proc, label) {
    if (!proc) return;
    try {
      proc.kill('SIGTERM');
      this.log.debug(`Sent SIGTERM to ${label}`);
      // Force kill if the process doesn't respond within 5 seconds
      const t = setTimeout(() => {
        try {
          if (proc.exitCode === null && !proc.killed) {
            proc.kill('SIGKILL');
            this.log.warn(`Sent SIGKILL to ${label} (SIGTERM timeout)`);
          }
        } catch (_) {}
      }, 5000);
      t.unref();
    } catch (_) {}
  }
}

module.exports = { StreamRelay, STATES };
