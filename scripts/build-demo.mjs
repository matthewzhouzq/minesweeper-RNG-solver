// Bundles web/main.ts and the solver into one self-contained demo.html.
import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';

const result = await build({
  entryPoints: ['web/main.ts'],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  write: false,
});

const script = result.outputFiles[0].text;
const template = await readFile('web/template.html', 'utf8');
await writeFile('demo.html', template.replace('/*__SCRIPT__*/', () => script));
console.log('Wrote demo.html');
