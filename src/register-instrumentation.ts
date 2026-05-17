/**
 * Loaded via Node's `--import` flag to register Claude SDK auto-instrumentation
 * before any module imports the SDK. The startup command is:
 *
 *   node --import @opentelemetry/instrumentation/hook.mjs \
 *        --import ./dist/src/register-instrumentation.js \
 *        dist/src/main.js
 *
 * The IITM hook (first --import) and this file (second --import) together
 * replace the broken `manuallyInstrument()` path, which throws on Node 22 ESM
 * because module namespace objects are read-only and the upstream method
 * discards the patched module returned by `patch()`.
 *
 * Drop this file (and the --import flags in package.json / Dockerfile /
 * agent-runtime entrypoint) when upstream `manuallyInstrument()` either
 * returns the patched module or installs the IITM hook itself.
 * Track: https://github.com/Arize-ai/openinference
 */

import 'dotenv/config';
import { register } from '@arizeai/phoenix-otel';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { ClaudeAgentSDKInstrumentation } from '@arizeai/openinference-instrumentation-claude-agent-sdk';
import { detectTracingProvider } from './config/detect-tracing-provider.js';

const provider = detectTracingProvider();

if (provider === 'phoenix') {
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
  registerInstrumentations({
    instrumentations: [new ClaudeAgentSDKInstrumentation()],
  });
  // eslint-disable-next-line no-console
  console.log(
    '[register-instrumentation] Claude SDK instrumentation registered (langfuse tracer installed async in instrumentation.ts)',
  );
} else {
  // eslint-disable-next-line no-console
  console.log(
    '[register-instrumentation] tracing disabled — instrumentation NOT registered',
  );
}
