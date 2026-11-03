// Bundles the Firebase SDK into one ES module so the site has no CDN dependency
// and no build step at deploy time. Run: npm run build:vendor
import { build } from 'esbuild';
await build({
  entryPoints: ['tools/vendor-entry.js'],
  outfile: 'js/vendor/firebase.js',
  bundle: true, format: 'esm', minify: true, target: 'es2020',
  legalComments: 'none', logLevel: 'info'
});
