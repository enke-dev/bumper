// Runtime-agnostic test (node:test + node:assert): runs under both `bun test` and `node --test`.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { imageRepo, parseImageRefs, partitionByOwnership } from './docker-refs.utils.js';

describe('parseImageRefs', () => {
  test('extracts FROM refs, ignoring platform flag, stage alias and scratch', () => {
    const dockerfile = [
      'FROM node:22-alpine AS build',
      'FROM --platform=linux/amd64 postgres:16',
      'FROM scratch',
      'COPY --from=build /app /app',
    ].join('\n');
    assert.deepEqual(parseImageRefs(dockerfile), ['node:22-alpine', 'postgres:16']);
  });

  test('extracts compose image: refs, quoted or bare', () => {
    const compose = [
      'services:',
      '  a:',
      '    image: redis:7.2',
      '  b:',
      '    image: "nginx:1.27"',
    ].join('\n');
    assert.deepEqual(parseImageRefs(compose), ['redis:7.2', 'nginx:1.27']);
  });
});

describe('imageRepo', () => {
  test('strips tag + digest, keeps registry/namespace', () => {
    const cases: Record<string, string> = {
      'node:22': 'node',
      postgres: 'postgres',
      'ghcr.io/x/app:1.2': 'ghcr.io/x/app',
      'redis:7.2.4@sha256:abc': 'redis',
      'myreg:5000/x:1.0': 'myreg:5000/x',
    };
    Object.entries(cases).forEach(([ref, repo]) => assert.equal(imageRepo(ref), repo, ref));
  });
});

describe('partitionByOwnership', () => {
  test('owned repos are held back; a same-name image under another namespace is not', () => {
    const { owned, candidates } = partitionByOwnership(
      ['node:22', 'postgres:16', 'ghcr.io/x/node:1'],
      new Set(['node'])
    );
    assert.deepEqual(owned, ['node:22']);
    assert.deepEqual(candidates, ['postgres:16', 'ghcr.io/x/node:1']);
  });
});
