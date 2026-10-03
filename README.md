# AgentQueue v2

Centralized agent orchestrator for AI agent workloads. Receives triggers (cron schedules, Linear webhooks, GitHub webhooks, Telegram webhooks), resolves a working directory, and runs a [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview) session against it.

## Architecture

NestJS modular backend backed by Postgres (via raw `pg`) and pg-boss for job queueing. Schema changes are managed with `dbmate` SQL migrations. Runs are enqueued asynchronously — `POST /runs` returns `202` immediately with a `runId`, and the run is processed by a background queue worker.

```text
┌─────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ Cron        │  │ Linear       │  │ GitHub       │  │ Telegram     │
│ scheduler   │  │ webhooks     │  │ webhooks     │  │ webhooks     │
└──────┬──────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │                │                 │                 │
       └────────────────┴─────────────────┴─────────────────┘
                                │
                     ┌──────────▼──────────┐
                     │ RunsService /       │
                     │ queue worker        │
                     └──────────┬──────────┘
                                │
                     ┌──────────▼──────────┐
                     │ SDK session factory │
                     │ + agent session     │
                     └──────────┬──────────┘
                                │
                ┌───────────────┼────────────────┬────────────────┐
                │               │                │                │
          ┌─────▼─────┐   ┌─────▼─────┐    ┌─────▼─────┐    ┌─────▼─────┐
          │ Logger    │   │ Langfuse  │    │ Run event │    │ Source     │
          │ callbacks │   │ callbacks │    │ storage   │    │ replies    │
          └───────────┘   └───────────┘    └───────────┘    └───────────┘
```

## Requirements

- Node.js >= 20
- Claude Agent SDK (installed as an npm dependency; see `@anthropic-ai/claude-agent-sdk` in `package.json`)

## Quick Start

```bash
# Install dependencies
npm install

# Copy env file and fill in values
cp .env.example .env

# Start dev Postgres (Docker required)
docker compose -f docker-compose.services.yml up -d

# Run database migrations
npm run db:migrate

# Development (with hot-reload)
npm run start:dev

# Health check
curl http://localhost:${PORT:-3000}/health
```

## Database Setup

AgentQueue uses Postgres for run persistence and job queueing.

```bash
# Start local Postgres
docker compose -f docker-compose.services.yml up -d

# Apply migrations
npm run db:migrate
```

Default local connection: `postgres://agentqueue:agentqueue@localhost:5433/agentqueue`

In production, set the `DATABASE_URL` environment variable.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `PORT` | No | Server port (default: `3000`) |
| `AUTH_TOKEN` | **Yes** | Bearer token for authenticated endpoints |
| `BEFORE_HOOK_TIMEOUT` | No | Timeout (ms) for trigger `before` hooks (default: `30000`) |
| `GITHUB_WEBHOOK_SECRET` | No | HMAC secret for GitHub webhook signature verification |
| `LANGFUSE_SECRET_KEY` | No | Enables Langfuse tracing when set |
| `LANGFUSE_PUBLIC_KEY` | No | Langfuse public key |
| `LANGFUSE_BASE_URL` | No | Langfuse API URL |
| `DATABASE_URL` | No* | Postgres connection string (default: local dev; **required** in production) |
| `QUEUE_CONCURRENCY` | No | Max concurrent queue jobs per worker (default: `5`) |
| `QUEUE_RETRY_LIMIT` | No | Max retry attempts for failed queue jobs (default: `3`) |
| `RUN_TIMEOUT_MS` | No | Default per-run timeout in milliseconds (default: `1800000` / 30 min) |
| `LINEAR_SIGNING_SECRET` | No | Referenced via `${VAR}` in trigger config |
| `LINEAR_API_KEY` | No | Referenced via `${VAR}` in trigger config |
| `TELEGRAM_MAIN_BOT_TOKEN` | No | Optional example variable for Telegram trigger bot tokens |
| `TELEGRAM_MAIN_WEBHOOK_SECRET` | No | Optional example variable for Telegram webhook secret tokens |

## API Endpoints

