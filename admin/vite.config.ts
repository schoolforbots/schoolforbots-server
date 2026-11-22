import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { loadEnv, type Plugin } from 'vite'
import { defineConfig } from 'vitest/config'

// The built pages are served from the admin path, which is known only to the server's environment: every URL in
// them is relative (`base: './'`, and the client calls `api/...`), so nothing here or in the bundle names that path.
//
// `npm run admin:dev` serves the pages at http://localhost:5173/ and forwards `/api/...` to a running registration
// service, at `{ADMIN_DEV_SERVER}{ADMIN_PATH}/api/...`. Both are read from the repository's `.env` (or the shell):
// ADMIN_PATH is the server's own setting, and ADMIN_DEV_SERVER defaults to http://localhost:{REGISTRATION_PORT}.
// `npm run admin:mock` (vite --mode mock) answers `/api/...` from the pretend school in mock/school.ts instead: no
// database, no server, no authenticator. Any password and any 6 digits log in.
function mockSchool(): Plugin {
  return {
    name: 'mock-school',
    configureServer(server) {
      server.middlewares.use('/api', (request, response) => {
        let text = ''
        request.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')))
        request.on('end', async () => {
          const { answer } = (await server.ssrLoadModule('/mock/school.ts')) as typeof import('./mock/school.js')
          const body = text === '' ? {} : (JSON.parse(text) as Record<string, unknown>)
          const reply = answer(request.method ?? 'GET', (request.url ?? '/').replace(/^\//, ''), body)
          // A pause like a real answer's, so the pages' loading states show.
          setTimeout(() => {
            response.statusCode = reply.status
            response.setHeader('content-type', 'application/json')
            response.end(JSON.stringify(reply.body))
          }, 150 + Math.random() * 250)
        })
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('..', import.meta.url)), '')
  const adminPath = env.ADMIN_PATH ?? ''
  const target = env.ADMIN_DEV_SERVER || `http://localhost:${env.REGISTRATION_PORT || '8080'}`

  return {
    base: './',
    plugins: [react(), tailwindcss(), ...(mode === 'mock' ? [mockSchool()] : [])],
    server: {
      proxy:
        adminPath === '' || mode === 'mock'
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
      // A page shown on its own, as most tests show one, reads times in this computer's zone (see src/zone.ts); the
      // tests expect the school's (UTC+8), wherever they run.
      env: { TZ: 'Asia/Shanghai' },
    },
  }
})
