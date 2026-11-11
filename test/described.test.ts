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
  { shape: "gap", id: "g1", summary: "a check that fails" },
]
// What a record_lapsed read answers: deadline rows, as records returns them
const LAPSED = [
  { shape: "due", id: "d1", role: "described", within_ms: 60000, at: 1, input_refs: ["w1"] },
  { shape: "due", id: "d9", role: "described", within_ms: 60000, at: 1, input_refs: ["w9"] }, // another request's
]
// Schema rows besides SCHEMA (newer ones, as records lists them oldest first)
let moreSchemas: Array<Record<string, unknown>> = []

let llmContent = JSON.stringify({ text: "hi" })
let llmFailure: Record<string, unknown> | null = null
let readsDown = false
let discovery: Fake
let identity: Fake
let port: number
let vessel: ReturnType<typeof run>

const resolve = (p: Record<string, any>): Response => {
  if (p.type === "record_read" && p.shape === "shape_schema") return Response.json([SCHEMA, ...moreSchemas])
  // The owner also describes shapes it does not want produced (a detector's gap): never something to serve.
  if (p.type === "record_read" && p.shape === "shape_description") return Response.json([{ shape: "shape_description", id: "sd1", of: "gap" }])
  if (p.type === "record_read" && p.shape === "channel") return Response.json((p.ids as string[]).includes(CHANNEL.id) ? [CHANNEL] : [])
  if (p.type === "record_read") return Response.json(INPUTS.filter((r) => (p.ids as string[]).includes(r.id)))
  if (p.type === "shapeDescriptions") return readsDown
    ? Response.json({ error: "down" }, { status: 503 })
    : Response.json({ content: { shape_descriptions: { fs_read: "produces file content from a path" }, data_shapes: { hop: "a record of a call" } } })
  if (p.type === "record_lapsed") return Response.json(LAPSED.filter((r) => !Array.isArray(p.asks) || r.input_refs.some((id) => p.asks.includes(id))))
  if (p.type === "llm_completion") return Response.json(llmFailure ?? { content: llmContent, model: "model-served" })
  if (p.type === "record_write") return Response.json({ ...p.row, id: "row-1", writer: p.writer, role: p.role })
  return Response.json({ error: "Not found" }, { status: 404 })
}

