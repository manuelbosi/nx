import { glob, joinPathFragments, type Tree } from '@nx/devkit';
import { ensureTypescript } from '@nx/js/src/utils/typescript/ensure-typescript';
import type {
  BinaryExpression,
  ExportAssignment,
  Expression,
  ExpressionStatement,
  InterfaceDeclaration,
  MethodSignature,
  ObjectLiteralExpression,
  PropertyAssignment,
  PropertySignature,
  SourceFile,
} from 'typescript';
import type {
  NxComponentTestingOptions,
  NxCypressE2EPresetOptions,
} from '../../plugins/cypress-preset';

export const CYPRESS_CONFIG_FILE_NAME_PATTERN =
  'cypress.config.{js,ts,mjs,cjs}';

const TS_QUERY_COMMON_JS_EXPORT_SELECTOR =
  'BinaryExpression:has(Identifier[name="module"]):has(Identifier[name="exports"])';
const TS_QUERY_EXPORT_CONFIG_PREFIX = `:matches(ExportAssignment, ${TS_QUERY_COMMON_JS_EXPORT_SELECTOR}) `;

export async function addDefaultE2EConfig(
  cyConfigContents: string,
  options: NxCypressE2EPresetOptions,
  baseUrl: string
) {
  if (!cyConfigContents) {
    throw new Error('The passed in cypress config file is empty!');
  }
  const { tsquery } = await import('@phenomnomnominal/tsquery');

  const isCommonJS =
    tsquery.query(cyConfigContents, TS_QUERY_COMMON_JS_EXPORT_SELECTOR).length >
    0;
  const testingTypeConfig = tsquery.query<PropertyAssignment>(
    cyConfigContents,
    `${TS_QUERY_EXPORT_CONFIG_PREFIX} PropertyAssignment:has(Identifier[name="e2e"])`
  );

  let updatedConfigContents = cyConfigContents;

  if (testingTypeConfig.length === 0) {
    const configValue = `nxE2EPreset(__filename, ${JSON.stringify(
      options,
      null,
      2
    )
      .split('\n')
      .join('\n    ')})`;

    updatedConfigContents = tsquery.replace(
      cyConfigContents,
      `${TS_QUERY_EXPORT_CONFIG_PREFIX} ObjectLiteralExpression:first-child`,
      (node: ObjectLiteralExpression) => {
        let baseUrlContents = baseUrl ? `,\n    baseUrl: '${baseUrl}'` : '';
        if (node.properties.length > 0) {
          return `{
  ${node.properties.map((p) => p.getText()).join(',\n')},
  e2e: {
    ...${configValue}${baseUrlContents}
  } 
}`;
        }
        return `{
  e2e: {
    ...${configValue}${baseUrlContents}
  }
}`;
      }
    );

    return isCommonJS
      ? `const { nxE2EPreset } = require('@nx/cypress/plugins/cypress-preset');
${updatedConfigContents}`
      : `import { nxE2EPreset } from '@nx/cypress/plugins/cypress-preset';
${updatedConfigContents}`;
  }
  return updatedConfigContents;
}

/**
 * Adds the nxComponentTestingPreset to the cypress config file
 * Make sure after calling this the correct import statement is addeda
 * to bring in the nxComponentTestingPreset function
 **/
export async function addDefaultCTConfig(
  cyConfigContents: string,
  options: NxComponentTestingOptions = {}
) {
  if (!cyConfigContents) {
    throw new Error('The passed in cypress config file is empty!');
  }
  const { tsquery } = await import('@phenomnomnominal/tsquery');

  const testingTypeConfig = tsquery.query<PropertyAssignment>(
    cyConfigContents,
    `${TS_QUERY_EXPORT_CONFIG_PREFIX} PropertyAssignment:has(Identifier[name="component"])`
  );

  let updatedConfigContents = cyConfigContents;

  if (testingTypeConfig.length === 0) {
    let configValue = 'nxComponentTestingPreset(__filename)';
    if (options) {
      if (options.bundler !== 'vite') {
        // vite is the default bundler, so we don't need to set it
        delete options.bundler;
      }

      if (Object.keys(options).length) {
        configValue = `nxComponentTestingPreset(__filename, ${JSON.stringify(
          options
        )})`;
      }
    }

    updatedConfigContents = tsquery.replace(
      cyConfigContents,
      `${TS_QUERY_EXPORT_CONFIG_PREFIX} ObjectLiteralExpression:first-child`,
      (node: ObjectLiteralExpression) => {
        if (node.properties.length > 0) {
          return `{
  ${node.properties.map((p) => p.getText()).join(',\n')},
  component: ${configValue} 
}`;
        }
        return `{
  component: ${configValue}
}`;
      }
    );
  }
  return updatedConfigContents;
}

