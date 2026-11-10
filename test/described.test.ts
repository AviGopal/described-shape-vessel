// SPDX-License-Identifier: MIT
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { type Fake, exitsNaming, fake, freePort, healthy, run, until } from "./harness"

const NODE_KEY = "node-key-for-test"
const PERSON_KEY = "person-key-for-test"

const SCHEMA = {
  shape: "shape_schema", id: "s1", target: "answer", description: "the answer", inputs: ["world_changed"], context: ["hop"],
  schema: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
}
const CHANNEL = {
  shape: "channel", id: "ch1",
  calls: [{ pointer: { type: "llm_completion", model: "model-asked" }, input_field: "prompt", output_field: "content", producer_field: "model" }],
}

const INPUTS = [
  { shape: "world_changed", id: "w1", what: "the question" },
  { shape: "hop", id: "h1", output: { text: "data a request fetched" } },
  { shape: "failure", id: "f1", body: "a draft answer from an earlier attempt" },
]

let llmContent = JSON.stringify({ text: "hi" })
let readsDown = false
let discovery: Fake
let identity: Fake
let port: number
let vessel: ReturnType<typeof run>

const resolve = (p: Record<string, any>): Response => {
  if (p.type === "record_read" && p.shape === "shape_schema") return Response.json([SCHEMA])
  if (p.type === "record_read" && p.shape === "channel") return Response.json([CHANNEL])
  if (p.type === "record_read") return Response.json(INPUTS.filter((r) => (p.ids as string[]).includes(r.id)))
  if (p.type === "shapeDescriptions") return readsDown
    ? Response.json({ error: "down" }, { status: 503 })
    : Response.json({ content: { shape_descriptions: { fs_read: "produces file content from a path" } } })
  if (p.type === "llm_completion") return Response.json({ content: llmContent, model: "model-served" })
  if (p.type === "record_write") return Response.json({ ...p.row, id: "row-1", writer: p.writer, role: p.role })
  return Response.json({ error: "Not found" }, { status: 404 })
}

const produce = async (key: string) => {
  const r = await fetch(`http://127.0.0.1:${port}/v2/impulses/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `ApiKey ${key}` },
    body: JSON.stringify({ impulse: { pointer: { type: "answer", shape: "answer", via_ref: "ch1", input_refs: ["w1", "h1", "f1"], selection_ref: "sel-1", call_id: "call-1" } } }),
  })
  return { status: r.status, body: (await r.json()) as any }
}

beforeAll(async () => {
  discovery = fake((path, body) => {
    if (path === "/resolve") return resolve(body.pointer)
    return Response.json(path === "/heartbeat" ? { nextHeartbeatMs: 600000 } : { ok: true })
  })
  identity = fake((_path, body) =>
    body?.impulse?.pointer?.apiKey === PERSON_KEY
      ? Response.json({ success: true, data: { authenticated: true, keyId: "kid-person" } })
      : Response.json({ success: false }, { status: 401 }))
  port = freePort()
  vessel = run("src/index.ts", {
    DESCRIBED_VESSEL_ID: "described-test", DESCRIBED_PORT: String(port), DISCOVERY_URL: discovery.url,
    DESCRIBED_ENDPOINT: `http://127.0.0.1:${port}`, IDENTITY_VESSEL_URL: identity.url, METABOB_API_KEY: NODE_KEY,
  })
  await healthy(port)
  await until(() => discovery.seen.some((s) => s.path === "/register"), "/register")
})

afterAll(() => {
  vessel?.kill()
  discovery?.stop()
  identity?.stop()
})

