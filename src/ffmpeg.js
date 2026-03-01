'use strict';

/**
 * Builds FFmpeg command arguments for relay and fallback modes.
 * All commands write a snapshot of the last received frame to /tmp/lastframe-{id}.jpg
 * so the fallback can use it if the source drops.
 */

const CF_RTMPS_URL = process.env.CF_RTMPS_URL || 'rtmps://live.cloudflare.com/live';

/**
 * Returns args array for: SRT listener → Cloudflare RTMPS relay
 * @param {object} cfg - stream config object
 */
function buildSrtRelayArgs(cfg) {
  const { id, input, output, video } = cfg;
  const srtUrl = `srt://0.0.0.0:${input.port}?mode=listener&latency=200`;
  const rtmpsUrl = `${CF_RTMPS_URL}/${output.streamKey}`;
  const snapshotPath = `/tmp/lastframe-${id}.jpg`;

  // When timecode is enabled, video must be re-encoded — copy is incompatible with -vf.
  const relayVideoArgs = video.timecode
    ? ['-vf', "drawtext=text='%{localtime}'", '-c:v', 'libx264', '-preset', 'ultrafast']
    : ['-c:v', 'copy'];

  return [
    '-y',
    '-loglevel', 'warning',
    '-i', srtUrl,
    // Output 1: relay to Cloudflare
    '-map', '0',
    ...relayVideoArgs,
    '-c:a', 'aac', '-b:a', '128k',
    '-f', 'flv', rtmpsUrl,
    // Output 2: snapshot every 30s
    '-map', '0:v',
    '-vf', 'fps=1/30',
    '-q:v', '2',
    '-update', '1',
    snapshotPath,
  ];
}

/**
 * Returns args array for: RTMP listener → Cloudflare RTMPS relay
 * @param {object} cfg - stream config object
 */
function buildRtmpRelayArgs(cfg) {
  const { id, input, output, video } = cfg;
  const rtmpUrl = `rtmp://0.0.0.0:${input.port}/live`;
  const rtmpsUrl = `${CF_RTMPS_URL}/${output.streamKey}`;
  const snapshotPath = `/tmp/lastframe-${id}.jpg`;

  const args = [
    '-y',
    '-loglevel', 'warning',
    '-listen', '1',
    '-i', rtmpUrl,
    // Output 1: relay to Cloudflare
    '-map', '0',
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '128k',
    '-f', 'flv', rtmpsUrl,
    // Output 2: snapshot every 30s
    '-map', '0:v',
    '-vf', 'fps=1/30',
    '-q:v', '2',
    '-update', '1',
    snapshotPath,
  ];

  return args;
}

/**
 * Returns args array for: frozen last-frame → Cloudflare RTMPS fallback.
 * If no snapshot exists, falls back to SMPTE color bars.
 * @param {object} cfg - stream config object
 * @param {boolean} hasFrame - whether /tmp/lastframe-{id}.jpg exists
 */
function buildFallbackArgs(cfg, hasFrame) {
  const { id, output, video } = cfg;
  const rtmpsUrl = `${CF_RTMPS_URL}/${output.streamKey}`;
  const fps = video.fps || 25;
  const bitrate = video.bitrate || '2000k';
  const width = video.width || 1920;
  const height = video.height || 1080;

  const videoInput = hasFrame
    ? ['-loop', '1', '-i', `/tmp/lastframe-${id}.jpg`]
    : ['-f', 'lavfi', '-i', `smptebars=size=${width}x${height}:rate=${fps}`];

  return [
    '-re',
    '-loglevel', 'warning',
    ...videoInput,
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'stillimage',
    '-b:v', bitrate,
    '-r', String(fps),
    '-c:a', 'aac', '-b:a', '128k',
    '-f', 'flv', rtmpsUrl,
  ];
}

/**
 * Returns the relay args for a given config (dispatches by protocol).
 * @param {object} cfg - stream config object
 */
function buildRelayArgs(cfg) {
  if (cfg.input.protocol === 'srt') return buildSrtRelayArgs(cfg);
  if (cfg.input.protocol === 'rtmp') return buildRtmpRelayArgs(cfg);
  throw new Error(`Unknown protocol: ${cfg.input.protocol}`);
}

module.exports = { buildRelayArgs, buildFallbackArgs };
