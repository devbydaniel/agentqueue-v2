# AgentQueue v2

Centralized agent orchestrator for AI agent workloads. Receives triggers (cron schedules, Linear webhooks, GitHub webhooks), resolves a target repo, and runs a [pi](https://github.com/mariozechner/pi-coding-agent) agent session against it.

## Architecture

NestJS modular backend. No database — job state is in-memory. Runs are executed synchronously via the pi SDK, with webhook endpoints returning `200` immediately and firing runs in the background.

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

# Development (with hot-reload)
npm run start:dev

# Health check
curl http://localhost:${PORT:-3000}/health
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `PORT` | No | Server port (default: `3000`) |
| `AUTH_TOKEN` | **Yes** | Bearer token for authenticated endpoints |
| `GITHUB_WEBHOOK_SECRET` | No | HMAC secret for GitHub webhook signature verification |
| `LANGFUSE_SECRET_KEY` | No | Enables Langfuse tracing when set |
| `LANGFUSE_PUBLIC_KEY` | No | Langfuse public key |
| `LANGFUSE_BASE_URL` | No | Langfuse API URL |
| `LINEAR_SIGNING_SECRET` | No | Referenced via `${VAR}` in trigger config |
| `LINEAR_API_KEY` | No | Referenced via `${VAR}` in trigger config |

## API Endpoints

All endpoints except health and webhooks require `Authorization: Bearer <AUTH_TOKEN>`.

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | Public | Health check |
| `POST` | `/runs` | Bearer | Execute a synchronous agent run |
| `POST` | `/webhooks/linear/:agentName` | Signature | Receive Linear Agent Interaction webhooks |
| `GET` | `/webhooks/linear/:agentName` | Public | Linear webhook URL verification |
| `POST` | `/webhooks/github` | Signature | Receive GitHub webhooks |

Swagger docs are available at `/docs` when the server is running.

### POST /runs

Execute a synchronous agent run against a configured repo:

```bash
curl -X POST http://localhost:3000/runs \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"repo": "my-repo", "prompt": "Fix the failing tests"}'
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

## Scripts

```bash
npm run start:dev       # Development with hot-reload
npm run build           # Production build
npm run start:prod      # Run production build
npm run test            # Run tests
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
