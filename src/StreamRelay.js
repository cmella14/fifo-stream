'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const { EventEmitter } = require('events');
const { buildRelayArgs, buildFallbackArgs } = require('./ffmpeg');
const logger = require('./logger');

const STATES = {
  CONNECTING:    'CONNECTING',
  LIVE:          'LIVE',
  FROZEN:        'FROZEN',
  RECONNECTING:  'RECONNECTING',
};

const RECONNECT_INTERVAL_MS = parseInt(process.env.RECONNECT_INTERVAL_MS, 10) || 5000;

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

  _launchRelay() {
    if (this._stopped) return;
    this._setState(STATES.CONNECTING);

    const args = buildRelayArgs(this.cfg);
    this.log.debug('Launching relay', { args: ['ffmpeg', ...args].join(' ') });

    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this._relayProc = proc;

    let wentLive = false;

    proc.stderr.on('data', (chunk) => {
      const line = chunk.toString().trim();
      if (!line) return;

      // FFmpeg starts pushing once it connects to the source and begins output
      if (!wentLive && (line.includes('Output #0') || line.includes('frame='))) {
        wentLive = true;
        this._setState(STATES.LIVE);
      }
      this.log.debug('ffmpeg[relay]', { line });
    });

    proc.stdout.on('data', (chunk) => {
      if (!wentLive) {
        wentLive = true;
        this._setState(STATES.LIVE);
      }
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
    this._killProc(this._fallbackProc, 'fallback');

    const snapshotPath = `/tmp/lastframe-${this.cfg.id}.jpg`;
    const hasFrame = fs.existsSync(snapshotPath);
    const args = buildFallbackArgs(this.cfg, hasFrame);

    this.log.info('Launching fallback', { hasFrame });
    this.log.debug('ffmpeg[fallback] args', { args: ['ffmpeg', ...args].join(' ') });

    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this._fallbackProc = proc;

    proc.stderr.on('data', (chunk) => {
      this.log.debug('ffmpeg[fallback]', { line: chunk.toString().trim() });
    });

    proc.on('exit', (code, signal) => {
      if (this._stopped || this._fallbackProc !== proc) return;
      this.log.warn('Fallback exited unexpectedly, restarting', { code, signal });
      this._fallbackProc = null;
      // Restart fallback after a brief delay to avoid tight spin
      setTimeout(() => this._launchFallback(), 2000);
    });

    proc.on('error', (err) => {
      if (this._stopped) return;
      this.log.error('Fallback process error', { err: err.message });
      this._fallbackProc = null;
      setTimeout(() => this._launchFallback(), 2000);
    });
  }

  _scheduleReconnect() {
    this._clearReconnectTimer();
    this._reconnectTimer = setTimeout(() => this._attemptReconnect(), RECONNECT_INTERVAL_MS);
  }

  async _attemptReconnect() {
    if (this._stopped) return;
    this.log.info('Probing source for reconnect…');

    const available = await this._probeSource();
    if (!available) {
      this.log.info('Source not yet available, retrying');
      this._scheduleReconnect();
      return;
    }

    this.log.info('Source available — reconnecting');
    this.reconnects++;
    this._setState(STATES.RECONNECTING);
    this._clearReconnectTimer();

    // Kill fallback, start relay
    this._killProc(this._fallbackProc, 'fallback');
    this._fallbackProc = null;
    this._launchRelay();
  }

  /**
   * Probe whether the source is reachable by running a short FFmpeg probe.
   * Returns true if the source responds within ~4 seconds.
   */
  _probeSource() {
    return new Promise((resolve) => {
      const { protocol, port } = this.cfg.input;
      let args;

      if (protocol === 'srt') {
        args = [
          '-loglevel', 'error',
          '-timeout', '4000000',   // 4s in microseconds
          '-i', `srt://0.0.0.0:${port}?mode=listener&latency=200`,
          '-t', '1',
          '-f', 'null', '-',
        ];
      } else {
        // RTMP: just try to open a short-lived listener — if no client connects in 4s, source is down
        args = [
          '-loglevel', 'error',
          '-listen', '1',
          '-timeout', '4000000',
          '-i', `rtmp://0.0.0.0:${port}/live`,
          '-t', '1',
          '-f', 'null', '-',
        ];
      }

      const proc = spawn('ffmpeg', args, { stdio: 'ignore' });
      const timer = setTimeout(() => { proc.kill(); resolve(false); }, 5000);

      proc.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code === 0);
      });
      proc.on('error', () => { clearTimeout(timer); resolve(false); });
    });
  }

  _clearReconnectTimer() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  _killProc(proc, label) {
    if (!proc) return;
    try {
      proc.kill('SIGTERM');
      this.log.debug(`Sent SIGTERM to ${label}`);
    } catch (_) {}
  }
}

module.exports = { StreamRelay, STATES };
