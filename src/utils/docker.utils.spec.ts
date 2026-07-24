// Runtime-agnostic test (node:test + node:assert): runs under both `bun test` and `node --test`.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { isDockerFileName, parseImageRef, parseImageRefs, registryHost } from './docker.utils.js';

describe('registryHost', () => {
  test('maps Docker Hub to its canonical endpoint, everything else is identity', () => {
    assert.equal(registryHost('docker.io'), 'registry-1.docker.io');
    assert.equal(registryHost('ghcr.io'), 'ghcr.io');
    assert.equal(registryHost('myreg:5000'), 'myreg:5000');
  });
});

describe('isDockerFileName', () => {
  test('matches Dockerfiles and compose manifests', () => {
    [
      'Dockerfile',
      'Dockerfile.prod',
      'compose.yaml',
      'docker-compose.yml',
      'compose.ci.yaml',
    ].forEach(name => assert.equal(isDockerFileName(name), true, name));
    ['package.json', '.node-version', 'README.md', 'compose.txt'].forEach(name =>
      assert.equal(isDockerFileName(name), false, name)
    );
  });
});

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

describe('parseImageRef', () => {
  test('normalizes to docker canonical form (domain + library/ + tag + digest)', () => {
    assert.deepEqual(parseImageRef('postgres:16'), {
      domain: 'docker.io',
      repository: 'library/postgres',
      tag: '16',
      digest: null,
    });
    assert.deepEqual(parseImageRef('ghcr.io/x/y:1'), {
      domain: 'ghcr.io',
      repository: 'x/y',
      tag: '1',
      digest: null,
    });
    assert.equal(
      parseImageRef(`redis:7@sha256:${'a'.repeat(64)}`)?.digest,
      `sha256:${'a'.repeat(64)}`
    );
    assert.equal(parseImageRef('node')?.tag, null);
  });
});
