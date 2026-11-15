import {
  concatSamples,
  encodeWav,
  rmsLevel,
  samplesFromBytes,
  synthesizeTone,
} from './pcm-audio.js';

describe('encodeWav', () => {
  it('writes a 16-bit mono PCM RIFF header followed by the samples', () => {
    const wav = encodeWav(new Int16Array([1, -2, 32767]), 16_000);

    expect(wav).toHaveLength(44 + 6);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(4)).toBe(36 + 6);
    expect(wav.toString('ascii', 8, 16)).toBe('WAVEfmt ');
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt32LE(28)).toBe(32_000);
    expect(wav.readUInt16LE(32)).toBe(2);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.toString('ascii', 36, 40)).toBe('data');
    expect(wav.readUInt32LE(40)).toBe(6);
    expect([
      wav.readInt16LE(44),
      wav.readInt16LE(46),
      wav.readInt16LE(48),
    ]).toEqual([1, -2, 32767]);
  });

  it('encodes a view into a larger buffer from its own offset', () => {
    const view = new Int16Array([9, 7, 5]).subarray(1);
    const wav = encodeWav(view, 8_000);
    expect(wav.readInt16LE(44)).toBe(7);
    expect(wav.readUInt32LE(40)).toBe(4);
  });
});

describe('rmsLevel', () => {
  it('is 0 for silence and an empty frame', () => {
    expect(rmsLevel(new Int16Array(160))).toBe(0);
    expect(rmsLevel(new Int16Array(0))).toBe(0);
  });

  it('is the root mean square relative to full scale', () => {
    expect(rmsLevel(new Int16Array([32767, -32767]))).toBeCloseTo(1);
    expect(rmsLevel(new Int16Array([3277, -3277]))).toBeCloseTo(0.1, 3);
  });
});

describe('samplesFromBytes', () => {
  it('reads little-endian samples even from an odd buffer offset', () => {
    const backing = Buffer.from([0xff, 0x01, 0x00, 0xfe, 0xff, 0x07]);
    expect([...samplesFromBytes(backing.subarray(1, 5))]).toEqual([1, -2]);
  });

  it('drops a trailing half sample', () => {
    expect(samplesFromBytes(Buffer.from([1, 0, 2]))).toHaveLength(1);
  });
});

describe('concatSamples', () => {
  it('joins frames in order', () => {
    expect([
      ...concatSamples([new Int16Array([1, 2]), new Int16Array([3])]),
    ]).toEqual([1, 2, 3]);
  });
});

describe('synthesizeTone', () => {
  const tone = synthesizeTone({
    sampleRate: 24_000,
    frequencyHz: 880,
    durationMs: 150,
    amplitude: 0.2,
    fadeMs: 20,
  });

  it('has the requested length', () => {
    expect(tone).toHaveLength(3_600);
  });

  it('fades in and out instead of clicking', () => {
    expect(tone[0]).toBe(0);
    expect(tone[tone.length - 1]).toBe(0);
  });

  it('peaks at the requested amplitude', () => {
    const peak = Math.max(...tone.map((s) => Math.abs(s)));
    expect(peak / 32767).toBeCloseTo(0.2, 2);
  });
});