All endpoints except health and webhooks require `Authorization: Bearer <AUTH_TOKEN>`.

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | Public | Health check |
| `POST` | `/runs` | Bearer | Enqueue an async agent run (returns 202) |
| `GET` | `/runs` | Bearer | List runs with optional filters |
| `GET` | `/runs/:id` | Bearer | Get run details by ID |
| `GET` | `/runs/:id/events` | Bearer | List filtered events for a run |
| `POST` | `/runs/:id/abort` | Bearer | Abort a running or waiting run |
| `GET` | `/flows` | Bearer | List available flows |
| `POST` | `/flows/:name/start` | Bearer | Start a flow run |
| `GET` | `/flows/:name/runs` | Bearer | List runs for a flow |
| `GET` | `/flows/runs/:runId` | Bearer | Get flow run details |
| `POST` | `/flows/runs/:runId/abort` | Bearer | Abort a running flow |
| `POST` | `/webhooks/linear/:agentName` | Signature | Receive Linear Agent Interaction webhooks |
| `GET` | `/webhooks/linear/:agentName` | Public | Linear webhook URL verification |
| `POST` | `/webhooks/github` | Signature | Receive GitHub webhooks |
| `POST` | `/webhooks/telegram/:botName` | Secret header | Receive Telegram bot webhooks |

Swagger docs are available at `/docs` when the server is running.

### POST /runs

> **Breaking change:** `POST /runs` is async-first. It returns `202 Accepted` immediately with `{ runId, status: 'waiting' }`. The run is processed in the background by the queue worker. To check the result, poll `GET /runs/:id`.

Enqueue an async agent run against a repository working directory.

Accepted request fields:

- `cwd` (required)
- `prompt` (required)
- `prependSystemPrompt` (optional)
- `appendSystemPrompt` (optional)
- `timeoutMs` (optional)
- `parentRunId` (optional) — the runId of the parent run. When set, the new run is recorded with `source: 'spawned'` and is grouped under the parent's Langfuse session. Intended for agents enqueueing child runs from inside a queue session; the executing agent's own runId is available as `$AGENTQUEUE_RUN_ID` and is also stated in its system prompt.

> `POST /runs` does **not** accept `externalSessionId`. Session resumption IDs are internal integration fields populated by webhook-based sources such as Linear.

```bash
# Step 1: Enqueue the run
curl -s -X POST http://localhost:3000/runs \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"cwd": "/absolute/path/to/my-repo", "prompt": "Fix the failing tests"}'
# => { "runId": "abc-123", "status": "waiting" }

# Step 2: Check status
curl -s http://localhost:3000/runs/abc-123 \
  -H "Authorization: Bearer $AUTH_TOKEN"
# => { "id": "abc-123", "status": "running", ... }
```

### GET /runs

List runs with optional filters:

```bash
# All runs
curl -s http://localhost:3000/runs \
  -H "Authorization: Bearer $AUTH_TOKEN"

# Filter by status and source
curl -s 'http://localhost:3000/runs?status=running&source=cron&limit=10' \
  -H "Authorization: Bearer $AUTH_TOKEN"
```

Query parameters: `status`, `source`, `cwd`, `trigger`, `parent`, `since`, `limit`, `offset`.

Use `?parent=<runId>` to list a run's spawned children (including flow-spawned children, which use `source=flow`).

### GET /runs/:id

Get full details for a specific run:

```bash
curl -s http://localhost:3000/runs/abc-123 \
  -H "Authorization: Bearer $AUTH_TOKEN"
```

### GET /runs/:id/events

Get the filtered event log for a run (agent lifecycle events, tool calls, etc.):

```bash
curl -s 'http://localhost:3000/runs/abc-123/events?limit=50' \
  -H "Authorization: Bearer $AUTH_TOKEN"
```

### POST /runs/:id/abort

Abort a running or waiting run. Returns `409` if the run is already in a terminal state.

```bash
curl -s -X POST http://localhost:3000/runs/abc-123/abort \
  -H "Authorization: Bearer $AUTH_TOKEN"
# => { "aborted": true }
```

### Flow Endpoints

Flow APIs are authenticated and operate on named flow configs under
`~/.agentqueue/flows/<name>/config.yaml`.