/**
 * Adds the mount command for Cypress
 * Make sure after calling this the correct import statement is added
 * to bring in the correct mount from cypress.
 **/
export async function addMountDefinition(cmpCommandFileContents: string) {
  if (!cmpCommandFileContents) {
    throw new Error('The passed in cypress component file is empty!');
  }
  const { tsquery } = await import('@phenomnomnominal/tsquery');
  const hasMountCommand =
    tsquery.query<MethodSignature | PropertySignature>(
      cmpCommandFileContents,
      'CallExpression StringLiteral[value="mount"]'
    )?.length > 0;

  if (hasMountCommand) {
    return cmpCommandFileContents;
  }

  const mountCommand = `Cypress.Commands.add('mount', mount);`;

  const updatedInterface = tsquery.replace(
    cmpCommandFileContents,
    'InterfaceDeclaration',
    (node: InterfaceDeclaration) => {
      return `interface ${node.name.getText()}${
        node.typeParameters
          ? `<${node.typeParameters.map((p) => p.getText()).join(', ')}>`
          : ''
      } {
      ${node.members.map((m) => m.getText()).join('\n      ')}
      mount: typeof mount;
    }`;
    }
  );
  return `${updatedInterface}\n${mountCommand}`;
}

export function getProjectCypressConfigPath(
  tree: Tree,
  projectRoot: string
): string {
  const cypressConfigPaths = glob(tree, [
    joinPathFragments(projectRoot, CYPRESS_CONFIG_FILE_NAME_PATTERN),
  ]);
  if (cypressConfigPaths.length === 0) {
    throw new Error(`Could not find a cypress config file in ${projectRoot}.`);
  }

  return cypressConfigPaths[0];
}

export function resolveCypressConfigObject(
  cypressConfigContents: string
): ObjectLiteralExpression | null {
  const ts = ensureTypescript();

  const { tsquery } = <typeof import('@phenomnomnominal/tsquery')>(
    require('@phenomnomnominal/tsquery')
  );
  const sourceFile = tsquery.ast(cypressConfigContents);

  const exportDefaultStatement = sourceFile.statements.find(
    (statement): statement is ExportAssignment =>
      ts.isExportAssignment(statement)
  );

  if (exportDefaultStatement) {
    return resolveCypressConfigObjectFromExportExpression(
      exportDefaultStatement.expression,
      sourceFile
    );
  }

  const moduleExportsStatement = sourceFile.statements.find(
    (
      statement
    ): statement is ExpressionStatement & { expression: BinaryExpression } =>
      ts.isExpressionStatement(statement) &&
      ts.isBinaryExpression(statement.expression) &&
      statement.expression.left.getText() === 'module.exports'
  );

  if (moduleExportsStatement) {
    return resolveCypressConfigObjectFromExportExpression(
      moduleExportsStatement.expression.right,
      sourceFile
    );
  }

  return null;
}

function resolveCypressConfigObjectFromExportExpression(
  exportExpression: Expression,
  sourceFile: SourceFile
): ObjectLiteralExpression | null {
  const ts = ensureTypescript();

  if (ts.isObjectLiteralExpression(exportExpression)) {
    return exportExpression;
  }

  if (ts.isIdentifier(exportExpression)) {
    // try to locate the identifier in the source file
    const variableStatements = sourceFile.statements.filter((statement) =>
      ts.isVariableStatement(statement)
    );

    for (const variableStatement of variableStatements) {
      for (const declaration of variableStatement.declarationList
        .declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.name.getText() === exportExpression.getText() &&
          ts.isObjectLiteralExpression(declaration.initializer)
        ) {
          return declaration.initializer;
        }
      }
    }

    return null;
  }

  if (
    ts.isCallExpression(exportExpression) &&
    ts.isIdentifier(exportExpression.expression) &&
    exportExpression.expression.getText() === 'defineConfig' &&
    ts.isObjectLiteralExpression(exportExpression.arguments[0])
  ) {
    return exportExpression.arguments[0];
  }

  return null;
}
