import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'

// The built pages are served from the admin path, which is known only to the server's environment: every URL in
// them is relative (`base: './'`, and the client calls `api/...`), so nothing here or in the bundle names that path.
//
// `npm run admin:dev` serves the pages at http://localhost:5173/ and forwards `/api/...` to a running registration
// service, at `{ADMIN_DEV_SERVER}{ADMIN_PATH}/api/...`. Both are read from the repository's `.env` (or the shell):
// ADMIN_PATH is the server's own setting, and ADMIN_DEV_SERVER defaults to http://localhost:{REGISTRATION_PORT}.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('..', import.meta.url)), '')
  const adminPath = env.ADMIN_PATH ?? ''
  const target = env.ADMIN_DEV_SERVER || `http://localhost:${env.REGISTRATION_PORT || '8080'}`

  return {
    base: './',
    plugins: [react()],
    // Ant Design is most of the one bundle (about 300 kB gzipped). One person opens these pages on a computer, so it
    // is not split up.
    build: { chunkSizeWarningLimit: 1100 },
    server: {
      proxy:
        adminPath === ''
          ? undefined
          : {
              '/api': {
                target,
                changeOrigin: true,
                rewrite: (path: string) => `${adminPath}${path}`,
                // The session cookie is scoped to the admin path; here the pages live at `/`.
                cookiePathRewrite: { [adminPath]: '/' },
              },
            },
    },
    test: {
      environment: 'jsdom',
      include: ['src/**/*.test.tsx'],
      setupFiles: ['src/test-setup.ts'],
      // The pages show times on the browser's clock; the tests expect the school's (UTC+8), wherever they run.
      env: { TZ: 'Asia/Shanghai' },
    },
  }
})
