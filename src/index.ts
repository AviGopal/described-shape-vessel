// SPDX-License-Identifier: MIT
import { PORT } from "./config"
import { beat, register } from "./heartbeat"
import { fail, produce, records } from "./produce"
import { SERVE } from "./routes"
import { RECORD_READ, SHAPE_SCHEMA } from "./shapes"

const schemas = await records(RECORD_READ, { shape: SHAPE_SCHEMA })
if (!schemas.ok) {
  process.exit(1)
}
const targets = [...new Set((schemas.body as Array<{ target: string }>).map((r) => String(r.target)))]

Bun.serve({
  port: PORT,
  idleTimeout: 0,
  routes: { [SERVE]: { POST: produce } },
  fetch: () => fail(404, ""),
  error: () => process.exit(1),
})
await register(targets)
await beat()
