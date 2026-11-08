/**
 * pg-boss fails a job that stays active longer than its `expireInSeconds`,
 * and refuses expirations of 24 hours or more. Run timeouts are capped below
 * that, and each job expires a margin after its run's timeout, so the queue
 * never fails a job whose run is still within its own timeout.
 */
export const MAX_RUN_TIMEOUT_MS = 23 * 60 * 60 * 1000;
const JOB_EXPIRY_MARGIN_SECONDS = 15 * 60;

export const capRunTimeoutMs = (timeoutMs: number): number =>
  Math.min(timeoutMs, MAX_RUN_TIMEOUT_MS);

export const jobExpireInSeconds = (runTimeoutMs: number): number =>
  Math.ceil(capRunTimeoutMs(runTimeoutMs) / 1000) + JOB_EXPIRY_MARGIN_SECONDS;
