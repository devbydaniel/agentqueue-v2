import { Injectable } from '@nestjs/common';

/** What a run needs from a live call: a way to say something. */
export interface CallVoice {
  /** Queue a sentence for speech; it plays after everything queued before. */
  speak(text: string): void;
}

/**
 * The calls in progress, keyed by the session key of their thread, so a run
 * in that session can speak its reply into the call. Calls register on join
 * and unregister on hang-up; the call lifecycle itself lives in
 * MatrixCallService.
 */
@Injectable()
export class MatrixActiveCallsService {
  private readonly calls = new Map<string, CallVoice>();

  register(sessionKey: string, voice: CallVoice): void {
    this.calls.set(sessionKey, voice);
  }

  unregister(sessionKey: string, voice: CallVoice): void {
    if (this.calls.get(sessionKey) === voice) this.calls.delete(sessionKey);
  }

  get(sessionKey: string): CallVoice | undefined {
    return this.calls.get(sessionKey);
  }
}
