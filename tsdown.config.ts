import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    client: 'src/client.ts',
  },
  format: 'esm',
  dts: false,
  outDir: 'lib',
  clean: false,
  external: [
    'react',
    'react/jsx-runtime',
    '@deepseek-ai/dsh-client-ui-settings',
    '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/cordis',
  ],
})