```bash
# List available flows
curl -s http://localhost:3000/flows \
  -H "Authorization: Bearer $AUTH_TOKEN"

# Start a flow
curl -s -X POST http://localhost:3000/flows/factory/start \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"vars":{"task":"build the feature"}}'

# Inspect flow runs
curl -s http://localhost:3000/flows/factory/runs \
  -H "Authorization: Bearer $AUTH_TOKEN"

curl -s http://localhost:3000/flows/runs/<flow-run-id> \
  -H "Authorization: Bearer $AUTH_TOKEN"

# Abort a running flow
curl -s -X POST http://localhost:3000/flows/runs/<flow-run-id>/abort \
  -H "Authorization: Bearer $AUTH_TOKEN"
```

### POST /webhooks/github

Single endpoint for all GitHub webhooks. Configure your GitHub repo/org to send webhooks to this URL with a shared secret. The trigger config determines which events match and which working directory/agent handles them.

```bash
# GitHub sends this automatically — example for testing:
curl -X POST http://localhost:3000/webhooks/github \
  -H "x-github-event: pull_request_review" \
  -H "x-hub-signature-256: sha256=..." \
  -H "Content-Type: application/json" \
  -d '{"action": "submitted", "review": {...}, "repository": {...}}'
```

Response:

```json
{ "accepted": true, "triggered": 1 }
```

## Configuration

### Migrations

Schema changes use `dbmate` and plain SQL migration files under
`src/database/migrations`.

```bash
# Create a new migration
npm run db:new -- add_telegram_support

# Apply pending migrations
npm run db:migrate

# Roll back the latest migration
npm run db:rollback
```

### Trigger Config

Triggers are defined in `~/.agentqueue/triggers.yaml`. Four types are supported:

#### Cron Triggers

Run an agent on a schedule:

```yaml
triggers:
  - name: daily-review
    schedule: "0 8 * * *"
    cwd: ~/dev/my-repo
    prompt: "Run the morning review routine"
    prepend_system_prompt: "Today is {{date}}."
```

Template variables for cron: `{{triggerName}}`, `{{schedule}}`, `{{date}}`, `{{cwd}}`.

### Before hooks

Cron and GitHub triggers support an optional `before` field that runs a shell
command before the agent is invoked. The hook can **gate** the run (skip
entirely if it exits non-zero) and **enrich** the prompt (substitute its stdout
into `{{before_output}}`).

```yaml
triggers:
  - name: meeting-prep
    schedule: "*/30 8-17 * * 1-5"
    cwd: ~/dev/assistant
    before: "/home/you/scripts/check-calendar.sh"
    prompt: "Prepare for the upcoming meeting: {{before_output}}"
```

Contract:

| Exit code | Behavior |
|---|---|
| `0` | Proceed. `{{before_output}}` placeholders in `prompt` are replaced with the trimmed stdout. |
| Non-zero | Skip. The run is not started. |
| Timeout | Skip. The default timeout is `BEFORE_HOOK_TIMEOUT` (30s). |

The hook is executed via `sh -c <before>`, so it can be a script path or an
inline shell expression. It does **not** apply to Linear or Telegram triggers.

#### Telegram Triggers

Telegram triggers route inbound bot messages by `bot_name` and sender `user_id`.
Each accepted chat (and each topic in a threaded chat) keeps a persistent agent
session that never expires. Send `/reset` or press the "new session" button to
start a fresh one.

```yaml
triggers:
  - name: daniel-assistant
    type: telegram
    bot_name: main-bot
    bot_token: ${TELEGRAM_MAIN_BOT_TOKEN}
    webhook_secret: ${TELEGRAM_MAIN_WEBHOOK_SECRET}
    user_id: "123456789"
    cwd: ~/dev/assistant
    prepend_system_prompt: "You are replying to Daniel on Telegram."
```

Register the Telegram webhook against AgentQueue with the matching secret token:

```bash
curl -X POST "https://api.telegram.org/bot$TELEGRAM_MAIN_BOT_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://your-host/webhooks/telegram/main-bot",
    "secret_token": "'"$TELEGRAM_MAIN_WEBHOOK_SECRET"'"
  }'
```

#### Matrix Triggers

Matrix triggers run a `/sync` long-poll loop per `bot_name` against a
homeserver, as a plain (unencrypted) bot account. The bot auto-joins rooms it
is invited to by an allowed `user_id`; messages from anyone else are ignored.

