// Runtime-agnostic test (see detection.spec.ts): runs under both `bun test` and `node --test`.
// The Node LTS is pinned on the context and the registry lookup stubbed, so no network call is made.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { contextFor, NODE_LTS } from '../../../testing/module-context.factory.js';
import { withTempDir } from '../../../testing/with-temp-dir.harness.js';
import { readPackageJson } from '../../../utils/fs.utils.js';
import { tsconfigNodeFeature, updateTsconfigNode } from './tsconfig-node.feature.js';

const NEXT = `@tsconfig/node${NODE_LTS.major}`;
const resolveInRange = async () => `${NODE_LTS.major}.0.4`;

async function repo(dir: string, spec = '^20.1.0') {
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ devDependencies: { '@tsconfig/node20': spec, typescript: '^5.9.0' } })
  );
  await writeFile(
    join(dir, 'tsconfig.json'),
    '{\n  // the base\n  "extends": "@tsconfig/node20/tsconfig.json"\n}\n'
  );
  await mkdir(join(dir, 'packages', 'a'), { recursive: true });
  await writeFile(
    join(dir, 'packages', 'a', 'tsconfig.build.json'),
    '{ "extends": ["@tsconfig/node20", "../../tsconfig.json"] }\n'
  );
}

describe('tsconfig-node feature', () => {
  test('swaps an older base for the LTS one in manifests and tsconfigs', async () => {
    await withTempDir('tsconfig-node', async dir => {
      await repo(dir);
      await updateTsconfigNode(contextFor(dir), resolveInRange);
      const pkg = await readPackageJson(dir);
      assert.deepEqual(pkg?.devDependencies, {
        [NEXT]: `^${NODE_LTS.major}.0.4`,
        typescript: '^5.9.0',
      });
      assert.equal(
        await readFile(join(dir, 'tsconfig.json'), 'utf8'),
        `{\n  // the base\n  "extends": "${NEXT}/tsconfig.json"\n}\n`
      );
      assert.ok(
        (await readFile(join(dir, 'packages', 'a', 'tsconfig.build.json'), 'utf8')).includes(
          `["${NEXT}", "../../tsconfig.json"]`
        )
      );
    });
  });

  test('leaves everything when the new base is not published, on a dry run, or for a protocol spec', async () => {
    await withTempDir('tsconfig-node', async dir => {
      await repo(dir);
      const before = await readFile(join(dir, 'tsconfig.json'), 'utf8');
      await updateTsconfigNode(contextFor(dir), async () => null);
      await updateTsconfigNode(contextFor(dir, true), resolveInRange);
      assert.equal(await readFile(join(dir, 'tsconfig.json'), 'utf8'), before);
      assert.ok((await readPackageJson(dir))?.devDependencies?.['@tsconfig/node20']);

      await repo(dir, 'catalog:');
      await updateTsconfigNode(contextFor(dir), resolveInRange);
      assert.equal(await readFile(join(dir, 'tsconfig.json'), 'utf8'), before);
    });
  });

  test('keeps a floating spec, and a target base the manifest lists already', async () => {
    await withTempDir('tsconfig-node', async dir => {
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({
          devDependencies: { '@tsconfig/node20': 'latest' },
          dependencies: { '@tsconfig/node20': '^20.1.0', [NEXT]: `~${NODE_LTS.major}.0.0` },
        })
      );
      await updateTsconfigNode(contextFor(dir), resolveInRange);
      const pkg = await readPackageJson(dir);
      assert.deepEqual(pkg?.devDependencies, { [NEXT]: 'latest' });
      assert.deepEqual(pkg?.dependencies, { [NEXT]: `~${NODE_LTS.major}.0.0` });
    });
  });

  test('never moves a base newer than the LTS down', async () => {
    await withTempDir('tsconfig-node', async dir => {
      const newer = `@tsconfig/node${NODE_LTS.major + 2}`;
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({ devDependencies: { [newer]: '^1.0.0' } })
      );
      await updateTsconfigNode(contextFor(dir), resolveInRange);
      assert.deepEqual((await readPackageJson(dir))?.devDependencies, { [newer]: '^1.0.0' });
    });
  });

  test('applies where a manifest depends on a node base', async () => {
    await withTempDir('tsconfig-node', async dir => {
      assert.equal(await tsconfigNodeFeature.isUsed(contextFor(dir)), false);
      await repo(dir);
      assert.equal(await tsconfigNodeFeature.isUsed(contextFor(dir)), true);
    });
  });
});
