import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, test } from 'vitest';

test('public procedure and service-map types support declaration emit', () => {
  const rootDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
  );
  const config = ts.readConfigFile(
    path.join(rootDir, 'tsconfig.json'),
    (fileName) => ts.sys.readFile(fileName),
  );
  expect(config.error).toBeUndefined();

  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    rootDir,
    {
      declaration: true,
      declarationMap: false,
      emitDeclarationOnly: true,
      noEmit: false,
    },
    path.join(rootDir, 'tsconfig.json'),
  );
  const fixture = path.join(
    rootDir,
    '__tests__/fixtures/public-declaration-consumer.ts',
  );
  const program = ts.createProgram([fixture], parsed.options);
  const declarations = new Map<string, string>();
  const emit = program.emit(undefined, (fileName, contents) => {
    if (fileName.endsWith('.d.ts')) {
      declarations.set(path.basename(fileName), contents);
    }
  });
  const diagnostics = [
    ...ts.getPreEmitDiagnostics(program),
    ...emit.diagnostics,
  ];

  expect(
    diagnostics.map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    ),
  ).toEqual([]);

  const consumerDeclaration = declarations.get(
    'public-declaration-consumer.d.ts',
  );
  expect(consumerDeclaration).toContain('ProcedureDefinition');
  expect(consumerDeclaration).toContain('ProcedureDefinitionMap');
  expect(consumerDeclaration).toContain('InstantiatedServiceSchemaMap');
  expect(consumerDeclaration).not.toContain('__BRAND_DO_NOT_USE');
}, 10_000);