```yaml
triggers:
  - name: matrix-daniel
    type: matrix
    bot_name: assistant
    homeserver_url: http://synapse.matrix.svc.cluster.local:8008
    access_token: ${MATRIX_ASSISTANT_TOKEN}
    user_id: "@daniel:matrix.example.org"
    cwd: ~/dev/assistant
    # room_id: "!abc:matrix.example.org"   # optional: only this room
```

Sessions: each room's main timeline is one persistent session, and each thread
is its own session. The first message in a thread gets the thread's root
message as context, and an explicitly quoted message is always included — so
replying to a message a cron run posted gives the agent that message. Replies
stream in by editing one message in place and render as markdown (tables
included). Images and files are passed as local paths; voice messages are
transcribed (`MISTRAL_API_KEY`).

Room commands: `!new` starts a fresh session (in the main timeline or the
thread it is sent in); `!voice`, `!voice on`, `!voice off` toggle spoken
replies for the room (`OPENAI_API_KEY`).

The `/sync` position is stored in `matrix_sync_state`, so messages sent while
AgentQueue is down are answered after a restart. The very first sync, and the
history of a newly joined room, are not replayed.

#### Linear Triggers

Receive webhooks from Linear's Agent Interaction API:

```yaml
triggers:
  - name: coding-agent
    type: linear
    cwd: ~/dev/my-repo
    signing_secret: ${LINEAR_SIGNING_SECRET}
    api_key: ${LINEAR_API_KEY}
    prepend_system_prompt: "You are working in {{cwd}}."
```

The `${VAR}` syntax interpolates from environment variables. The webhook URL is `POST /webhooks/linear/<name>`.

For Linear-triggered runs, AgentQueue stores the incoming Linear `agentSessionId` as an internal `externalSessionId` so follow-up webhook events can resume or abort the same underlying agent session.

#### GitHub Triggers

Receive GitHub webhooks with flexible event and payload filtering:

```yaml
triggers:
  - name: address-pr-review
    type: github
    events:
      - pull_request_review
    filters:
      - field: action
        equals: submitted
      - field: review.state
        in: ["changes_requested", "commented"]
      - field: repository.full_name
        equals: "myorg/my-repo"
    cwd: "~/dev/{{repository.name}}"
    prompt: |
      Address review feedback on PR #{{pull_request.number}} in {{repository.full_name}}.
      Reviewer: {{review.user.login}}
      Review state: {{review.state}}
      Review body: {{review.body}}
      PR branch: {{pull_request.head.ref}}
      PR URL: {{pull_request.html_url}}

      Check out the branch, read the review comments, address each one, push fixes.
    prepend_system_prompt: |
      You are working on {{repository.full_name}}.
    append_system_prompt: |
      Always use the pr-review-comments skill when addressing PR feedback.
```

All GitHub triggers share a single endpoint: `POST /webhooks/github`. When a webhook arrives, the service:

1. Verifies the `x-hub-signature-256` HMAC signature against `GITHUB_WEBHOOK_SECRET`
2. Extracts the event type from the `x-github-event` header
3. Matches all triggers where `events` includes the event type AND all `filters` pass
4. For each match, interpolates `cwd`, `prompt`, and system prompts using the webhook payload, then fires an agent run

**Filter operators** (all filters use AND logic):

| Operator | Description | Example |
|---|---|---|
| `equals` | Exact string match | `field: action`, `equals: submitted` |
| `contains` | Substring match (strings only) | `field: pull_request.title`, `contains: feat` |
| `in` | Value is one of a list | `field: review.state`, `in: ["changes_requested", "commented"]` |
| `pattern` | Regex match | `field: pull_request.head.ref`, `pattern: "^feat/"` |

**Template interpolation** uses `{{dotted.path}}` syntax to access any nested field in the GitHub webhook payload (e.g., `{{pull_request.head.ref}}`, `{{review.user.login}}`).

## Robustness

- **Per-run timeout:** Each run has a configurable timeout (default: 30 minutes via `RUN_TIMEOUT_MS`). Per-trigger overrides are supported via `timeout_ms` in `triggers.yaml`. When a run times out, it is marked `timed_out`.
- **Startup recovery:** On boot, any `runs` rows left in `running` status (from a previous crash) are automatically marked `interrupted`. They appear in the dashboard for manual review.
- **Graceful shutdown:** On `SIGTERM`, the queue worker aborts all in-flight sessions before the process exits.

