// Fold the flat vite output into one self-contained dist/index.html: the CLI embeds that file as a
// string (`import html from '…/index.html' with { type: 'text' }`), so npm package and binary ship
// the GUI the same way with no asset serving.
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const dist = join(import.meta.dirname, '..', 'dist');
const index = join(dist, 'index.html');
const html = await readFile(index, 'utf8');

const inlineScript = async (_match: string, src: string): Promise<string> => {
  const code = await readFile(join(dist, src), 'utf8');
  // a literal `</script>` inside the bundle would end the inline tag early
  return `<script type="module">${code.replaceAll('</script', '<\\/script')}</script>`;
};
const inlineStyle = async (_match: string, href: string): Promise<string> =>
  `<style>${await readFile(join(dist, href), 'utf8')}</style>`;

const replaceAsync = async (
  text: string,
  pattern: RegExp,
  replacer: (match: string, group: string) => Promise<string>
): Promise<string> => {
  const parts = await Promise.all(
    [...text.matchAll(pattern)].map(match => replacer(match[0], match[1] ?? ''))
  );
  return text.split(pattern).reduce((acc, chunk, i) => `${acc}${chunk}${parts[i] ?? ''}`, '');
};

const withScripts = await replaceAsync(
  html,
  /<script type="module"[^>]*src="\.?\/?([^"]+)"[^>]*><\/script>/g,
  inlineScript
);
const inlined = await replaceAsync(
  withScripts,
  /<link rel="stylesheet"[^>]*href="\.?\/?([^"]+)"[^>]*>/g,
  inlineStyle
);

await writeFile(index, inlined);
// everything else is now inside index.html
await Promise.all(
  (await readdir(dist))
    .filter(name => name !== 'index.html')
    .map(name => rm(join(dist, name), { recursive: true }))
);
process.stdout.write(`inlined → ${index} (${(inlined.length / 1024).toFixed(0)} kB)\n`);
