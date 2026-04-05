import { ApplicationError } from '../../common/errors/base.error.js';

export enum FlowErrorCode {
  FLOW_NOT_FOUND = 'FLOW_NOT_FOUND',
  FLOW_CONFIG_INVALID = 'FLOW_CONFIG_INVALID',
  FLOW_AGENT_NOT_FOUND = 'FLOW_AGENT_NOT_FOUND',
  FLOW_RESOLVER_ERROR = 'FLOW_RESOLVER_ERROR',
  FLOW_RUN_NOT_FOUND = 'FLOW_RUN_NOT_FOUND',
  FLOW_DISPATCH_FAILED = 'FLOW_DISPATCH_FAILED',
  UNEXPECTED_FLOW_ERROR = 'UNEXPECTED_FLOW_ERROR',
}

export abstract class FlowError extends ApplicationError {
  constructor(message: string, code: FlowErrorCode, statusCode: number = 400) {
    super(message, code, statusCode);
  }
}

export class FlowNotFoundError extends FlowError {
  constructor(name: string) {
    super(`Flow "${name}" not found`, FlowErrorCode.FLOW_NOT_FOUND, 404);
  }
}

export class FlowConfigInvalidError extends FlowError {
  constructor(detail: string) {
    super(
      `Invalid flow config: ${detail}`,
      FlowErrorCode.FLOW_CONFIG_INVALID,
      400,
    );
  }
}

export class FlowAgentNotFoundError extends FlowError {
  constructor(agentName: string, flowName: string) {
    super(
      `Resolver returned unknown agent "${agentName}" in flow "${flowName}"`,
      FlowErrorCode.FLOW_AGENT_NOT_FOUND,
      400,
    );
  }
}

export class FlowResolverError extends FlowError {
  constructor(detail: string) {
    super(
      `Flow resolver error: ${detail}`,
      FlowErrorCode.FLOW_RESOLVER_ERROR,
      500,
    );
  }
}

export class FlowRunNotFoundError extends FlowError {
  constructor(runId: string) {
    super(
      `Flow run "${runId}" not found`,
      FlowErrorCode.FLOW_RUN_NOT_FOUND,
      404,
    );
  }
}

export class FlowDispatchFailedError extends FlowError {
  constructor(detail: string) {
    super(
      `Flow dispatch failed: ${detail}`,
      FlowErrorCode.FLOW_DISPATCH_FAILED,
      500,
    );
  }
}

export class UnexpectedFlowError extends FlowError {
  constructor(error: unknown) {
    const message =
      error instanceof Error ? error.message : 'Unexpected flow error';
    super(message, FlowErrorCode.UNEXPECTED_FLOW_ERROR, 500);
  }
}
