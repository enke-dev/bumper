// Runtime-agnostic test (node:test + node:assert): runs under both `bun test` and `node --test`.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { readDockerConfigAuth } from './docker-auth.utils.js';

const b64 = (value: string): string => Buffer.from(value).toString('base64');
const reader = (config: unknown) => async () => JSON.stringify(config);

describe('readDockerConfigAuth', () => {
  test('decodes inline Basic credentials for a registry', async () => {
    const read = reader({ auths: { 'ghcr.io': { auth: b64('me:secret') } } });
    assert.deepEqual(await readDockerConfigAuth('ghcr.io', { home: '/h', read }), {
      username: 'me',
      password: 'secret',
    });
  });

  test('matches Docker Hub under any of its config-key spellings', async () => {
    const read = reader({ auths: { 'https://index.docker.io/v1/': { auth: b64('u:p') } } });
    assert.deepEqual(await readDockerConfigAuth('docker.io', { home: '/h', read }), {
      username: 'u',
      password: 'p',
    });
  });

  test('returns null for a credential-helper config (no inline auth to read)', async () => {
    const read = reader({ auths: { 'ghcr.io': {} }, credsStore: 'osxkeychain' });
    assert.equal(await readDockerConfigAuth('ghcr.io', { home: '/h', read }), null);
  });

  test('returns null when the config is missing or unreadable', async () => {
    const read = async () => {
      throw new Error('ENOENT');
    };
    assert.equal(await readDockerConfigAuth('ghcr.io', { home: '/h', read }), null);
  });
});
