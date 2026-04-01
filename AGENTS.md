# agentqueue-v2

Centralized agent orchestrater for AI agent workloads.

## Architecture

NestJS modular backend (medium tier). No database — job state is in-memory or will use Redis/BullMQ when added later.

## Directory Structure

```text
agentqueue-v2/
├── src/
│   ├── [module]/           # Feature modules (jobs, triggers, workers, etc.)
│   │   ├── [module].module.ts
│   │   ├── [module].controller.ts
│   │   ├── [module].service.ts
│   │   └── dto/
│   ├── health/             # Health check endpoint
│   ├── main.ts             # Entry point
│   └── app.module.ts       # Root module
├── scripts/                # Quality check scripts
├── .github/workflows/      # CI pipelines
└── AGENTS.md               # Agent guidelines
```

## Config Files

- **Agentfiles config** (`~/.config/agentfiles/config.toml`): Defines repos (name → local path), stores, bundles. Parsed by `AgentfilesConfigService`.
- **Triggers config** (`~/.agentqueue/triggers.yaml`): Defines cron triggers and webhook trigger settings (e.g. Linear). Parsed by `TriggerConfigService`.

## Dev Environment

```bash
npm run start:dev     # NestJS with --watch
```

Health check: `curl http://localhost:${PORT:-3000}/health`

## Conventions

- **Commits**: Conventional commits (`feat:`, `fix:`, `chore:`, etc.) — no ticket prefix required
- **Modules**: Each domain concept gets its own NestJS module
- **No console.\***: Use NestJS `Logger`
