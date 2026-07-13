// Runtime-agnostic test (see spec.utils.spec.ts): runs under both `bun test` and `node --test`.
// The LTS is pinned on the context so `ensureNodeLts` never touches the network; fs is real,
// backed by a tmpdir.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type { ModuleContext, NodeLts } from '../../../context/context.types.js';
import { PackageManager } from '../../../context/context.types.js';
import type { PackageJson } from '../../../utils/package.types.js';
import { alignNpmToNodeLts } from './npm.package-manager.js';

/** npm bundled with the pinned Node LTS — distinct from any registry-latest npm. */
const LTS: NodeLts = { version: '24.18.0', major: 24, npm: '11.16.0' };

let dir: string;

function ctx(overrides: Partial<ModuleContext> = {}): ModuleContext {
  return {
    cwd: dir,
    workspaces: [dir],
    packageManager: PackageManager.Npm,
    nodeLts: { ...LTS },
    dryRun: false,
    ...overrides,
  } as ModuleContext;
}

async function writePkg(pkg: PackageJson): Promise<void> {
  await writeFile(join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
}

async function readField(): Promise<string | undefined> {
  return JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).packageManager;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bumper-npm-pm-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('npm package manager: alignNpmToNodeLts', () => {
  test('rewrites an npm@ field to the npm bundled with the Node LTS', async () => {
    await writePkg({ name: 'root', packageManager: 'npm@12.0.1' });
    await alignNpmToNodeLts(ctx());
    assert.equal(await readField(), `npm@${LTS.npm}`);
  });

  test('leaves a non-npm packageManager field untouched', async () => {
    await writePkg({ name: 'root', packageManager: 'pnpm@9.1.0' });
    await alignNpmToNodeLts(ctx());
    assert.equal(await readField(), 'pnpm@9.1.0');
  });

  test('never adds a packageManager field when none exists', async () => {
    await writePkg({ name: 'root' });
    await alignNpmToNodeLts(ctx());
    assert.equal(await readField(), undefined);
  });

  test('dry-run leaves the field untouched', async () => {
    await writePkg({ name: 'root', packageManager: 'npm@12.0.1' });
    await alignNpmToNodeLts(ctx({ dryRun: true }));
    assert.equal(await readField(), 'npm@12.0.1');
  });

  test('leaves the field untouched when the LTS carries no bundled npm version', async () => {
    await writePkg({ name: 'root', packageManager: 'npm@12.0.1' });
    await alignNpmToNodeLts(ctx({ nodeLts: { version: '24.18.0', major: 24 } }));
    assert.equal(await readField(), 'npm@12.0.1');
  });
});