## Callback Handlers

Every agent run streams events to registered callback handlers:

| Handler | Scope | Description |
|---|---|---|
| **Logger** | Global | Logs agent activity (tool calls, messages) via NestJS Logger |
| **Langfuse** | Global | Sends traces to Langfuse (enabled when `LANGFUSE_SECRET_KEY` is set) |
| **Run event** | Per-run | Persists filtered agent events for `GET /runs/:id/events` |
| **Linear** | Per-run | Posts agent responses and errors back to Linear for Linear webhook runs |
| **Assistant message** | Per-run/internal | Captures the last assistant reply so Telegram runs can send it back to the chat |

## Project Structure

```text
src/
├── main.ts                           # Entry point, Swagger setup
├── app.module.ts                     # Root module
├── instrumentation.ts                # OpenTelemetry / Langfuse init
├── auth/                             # Bearer auth guard + @Public()
├── callbacks/                        # Event handlers (logger, Langfuse, Linear, Telegram helpers, run events)
├── config/                           # Env + trigger config
├── database/                         # Row types, raw pg wiring, SQL migrations
├── flows/                            # Multi-step flow orchestration
├── matrix/                           # Matrix client, /sync listener, ingest, streaming replies
├── queue/                            # pg-boss integration
├── runs/                             # Run API, persistence, processor, queue worker
│   ├── runs.controller.ts
│   ├── runs.service.ts
│   ├── run.repository.ts
│   ├── run-processor.service.ts
│   ├── run-queue-worker.service.ts
│   ├── active-session-tracker.service.ts
│   ├── sdk-session.factory.ts
│   ├── external-session.repository.ts
│   └── dto/
├── telegram/                         # Telegram API client + response delivery
├── triggers/                         # Cron scheduler
└── webhooks/                         # Linear, GitHub, and Telegram webhook entrypoints/services
```

## Running Tests

```bash
# Unit tests (no Docker required)
npm test

# Integration tests (requires Docker for testcontainers)
npm run test:integration
```

## Scripts

```bash
npm run start:dev       # Development with hot-reload
npm run build           # Production build
npm run start:prod      # Run production build
npm run test            # Run unit tests
npm run test:integration# Integration tests
npm run test:coverage   # Tests with coverage
npm run lint            # ESLint
npm run lint:fix        # ESLint with auto-fix
npm run typecheck       # TypeScript type checking
npm run format          # Prettier formatting
npm run format:check    # Check formatting
npm run deps:check      # Dependency-cruiser architecture checks

# Local quality scripts
./scripts/check-duplication.sh
./scripts/check-file-size.sh

# Deployment (production — bare-metal, supervised by systemd)
./scripts/deploy.sh     # Pull, build, migrate, restart via systemctl, health check
#                       # Override service name: AGENTQUEUE_SERVICE=...
#                       # Override scope (--user / --system): AGENTQUEUE_SYSTEMCTL_SCOPE=...
systemctl --user status agentqueue   # Check status
systemctl --user stop agentqueue     # Stop
```

## Docker

```bash
# Supporting services (Postgres) — dev or single-host prod
docker compose -f docker-compose.services.yml up -d

# Production — full stack (app + Postgres)
docker compose up -d
```

The production compose builds the app from the `Dockerfile`, wires it to Postgres, and includes health checks on both services. It reads additional env vars from `.env` (e.g. `AUTH_TOKEN`, `LANGFUSE_*`), while `DATABASE_URL` is overridden to use the internal Postgres service.

## CI Pipelines

| Workflow | Description |
|---|---|
| `lint-and-test.yml` | ESLint + Jest on every push/PR |
| `dead-code.yml` | Detect unused exports |
| `dependency-check.yml` | Circular dependency detection |
| `duplication-check.yml` | Code duplication analysis |
| `pr-title.yml` | Enforce conventional commit PR titles |
| `secret-scan.yml` | Scan for leaked secrets |
| `security-audit.yml` | npm audit for vulnerabilities |
