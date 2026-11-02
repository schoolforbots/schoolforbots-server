import { PostgreSqlContainer } from '@testcontainers/postgresql'
import type { TestProject } from 'vitest/node'

// One Postgres container for the whole run; each test gets its own database inside it (see helpers/db.ts).
export default async function setup(project: TestProject) {
  const container = await new PostgreSqlContainer('postgres:17-alpine').start()
  project.provide('pgUrl', container.getConnectionUri())
  return async () => {
    await container.stop()
  }
}
