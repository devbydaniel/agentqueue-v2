import { OpenaiTtsService } from './openai-tts.service.js';
import type { AppConfigService } from '../config/app-config.service.js';

describe('OpenaiTtsService', () => {
  let service: OpenaiTtsService;
  let appConfigService: jest.Mocked<AppConfigService>;
  let fetchMock: jest.Mock;

  const buildConfig = (
    apiKey: string | undefined,
  ): jest.Mocked<AppConfigService> =>
    ({
      openaiApiKey: apiKey,
      openaiTtsModel: 'gpt-4o-mini-tts',
      openaiTtsVoice: 'alloy',
    }) as unknown as jest.Mocked<AppConfigService>;

  beforeEach(() => {
    appConfigService = buildConfig('sk-test');
    fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: jest
        .fn()
        .mockResolvedValue(new Uint8Array([1, 2, 3]).buffer),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    service = new OpenaiTtsService(appConfigService);
  });

  describe('isAvailable', () => {
    it('is false without an API key', () => {
      service = new OpenaiTtsService(buildConfig(undefined));
      expect(service.isAvailable()).toBe(false);
    });

    it('is true with an API key', () => {
      expect(service.isAvailable()).toBe(true);
    });
  });

  describe('synthesize', () => {
    it('requests Ogg/Opus speech and returns a Buffer', async () => {
      const audio = await service.synthesize('Hello');

      expect(audio).toBeInstanceOf(Buffer);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.openai.com/v1/audio/speech',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer sk-test',
          }),
          body: JSON.stringify({
            model: 'gpt-4o-mini-tts',
            voice: 'alloy',
            input: 'Hello',
            response_format: 'opus',
          }),
        }),
      );
    });

    it('caps input at 4096 characters', async () => {
      await service.synthesize('a'.repeat(5000));

      const body = JSON.parse(
        (fetchMock.mock.calls[0][1] as { body: string }).body,
      ) as { input: string };
      expect(body.input).toHaveLength(4096);
    });

    it('throws when no API key is configured', async () => {
      service = new OpenaiTtsService(buildConfig(undefined));
      await expect(service.synthesize('Hello')).rejects.toThrow(
        'OPENAI_API_KEY not set',
      );
    });

    it('throws on a non-OK response', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: jest.fn().mockResolvedValue('unauthorized'),
      });
      await expect(service.synthesize('Hello')).rejects.toThrow(
        'OpenAI speech synthesis failed (401)',
      );
    });
  });
  describe('streamPcm', () => {
    const streamOf = (...chunks: number[][]): ReadableStream<Uint8Array> =>
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
          controller.close();
        },
      });

    it('requests raw PCM and yields whole samples across odd chunk splits', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        body: streamOf([1, 2, 3], [4, 5], [6]),
      });
      const chunks: number[][] = [];
      for await (const chunk of service.streamPcm('Hallo')) {
        chunks.push([...chunk]);
      }

      expect(chunks).toEqual([
        [1, 2],
        [3, 4],
        [5, 6],
      ]);
      const body = JSON.parse(
        (fetchMock.mock.calls[0][1] as { body: string }).body,
      ) as { response_format: string };
      expect(body.response_format).toBe('pcm');
    });

    it('passes the abort signal to the request', async () => {
      const controller = new AbortController();
      fetchMock.mockResolvedValueOnce({ ok: true, body: streamOf() });
      await service.streamPcm('Hallo', controller.signal).next();

      expect(fetchMock.mock.calls[0][1]).toMatchObject({
        signal: controller.signal,
      });
    });
  });
});
