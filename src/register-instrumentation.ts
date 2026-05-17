/**
 * register-instrumentation.ts — sets up OTel auto-instrumentation for the
 * Claude Agent SDK via import-in-the-middle (IITM).
 *
 * Loaded via Node's `--import` flag BEFORE any module that imports the SDK,
 * so the IITM hook can intercept the import and replace the module exports
 * with instrumented versions.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * WORKAROUND: ESM-incompatible `manuallyInstrument()` upstream
 * ──────────────────────────────────────────────────────────────────────────
 *
 * The original tracing setup in `instrumentation.ts` called
 * `instrumentation.manuallyInstrument(ClaudeAgentSDK)`. That throws
 *
 *   TypeError: Cannot assign to read only property 'query' of object '[object Module]'
 *
 * on Node 22 because ESM module namespace objects are strictly read-only.
 *
 * In `@arizeai/openinference-instrumentation-claude-agent-sdk@>=0.2.4` the
 * internal `patch()` function detects the frozen-namespace case and returns
 * a copy (so `require-in-the-middle` / `import-in-the-middle` can swap the
 * module out wholesale). But `manuallyInstrument()` itself still discards
 * the return value of `patch()`, so it's a no-op in ESM.
 *
 * The auto-instrumentation path here uses IITM, which DOES use the return
 * value. That's why we have to start Node with TWO `--import` flags:
 *
 *   1. `--import @opentelemetry/instrumentation/hook.mjs`
 *      Installs the IITM loader (without this, ESM imports aren't hooked).
 *   2. `--import ./dist/src/register-instrumentation.js`
 *      Runs this file, which calls `registerInstrumentations()` to tell IITM
 *      which modules to wrap.
 *
 * Both flags are needed because agentqueue compiles to CJS but the Claude
 * Agent SDK is ESM-only — its `await import()` resolves through Node's ESM
 * loader, so IITM must be active there.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * WHEN TO DROP THIS FILE
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Once upstream `manuallyInstrument()` either:
 *   (a) returns the patched module so callers can capture it, OR
 *   (b) installs an IITM hook itself so callers don't need to,
 *
 * collapse this file back into `instrumentation.ts` and remove the
 * `--import` flag from `package.json` / Dockerfile / agent-runtime
 * entrypoint.
 *
 * Track upstream: https://github.com/Arize-ai/openinference (look for
 * issues / PRs touching `ESM`, `manuallyInstrument`, or `claude-agent-sdk`).
 */

import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { ClaudeAgentSDKInstrumentation } from '@arizeai/openinference-instrumentation-claude-agent-sdk';
import { detectTracingProvider } from './config/detect-tracing-provider.js';

const provider = detectTracingProvider();
if (provider !== 'none') {
  registerInstrumentations({
    instrumentations: [new ClaudeAgentSDKInstrumentation()],
  });
  // eslint-disable-next-line no-console
  console.log(
    `[register-instrumentation] Claude Agent SDK instrumentation registered for provider=${provider}`,
  );
} else {
  // eslint-disable-next-line no-console
  console.log(
    '[register-instrumentation] tracing disabled — instrumentation NOT registered',
  );
}
