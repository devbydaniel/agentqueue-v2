import { BadRequestException, Injectable } from '@nestjs/common';

export type ResolverResult =
  | { agent: string; vars: Record<string, string> }
  | { done: true; summary?: string }
  | { escalate: string };

export type Resolver = (
  flowDir: string,
  vars: Record<string, string>,
) => ResolverResult | Promise<ResolverResult>;

/**
 * Loads a flow's resolver TypeScript module from disk via a dynamic import.
 *
 * Registers the `tsx` CJS loader so the resolver file can be authored as
 * TypeScript without a separate build step. Throws `BadRequestException` if
 * the module does not export a `resolve` function.
 */
@Injectable()
export class FlowResolverLoaderService {
  async load(resolverPath: string): Promise<Resolver> {
    // Register tsx loader for TypeScript resolvers
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- tsx CJS registration must use require()
    require('tsx/cjs/api');
    const mod = (await import(resolverPath)) as { resolve?: Resolver };

    if (typeof mod.resolve !== 'function') {
      throw new BadRequestException(
        `Resolver module at "${resolverPath}" does not export a "resolve" function`,
      );
    }

    return mod.resolve;
  }
}
