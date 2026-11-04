import { TypeBoxValidatorCompiler, type TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import type { FastifyPluginAsync } from 'fastify'
import { Type } from 'typebox'
import { ApiError } from '../registration/errors.js'
import { isSwitchName, setSwitch, SWITCH_NAMES, type SwitchName } from '../shared/switches.js'
import type { AdminDeps } from './app.js'

interface SwitchRow {
  name: SwitchName
  on: boolean
  updatedAt: string | null
}

/** Every switch, read from the database (not the service's own copy, which is up to a few seconds old). */
async function readSwitches({ db, config }: AdminDeps): Promise<SwitchRow[]> {
  const rows = await db.selectFrom('switches').select(['name', 'on', 'updatedAt']).execute()
  return SWITCH_NAMES.map((name) => {
    const row = rows.find((r) => r.name === name)
    return { name, on: row?.on ?? config.switchDefaults[name], updatedAt: row ? row.updatedAt.toISOString() : null }
  })
}

export function switchRoutes(deps: AdminDeps): FastifyPluginAsync {
  return async (instance) => {
    const app = instance.withTypeProvider<TypeBoxTypeProvider>()
    app.setValidatorCompiler(TypeBoxValidatorCompiler)

    app.get('/switches', async () => ({ switches: await readSwitches(deps) }))

    app.put(
      '/switches/:name',
      { schema: { body: Type.Object({ on: Type.Boolean() }, { additionalProperties: false }) } },
      async (request) => {
        const { name } = request.params as { name: string }
        if (!isSwitchName(name)) throw new ApiError(404, 'not_found')
        await setSwitch(deps.db, name, request.body.on, deps.clock.now())
        await deps.switches.refresh()
        const row = (await readSwitches(deps)).find((r) => r.name === name)
        if (row === undefined) throw new ApiError(404, 'not_found')
        return row
      },
    )
  }
}
