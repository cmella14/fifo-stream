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
  const { input, output, video } = cfg;
  const srtUrl = `srt://0.0.0.0:${input.port}?mode=listener&latency=200`;
  const rtmpsUrl = `${CF_RTMPS_URL}/${output.streamKey}`;
  const width   = video.width   || 1920;
  const height  = video.height  || 1080;
  const fps     = video.fps     || 25;
  const bitrate = video.bitrate || '4000k';

  const vf = video.timecode
    ? `scale=${width}:${height},drawtext=text='%{localtime}'`
    : `scale=${width}:${height}`;

  return [
    '-loglevel', 'warning',
    '-i', srtUrl,
    '-vf', vf,
    '-c:v', 'libx264', '-preset', 'ultrafast',
    '-b:v', bitrate, '-r', String(fps),
    '-c:a', 'aac', '-b:a', '128k',
    '-f', 'flv', rtmpsUrl,
  ];
}

/**
 * Returns args array for: RTMP listener → Cloudflare RTMPS relay
 * @param {object} cfg - stream config object
 */
function buildRtmpRelayArgs(cfg) {
  const { input, output, video } = cfg;
  const rtmpUrl = `rtmp://0.0.0.0:${input.port}/live`;
  const rtmpsUrl = `${CF_RTMPS_URL}/${output.streamKey}`;
  const width   = video.width   || 1920;
  const height  = video.height  || 1080;
  const fps     = video.fps     || 25;
  const bitrate = video.bitrate || '4000k';

  const vf = video.timecode
    ? `scale=${width}:${height},drawtext=text='%{localtime}'`
    : `scale=${width}:${height}`;

  return [
    '-loglevel', 'warning',
    '-listen', '1',
    '-i', rtmpUrl,
    '-vf', vf,
    '-c:v', 'libx264', '-preset', 'ultrafast',
    '-b:v', bitrate, '-r', String(fps),
    '-c:a', 'aac', '-b:a', '128k',
    '-f', 'flv', rtmpsUrl,
  ];
}

/**
 * Returns args array for: black video → Cloudflare RTMPS fallback.
 * Used when the source camera is unavailable.
 * @param {object} cfg - stream config object
 */
function buildFallbackArgs(cfg) {
  const { output, video } = cfg;
  const rtmpsUrl = `${CF_RTMPS_URL}/${output.streamKey}`;
  const fps     = video.fps     || 25;
  const bitrate = video.bitrate || '4000k';
  const width   = video.width   || 1920;
  const height  = video.height  || 1080;

  return [
    '-re',
    '-loglevel', 'warning',
    '-f', 'lavfi', '-i', `color=black:size=${width}x${height}:rate=${fps}`,
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
