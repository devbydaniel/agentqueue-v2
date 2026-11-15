/**
 * Pure helpers for 16-bit mono PCM audio: WAV encoding, signal level and a
 * synthesized cue tone.
 */

const INT16_MAX = 32_767;
const WAV_HEADER_BYTES = 44;

/** Wrap 16-bit mono PCM in a WAV (RIFF) container. */
export function encodeWav(samples: Int16Array, sampleRate: number): Buffer {
  const dataBytes = samples.length * 2;
  const wav = Buffer.alloc(WAV_HEADER_BYTES + dataBytes);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16); // fmt chunk size
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28); // byte rate
  wav.writeUInt16LE(2, 32); // block align
  wav.writeUInt16LE(16, 34); // bits per sample
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataBytes, 40);
  // Typed arrays use the platform byte order, little-endian on every target.
  Buffer.from(samples.buffer, samples.byteOffset, dataBytes).copy(
    wav,
    WAV_HEADER_BYTES,
  );
  return wav;
}

/** Concatenate PCM frames into one buffer of samples. */
export function concatSamples(frames: readonly Int16Array[]): Int16Array {
  const out = new Int16Array(frames.reduce((n, f) => n + f.length, 0));
  let offset = 0;
  for (const frame of frames) {
    out.set(frame, offset);
    offset += frame.length;
  }
  return out;
}

/**
 * Samples from little-endian 16-bit PCM bytes. Copies, because a Buffer may
 * sit at an odd offset of its pool, where an Int16Array view is not allowed.
 */
export function samplesFromBytes(bytes: Uint8Array): Int16Array {
  const copy = new Uint8Array(bytes.length - (bytes.length % 2));
  copy.set(bytes.subarray(0, copy.length));
  return new Int16Array(copy.buffer);
}

/** Root-mean-square level of a frame, from 0 (silence) to 1 (full scale). */
export function rmsLevel(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length) / INT16_MAX;
}

export interface ToneOptions {
  sampleRate: number;
  frequencyHz: number;
  durationMs: number;
  /** Peak level from 0 to 1. */
  amplitude: number;
  /** Raised-cosine fade at both ends, so the tone starts and stops without a click. */
  fadeMs: number;
}

/** A sine tone with soft edges. */
export function synthesizeTone(options: ToneOptions): Int16Array {
  const { sampleRate, frequencyHz, durationMs, amplitude, fadeMs } = options;
  const length = Math.round((sampleRate * durationMs) / 1000);
  const fadeLength = Math.max(1, Math.round((sampleRate * fadeMs) / 1000));
  return Int16Array.from({ length }, (_, i) => {
    const edge = Math.min(i, length - 1 - i);
    const envelope =
      edge >= fadeLength
        ? 1
        : 0.5 - 0.5 * Math.cos((Math.PI * edge) / fadeLength);
    const value = Math.sin((2 * Math.PI * frequencyHz * i) / sampleRate);
    return Math.round(value * envelope * amplitude * INT16_MAX);
  });
}
