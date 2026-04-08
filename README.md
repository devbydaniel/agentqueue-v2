# AgentQueue v2

Centralized agent orchestrator for AI agent workloads. Receives triggers (cron schedules, Linear webhooks, GitHub webhooks), resolves a target repo, and runs a [pi](https://github.com/mariozechner/pi-coding-agent) agent session against it.

## Architecture

NestJS modular backend backed by Postgres (via Drizzle ORM) and pg-boss for job queueing. Runs are enqueued asynchronously — `POST /runs` returns `202` immediately with a `runId`, and the run is processed by a background queue worker.

```text
┌─────────────┐   ┌──────────────┐   ┌──────────────┐
│  Cron        │   │  Linear      │   │  GitHub      │
│  Scheduler   │   │  Webhook     │   │  Webhook     │
└──────┬───────┘   └──────┬───────┘   └──────┬───────┘
       │                  │                  │
       └──────────────────┼──────────────────┘
                          │
                   ┌──────▼───────┐
                   │ ExecuteRun   │
                   │ UseCase      │
                   └──────┬───────┘
                          │
                   ┌──────▼───────┐
                   │ pi Agent     │
                   │ Session      │
                   └──────┬───────┘
                          │
              ┌───────────┼───────────┐
              │           │           │
        ┌─────▼──┐  ┌─────▼──┐  ┌────▼────┐
        │ Logger │  │Langfuse│  │ Linear  │
        │Handler │  │Handler │  │Handler  │
        └────────┘  └────────┘  └─────────┘
```

## Requirements

- Node.js >= 20
- pi agent CLI installed (`@mariozechner/pi-coding-agent`)
- Agentfiles config at `~/.config/agentfiles/config.toml`

## Quick Start

```bash
# Install dependencies
npm install

# Copy env file and fill in values
cp .env.example .env

# Start Postgres (Docker required)
docker compose up -d postgres

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
docker compose up -d postgres

# Apply migrations
npm run db:migrate

# Browse schema (optional)
npm run db:studio
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
| `POST` | `/webhooks/linear/:agentName` | Signature | Receive Linear Agent Interaction webhooks |
| `GET` | `/webhooks/linear/:agentName` | Public | Linear webhook URL verification |
| `POST` | `/webhooks/github` | Signature | Receive GitHub webhooks |

Swagger docs are available at `/docs` when the server is running.

### POST /runs

> **Breaking change:** `POST /runs` is now async-first. It returns `202 Accepted` immediately with `{ runId, status: 'waiting' }`. The run is processed in the background by the queue worker. To check the result, poll `GET /runs/:id` (coming soon).

Enqueue an async agent run against a configured repo:

```bash
# Step 1: Enqueue the run
curl -s -X POST http://localhost:3000/runs \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"repo": "my-repo", "prompt": "Fix the failing tests"}'
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

Query parameters: `status`, `source`, `repo`, `trigger`, `since`, `limit`, `offset`.

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

### POST /webhooks/github

Single endpoint for all GitHub webhooks. Configure your GitHub repo/org to send webhooks to this URL with a shared secret. The trigger config determines which events match and which repo/agent handles them.

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

### Agentfiles Config

Repos are registered in `~/.config/agentfiles/config.toml`:

```toml
[[repos]]
name = "my-repo"
path = "~/dev/my-repo"

[[repos]]
name = "other-repo"
path = "~/dev/other-repo"
```

The `repo` / `target` field in runs and triggers maps to these entries.

### Trigger Config

Triggers are defined in `~/.agentqueue/triggers.yaml`. Three types are supported:

#### Cron Triggers

Run an agent on a schedule:

```yaml
triggers:
  - name: daily-review
    schedule: "0 8 * * *"
    target: my-repo
    prompt: "Run the morning review routine"
    prepend_system_prompt: "Today is {{date}}."
```

Template variables for cron: `{{triggerName}}`, `{{schedule}}`, `{{date}}`, `{{target}}`.

### Before hooks

Cron and GitHub triggers support an optional `before` field that runs a shell
command before the agent is invoked. The hook can **gate** the run (skip
entirely if it exits non-zero) and **enrich** the prompt (substitute its stdout
into `{{before_output}}`).

```yaml
triggers:
  - name: meeting-prep
    schedule: "*/30 8-17 * * 1-5"
    target: assistant
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
inline shell expression. It does **not** apply to Linear triggers (those have
no static prompt to gate).

#### Linear Triggers

Receive webhooks from Linear's Agent Interaction API:

```yaml
triggers:
  - name: coding-agent
    type: linear
    target: my-repo
    signing_secret: ${LINEAR_SIGNING_SECRET}
    api_key: ${LINEAR_API_KEY}
    prepend_system_prompt: "You are working on issues in {{target}}."
```

The `${VAR}` syntax interpolates from environment variables. The webhook URL is `POST /webhooks/linear/<name>`.

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
    target: "{{repository.name}}"
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
4. For each match, interpolates `target`, `prompt`, and system prompts using the webhook payload, then fires an agent run

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
| **Linear** | Per-run | Posts agent activity back to Linear (only for Linear webhook runs) |

## Project Structure

```text
src/
├── main.ts                           # Entry point, Swagger setup
├── app.module.ts                     # Root module
├── instrumentation.ts                # OpenTelemetry / Langfuse init
├── auth/
│   ├── auth.guard.ts                 # Bearer token guard (global)
│   └── public.decorator.ts           # @Public() to skip auth
├── config/
│   ├── app-config.service.ts         # Centralized env var access
│   ├── agentfiles-config.service.ts  # Repo resolution from agentfiles config
│   └── config.errors.ts
├── runs/
│   ├── runs.controller.ts            # POST /runs
│   ├── application/
│   │   └── execute-run.use-case.ts   # Core: create pi session, run prompt
│   ├── session-registry.service.ts   # Track sessions for resumption/abort
│   └── dto/
├── triggers/
│   ├── trigger-config.service.ts     # Load triggers from YAML
│   ├── trigger-config.interface.ts   # CronTrigger, LinearTrigger, GithubTrigger types
│   └── cron-scheduler.service.ts     # node-cron scheduler
├── webhooks/
│   ├── webhooks.controller.ts        # Webhook endpoints (Linear + GitHub)
│   ├── linear-webhook.service.ts     # Linear signature verification & parsing
│   └── github/
│       ├── github-webhook.service.ts # GitHub signature verification & trigger matching
│       ├── webhook-filter.ts         # Filter engine (equals/contains/in/pattern)
│       └── payload-template.ts       # {{dotted.path}} template interpolation
├── callbacks/
│   ├── callback-handler.interface.ts # CallbackHandler contract
│   └── handlers/
│       ├── logger.callback-handler.ts
│       ├── langfuse.callback-handler.ts
│       └── linear.callback-handler.ts
└── common/
    ├── errors/base.error.ts          # ApplicationError base class
    └── filters/                      # Global exception filter
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
npm run test:coverage   # Tests with coverage
npm run lint            # ESLint
npm run lint:fix        # ESLint with auto-fix
npm run typecheck       # TypeScript type checking
npm run format          # Prettier formatting
npm run format:check    # Check formatting

# Deployment (production)
./scripts/deploy.sh     # Pull, build, restart with health check
./scripts/stop.sh       # Stop the running process
./scripts/status.sh     # Check if running and healthy
```

## CI Pipelines

| Workflow | Description |
|---|---|
| `lint-and-test.yml` | ESLint + Jest on every push/PR |
| `complexity-check.yml` | Flag overly complex functions |
| `dead-code.yml` | Detect unused exports |
| `dependency-check.yml` | Circular dependency detection |
| `duplication-check.yml` | Code duplication analysis |
| `pr-title.yml` | Enforce conventional commit PR titles |
| `secret-scan.yml` | Scan for leaked secrets |
| `security-audit.yml` | npm audit for vulnerabilities |
