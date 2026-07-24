// Runtime-agnostic test (node:test + node:assert): runs under both `bun test` and `node --test`.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { RegistryAuth } from './docker-auth.utils.js';
import { fetchOciTags } from './oci-registry.client.js';

const CHALLENGE =
  'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:x/y:pull"';

describe('fetchOciTags', () => {
  test('returns tags directly when the registry serves them anonymously', async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ tags: ['1', '2'] }), { status: 200 });
    assert.deepEqual(await fetchOciTags('ghcr.io', 'x/y', fetchImpl as unknown as typeof fetch), [
      '1',
      '2',
    ]);
  });

  test('runs the bearer-token dance on 401, then retries with the token', async () => {
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/token')) {
        return new Response(JSON.stringify({ token: 'TKN' }), { status: 200 });
      }
      const auth = (init?.headers as Record<string, string> | undefined)?.['Authorization'];
      if (auth === undefined) {
        return new Response('', { status: 401, headers: { 'www-authenticate': CHALLENGE } });
      }
      assert.equal(auth, 'Bearer TKN');
      return new Response(JSON.stringify({ tags: ['7.2', '8.0'] }), { status: 200 });
    };
    assert.deepEqual(await fetchOciTags('ghcr.io', 'x/y', fetchImpl as unknown as typeof fetch), [
      '7.2',
      '8.0',
    ]);
  });

  test('sends Basic credentials to the token endpoint when a resolver supplies them', async () => {
    const auth: RegistryAuth = { username: 'me', password: 'secret' };
    const expected = `Basic ${Buffer.from('me:secret').toString('base64')}`;
    let sawBasic = false;
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/token')) {
        if ((init?.headers as Record<string, string> | undefined)?.['Authorization'] === expected) {
          sawBasic = true;
        }
        return new Response(JSON.stringify({ token: 'TKN' }), { status: 200 });
      }
      const bearer = (init?.headers as Record<string, string> | undefined)?.['Authorization'];
      return bearer
        ? new Response(JSON.stringify({ tags: ['1'] }), { status: 200 })
        : new Response('', { status: 401, headers: { 'www-authenticate': CHALLENGE } });
    };
    await fetchOciTags('ghcr.io', 'x/y', fetchImpl as unknown as typeof fetch, async () => auth);
    assert.ok(sawBasic, 'Basic auth header was sent to the token endpoint');
  });

  test('resolves to [] on registry failure', async () => {
    const fetchImpl = async () => new Response('', { status: 500 });
    assert.deepEqual(
      await fetchOciTags('ghcr.io', 'x/y', fetchImpl as unknown as typeof fetch),
      []
    );
  });
});
