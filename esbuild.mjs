import * as esbuild from 'esbuild';

const isWatch = process.argv.includes('--watch');
const baseOpts = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'info'
};

const targets = [
  {
    ...baseOpts,
    entryPoints: ['src/extension/extension.ts'],
    outfile: 'out/extension.js',
    external: ['vscode']
  },
  {
    ...baseOpts,
    entryPoints: ['src/mcp/server.ts'],
    outfile: 'out/mcp/server.js',
    external: []
  }
];

if (isWatch) {
  for (const opts of targets) {
    const ctx = await esbuild.context(opts);
    await ctx.watch();
  }
} else {
  await Promise.all(targets.map(o => esbuild.build(o)));
}
