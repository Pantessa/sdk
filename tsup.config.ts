import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    agent: 'src/agent.ts',
    client: 'src/client.ts',
    server: 'src/server.ts',
    next: 'src/next.ts',
    express: 'src/express.ts',
    embed: 'src/embed.ts',
    desk: 'src/desk.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  treeshake: true,
  target: 'es2022',
  external: ['viem', 'next', 'express'],
})
