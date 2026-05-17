/**
 * register-instrumentation.ts — sets up OTel tracing AND Claude SDK
 * auto-instrumentation via import-in-the-middle (IITM).
 *
 * Loaded via Node's `--import` flag BEFORE any module that imports the SDK,
 * so the IITM hook can intercept the import and replace the module exports
 * with instrumented versions.
 *
 * **Order matters here.** The TracerProvider must be initialized *before*
 * `registerInstrumentations()` is called, because `ClaudeAgentSDKInstrumentation`'s
 * internal `OITracer` captures a tracer reference in its constructor. If the
 * provider isn't ready yet, it captures a no-op tracer and silently emits
 * nothing — even though IITM hook + module patching all "succeeds".
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
 *      Runs this file, which initializes the TracerProvider and then calls
 *      `registerInstrumentations()` so IITM knows which modules to wrap.
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

import 'dotenv/config';
import { register } from '@arizeai/phoenix-otel';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { ClaudeAgentSDKInstrumentation } from '@arizeai/openinference-instrumentation-claude-agent-sdk';
import { detectTracingProvider } from './config/detect-tracing-provider.js';

const provider = detectTracingProvider();

if (provider === 'phoenix') {
  // One-call setup: phoenix-otel's register() initializes the TracerProvider
  // AND wires instrumentations through it in the correct order. This is the
  // documented pattern and avoids the no-op-tracer race we hit when handling
  // each step manually.
  register({
    projectName: process.env.PHOENIX_PROJECT_NAME ?? 'agentqueue',
    url:
      process.env.PHOENIX_COLLECTOR_ENDPOINT ??
      'http://localhost:6006/v1/traces',
    instrumentations: [new ClaudeAgentSDKInstrumentation()],
  });

  // eslint-disable-next-line no-console
  console.log(
    '[register-instrumentation] Phoenix tracer + Claude SDK instrumentation registered',
  );
} else if (provider === 'langfuse') {
  // Langfuse setup is async (NodeSDK.start) — it's handled in instrumentation.ts.
  // We still want SDK auto-instrumentation; it picks up the global tracer
  // that langfuse will install by the time the first query() runs.
  registerInstrumentations({
    instrumentations: [new ClaudeAgentSDKInstrumentation()],
  });

  // eslint-disable-next-line no-console
  console.log(
    '[register-instrumentation] Claude SDK instrumentation registered (langfuse provider set up async in instrumentation.ts)',
  );
} else {
  // eslint-disable-next-line no-console
  console.log(
    '[register-instrumentation] tracing disabled — instrumentation NOT registered',
  );
}
