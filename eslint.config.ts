import { lit } from '@enke.dev/lint/eslint/lit';
import { nodeLibrary } from '@enke.dev/lint/eslint/presets/node-library';
import { defineConfig } from 'eslint/config';

export default defineConfig([
  ...nodeLibrary,
  // the GUI package is lit: element, a11y and inline-html rules on top of the node rules
  { files: ['packages/ui/src/**/*.ts'], extends: lit },
  {
    // the GUI is imported as text from the ui package's build output, absent in a fresh checkout
    files: ['**/*.ts'],
    rules: { 'import/no-unresolved': ['error', { ignore: ['\\.html$'] }] },
  },
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
