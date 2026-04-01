/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // ═══════════════════════════════════════════════════════════════════════════
    // MODULAR NESTJS — Enforce module boundaries
    // Modules should not reach into each other's internals.
    // Cross-module communication goes through exported services.
    // ═══════════════════════════════════════════════════════════════════════════
    {
      name: 'no-circular-dependencies',
      comment: 'Circular dependencies indicate poor module design',
      severity: 'error',
      from: {},
      to: {
        circular: true,
      },
    },
  ],

  options: {
    doNotFollow: {
      path: ['node_modules'],
    },
    exclude: {
      path: [
        '\\.spec\\.ts$',
        '\\.test\\.ts$',
        '\\.e2e-spec\\.ts$',
        '/test/',
        '/generated/',
        '/db/migrations/',
        '\\.module\\.ts$',
      ],
    },
    includeOnly: {
      path: '^src/',
    },
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: './tsconfig.json',
    },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
  },
};
