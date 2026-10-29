// Runtime-agnostic test (see detection.spec.ts): runs under both `bun test` and `node --test`.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { contextFor } from '../../../testing/module-context.factory.js';
import { withTempDir } from '../../../testing/with-temp-dir.harness.js';
import {
  githubVersionFilesFeature,
  SETUP_ACTIONS,
  useVersionFiles,
} from './github-version-files.feature.js';

const workflow = (setup: string[]) =>
  [
    'jobs:',
    '  test:',
    '    steps:',
    '      - uses: actions/checkout@v4',
    ...setup,
    '      - run: npm test',
    '',
  ].join('\n');

describe('useVersionFiles', () => {
  test('points a literal version at the version file', () => {
    const out = useVersionFiles(
      workflow([
        '      - uses: actions/setup-node@v4',
        '        with:',
        '          node-version: 22',
      ])
    );
    assert.ok(out.includes('          node-version-file: .node-version'));
    assert.ok(!out.includes('node-version: 22'));
    assert.ok(out.includes('      - run: npm test'), 'the steps around stay');
  });

  test('takes quoted, wildcard and alias pins, and keeps a trailing comment', () => {
    ["'22'", '"22.x"', 'lts/*', 'v22.1.0', 'latest', 'node', 'current'].forEach(pin => {
      const out = useVersionFiles(
        workflow([
          '      - uses: actions/setup-node@v4',
          '        with:',
          `          node-version: ${pin} # was`,
        ])
      );
      assert.ok(out.includes('node-version-file: .node-version # was'), pin);
    });
  });

  test('finds the step when uses is not its first key', () => {
    const out = useVersionFiles(
      workflow([
        '      - name: node',
        '        uses: actions/setup-node@v4',
        '        with:',
        '          cache: npm',
        '          node-version: 22',
      ])
    );
    assert.ok(out.includes('          node-version-file: .node-version'));
    assert.ok(out.includes('          cache: npm'));
  });

  test('leaves expressions, lists and other actions alone', () => {
    const body = workflow([
      '      - uses: actions/setup-node@v4',
      '        with:',
      '          node-version: ${{ matrix.node }}',
      '      - uses: actions/setup-node@v4',
      '        with:',
      '          node-version: [20, 22]',
      '      - uses: some/other-action@v1',
      '        with:',
      '          node-version: 22',
    ]);
    assert.equal(useVersionFiles(body), body);
  });

  test('leaves a step that reads a file already', () => {
    const body = workflow([
      '      - uses: actions/setup-node@v4',
      '        with:',
      '          node-version: 22',
      '          node-version-file: .nvmrc',
    ]);
    assert.equal(useVersionFiles(body), body);
  });

  test('holds a line below a `# bumper: skip` comment', () => {
    const body = workflow([
      '      - uses: actions/setup-node@v4',
      '        with:',
      '          # bumper: skip - the oldest supported node',
      '          node-version: 18',
    ]);
    assert.equal(useVersionFiles(body), body);
  });

  test('does not reach into the next step', () => {
    const out = useVersionFiles(
      workflow([
        '      - uses: actions/setup-node@v4',
        '      - uses: some/other-action@v1',
        '        with:',
        '          node-version: 22',
      ])
    );
    assert.ok(out.includes('node-version: 22'), 'the other action keeps its input');
  });

  test('points a literal bun-version at .bun-version, leaving canary', () => {
    const out = useVersionFiles(
      workflow([
        '      - uses: oven-sh/setup-bun@v2',
        '        with:',
        '          bun-version: 1.2',
        '      - uses: oven-sh/setup-bun@v2',
        '        with:',
        '          bun-version: canary',
      ])
    );
    assert.ok(out.includes('          bun-version-file: .bun-version'));
    assert.ok(out.includes('          bun-version: canary'));
  });

  test('rewrites only the given setup actions', () => {
    const body = workflow([
      '      - uses: oven-sh/setup-bun@v2',
      '        with:',
      '          bun-version: 1.2',
    ]);
    const node = SETUP_ACTIONS.filter(setup => setup.pin === '.node-version');
    assert.equal(useVersionFiles(body, node), body);
  });

  test('drops a literal pnpm version, and the with block it leaves empty', () => {
    const out = useVersionFiles(
      workflow([
        '      - uses: pnpm/action-setup@v4',
        '        with:',
        '          version: 10',
        '      - uses: pnpm/action-setup@v4',
        '        with:',
        '          version: 9.x',
        '          run_install: false',
      ])
    );
    assert.ok(!/version: (10|9\.x)/.test(out), 'versions dropped');
    assert.equal(out.match(/with:/g)?.length, 1, 'only the emptied with block is gone');
    assert.ok(out.includes('        with:\n          run_install: false'));
    assert.ok(out.includes('      - run: npm test'), 'the steps around stay');
  });

  test('keeps a pnpm version given by an expression', () => {
    const body = workflow([
      '      - uses: pnpm/action-setup@v4',
      '        with:',
      '          version: ${{ matrix.pnpm }}',
    ]);
    assert.equal(useVersionFiles(body), body);
  });

  test('leaves a step not preceded by a checkout of the repo into its root', () => {
    const setup = [
      '      - uses: actions/setup-node@v4',
      '        with:',
      '          node-version: 22',
    ];
    const before = [
      'jobs:',
      '  test:',
      '    steps:',
      ...setup,
      '      - uses: actions/checkout@v4',
    ];
    const otherJob = [
      'jobs:',
      '  lint:',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '  test:',
      '    steps:',
      ...setup,
    ];
    const intoPath = [
      'jobs:',
      '  test:',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '        with:',
      '          path: app',
      ...setup,
    ];
    [before, otherJob, intoPath].forEach(lines => {
      const body = lines.join('\n');
      assert.equal(useVersionFiles(body), body);
    });
  });

  test('leaves a pnpm step reading another manifest', () => {
    const body = workflow([
      '      - uses: pnpm/action-setup@v4',
      '        with:',
      '          version: 9',
      '          package_json_file: app/package.json',
    ]);
    assert.equal(useVersionFiles(body), body);
  });

  test('drops a with block left holding only a comment', () => {
    const out = useVersionFiles(
      workflow([
        '      - uses: pnpm/action-setup@v4',
        '        with:',
        '          # pinned for ci',
        '          version: 9',
      ])
    );
    assert.ok(!out.includes('with:') && !out.includes('version: 9'));
  });
});

