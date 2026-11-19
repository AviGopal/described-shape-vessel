// SPDX-License-Identifier: MIT
// Identity giving no answer is identity's outage, not the caller's refusal, and never ends described (src/auth.ts
// validate, src/serve-error.ts): on the running vessel, with identity a listener that closes every connection on its first
// bytes (a reset on the way, as across a relay), whose answer breaks off in its body, or that answers 429, a key's call is answered 503, and
// described goes on serving. A request that throws anyway (here: identity answering 200 with no data, read as if it had
// some) is answered 500 and the process is never ended.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { type Fake, fake, freePort, healthy, run, until } from "./harness"
import { onServeError } from "../src/serve-error"

const NODE_KEY = "node-key-for-no-answer-test"

let discovery: Fake
let reset: ReturnType<typeof Bun.listen>
// how identity answers each connection: closed on its first bytes, a 200 whose body breaks off, a 429 (too many asks), or a
// 200 with no data
let mode: "reset" | "cut" | "busy" | "no-data" = "reset"
const NO_DATA = '{"success":true}'
let port: number
let vessel: ReturnType<typeof run>

const call = async (auth: string, pointer: object) => {
  const r = await fetch(`http://127.0.0.1:${port}/v2/impulses/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth },
    body: JSON.stringify({ impulse: { pointer } }),
  })
  return r.status
}
const served = async () => {
  expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200)
  // the node's own key asks identity nothing, and is served as before: an ask naming no schema the owner wrote
  expect(await call(`ApiKey ${NODE_KEY}`, { type: "answer", shape: "no-such-target" })).toBe(422)
  expect(vessel.exitCode).toBeNull()
}

beforeAll(async () => {
  discovery = fake((path, body) => {
    if (path === "/resolve" && body?.pointer?.type === "record_read") return Response.json([])
    return Response.json(path === "/heartbeat" ? { nextHeartbeatMs: 600000 } : { ok: true })
  })
  reset = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: {
    data: (s) => {
      if (mode === "cut") s.write(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"succ`)
      if (mode === "busy") s.write("HTTP/1.1 429 Too Many Requests\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
      if (mode === "no-data") s.write(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${NO_DATA.length}\r\nConnection: close\r\n\r\n${NO_DATA}`)
      s.end()
    },
  } })
  port = freePort()
  vessel = run("src/index.ts", {
    DESCRIBED_VESSEL_ID: "described-no-answer-test", DESCRIBED_PORT: String(port), DISCOVERY_URL: discovery.url,
    DESCRIBED_ENDPOINT: `http://127.0.0.1:${port}`, IDENTITY_VESSEL_URL: `http://127.0.0.1:${reset.port}`, METABOB_API_KEY: NODE_KEY,
  })
  await healthy(port)
  await until(() => discovery.seen.some((s) => s.path === "/register"), "/register")
})

afterAll(() => {
  vessel?.kill()
  discovery?.stop()
  reset?.stop(true)
})

describe("described: identity giving no answer", () => {
  test("[MUST-FAIL] a key's call, with identity resetting the connection, is answered 503, and described still serves", async () => {
    expect(await call("ApiKey some-peer-key", { type: "answer", shape: "answer" })).toBe(503)
    await served()
  })

  test("[MUST-FAIL] a key's call, with identity's answer breaking off in its body, is answered 503, and described still serves", async () => {
    mode = "cut"
    try {
      expect(await call("ApiKey cut-peer-key", { type: "answer", shape: "answer" })).toBe(503)
    } finally {
      mode = "reset"
    }
    await served()
  })

  test("[MUST-FAIL] a key's call, with identity answering 429, is answered 503 (ask again later), never refused", async () => {
    mode = "busy"
    try {
      expect(await call("ApiKey busy-peer-key", { type: "answer", shape: "answer" })).toBe(503)
    } finally {
      mode = "reset"
    }
    await served()
  })

  test("[MUST-FAIL] a request that throws (identity's 200 with no data) is answered 500, and described still serves", async () => {
    mode = "no-data"
    try {
      expect(await call("ApiKey another-peer-key", { type: "answer", shape: "answer" })).toBe(500)
    } finally {
      mode = "reset"
    }
    await served()
  })

  test("the error answer: 500 with the stack logged, and process.exit never called", () => {
    const exit = process.exit
    const logged: string[] = []
    const error = console.error
    let ended = false
    process.exit = (() => { ended = true }) as typeof process.exit
    console.error = (...a: unknown[]) => { logged.push(a.map(String).join(" ")) }
    try {
      const r = onServeError(new Error("connection reset on the way"))
      expect(r.status).toBe(500)
      expect(ended).toBe(false)
      expect(logged.some((l) => l.includes("connection reset on the way") && l.includes("no-answer.test.ts"))).toBe(true)
    } finally {
      process.exit = exit
      console.error = error
    }
  })
})
