import { nodeLibrary } from '@enke.dev/lint/eslint/presets/node-library';
import { defineConfig } from 'eslint/config';

export default defineConfig([
  ...nodeLibrary,
  { ignores: ['dist/', 'examples/**/*.{yml,yaml,json}'] },
]);