describe('github-version-files feature', () => {
  const setup = [
    '      - uses: actions/setup-node@v4',
    '        with:',
    '          node-version: 22',
  ];

  async function repo(dir: string, pin: boolean) {
    await mkdir(join(dir, '.github', 'workflows'), { recursive: true });
    await writeFile(join(dir, '.github', 'workflows', 'ci.yml'), workflow(setup));
    if (pin) {
      await writeFile(join(dir, '.node-version'), 'v26.13.0\n');
    }
  }

  test('rewrites the workflows of a repo that has the pin', async () => {
    await withTempDir('github-version-files', async dir => {
      await repo(dir, true);
      await githubVersionFilesFeature.update(contextFor(dir));
      const out = await readFile(join(dir, '.github', 'workflows', 'ci.yml'), 'utf8');
      assert.ok(out.includes('node-version-file: .node-version'));
    });
  });

  test('does nothing without the pin to read, or on a dry run', async () => {
    await withTempDir('github-version-files', async dir => {
      await repo(dir, false);
      const path = join(dir, '.github', 'workflows', 'ci.yml');
      const before = await readFile(path, 'utf8');
      await githubVersionFilesFeature.update(contextFor(dir));
      assert.equal(await readFile(path, 'utf8'), before, 'no pin');

      await writeFile(join(dir, '.node-version'), 'v26.13.0\n');
      await githubVersionFilesFeature.update(contextFor(dir, true));
      assert.equal(await readFile(path, 'utf8'), before, 'dry run');
    });
  });

  test('applies only where a workflow still pins a version by hand', async () => {
    await withTempDir('github-version-files', async dir => {
      assert.equal(await githubVersionFilesFeature.isUsed(contextFor(dir)), false, 'no workflows');
      await repo(dir, true);
      assert.equal(await githubVersionFilesFeature.isUsed(contextFor(dir)), true, 'a literal pin');
      await githubVersionFilesFeature.update(contextFor(dir));
      assert.equal(await githubVersionFilesFeature.isUsed(contextFor(dir)), false, 'followed');
    });
  });

  test('applies only where a pin file is there to follow', async () => {
    await withTempDir('github-version-files', async dir => {
      await mkdir(join(dir, '.github', 'workflows'), { recursive: true });
      const body = workflow([
        '      - uses: oven-sh/setup-bun@v2',
        '        with:',
        '          bun-version: 1.2',
      ]);
      await writeFile(join(dir, '.github', 'workflows', 'ci.yml'), body);
      // a node repo has no .bun-version for the step to read
      assert.equal(await githubVersionFilesFeature.isUsed(contextFor(dir)), false, 'no pin');
      await writeFile(join(dir, '.bun-version'), '1.3.0\n');
      assert.equal(await githubVersionFilesFeature.isUsed(contextFor(dir)), true, 'pinned');
    });
  });

  test('drops the pnpm version only where packageManager names pnpm', async () => {
    await withTempDir('github-version-files', async dir => {
      await mkdir(join(dir, '.github', 'workflows'), { recursive: true });
      const path = join(dir, '.github', 'workflows', 'ci.yml');
      const body = workflow([
        '      - uses: pnpm/action-setup@v4',
        '        with:',
        '          version: 9',
      ]);
      await writeFile(path, body);
      await writeFile(join(dir, 'package.json'), '{ "packageManager": "npm@11.0.0" }\n');
      assert.equal(await githubVersionFilesFeature.isUsed(contextFor(dir)), false, 'not pnpm');

      await writeFile(join(dir, 'package.json'), '{ "packageManager": "pnpm@10.0.0" }\n');
      assert.equal(await githubVersionFilesFeature.isUsed(contextFor(dir)), true, 'pnpm');
      await githubVersionFilesFeature.update(contextFor(dir));
      assert.ok(!(await readFile(path, 'utf8')).includes('version: 9'));
    });
  });

  test('leaves excluded workflows alone', async () => {
    await withTempDir('github-version-files', async dir => {
      await repo(dir, true);
      const path = join(dir, '.github', 'workflows', 'ci.yml');
      const before = await readFile(path, 'utf8');
      await githubVersionFilesFeature.update(contextFor(dir, false, ['.github/workflows/ci.yml']));
      assert.equal(await readFile(path, 'utf8'), before);
    });
  });

  test('config toggle overrides the detection', async () => {
    await withTempDir('github-version-files', async dir => {
      const base = contextFor(dir);
      const off = {
        ...base,
        config: { ...base.config, modules: { 'github-version-files': false } },
      };
      const on = { ...base, config: { ...base.config, modules: { 'github-version-files': true } } };
      await repo(dir, true);
      assert.equal(await githubVersionFilesFeature.isUsed(off), false);
      assert.equal(await githubVersionFilesFeature.isUsed(on), true);
    });
  });
});
