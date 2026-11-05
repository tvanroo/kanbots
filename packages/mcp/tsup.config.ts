import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/server.ts'],
  format: ['esm'],
  target: 'node20',
  noExternal: [/.*/],
  // The shared manifest is also bundled into Electron CommonJS; import.meta.url
  // is unavailable there. Preserve a valid filename in both runtime formats.
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(typeof __filename === 'string' ? __filename : import.meta.url);" },
  dts: true,
  sourcemap: true,
  clean: true,
});
