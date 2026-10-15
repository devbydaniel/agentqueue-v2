import { Logger } from '@nestjs/common';
import { SteerableSession } from './steerable-session.js';

function createFakeSession() {
  let steering: string[] = [];
  return {
    steer: jest.fn((text: string) => {
      steering.push(text);
      return Promise.resolve('queued' as const);
    }),
    waitForIdle: jest.fn(() => Promise.resolve()),
    clearQueue: jest.fn(() => {
      const queued = { steering, followUp: [] as string[] };
      steering = [];
      return queued;
    }),
    prompt: jest.fn(() => Promise.resolve()),
  };
}
type FakeSession = ReturnType<typeof createFakeSession>;

describe('SteerableSession', () => {
  let session: FakeSession;
  let steerable: SteerableSession;
  const signal = () => new AbortController().signal;

  beforeEach(() => {
    session = createFakeSession();
    steerable = new SteerableSession(session as never);
  });

  it('passes steers to the session while open', async () => {
    await expect(steerable.steer('use pnpm')).resolves.toBe(true);
    expect(session.steer).toHaveBeenCalledWith('use pnpm');
  });

  it('settles at once when nothing is queued, then refuses steers', async () => {
    await steerable.settle(signal());

    expect(session.waitForIdle).toHaveBeenCalledTimes(1);
    expect(session.prompt).not.toHaveBeenCalled();
    expect(steerable.isClosed).toBe(true);
    await expect(steerable.steer('too late')).resolves.toBe(false);
    expect(session.steer).not.toHaveBeenCalled();
  });

  it('runs another turn for steers pi did not pick up before going idle', async () => {
    await steerable.steer('first');
    await steerable.steer('second');

    await steerable.settle(signal());

    expect(session.prompt).toHaveBeenCalledTimes(1);
    expect(session.prompt).toHaveBeenCalledWith('first\n\nsecond', {
      expandPromptTemplates: false,
    });
    expect(session.waitForIdle).toHaveBeenCalledTimes(2);
  });

  it('waits for a steer still in flight before deciding the run is done', async () => {
    let finishSteer: (() => void) | undefined;
    session.steer.mockImplementationOnce(
      (text: string) =>
        new Promise((resolve) => {
          finishSteer = () => {
            // pi queues only once its input handlers have run.
            session.clearQueue.mockReturnValueOnce({
              steering: [text],
              followUp: [],
            });
            resolve('queued');
          };
        }),
    );
    const steered = steerable.steer('late');
    const settled = steerable.settle(signal());
    finishSteer!();

    await Promise.all([steered, settled]);

    expect(session.prompt).toHaveBeenCalledWith('late', {
      expandPromptTemplates: false,
    });
  });

  it('drops leftovers when the run was aborted', async () => {
    await steerable.steer('never mind');
    const controller = new AbortController();
    controller.abort();

    await steerable.settle(controller.signal);

    expect(session.prompt).not.toHaveBeenCalled();
    expect(steerable.isClosed).toBe(true);
  });

  it('reports a steer pi rejects as not delivered', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    session.steer.mockRejectedValueOnce(new Error('extension command'));

    await expect(steerable.steer('/cmd')).resolves.toBe(false);
  });

  it('closes even when waiting for idle fails', async () => {
    session.waitForIdle.mockRejectedValueOnce(new Error('boom'));

    await expect(steerable.settle(signal())).rejects.toThrow('boom');
    expect(steerable.isClosed).toBe(true);
  });
});
