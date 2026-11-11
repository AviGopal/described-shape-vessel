// SPDX-License-Identifier: MIT
import { PORT, VESSEL_ID } from "./config"
import { beat, register } from "./heartbeat"
import { fail, produce, records } from "./produce"
import { HEALTH, SERVE } from "./routes"
import { RECORD_READ, SHAPE_SCHEMA } from "./shapes"

const schemas = await records(RECORD_READ, { shape: SHAPE_SCHEMA })
if (!schemas.ok) {
  console.error(`shape_schema read answered ${schemas.status}: ${schemas.text}`)
  process.exit(1)
}
// Only a list of rows (bare, or under content) is the owner's schemas. Anything else, such as records or discovery not
// ready at boot and answering an error with a 200, is refused by name like a failed read, so the unit starts again
// rather than crashing on it or serving nothing.
const answer = schemas.body as unknown
const rows = Array.isArray(answer) ? answer : (answer as { content?: unknown } | null)?.content
if (!Array.isArray(rows)) {
  console.error(`shape_schema read answered ${schemas.status} with no list of rows: ${JSON.stringify(answer).slice(0, 200)}`)
  process.exit(1)
}
const targets = [...new Set((rows as Array<{ target: string }>).map((r) => String(r.target)))]

Bun.serve({
  port: PORT,
  idleTimeout: 0,
  routes: { [SERVE]: { POST: produce }, [HEALTH]: { GET: () => Response.json({ vessel: VESSEL_ID }) } },
  fetch: () => fail(404, ""),
  error: (e) => {
    console.error(String(e))
    process.exit(1)
  },
})
// The targets as the owner's schema rows name them now, or null when they cannot be read.
const readTargets = async (): Promise<string[] | null> => {
  const r = await records(RECORD_READ, { shape: SHAPE_SCHEMA })
  const body = r.ok ? (r.body as unknown) : null
  const list = Array.isArray(body) ? body : (body as { content?: unknown } | null)?.content
  return Array.isArray(list) ? [...new Set((list as Array<{ target: string }>).map((x) => String(x.target)))] : null
}

await register(targets)
await beat(targets, readTargets)
