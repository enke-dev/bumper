import { nodeLibrary } from '@enke.dev/lint/eslint/presets/node-library';
import { defineConfig } from 'eslint/config';

export default defineConfig([
  ...nodeLibrary,
  {
    ignores: [
      '**/CHANGELOG.md',
      '**/dist/',
      'packages/core/examples/**/*.{yml,yaml,json}',
      // copied in by the CLI's prepack hook, never edited there
      'packages/cli/README.md',
      'packages/cli/LICENSE',
    ],
  },
]);
