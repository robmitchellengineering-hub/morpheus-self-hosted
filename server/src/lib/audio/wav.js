// WAV read/write, in pure Node.
//
// WHY NOT A LIBRARY: this is a measuring instrument, and the format it stores measurements in is part of the
// result. A dependency that silently converts to 16-bit, or dithers, or drops the sample rate, would corrupt
// every number downstream — and the failure would look like a bad plugin rather than a bad tool. So the RIFF
// parsing is ours, `float32` is the DEFAULT (lossless, so a reference signal stays a reference), and the guard
// round-trips audio through both PCM and float to prove nothing is lost in between.
//
// Supported on read: PCM 8/16/24/32-bit, IEEE float 32/64-bit, and WAVE_FORMAT_EXTENSIBLE wrappers around
// either. Chunks other than `fmt ` and `data` are skipped, which is what makes real-world files load.
//
// ⚠️ INTEGER PCM IS SCALED BY THE SAME CONSTANT IN BOTH DIRECTIONS — 32767, 8388607, 2147483647. Mixing the
// positive maximum on the way in with the negative-extreme modulus on the way out (32768, 8388608) is a real
// convention some tools use, and it costs a systematic gain error of 1/32768 on top of the rounding error: a
// 16-bit round trip then measures 4.1e-5 of error where 1.5e-5 is the correct floor. The guard noticed.

const RIFF = 0x52494646; // 'RIFF'
const WAVE = 0x57415645; // 'WAVE'

function fourcc(buf, offset) {
  return buf.toString('ascii', offset, offset + 4);
}

/**
 * Encode channels of audio into a WAV buffer.
 *
 * `format`: 'float32' (default, lossless) | 'int16' | 'int24' | 'int32'.
 * `data`: an array of channel arrays (each a Float64Array/Float32Array/Array), or a single array for mono.
 * Values are full-scale ratios; +1.0 is the largest representable positive sample.
 */
export function encodeWav({ sampleRate, data, format = 'float32' }) {
  // Mono can arrive as a bare typed array or a plain array of numbers; multichannel arrives as an array of
  // channel arrays. Distinguishing them on the first element is enough and avoids a shape-guessing cascade.
  const channels = Array.isArray(data) ? (typeof data[0] === 'number' ? [data] : data) : [data];
  const numChannels = channels.length;
  const frames = channels[0].length;
  for (const ch of channels) {
    if (ch.length !== frames) throw new Error('encodeWav: all channels must be the same length');
  }

  const bits = format === 'float32' ? 32 : format === 'int16' ? 16 : format === 'int24' ? 24 : format === 'int32' ? 32 : null;
  if (!bits) throw new Error(`encodeWav: unknown format "${format}"`);
  const audioFormat = format === 'float32' ? 3 : 1;
  const bytesPerSample = bits / 8;
  const blockAlign = numChannels * bytesPerSample;
  const dataBytes = frames * blockAlign;

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);              // PCM/float fmt chunk size
  header.writeUInt16LE(audioFormat, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bits, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);

  const body = Buffer.alloc(dataBytes);
  let o = 0;
  const clamp = (v) => (v > 1 ? 1 : v < -1 ? -1 : v);
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < numChannels; c++) {
      const v = channels[c][f];
      if (format === 'float32') {
        body.writeFloatLE(v, o);
      } else if (format === 'int16') {
        body.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(clamp(v) * 32767))), o);
      } else if (format === 'int24') {
        const s = Math.max(-8388608, Math.min(8388607, Math.round(clamp(v) * 8388607)));
        body.writeUInt8(s & 0xff, o);
        body.writeUInt8((s >> 8) & 0xff, o + 1);
        body.writeUInt8((s >> 16) & 0xff, o + 2);
      } else {
        body.writeInt32LE(Math.max(-2147483648, Math.min(2147483647, Math.round(clamp(v) * 2147483647))), o);
      }
      o += bytesPerSample;
    }
  }
  return Buffer.concat([header, body]);
}

/**
 * Decode a WAV buffer. Returns `{ sampleRate, channels, frames, format, bitsPerSample, data }` where `data` is
 * an array of Float64Array, one per channel, in full-scale units.
 */
export function decodeWav(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) throw new Error('decodeWav: not a buffer / too short');
  if (fourcc(buf, 0) !== 'RIFF') throw new Error(`decodeWav: expected RIFF, got "${fourcc(buf, 0)}"`);
  if (fourcc(buf, 8) !== 'WAVE') throw new Error(`decodeWav: expected WAVE, got "${fourcc(buf, 8)}"`);

  let fmt = null;
  let dataOffset = -1;
  let dataBytes = 0;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = fourcc(buf, offset);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      const audioFormat = buf.readUInt16LE(body);
      const numChannels = buf.readUInt16LE(body + 2);
      const sampleRate = buf.readUInt32LE(body + 4);
      const bitsPerSample = buf.readUInt16LE(body + 14);
      // WAVE_FORMAT_EXTENSIBLE hides the real format in the first two bytes of the sub-format GUID.
      const effective = audioFormat === 0xfffe && size >= 40 ? buf.readUInt16LE(body + 24) : audioFormat;
      fmt = { audioFormat: effective, numChannels, sampleRate, bitsPerSample, extensible: audioFormat === 0xfffe };
    } else if (id === 'data') {
      dataOffset = body;
      dataBytes = Math.min(size, buf.length - body);
    }
    offset = body + size + (size % 2); // chunks are word-aligned
  }
  if (!fmt) throw new Error('decodeWav: no fmt chunk');
  if (dataOffset < 0) throw new Error('decodeWav: no data chunk');

  const { audioFormat, numChannels, sampleRate, bitsPerSample } = fmt;
  const bytesPerSample = bitsPerSample / 8;
  const frames = Math.floor(dataBytes / (bytesPerSample * numChannels));
  const data = Array.from({ length: numChannels }, () => new Float64Array(frames));
  const isFloat = audioFormat === 3;

  let o = dataOffset;
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < numChannels; c++) {
      let v;
      if (isFloat && bitsPerSample === 32) v = buf.readFloatLE(o);
      else if (isFloat && bitsPerSample === 64) v = buf.readDoubleLE(o);
      else if (bitsPerSample === 8) v = (buf.readUInt8(o) - 128) / 127;
      else if (bitsPerSample === 16) v = buf.readInt16LE(o) / 32767;
      else if (bitsPerSample === 24) {
        const raw = buf.readUInt8(o) | (buf.readUInt8(o + 1) << 8) | (buf.readUInt8(o + 2) << 16);
        v = ((raw & 0x800000) ? raw - 0x1000000 : raw) / 8388607;
      } else if (bitsPerSample === 32) v = buf.readInt32LE(o) / 2147483647;
      else throw new Error(`decodeWav: unsupported ${bitsPerSample}-bit ${isFloat ? 'float' : 'PCM'}`);
      data[c][f] = v;
      o += bytesPerSample;
    }
  }

  return {
    sampleRate,
    channels: numChannels,
    frames,
    format: isFloat ? `float${bitsPerSample}` : `pcm${bitsPerSample}`,
    bitsPerSample,
    data,
  };
}

/** Mono convenience: the first channel as a Float64Array. */
export function decodeWavMono(buf) {
  const w = decodeWav(buf);
  return { sampleRate: w.sampleRate, samples: w.data[0], format: w.format, channels: w.channels };
}
