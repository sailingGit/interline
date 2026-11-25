import { cp, rm } from 'node:fs/promises';
import { build } from 'esbuild';

await rm('dist', { recursive: true, force: true });

await build({
  entryPoints: ['src/background.js', 'src/content.js', 'src/popup.js', 'src/options.js'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome116',
  outdir: 'dist',
});

for (const file of ['manifest.json', 'youtube-hook.js', 'popup.html', 'options.html', '_locales', 'icons']) {
  await cp(`src/${file}`, `dist/${file}`, { recursive: true });
}