describe("described-shape vessel", () => {
  test("/health answers 200 with the vessel id only", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/health`)
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ vessel: "described-test" })
  })

  test("registers the shape_schema targets under the node key, with no forward time limit", () => {
    const reg = discovery.seen.find((s) => s.path === "/register")
    expect(reg?.auth).toBe(`ApiKey ${NODE_KEY}`)
    const body = reg?.body as { shapes: string[]; resolve_timeout_ms: number }
    expect(body.shapes).toEqual(["answer"])
    expect(body.resolve_timeout_ms).toBe(2147483647)
  })

  test("a node-self produce calls the channel through discovery and writes the checked row", async () => {
    const before = discovery.seen.length
    const r = await produce(NODE_KEY)
    expect(r.status).toBe(200)
    const calls = discovery.seen.slice(before)
    for (const c of calls) {
      expect(c.path).toBe("/resolve")
      expect(c.auth).toBe(`ApiKey ${NODE_KEY}`)
    }
    const llm = calls.find((c) => (c.body as any).pointer.type === "llm_completion")?.body as any
    expect(llm.pointer.model).toBe("model-asked")
    expect(typeof llm.pointer.prompt).toBe("string")
    const w = calls.find((c) => (c.body as any).pointer.type === "record_write")?.body as any
    expect(w.pointer.writer).toBe("described-test")
    expect(w.pointer.role).toBe("described")
    expect(w.pointer.row).toMatchObject({ text: "hi", shape: "answer", selection_ref: "sel-1", call_id: "call-1", producer: "model-served" })
    expect(w.pointer.row.caller_key).toBeUndefined()
    expect(JSON.stringify(calls)).not.toContain("endpoint")
  })

  test("the LLM sees only the inputs and context the schema names, and the row records exactly those", async () => {
    const before = discovery.seen.length
    expect((await produce(NODE_KEY)).status).toBe(200)
    const calls = discovery.seen.slice(before)
    const llm = calls.find((c) => (c.body as any).pointer.type === "llm_completion")?.body as any
    expect(llm.pointer.prompt).toContain("the question")
    expect(llm.pointer.prompt).toContain("data a request fetched")
    expect(llm.pointer.prompt).not.toContain("a draft answer")
    const w = calls.find((c) => (c.body as any).pointer.type === "record_write")?.body as any
    expect(w.pointer.row.input_refs).toEqual(["w1", "h1"])
  })

  test("reads the schema names are resolved by shape and shown to the producer", async () => {
    ;(SCHEMA as any).reads = [{ type: "shapeDescriptions" }]
    const before = discovery.seen.length
    const ok = await produce(NODE_KEY)
    const calls = discovery.seen.slice(before)
    readsDown = true
    const down = await produce(NODE_KEY)
    const downCalls = discovery.seen.slice(before + calls.length)
    readsDown = false
    delete (SCHEMA as any).reads
    expect(ok.status).toBe(200)
    expect(calls.some((c) => c.path === "/resolve" && (c.body as any).pointer.type === "shapeDescriptions")).toBe(true)
    const llm = calls.find((c) => (c.body as any).pointer.type === "llm_completion")?.body as any
    expect(llm.pointer.prompt).toContain("produces file content from a path")
    const w = calls.find((c) => (c.body as any).pointer.type === "record_write")?.body as any
    expect(w.pointer.row.input_refs).toEqual(["w1", "h1"])
    expect(down.status).toBe(503)
    expect(downCalls.some((c) => (c.body as any).pointer.type === "llm_completion")).toBe(false)
  })

  test("a schema row with no inputs list is refused, not read as empty", async () => {
    const keep = (SCHEMA as any).inputs
    delete (SCHEMA as any).inputs
    const before = discovery.seen.length
    const r = await produce(NODE_KEY)
    ;(SCHEMA as any).inputs = keep
    expect(r.status).toBe(422)
    expect(discovery.seen.slice(before).some((c) => (c.body as any).pointer.type === "llm_completion")).toBe(false)
  })

  test("an answer that is not the schema's JSON is refused with 422", async () => {
    llmContent = "not json"
    expect((await produce(NODE_KEY)).status).toBe(422)
    llmContent = JSON.stringify({ wrong: 1 })
    expect((await produce(NODE_KEY)).status).toBe(422)
    llmContent = JSON.stringify({ text: "hi" })
  })

  test("a schema's numeric bounds are enforced: a due of within_ms 0 is refused", async () => {
    const keep = { schema: (SCHEMA as any).schema }
    ;(SCHEMA as any).schema = {
      type: "object", required: ["within_ms"], properties: { within_ms: { type: "number", minimum: 60000, maximum: 1800000 } },
    }
    llmContent = JSON.stringify({ within_ms: 0 })
    const tooSoon = await produce(NODE_KEY)
    llmContent = JSON.stringify({ within_ms: 1800001 })
    const tooLate = await produce(NODE_KEY)
    llmContent = JSON.stringify({ within_ms: 60000 })
    const inside = await produce(NODE_KEY)
    ;(SCHEMA as any).schema = keep.schema
    llmContent = JSON.stringify({ text: "hi" })
    expect(tooSoon.status).toBe(422)
    expect(tooLate.status).toBe(422)
    expect(inside.status).toBe(200)
  })

  test("a key that is not the node's own gets 403, even when identity accepts it", async () => {
    const before = discovery.seen.length
    expect((await produce(PERSON_KEY)).status).toBe(403)
    expect(discovery.seen.length).toBe(before)
  })

  test("a key identity rejects gets 401", async () => {
    expect((await produce("not-a-key")).status).toBe(401)
  })

  test("a missing boot value exits 1 and names it, never its value", async () => {
    const { code, stderr } = await exitsNaming("src/index.ts", {
      DESCRIBED_VESSEL_ID: "described-test", DESCRIBED_PORT: String(freePort()), DISCOVERY_URL: discovery.url,
      DESCRIBED_ENDPOINT: "x", METABOB_API_KEY: NODE_KEY,
    })
    expect(code).toBe(1)
    expect(stderr).toContain("missing env IDENTITY_VESSEL_URL")
    expect(stderr).not.toContain(NODE_KEY)
  })
})
