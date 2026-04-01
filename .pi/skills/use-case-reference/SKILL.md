---
name: use-case-reference
description: "Reference implementation for backend use cases — error handling, structure, and patterns. MUST be loaded when creating or modifying any *.use-case.ts file."
---

# Use Case Reference Implementation

This skill defines the canonical use case structure. Every use case MUST follow this pattern.

## Structure

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { ApplicationError } from 'src/common/errors/base.error';
import { UnauthorizedAccessError } from 'src/common/errors/unauthorized-access.error';
import { ContextService } from 'src/common/context/services/context.service';
// Import domain-specific errors from the module's errors file
import { EntityNotFoundError, UnexpectedEntityError } from '../../entity.errors';
// Import ports (repository interfaces)
import { EntityRepository } from '../../ports/entity.repository';

@Injectable()
export class DoSomethingUseCase {
  private readonly logger = new Logger(DoSomethingUseCase.name);

  constructor(
    private readonly entityRepository: EntityRepository,
    private readonly contextService: ContextService,
  ) {}

  async execute(command: DoSomethingCommand): Promise<Entity> {
    this.logger.log('Doing something', { entityId: command.entityId });

    try {
      // 1. Auth context
      const userId = this.contextService.get('userId');
      if (!userId) {
        throw new UnauthorizedAccessError();
      }

      // 2. Precondition checks (existence, permissions, business rules)
      const entity = await this.entityRepository.findOne(command.entityId, userId);
      if (!entity) {
        throw new EntityNotFoundError(command.entityId);
      }

      // 3. Business logic
      entity.updateName(command.name);

      // 4. Persist and return
      return await this.entityRepository.save(entity);

    } catch (error) {
      // 5. Error handling — REQUIRED in every use case
      if (error instanceof ApplicationError) throw error;
      this.logger.error('Error doing something', { error: error as Error });
      throw new UnexpectedEntityError(error);
    }
  }
}
```

## Rules

### 1. Every `execute()` method MUST be wrapped in try/catch

The catch block follows this exact pattern:

```typescript
catch (error) {
  if (error instanceof ApplicationError) throw error;
  this.logger.error('<descriptive context>', { error: error as Error });
  throw new UnexpectedModuleError(error);
}
```

- **Re-throw `ApplicationError`** subclasses as-is — these are domain errors with proper status codes
- **Log unexpected errors** with context (what operation failed)
- **Wrap in a module-specific `Unexpected*Error`** — never let raw errors escape

### 2. Never throw HTTP exceptions from use cases

```typescript
// WRONG ✗ — couples domain to HTTP
throw new UnauthorizedException('User not authenticated');
throw new NotFoundException('Agent not found');

// CORRECT ✓ — domain errors
throw new UnauthorizedAccessError();
throw new AgentNotFoundError(agentId);
```

Use cases throw `ApplicationError` subclasses. The global exception filter converts them to HTTP responses via `toHttpException()`.

### 3. Auth context comes from ContextService

```typescript
const userId = this.contextService.get('userId');
if (!userId) {
  throw new UnauthorizedAccessError();
}
```

Never accept `userId` as a command parameter.

### 4. Validate preconditions before mutating

Always check existence and permissions before performing writes:

```typescript
const entity = await this.repository.findOne(id, userId);
if (!entity) {
  throw new EntityNotFoundError(id);
}
// Only then proceed with mutation
```

### 5. Each module has its own errors file

Errors live in `application/<module>.errors.ts` and follow this structure:

```typescript
import { ApplicationError } from 'src/common/errors/base.error';

export enum EntityErrorCode {
  ENTITY_NOT_FOUND = 'ENTITY_NOT_FOUND',
  UNEXPECTED_ENTITY_ERROR = 'UNEXPECTED_ENTITY_ERROR',
  // ... other codes
}

export abstract class EntityError extends ApplicationError {
  constructor(message: string, code: EntityErrorCode, statusCode: number = 400) {
    super(message, code, statusCode);
  }
}

export class EntityNotFoundError extends EntityError {
  constructor(entityId: string) {
    super(`Entity with ID ${entityId} not found`, EntityErrorCode.ENTITY_NOT_FOUND, 404);
  }
}

export class UnexpectedEntityError extends EntityError {
  constructor(error: unknown) {
    super('Unexpected error occurred', EntityErrorCode.UNEXPECTED_ENTITY_ERROR, 500, { error });
  }
}
```

Every module MUST have an `Unexpected*Error` class for the catch block.

### 6. Logger — use the class name, log entry and errors

```typescript
private readonly logger = new Logger(MyUseCase.name);

// At the start of execute():
this.logger.log('Descriptive action', { relevantId: command.id });

// In catch block:
this.logger.error('Error descriptive action', { error: error as Error });
```

## Checklist

When creating or modifying a use case, verify:

- [ ] `execute()` body is wrapped in try/catch
- [ ] Catch block re-throws `ApplicationError`, logs and wraps everything else
- [ ] No HTTP exceptions (`NotFoundException`, `UnauthorizedException`, etc.)
- [ ] Auth context from `ContextService`, not command parameters
- [ ] Preconditions checked before mutations (entity exists, permissions valid)
- [ ] Module has an `Unexpected*Error` class in its errors file
- [ ] Logger uses class name, logs entry point and errors
