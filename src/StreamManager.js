'use strict';

const fs = require('fs');
const path = require('path');
const { StreamRelay } = require('./StreamRelay');
const logger = require('./logger');

const RUNTIME_PATH = path.join(__dirname, '../streams.runtime.json');

/**
 * Manages the lifecycle of all StreamRelay instances.
 * Static streams come from streams.config.js and are never persisted to the runtime file.
 * Dynamic streams created via API are saved to streams.runtime.json and restored on restart.
 */
class StreamManager {
  constructor(staticConfigs = []) {
    this._configs = new Map();  // id → cfg
    this._relays  = new Map();  // id → StreamRelay
    this._staticIds = new Set();

    for (const cfg of staticConfigs) {
      this._register(cfg, true);
    }

    for (const cfg of this._loadRuntime()) {
      if (this._configs.has(cfg.id)) {
        logger.warn('Runtime stream conflicts with static config, skipping', { id: cfg.id });
        continue;
      }
      this._register(cfg, false);
    }
  }

  /** Start all relays (call once at startup). */
  startAll() {
    for (const relay of this._relays.values()) relay.start();
    logger.info(`StreamManager: started ${this._relays.size} relay(s)`);
  }

  /** Create a new dynamic stream, start it, and persist. */
  create(cfg) {
    if (this._configs.has(cfg.id)) {
      const err = new Error(`Stream '${cfg.id}' already exists`);
      err.code = 'DUPLICATE_ID';
      throw err;
    }
    this._register(cfg, false);
    this._relays.get(cfg.id).start();
    this._saveRuntime();
    return this._relays.get(cfg.id).getStatus();
  }

  /** Stop and remove a dynamic stream. Returns false if not found or is static. */
  remove(id) {
    if (!this._configs.has(id)) return { ok: false, reason: 'not_found' };
    if (this._staticIds.has(id)) return { ok: false, reason: 'static_stream' };

    this._relays.get(id).stop();
    this._relays.delete(id);
    this._configs.delete(id);
    this._saveRuntime();
    return { ok: true };
  }

  /** Get status of a single stream. */
  get(id) {
    return this._relays.get(id)?.getStatus() ?? null;
  }

  /** List status of all streams. */
  list() {
    return [...this._relays.values()].map((r) => r.getStatus());
  }

  /** Stop all relays (for graceful shutdown). */
  stopAll() {
    for (const relay of this._relays.values()) relay.stop();
  }

  // ─── private ──────────────────────────────────────────────────────────────

  _register(cfg, isStatic) {
    this._configs.set(cfg.id, cfg);
    this._relays.set(cfg.id, new StreamRelay(cfg));
    if (isStatic) this._staticIds.add(cfg.id);
  }

  _loadRuntime() {
    try {
      const raw = fs.readFileSync(RUNTIME_PATH, 'utf8');
      const data = JSON.parse(raw);
      if (!Array.isArray(data)) return [];
      const valid = data.filter((cfg) => cfg && typeof cfg.id === 'string' && cfg.output?.streamKey);
      if (valid.length !== data.length) {
        logger.warn('Some runtime stream entries were malformed and skipped',
          { total: data.length, loaded: valid.length });
      }
      logger.info(`Loaded ${valid.length} runtime stream(s) from ${RUNTIME_PATH}`);
      return valid;
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.warn('Could not read runtime streams file', { err: err.message });
      }
      return [];
    }
  }

  _saveRuntime() {
    const dynamic = [...this._configs.entries()]
      .filter(([id]) => !this._staticIds.has(id))
      .map(([, cfg]) => cfg);

    fs.writeFile(RUNTIME_PATH, JSON.stringify(dynamic, null, 2), (err) => {
      if (err) logger.error('Could not save runtime streams file', { err: err.message });
    });
  }
}

module.exports = StreamManager;
