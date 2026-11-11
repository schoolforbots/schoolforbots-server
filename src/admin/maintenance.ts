import { TypeBoxValidatorCompiler, type TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import type { FastifyPluginAsync } from 'fastify'
import { Type } from 'typebox'
import { ApiError } from '../registration/errors.js'
import { readMaintenance, setMaintenance } from '../shared/maintenance.js'
import type { AdminDeps } from './app.js'

const MAX_MESSAGE = 200

/** The maintenance now on, read from the database (not the service's own copy, which is a few seconds old). */
async function view({ db }: AdminDeps) {
  const m = await readMaintenance(db)
  return {
    maintenance:
      m === null
        ? null
        : {
            message: m.message,
            since: m.since.toISOString(),
            expectedBackAt: m.expectedBackAt?.toISOString() ?? null,
          },
  }
}

export const maintenanceRoutes = (deps: AdminDeps): FastifyPluginAsync => async (instance) => {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>()
  app.setValidatorCompiler(TypeBoxValidatorCompiler)

  app.get('/maintenance', async () => view(deps))

  app.put(
    '/maintenance',
    {
      schema: {
        body: Type.Object(
          {
            on: Type.Boolean(),
            message: Type.Optional(Type.String()),
            expectedBackAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request) => {
      const { on, message, expectedBackAt } = request.body
      const now = deps.clock.now()
      if (!on) {
        await setMaintenance(deps.db, null, now)
      } else {
        const text = message?.trim() ?? ''
        if (text.length < 1 || [...text].length > MAX_MESSAGE) throw new ApiError(400, 'invalid_request')
        // Absent keeps the expected time of maintenance already on (none when switching on); null clears it.
        let back: Date | null | undefined
        if (expectedBackAt === null) back = null
        else if (expectedBackAt !== undefined) {
          back = new Date(expectedBackAt)
          if (Number.isNaN(back.getTime()) || back.getTime() <= now.getTime()) throw new ApiError(400, 'invalid_request')
        }
        if (back === undefined) back = (await readMaintenance(deps.db))?.expectedBackAt ?? null
        await setMaintenance(deps.db, { message: text, expectedBackAt: back }, now)
      }
      await deps.maintenance.refresh()
      return view(deps)
    },
  )
}