const produce = async (key: string, more: Record<string, unknown> = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}/v2/impulses/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `ApiKey ${key}` },
    body: JSON.stringify({ impulse: { pointer: { type: "answer", shape: "answer", via_ref: "ch1", input_refs: ["w1", "h1", "f1"], selection_ref: "sel-1", call_id: "call-1", ...more } } }),
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

  test("the owner's description of a shape (a detector's gap) is never served: only schema targets are", () => {
    const reg = discovery.seen.find((s) => s.path === "/register")
    expect((reg?.body as { shapes: string[] }).shapes).not.toContain("gap")
    expect(discovery.seen.some((s) => s.path === "/resolve" && (s.body as any).pointer?.shape === "shape_description")).toBe(false)
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

  test("[MUST-FAIL] a produce asking for a schema variant applies that variant's newest row; one asking for none, the plain row", async () => {
    moreSchemas = [{ ...SCHEMA, id: "s2", variant: "gap", description: "made from a gap", inputs: ["gap"] }]
    const prompt = async (more: Record<string, unknown>) => {
      const before = discovery.seen.length
      const r = await produce(NODE_KEY, more)
      const llm = discovery.seen.slice(before).find((c) => (c.body as any).pointer.type === "llm_completion")?.body as any
      return { status: r.status, prompt: String(llm?.pointer?.prompt ?? "") }
    }
    const fromGap = await prompt({ variant: "gap", input_refs: ["g1", "h1"] })
    const plain = await prompt({})
    const unknown = await prompt({ variant: "nope" })
    moreSchemas = []
    expect(fromGap.status).toBe(200)
    expect(fromGap.prompt).toContain("made from a gap")
    expect(fromGap.prompt).toContain("a check that fails")
    expect(plain.status).toBe(200)
    expect(plain.prompt).toContain("the answer")
    expect(plain.prompt).not.toContain("made from a gap") // the newer gap row is not the plain variant
    expect(unknown.status).toBe(422)
  })

  test("[MUST-FAIL] context rows past the budget are left out, oldest first; the inputs stay whole and the row cites what was shown", async () => {
    // 70 hops of about 3 KB each: more than the 192 KiB the context rows may take together
    const hops = Array.from({ length: 70 }, (_, i) => ({ shape: "hop", id: `hb${i}`, seq: 100 + i, output: { text: `step-${i}. ` + "x".repeat(3000) } }))
    INPUTS.push(...hops)
    const before = discovery.seen.length
    const r = await produce(NODE_KEY, { input_refs: ["w1", ...hops.map((h) => h.id)] })
    INPUTS.splice(INPUTS.length - hops.length, hops.length)
    const calls = discovery.seen.slice(before)
    const prompt = String((calls.find((c) => (c.body as any).pointer.type === "llm_completion")?.body as any)?.pointer?.prompt ?? "")
    const w = calls.find((c) => (c.body as any).pointer.type === "record_write")?.body as any
    expect(r.status).toBe(200)
    expect(prompt).toContain("the question") // the input, whole
    expect(prompt).toContain("step-69.") // the newest
    expect(prompt).not.toContain("step-0.") // the oldest, left out
    expect(prompt).toContain("older context rows are not shown")
    const cited = w.pointer.row.input_refs as string[]
    expect(cited).toContain("w1")
    expect(cited).toContain("hb69")
    expect(cited).not.toContain("hb0")
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

  test("JSON is read bare, from a fenced block, or from a fenced block with prose around it", async () => {
    const forms = [
      JSON.stringify({ text: "hi" }),
      "```json\n" + JSON.stringify({ text: "hi" }) + "\n```",
      "```\n" + JSON.stringify({ text: "hi" }) + "\n```",
      "Here it is:\n```json\n" + JSON.stringify({ text: "hi" }) + "\n```\nDone.",
    ]
    const statuses: number[] = []
    for (const form of forms) {
      llmContent = form
      statuses.push((await produce(NODE_KEY)).status)
    }
    llmContent = JSON.stringify({ text: "hi" })
    expect(statuses).toEqual([200, 200, 200, 200])
  })

  test("two fenced blocks are ambiguous: refused, nothing written", async () => {
    llmContent = "Example:\n```json\n" + JSON.stringify({ text: "example" }) + "\n```\nAnswer:\n```json\n" + JSON.stringify({ text: "real" }) + "\n```"
    const before = discovery.seen.length
    const r = await produce(NODE_KEY)
    const wrote = discovery.seen.slice(before).some((c) => (c.body as any).pointer.type === "record_write")
    llmContent = JSON.stringify({ text: "hi" })
    expect(r.status).toBe(422)
    expect(wrote).toBe(false)
  })

  test("a fenced block that is not JSON is still refused", async () => {
    llmContent = "```json\nnot json\n```"
    const r = await produce(NODE_KEY)
    llmContent = JSON.stringify({ text: "hi" })
    expect(r.status).toBe(422)
  })

  test("[MUST-FAIL] a channel that answers without its output field fails with what it returned, not 'undefined'", async () => {
    llmFailure = { resolved: false, error: "provider refused the request" }
    const r = await produce(NODE_KEY)
    llmFailure = null
    const body = JSON.stringify(r.body)
    expect(r.status).toBe(502)
    expect(body).toContain("provider refused the request")
    expect(body).not.toContain("undefined")
  })

  test("[MUST-FAIL] a 422 for text that is not JSON carries the start of that text", async () => {
    llmContent = "not json at all"
    const r = await produce(NODE_KEY)
    llmContent = JSON.stringify({ text: "hi" })
    expect(r.status).toBe(422)
    expect(JSON.stringify(r.body)).toContain("not json at all")
  })

  test("[MUST-FAIL] a context entry with a where shows only the rows it matches: a tool call's ended hop, not the walk's own steps", async () => {
    // the walk's hops as written: a started hop names the shape called; the ended hop carries kind and output, no pointer_type
    const hops = [
      { shape: "hop", id: "hs1", role: "walk", phase: "started", kind: "call", call_id: "k1", pointer_type: "fs_read", input: { path: "a" } },
      { shape: "hop", id: "he1", role: "walk", phase: "ended", kind: "call", call_id: "k1", output: { text: "what fs_read returned" } },
      { shape: "hop", id: "he2", role: "walk", phase: "ended", kind: "run", call_id: "k2", output: { text: "what the template run returned" } },
      { shape: "hop", id: "he3", role: "walk", phase: "ended", kind: "produce", call_id: "k3", output: { text: "a draft the walk produced" } },
      { shape: "hop", id: "he4", role: "walk", phase: "ended", kind: "wait-for", call_id: "k4", output: { text: "a wait that ended" } },
    ]
    INPUTS.push(...hops)
    const keep = SCHEMA.context
    ;(SCHEMA as any).context = [{ shape: "hop", where: { phase: "ended", kind: ["call", "run"] }, join: { on: "call_id", take: ["pointer_type"] } }]
    const before = discovery.seen.length
    const r = await produce(NODE_KEY, { input_refs: ["w1", ...hops.map((h) => h.id)] })
    ;(SCHEMA as any).context = keep
    INPUTS.splice(INPUTS.length - hops.length, hops.length)
    const calls = discovery.seen.slice(before)
    const prompt = String((calls.find((c) => (c.body as any).pointer.type === "llm_completion")?.body as any)?.pointer?.prompt ?? "")
    const w = calls.find((c) => (c.body as any).pointer.type === "record_write")?.body as any
    expect(r.status).toBe(200)
    expect(prompt).toContain("what fs_read returned")
    expect(prompt).toContain("what the template run returned")
    expect(prompt).not.toContain("a draft the walk produced")
    expect(prompt).not.toContain("a wait that ended")
    expect(prompt).not.toContain('"started"')
    expect(prompt).toContain('"pointer_type":"fs_read"') // the shape called, joined from the started hop by call_id
    expect(prompt).not.toContain('"path":"a"') // and nothing else of it
    expect(w.pointer.row.input_refs).toEqual(["w1", "he1", "he2"])
  })

  test("[MUST-FAIL] rows a read returned are cited as shown, and a value the schema says names a shown row is refused when it names another", async () => {
    const keep = (SCHEMA as any).schema
    ;(SCHEMA as any).reads = [{ type: "record_lapsed", deadline_shape: "due", answer_shape: "answer" }]
    ;(SCHEMA as any).schema = {
      type: "object", required: ["r", "evidence_refs"],
      properties: { r: { enum: [0, 1] }, evidence_refs: { type: "array", items: { type: "string", "x-shown": true } } },
    }
    const writes = () => discovery.seen.filter((c) => c.path === "/resolve" && (c.body as any).pointer.type === "record_write")
    const before = writes().length
    llmContent = JSON.stringify({ r: 0, evidence_refs: ["d1"] })
    const judged = await produce(NODE_KEY)
    const row = writes().at(-1)?.body as any
    llmContent = JSON.stringify({ r: 0, evidence_refs: ["d9"] }) // another request's deadline the read showed
    const other = await produce(NODE_KEY)
    const after = writes().length
    ;(SCHEMA as any).schema = keep
    delete (SCHEMA as any).reads
    llmContent = JSON.stringify({ text: "hi" })
    expect(judged.status).toBe(200)
    expect(row.pointer.row.input_refs).toEqual(["w1", "h1", "d1"])
    expect(other.status).toBe(422)
    expect(other.body.failure.refused).toBe("schema")
    expect(other.body.failure.body).toContain('"d9"')
    expect(after - before).toBe(1) // the refused answer wrote nothing
  })

  test("[MUST-FAIL] a read pointer value {x-inputs} is bound to the input rows shown, so a scoped read answers about this request alone", async () => {
    ;(SCHEMA as any).reads = [{ type: "record_lapsed", deadline_shape: "due", answer_shape: "answer", asks: { "x-inputs": true } }]
    const before = discovery.seen.length
    const r = await produce(NODE_KEY)
    delete (SCHEMA as any).reads
    const calls = discovery.seen.slice(before)
    const read = calls.find((c) => (c.body as any).pointer.type === "record_lapsed")?.body as any
    const prompt = String((calls.find((c) => (c.body as any).pointer.type === "llm_completion")?.body as any)?.pointer?.prompt ?? "")
    expect(r.status).toBe(200)
    expect(read.pointer.asks).toEqual(["w1"])
    expect(prompt).toContain('"d1"')
    expect(prompt).not.toContain('"d9"')
  })

  test("[MUST-FAIL] a value the schema says names a served shape is refused when it is not one, and kept when it is", async () => {
    const keep = { schema: (SCHEMA as any).schema }
    ;(SCHEMA as any).reads = [{ type: "shapeDescriptions", declared: true }]
    ;(SCHEMA as any).schema = {
      type: "object", required: ["calls"],
      properties: { calls: { type: "array", items: { type: "object", required: ["shape"], properties: {
        shape: { type: "string", "x-shape-in": { read: "shapeDescriptions", keys_of: "content.shape_descriptions" } },
      } } } },
    }
    const writes = () => discovery.seen.filter((c) => c.path === "/resolve" && (c.body as any).pointer.type === "record_write").length
    const before = writes()
    llmContent = JSON.stringify({ calls: [{ shape: "fs_read" }, { shape: "wait-for" }] })
    const kind = await produce(NODE_KEY)
    llmContent = JSON.stringify({ calls: [{ shape: "hop" }] })
    const written = await produce(NODE_KEY)
    const refusedWrites = writes() - before
    llmContent = JSON.stringify({ calls: [{ shape: "constructor" }, { shape: "__proto__" }] })
    const inherited = await produce(NODE_KEY)
    llmContent = JSON.stringify({ calls: [{ shape: "fs_read" }] })
    const served = await produce(NODE_KEY)
    ;(SCHEMA as any).schema = keep.schema
    delete (SCHEMA as any).reads
    llmContent = JSON.stringify({ text: "hi" })
    expect(kind.status).toBe(422)
    expect(kind.body.failure.body).toContain('"wait-for"')
    expect(kind.body.failure.body).not.toContain('"fs_read"')
    expect(written.status).toBe(422) // a shape described as written, not served, is not one to call
    expect(written.body.failure.body).toContain('"hop"')
    expect(refusedWrites).toBe(0)
    expect(inherited.status).toBe(422) // a name every object inherits is not a key the read returned
    for (const r of [kind, written, inherited]) expect(r.body.failure.refused).toBe("schema")
    expect(served.status).toBe(200)
  })

  test("[MUST-FAIL] an oversized row is shown cut and marked, so it cannot push the prompt past the model's ceiling", async () => {
    const big = { shape: "hop", id: "h-big", output: { stdout: "x".repeat(300_000) } }
    INPUTS.push(big)
    const before = discovery.seen.length
    const r = await fetch(`http://127.0.0.1:${port}/v2/impulses/resolve`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `ApiKey ${NODE_KEY}` },
      body: JSON.stringify({ impulse: { pointer: { type: "answer", shape: "answer", via_ref: "ch1", input_refs: ["w1", "h1", "h-big"], selection_ref: "sel-1", call_id: "c" } } }),
    })
    INPUTS.pop()
    expect(r.status).toBe(200)
    const llm = discovery.seen.slice(before).find((c) => (c.body as any).pointer.type === "llm_completion")?.body as any
    expect(llm.pointer.prompt.length).toBeLessThan(40_000)
    expect(llm.pointer.prompt).toContain('"cut":true')
    expect(llm.pointer.prompt).toContain("data a request fetched") // a small row is shown whole
    const w = discovery.seen.slice(before).find((c) => (c.body as any).pointer.type === "record_write")?.body as any
    expect(w.pointer.row.input_refs).toContain("h-big") // still counted as used
  })

  test("[MUST-FAIL] an input row too big to show whole is refused by name, never cut", async () => {
    const huge = { shape: "world_changed", id: "w-huge", what: "y".repeat(200_000) }
    INPUTS.push(huge)
    const before = discovery.seen.length
    const r = await fetch(`http://127.0.0.1:${port}/v2/impulses/resolve`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `ApiKey ${NODE_KEY}` },
      body: JSON.stringify({ impulse: { pointer: { type: "answer", shape: "answer", via_ref: "ch1", input_refs: ["w-huge"], selection_ref: "s", call_id: "c" } } }),
    })
    INPUTS.pop()
    expect(r.status).toBe(422)
    expect(((await r.json()) as any).failure.body).toContain("w-huge")
    expect(discovery.seen.slice(before).some((c) => (c.body as any).pointer.type === "llm_completion")).toBe(false)
  })

  test("[MUST-FAIL] a call naming no channel is refused by name, not a 500", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/v2/impulses/resolve`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `ApiKey ${NODE_KEY}` },
      body: JSON.stringify({ impulse: { pointer: { type: "answer", shape: "answer", input_refs: ["w1"], selection_ref: "s", call_id: "c" } } }),
    })
    expect(r.status).toBe(422)
    expect(((await r.json()) as any).failure.body).toContain("names no channel row")
  })

  test("an answer that is not the schema's JSON is refused with 422", async () => {
    llmContent = "not json"
    const unparsed = await produce(NODE_KEY)
    expect(unparsed.status).toBe(422)
    expect(unparsed.body.failure.refused).toBeUndefined()
    llmContent = JSON.stringify({ wrong: 1 })
    const misfit = await produce(NODE_KEY)
    expect(misfit.status).toBe(422)
    expect(misfit.body.failure.refused).toBe("schema")
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

  test("[MUST-FAIL] a schema read that answers no list of rows at boot exits 1 and says so, not a TypeError", async () => {
    const notReady = fake((path, body) => path === "/resolve" && body?.pointer?.type === "record_read"
      ? Response.json({ error: "records not ready" })
      : Response.json(path === "/heartbeat" ? { nextHeartbeatMs: 600000 } : { ok: true }))
    const { code, stderr } = await exitsNaming("src/index.ts", {
      DESCRIBED_VESSEL_ID: "described-test", DESCRIBED_PORT: String(freePort()), DISCOVERY_URL: notReady.url,
      DESCRIBED_ENDPOINT: "x", IDENTITY_VESSEL_URL: identity.url, METABOB_API_KEY: NODE_KEY,
    })
    notReady.stop()
    expect(code).toBe(1)
    expect(stderr).toContain("no list of rows")
    expect(stderr).not.toContain("TypeError")
    expect(stderr).not.toContain(NODE_KEY)
  })

  test("[MUST-FAIL] a schema target the owner writes after boot is served from the next heartbeat, without a restart", async () => {
    let targets = ["answer"]
    let readsFail = false
    const d = fake((path, body) => {
      if (path === "/heartbeat") return Response.json({ nextHeartbeatMs: 100 })
      if (path !== "/resolve") return Response.json({ ok: true })
      const p = (body as any).pointer
      if (p.type === "record_read" && p.shape === "shape_schema") {
        return readsFail ? Response.json({ error: "down" }, { status: 503 }) : Response.json(targets.map((t, i) => ({ ...SCHEMA, id: `s${i}`, target: t })))
      }
      return Response.json([])
    })
    const p2 = freePort()
    const v = run("src/index.ts", {
      DESCRIBED_VESSEL_ID: "described-beat", DESCRIBED_PORT: String(p2), DISCOVERY_URL: d.url,
      DESCRIBED_ENDPOINT: `http://127.0.0.1:${p2}`, IDENTITY_VESSEL_URL: identity.url, METABOB_API_KEY: NODE_KEY,
    })
    try {
      await healthy(p2)
      const registered = () => d.seen.filter((x) => x.path === "/register").map((x) => (x.body as any).shapes as string[])
      await until(() => registered().length >= 1, "first /register")
      expect(registered()[0]).toEqual(["answer"])
      readsFail = true // a failed read keeps what is registered
      await Bun.sleep(400)
      expect(registered()).toHaveLength(1)
      readsFail = false
      targets = ["answer", "change_wanted"]
      await until(() => registered().length >= 2, "a /register with the new target")
      expect([...registered()[1]].sort()).toEqual(["answer", "change_wanted"])
    } finally {
      v.kill()
      d.stop()
    }
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
