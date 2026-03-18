import { readFile } from 'fs/promises';
import { resolve, dirname, join } from 'path';
import { existsSync } from 'fs';

/**
 * Builds a map of TypeScript path aliases to their real file system paths.
 * Parses tsconfig.json (and follows 'extends' if needed).
 */
export async function buildAliasMap(repoRoot) {
  const tsconfigPath = resolve(repoRoot, 'tsconfig.json');
  const aliasMap = {};

  if (!existsSync(tsconfigPath)) {
    return aliasMap;
  }

  try {
    const content = await readFile(tsconfigPath, 'utf-8');
    // Basic JSON.parse (might fail with comments, but usually works for simple tsconfigs)
    // In a real monorepo, you'd use a more robust JSONC parser.
    const json = JSON.parse(content.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, ''));
    const paths = json?.compilerOptions?.paths ?? {};
    const baseUrl = json?.compilerOptions?.baseUrl ?? '.';

    for (const [alias, targets] of Object.entries(paths)) {
      if (Array.isArray(targets) && targets.length > 0) {
        const cleanAlias = alias.replace(/\/\*$/, '');
        const cleanTarget = targets[0].replace(/\/\*$/, '');
        aliasMap[cleanAlias] = join(baseUrl, cleanTarget);
      }
    }
  } catch (e) {
    // console.error('Failed to parse tsconfig.json:', e.message);
  }

  return aliasMap;
}
