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
  // The walk's record of a call whose answer was a row records stamped, whole; it names in its input_refs a row never shown.
  { shape: "hop", id: "h2", role: "walk", input_refs: ["w7"], output: { shape: "change_wanted", id: "cw1", seq: 5, writer: "ds", role: "described", repo: "a-vessel" } },
  // Too big to show whole: the clip cuts it, and the row inside goes with it.
  { shape: "hop", id: "h3", role: "walk", output: { shape: "change_wanted", id: "cw2", seq: 6, writer: "ds", role: "described", pad: "x".repeat(9 * 1024) } },
  // The walk's record carrying an object stamped unlike the row records holds (a forged copy).
  { shape: "hop", id: "h4", role: "walk", output: { shape: "change_wanted", id: "cw3", seq: 999, writer: "ds", role: "described" } },
  // A row a producer wrote (not the walk's record of a call) carrying an object shaped like a stamped row.
  { shape: "hop", id: "h5", role: "described", output: { shape: "change_wanted", id: "cw1", seq: 5, writer: "ds", role: "described" } },
  // What records holds for those ids.
  { shape: "change_wanted", id: "cw1", seq: 5, writer: "ds", role: "described", repo: "a-vessel" },
  { shape: "change_wanted", id: "cw2", seq: 6, writer: "ds", role: "described" },
  { shape: "change_wanted", id: "cw3", seq: 7, writer: "ds", role: "described" },
]
// What a record_lapsed read answers: deadline rows, as records returns them
const LAPSED = [
  { shape: "due", id: "d1", role: "described", within_ms: 60000, at: 1, input_refs: ["w1"] },
  { shape: "due", id: "d9", role: "described", within_ms: 60000, at: 1, input_refs: ["w9"] }, // another request's
]
// The owner's requires rows, as a record_read of shape requires answers
let REQUIRES_ROWS: Array<Record<string, unknown>> = []
// What a record_summary answers for its newest_seq (null: no such row), or a failure
let SUMMARY_NEWEST: number | null = null
let summaryDown = false
// Schema rows besides SCHEMA (newer ones, as records lists them oldest first)
let moreSchemas: Array<Record<string, unknown>> = []

let llmContent = JSON.stringify({ text: "hi" })
let llmFailure: Record<string, unknown> | null = null
let vesselErr = ""
// discovery's own answer when no producer serves the model's shape (it never reached a resolver)
let llmUnrouted = false
let readsDown = false
// What the vessels declare, as discovery's shapeDescriptions read carries it: what each call answers with, what it changes
let DECL: { shape_answers?: Record<string, string>; shape_changes?: Record<string, string[]> } = {}
let discovery: Fake
let identity: Fake
let port: number
let vessel: ReturnType<typeof run>

const resolve = (p: Record<string, any>): Response => {
  if (p.type === "record_read" && p.shape === "shape_schema") return Response.json([SCHEMA, ...moreSchemas])
  // The owner also describes shapes it does not want produced (a detector's gap): never something to serve.
  if (p.type === "record_read" && p.shape === "shape_description") return Response.json([{ shape: "shape_description", id: "sd1", of: "gap" }])
  if (p.type === "record_read" && p.shape === "requires") return Response.json(REQUIRES_ROWS)
  if (p.type === "record_summary") return summaryDown ? Response.json({ error: "down" }, { status: 503 })
    : Response.json({ shape: p.shape, count: SUMMARY_NEWEST === null ? 0 : 1, newest_seq: SUMMARY_NEWEST, fields: {} })
  if (p.type === "record_read" && p.shape === "channel") return Response.json((p.ids as string[]).includes(CHANNEL.id) ? [CHANNEL] : [])
  if (p.type === "record_read") return Response.json(INPUTS.filter((r) => (p.ids as string[]).includes(r.id)))
  if (p.type === "shapeDescriptions") return readsDown
    ? Response.json({ error: "down" }, { status: 503 })
    : Response.json({ content: { shape_descriptions: { fs_read: "produces file content from a path" }, data_shapes: { hop: "a record of a call" }, ...DECL } })
  if (p.type === "record_lapsed") return Response.json(LAPSED.filter((r) => !Array.isArray(p.asks) || r.input_refs.some((id) => p.asks.includes(id))))
  if (p.type === "llm_completion" && llmUnrouted) return Response.json({ error: "Not found", shape: "llm_completion", unserved: "llm_completion" }, { status: 404 })
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
  // what the vessel journals, kept for the legs that read it
  ;(async () => {
    const rd = (vessel.stderr as ReadableStream<Uint8Array>).getReader()
    const dec = new TextDecoder()
    for (;;) { const { value, done } = await rd.read(); if (done) break; vesselErr += dec.decode(value) }
  })()
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
    const llm = calls.find((c) => (c.body as any)?.pointer?.type === "llm_completion")?.body as any
    expect(llm.pointer.model).toBe("model-asked")
    expect(typeof llm.pointer.prompt).toBe("string")
    const w = calls.find((c) => (c.body as any)?.pointer?.type === "record_write")?.body as any
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
    const llm = calls.find((c) => (c.body as any)?.pointer?.type === "llm_completion")?.body as any
    expect(llm.pointer.prompt).toContain("the question")
    expect(llm.pointer.prompt).toContain("data a request fetched")
    expect(llm.pointer.prompt).not.toContain("a draft answer")
    const w = calls.find((c) => (c.body as any)?.pointer?.type === "record_write")?.body as any
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
    expect(calls.some((c) => c.path === "/resolve" && (c.body as any)?.pointer?.type === "shapeDescriptions")).toBe(true)
    const llm = calls.find((c) => (c.body as any)?.pointer?.type === "llm_completion")?.body as any
    expect(llm.pointer.prompt).toContain("produces file content from a path")
    const w = calls.find((c) => (c.body as any)?.pointer?.type === "record_write")?.body as any
    expect(w.pointer.row.input_refs).toEqual(["w1", "h1"])
    expect(down.status).toBe(503)
    expect(downCalls.some((c) => (c.body as any)?.pointer?.type === "llm_completion")).toBe(false)
  })

  test("[MUST-FAIL] a produce asking for a schema variant applies that variant's newest row; one asking for none, the plain row", async () => {
    moreSchemas = [{ ...SCHEMA, id: "s2", variant: "gap", description: "made from a gap", inputs: ["gap"] }]
    const prompt = async (more: Record<string, unknown>) => {
      const before = discovery.seen.length
      const r = await produce(NODE_KEY, more)
      const llm = discovery.seen.slice(before).find((c) => (c.body as any)?.pointer?.type === "llm_completion")?.body as any
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
    const prompt = String((calls.find((c) => (c.body as any)?.pointer?.type === "llm_completion")?.body as any)?.pointer?.prompt ?? "")
    const w = calls.find((c) => (c.body as any)?.pointer?.type === "record_write")?.body as any
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

  // The request's own clone, kept in view however much newer context there is (the owner's keep, within keep_share).
  const keepRun = async (opts: { keep?: boolean; share?: number; extra?: Array<Record<string, unknown>> }) => {
    const ctx = (SCHEMA as any).context
    ;(SCHEMA as any).context = ["hop", "failure", { shape: "gitWorktree", latest_by: "repo", ...(opts.keep ? { keep: true } : {}) }]
    if (opts.share !== undefined) (SCHEMA as any).keep_share = opts.share
    // bigger than any slack the newest-first fill can leave (each hop is about 3 KB), so only keep can bring it in
    const clone = { shape: "gitWorktree", id: "gw-own", seq: 50, repo: "hsv", cwd: "/trees/OWN_CLONE", input_refs: ["w1"], note: "c".repeat(3500) }
    const hops = Array.from({ length: 80 }, (_, i) => ({ shape: "hop", id: `hk${i}`, seq: 100 + i, output: { text: `kstep-${i}. ` + "x".repeat(3000) } }))
    const rows = [clone, ...hops, ...(opts.extra ?? [])]
    INPUTS.push(...(rows as any))
    const before = discovery.seen.length
    const r = await produce(NODE_KEY, { input_refs: ["w1", ...rows.map((x) => x.id)] })
    INPUTS.splice(INPUTS.length - rows.length, rows.length)
    ;(SCHEMA as any).context = ctx
    delete (SCHEMA as any).keep_share
    const calls = discovery.seen.slice(before)
    const prompt = String((calls.find((c) => (c.body as any)?.pointer?.type === "llm_completion")?.body as any)?.pointer?.prompt ?? "")
    const row = (calls.find((c) => (c.body as any)?.pointer?.type === "record_write")?.body as any)?.pointer?.row
    return { status: r.status, prompt, row }
  }

  // What a call requires, shown first (52d7196f: an edit written by a producer shown none of the file it edited, its
  // read dropped for newer hops). The owner's requires row, as the seed writes it for fs_edit.
  const REQ = { shape: "requires", id: "rq1", seq: 1, role: "owner", for: "fs_edit", needs: "fileContent", where: { path: { "x-pointer": "path" } }, latest_by: "path", group: "read" }
  const reqRun = async (opts: { reqs?: Array<Record<string, unknown>>; given?: boolean; share?: number; extra?: Array<Record<string, unknown>>; entry?: Record<string, unknown>; more?: Array<Record<string, unknown>> }) => {
    const ctx = (SCHEMA as any).context
    ;(SCHEMA as any).context = ["hop", "failure", opts.entry ?? { shape: "fileContent", whole: true, latest_by: "path" }, ...(opts.more ?? [])]
    ;(SCHEMA as any).keep_share = opts.share ?? 0.25
    REQUIRES_ROWS = opts.given ? [] : (opts.reqs ?? [])
    const file = { shape: "fileContent", id: "fc-edit", seq: 50, path: "/trees/c2/src/EDITED.ts", input_refs: ["w1"], content: "EDITED_FILE_BODY " + "e".repeat(20000) }
    const hops = Array.from({ length: 80 }, (_, i) => ({ shape: "hop", id: `hr${i}`, seq: 100 + i, output: { text: `rstep-${i}. ` + "x".repeat(3000) } }))
    const rows = [file, ...hops, ...(opts.given ? (opts.reqs ?? []) : []), ...(opts.extra ?? [])]
    INPUTS.push(...(rows as any))
    const before = discovery.seen.length
    const r = await produce(NODE_KEY, { input_refs: ["w1", ...rows.map((x) => x.id)] })
    INPUTS.splice(INPUTS.length - rows.length, rows.length)
    ;(SCHEMA as any).context = ctx
    delete (SCHEMA as any).keep_share
    REQUIRES_ROWS = []
    // only the calls this produce made: the vessel's own discovery traffic (register, heartbeat) carries no pointer
    const calls = discovery.seen.slice(before)
    const prompt = String((calls.find((c) => (c.body as any)?.pointer?.type === "llm_completion")?.body as any)?.pointer?.prompt ?? "")
    const row = (calls.find((c) => (c.body as any)?.pointer?.type === "record_write")?.body as any)?.pointer?.row
    return { status: r.status, prompt, row }
  }

  test("[MUST-FAIL] a row a call requires is shown first, however much newer context there is, whether the requires row is read or given", async () => {
    for (const given of [false, true]) {
      const r = await reqRun({ reqs: [REQ], given })
      expect([given, r.status, r.prompt.includes("EDITED_FILE_BODY"), (r.row.input_refs as string[]).includes("fc-edit")]).toEqual([given, 200, true, true])
      expect(r.prompt).toContain("rstep-79.") // the newest hop still shown
    }
  })

  test("[MUST-FAIL] a requires row bound to the clone's newest tree shows first only the verdict on that tree", async () => {
    const XL = { "x-latest": { shapes: ["gitCommitResult", "gitWorktree", "gitDiff"], moves: ["gitCommitResult", "gitWorktree"], same: "cwd", field: "tree" } }
    const req = { shape: "requires", id: "rqL", seq: 1, role: "owner", for: "git_land", needs: "land_verdict", where: { r: 1, tree: XL }, latest_by: "tree", group: "verdict" }
    const clone = [
      { shape: "selection", id: "sel-1", seq: 9, role: "walk", root: "w1" },
      { shape: "gitWorktree", id: "cl", seq: 10, role: "walk", call_id: "c-cl", cwd: "/c", input_refs: ["w1"] },
      { shape: "gitCommitResult", id: "k2", seq: 11, role: "walk", call_id: "c-k2", cwd: "/c", tree: "TREE_TWO", input_refs: ["w1"] },
    ]
    const verdicts = [
      { shape: "land_verdict", id: "vOld", seq: 60, role: "described", r: 1, tree: "TREE_ONE", input_refs: ["w1"], why: "VERDICT_ON_ONE " + "o".repeat(2000) },
      { shape: "land_verdict", id: "vNew", seq: 61, role: "described", r: 1, tree: "TREE_TWO", input_refs: ["w1"], why: "VERDICT_ON_TWO " + "n".repeat(2000) },
      { shape: "land_verdict", id: "vNone", seq: 62, role: "described", r: 1, input_refs: ["w1"], why: "VERDICT_NAMING_NO_TREE " + "x".repeat(2000) },
    ]
    const shown = await reqRun({ reqs: [req], extra: [...clone, ...verdicts], entry: { shape: "land_verdict" } })
    expect([shown.prompt.includes("VERDICT_ON_TWO"), shown.prompt.includes("VERDICT_ON_ONE")]).toEqual([true, false])
    // the clone moved without saying its tree: no verdict is the newest tree's, so none is shown first
    const moved = await reqRun({ reqs: [req], extra: [...clone, { ...clone[1], id: "cl2", seq: 12, call_id: "c-cl2" }, ...verdicts], entry: { shape: "land_verdict" } })
    expect([moved.prompt.includes("VERDICT_ON_TWO"), moved.prompt.includes("VERDICT_ON_ONE"), moved.prompt.includes("VERDICT_NAMING_NO_TREE")]).toEqual([false, false, false])
    expect(shown.prompt.includes("VERDICT_NAMING_NO_TREE")).toBe(false)
  })

  test("[MUST-FAIL] a row a shown refusal names is shown with it, ahead of older rows; without the name, it is left to the budget (90b4ece3)", async () => {
    // an old verdict the budget would drop behind 80 newer hops, and the walk's skip naming it (against_refs)
    const verdict = { shape: "land_verdict", id: "lv-old", seq: 60, r: 0, tree: "t-old", input_refs: ["w1"], note: "OLD_VERDICT " + "v".repeat(2000) }
    const skip = { shape: "failure", id: "sk-n", seq: 190, kind: "skip", unserved: ["git_land (requires land_verdict; r: required 1 ≠ land_verdict's 0)"], against_refs: ["lv-old"], input_refs: ["w1"] }
    const more = [{ shape: "land_verdict" }]
    const named = await reqRun({ reqs: [], extra: [verdict, skip], more })
    expect([named.prompt.includes("OLD_VERDICT"), (named.row.input_refs as string[]).includes("lv-old"), named.prompt.includes("rstep-79.")]).toEqual([true, true, true])
    // the same rows, the skip naming nothing: as before, the old verdict is left to the budget (not shown)
    const unnamed = await reqRun({ reqs: [], extra: [verdict, { ...skip, against_refs: undefined }], more })
    expect([unnamed.prompt.includes("OLD_VERDICT"), (unnamed.row.input_refs as string[]).includes("lv-old")]).toEqual([false, false])
    // named rows that do not all fit (30 of ~8 KB each, cut, past the 192 KB budget) are each either shown and cited or
    // said by id; none is dropped in silence
    const many = Array.from({ length: 30 }, (_, i) => ({ ...verdict, id: `lv-${i}`, seq: 61 + i, note: `OLD_VERDICT_${i} ` + "v".repeat(9000) }))
    const big = await reqRun({ reqs: [], extra: [...many, { ...skip, against_refs: many.map((v) => v.id) }], more })
    const said = (big.prompt.match(/rows a shown refusal names that did not fit: ([^"]*)/)?.[1] ?? "").split(", ").filter(Boolean)
    const cited = new Set(big.row.input_refs as string[])
    expect([said.length > 0, many.filter((v) => !cited.has(v.id) && !said.includes(v.id)).map((v) => v.id), said.filter((id) => cited.has(id))]).toEqual([true, [], []])
  })

  test("[MUST-FAIL] required reads that fill a share never push out the kept rows: the request's clone is still shown beside them", async () => {
    // two more reads of other files, so the required rows alone (~66 KB) are more than the keep share (48 KB)
    const reads = ["A", "B"].map((x, i) => ({ shape: "fileContent", id: `fc-${x}`, seq: 55 + i, path: `/trees/c2/src/${x}.ts`, input_refs: ["w1"], content: `READ_${x} ` + "r".repeat(22000) }))
    // bigger than what two reads leave of one 48 KB share, so it fits only with a share of its own
    const clone = { shape: "gitWorktree", id: "gw-own", seq: 45, repo: "hsv", cwd: "/trees/OWN_CLONE", input_refs: ["w1"], note: "c".repeat(6000) }
    const r = await reqRun({ reqs: [REQ], extra: [...reads, clone], more: [{ shape: "gitWorktree", latest_by: "repo", keep: true }] })
    expect([r.prompt.includes("/trees/OWN_CLONE"), (r.row.input_refs as string[]).includes("gw-own"), r.prompt.includes("READ_B")]).toEqual([true, true, true])
  })

  test("[MUST-FAIL] kept rows that fill their share never push out a required read: the edited file is still shown beside them", async () => {
    // five clones of different repositories, ~46 KB of kept rows: nearly the whole 48 KB keep share
    const clones = [1, 2, 3, 4, 5].map((i) => ({ shape: "gitWorktree", id: `gw-${i}`, seq: 40 + i, repo: `repo-${i}`, cwd: `/trees/CLONE_${i}`, input_refs: ["w1"], note: "c".repeat(9000) }))
    const r = await reqRun({ reqs: [REQ], extra: clones, more: [{ shape: "gitWorktree", latest_by: "repo", keep: true }] })
    expect([r.prompt.includes("EDITED_FILE_BODY"), (r.row.input_refs as string[]).includes("fc-edit"), clones.every((c) => (r.row.input_refs as string[]).includes(c.id))]).toEqual([true, true, true])
  })

  test("[MUST-FAIL] with no requires row, one not the owner's, or no keep share, it is left to the budget (as before)", async () => {
    for (const o of [{ reqs: [] }, { reqs: [{ ...REQ, role: "described" }] }, { reqs: [REQ], share: 0 }]) {
      const r = await reqRun(o)
      expect([JSON.stringify(o.reqs.map((q) => q.role)), r.prompt.includes("EDITED_FILE_BODY")]).toEqual([JSON.stringify(o.reqs.map((q) => q.role)), false])
    }
  })

  test("[MUST-FAIL] only the request's own rows, the newest per latest_by, and only those meeting the requires row's fixed where", async () => {
    const other = { shape: "fileContent", id: "fc-other", seq: 60, path: "/trees/x/OTHER.ts", input_refs: ["w9"], content: "OTHER_LINEAGE_BODY " + "o".repeat(20000) }
    const older = { shape: "fileContent", id: "fc-old", seq: 40, path: "/trees/c2/src/EDITED.ts", input_refs: ["w1"], content: "OLDER_READ_BODY " + "d".repeat(20000) }
    const r = await reqRun({ reqs: [REQ], extra: [other, older] })
    expect([r.prompt.includes("EDITED_FILE_BODY"), r.prompt.includes("OTHER_LINEAGE_BODY"), r.prompt.includes("OLDER_READ_BODY")]).toEqual([true, false, false])
    // the requires row's own latest_by, even where the owner's context entry has none
    const plain = await reqRun({ reqs: [REQ], extra: [older], entry: { shape: "fileContent", whole: true } })
    expect([plain.prompt.includes("EDITED_FILE_BODY"), plain.prompt.includes("OLDER_READ_BODY")]).toEqual([true, false])
    const fixed = await reqRun({ reqs: [{ ...REQ, where: { path: "/trees/c2/src/NOT_THIS.ts" } }] })
    expect(fixed.prompt.includes("EDITED_FILE_BODY")).toBe(false)
  })

  test("[MUST-FAIL] on 62707's real pool (a gap root; sizes, sequence and citations as they were) the edited file's read is shown", async () => {
    // database's read of the rows the walk gave that producer, scrubbed: ids remapped, paths cut to the clone-relative
    // part, bodies padded to each row's real size. With the live request schema (the gap variant), the base fill showed
    // none of the 8 file reads; the edited file's (seq 59472) was older than everything shown.
    const { gunzipSync } = await import("node:zlib")
    const { readFileSync } = await import("node:fs")
    const fx = JSON.parse(gunzipSync(readFileSync(new URL("./fixtures/p62707.json.gz", import.meta.url))).toString()) as
      { root: string; rows: Array<{ id: string; shape: string; seq: number; bytes: number; input_refs: string[]; path?: string; edited?: boolean }> }
    const rows = fx.rows.map((r) => {
      const base = { shape: r.shape, id: r.id, seq: r.seq, role: r.shape === "gap" ? "detector" : "walk", input_refs: r.input_refs, ...(r.path ? { path: r.path } : {}) }
      const mark = r.edited ? "EDITED_REAL_FILE " : ""
      const pad = mark + "p".repeat(Math.max(0, r.bytes - JSON.stringify(base).length - 20 - mark.length))
      return r.shape === "hop" ? { ...base, output: { text: pad } } : r.shape === "fileContent" ? { ...base, content: pad } : { ...base, pad }
    })
    const ctx = (SCHEMA as any).context, ins = (SCHEMA as any).inputs
    ;(SCHEMA as any).inputs = ["gap"]
    ;(SCHEMA as any).context = ["hop", "failure", "answer", "outcome", { shape: "fileContent", whole: true, latest_by: "path", covers: { shape: "hop", on: "call_id" } },
      { shape: "gitWorktree", latest_by: "repo", keep: true }, { shape: "change_wanted", latest_by: "repo", keep: true },
      { shape: "gitCommitResult", latest_by: "shape", keep: true }, { shape: "request_acts", latest_by: "shape", keep: true }]
    ;(SCHEMA as any).keep_share = 0.25
    REQUIRES_ROWS = [REQ]
    INPUTS.push(...(rows as any))
    const before = discovery.seen.length
    const r = await produce(NODE_KEY, { input_refs: rows.map((x) => x.id) })
    INPUTS.splice(INPUTS.length - rows.length, rows.length)
    ;(SCHEMA as any).context = ctx; (SCHEMA as any).inputs = ins
    delete (SCHEMA as any).keep_share
    REQUIRES_ROWS = []
    // only the calls this produce made: the vessel's own discovery traffic (register, heartbeat) carries no pointer
    const calls = discovery.seen.slice(before)
    const prompt = String((calls.find((c) => (c.body as any)?.pointer?.type === "llm_completion")?.body as any)?.pointer?.prompt ?? "")
    const edited = fx.rows.find((x) => x.edited)!.id
    const row = (calls.find((c) => (c.body as any)?.pointer?.type === "record_write")?.body as any)?.pointer?.row
    expect([r.status, prompt.includes("EDITED_REAL_FILE"), (row?.input_refs as string[] | undefined)?.includes(edited)]).toEqual([200, true, true])
    // and the request's newest clone, commit and acts (the kept rows) are cited beside it
    const newest = (shape: string) => fx.rows.filter((x) => x.shape === shape).sort((a, b) => b.seq - a.seq)[0].id
    expect(["gitWorktree", "gitCommitResult", "request_acts"].map((s) => (row?.input_refs as string[]).includes(newest(s)))).toEqual([true, true, true])
  })

  test("[MUST-FAIL] a kept entry's row is shown and cited past more than the whole budget of newer context; the row records what was left out", async () => {
    const r = await keepRun({ keep: true, share: 0.25 })
    expect(r.status).toBe(200)
    expect(r.prompt).toContain("/trees/OWN_CLONE")
    expect(r.row.input_refs).toContain("gw-own")
    expect(r.prompt).toContain("kstep-79.") // the newest still shown
    expect(r.row.context_omitted).toBeGreaterThan(0)
    expect(typeof r.row.oldest_shown_seq).toBe("number")
  })

  test("[MUST-FAIL] with no keep, no keep_share, or a share too small for it, the old clone is left out: kept rows never pass their share", async () => {
    for (const o of [{ keep: false, share: 0.25 }, { keep: true }, { keep: true, share: 0.01 }]) {
      const r = await keepRun(o)
      expect(r.prompt).not.toContain("/trees/OWN_CLONE")
      expect(r.row.input_refs).not.toContain("gw-own")
    }
  })

  test("[MUST-FAIL] a kept-shape row reached through another request's lineage is not kept; the newest failure is still shown", async () => {
    const other = { shape: "gitWorktree", id: "gw-other", seq: 60, repo: "hsv2", cwd: "/trees/OTHER_CLONE", input_refs: ["w9"], note: "o".repeat(3500) }
    const fail = { shape: "failure", id: "f-new", seq: 200, body: "NEWEST_REFUSAL_REASON" }
    const r = await keepRun({ keep: true, share: 0.25, extra: [other, fail] })
    expect(r.prompt).not.toContain("/trees/OTHER_CLONE")
    expect(r.prompt).toContain("/trees/OWN_CLONE")
    expect(r.prompt).toContain("NEWEST_REFUSAL_REASON")
  })

  test("[MUST-FAIL] the omission count on the row is the vessel's, never what the model wrote", async () => {
    const keep = llmContent
    llmContent = JSON.stringify({ text: "hi", context_omitted: 0, oldest_shown_seq: 1 })
    const big = await keepRun({ keep: true, share: 0.25 }) // rows were left out: the model's 0 is not stored
    llmContent = JSON.stringify({ text: "hi", context_omitted: 42, oldest_shown_seq: 7 })
    const before = discovery.seen.length
    await produce(NODE_KEY) // nothing left out: the model's 42 is not stored
    llmContent = keep
    const small = (discovery.seen.slice(before).find((c) => (c.body as any)?.pointer?.type === "record_write")?.body as any)?.pointer?.row
    expect(big.row.context_omitted).toBeGreaterThan(0)
    expect(big.row.oldest_shown_seq).not.toBe(1)
    expect(small.context_omitted).toBe(0)
    expect(small.oldest_shown_seq).not.toBe(7)
  })

  test("[MUST-FAIL] one row too big for what is left is skipped, and older small rows still fill the budget", async () => {
    const ctx = (SCHEMA as any).context
    ;(SCHEMA as any).context = ["hop"]
    // 25 newest rows of about 7.85 KB nearly fill the 192 KiB; the next older one, as big, does not fit; older small ones do
    const newer = Array.from({ length: 25 }, (_, i) => ({ shape: "hop", id: `hn${i}`, seq: 600 + i, output: { text: "n".repeat(7800) } }))
    const big = { shape: "hop", id: "h-big", seq: 500, output: { text: "z".repeat(7800) } }
    const small = Array.from({ length: 3 }, (_, i) => ({ shape: "hop", id: `hs${i}`, seq: 10 + i, output: { text: `small-${i}.` } }))
    const rows = [...small, big, ...newer]
    INPUTS.push(...(rows as any))
    const before = discovery.seen.length
    await produce(NODE_KEY, { input_refs: ["w1", ...rows.map((x) => x.id)] })
    INPUTS.splice(INPUTS.length - rows.length, rows.length)
    ;(SCHEMA as any).context = ctx
    const prompt = String((discovery.seen.slice(before).find((c) => (c.body as any)?.pointer?.type === "llm_completion")?.body as any)?.pointer?.prompt ?? "")
    expect(prompt).not.toContain("zzzzzzzzzz") // the one that did not fit is left out
    expect(prompt).toContain("small-2.") // and the fill went on past it
  })

  test("a schema row with no inputs list is refused, not read as empty", async () => {
    const keep = (SCHEMA as any).inputs
    delete (SCHEMA as any).inputs
    const before = discovery.seen.length
    const r = await produce(NODE_KEY)
    ;(SCHEMA as any).inputs = keep
    expect(r.status).toBe(422)
    expect(discovery.seen.slice(before).some((c) => (c.body as any)?.pointer?.type === "llm_completion")).toBe(false)
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
    const wrote = discovery.seen.slice(before).some((c) => (c.body as any)?.pointer?.type === "record_write")
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

  test("[MUST-FAIL] an answer cut at the model's output limit says so, with how it ended; a complete wrong answer says how it ended too", async () => {
    // the resolver's own answer form (llm-resolver anthropic branch): the text cut inside a string, stop_reason max_tokens
    const answer = (content: string, stop_reason: string, output_tokens: number) => ({ resolved: true, shape: "llmCompletion", content,
      provider: "anthropic", model: "model-served", usage: { input_tokens: 9000, output_tokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, stop_reason })
    const from = vesselErr.length
    try {
      llmFailure = answer('{"text": "an edit whose old_string was cut in the mid', "max_tokens", 4096)
      const cut = await produce(NODE_KEY)
      llmFailure = answer("not json at all", "end_turn", 12)
      const malformed = await produce(NODE_KEY)
      llmFailure = answer(JSON.stringify({ other: 1 }), "end_turn", 8)
      const misfit = await produce(NODE_KEY)
      llmFailure = null
      const f = (r: any) => r.body.failure
      expect([cut.status, f(cut).stop_reason, f(cut).output_tokens, String(f(cut).body).startsWith("output cut at the model's output limit after 4096 tokens"),
        String(f(cut).body).includes("old_string was cut")]).toEqual([422, "max_tokens", 4096, true, true])
      expect([malformed.status, f(malformed).stop_reason, f(malformed).output_tokens, String(f(malformed).body).includes("output cut")]).toEqual([422, "end_turn", 12, false])
      expect([f(misfit).refused, f(misfit).stop_reason, f(misfit).output_tokens]).toEqual(["schema", "end_turn", 8])
      // one journal line per refused produce, saying why and how it ended, never the answer's text
      // the journal arrives through a pipe: wait for it, bounded well inside the test's own time limit
      for (let i = 0; i < 80 && vesselErr.slice(from).split("\n").filter((l) => l.startsWith("[described] produce answer refused 422")).length < 3; i++) await Bun.sleep(25)
      const said = vesselErr.slice(from).split("\n").filter((l) => l.startsWith("[described] produce answer refused 422"))
      expect(said.map((l) => /\(([^)]*)\): stop_reason (\S+), output_tokens (\S+)/.exec(l)?.slice(1))).toEqual([["output cut", "max_tokens", "4096,"], ["not JSON", "end_turn", "12,"], ["schema", "end_turn", "8,"]])
      expect(said.some((l) => l.includes("old_string") || l.includes("not json at all"))).toBe(false)
    } finally {
      llmFailure = null
    }
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
    const prompt = String((calls.find((c) => (c.body as any)?.pointer?.type === "llm_completion")?.body as any)?.pointer?.prompt ?? "")
    const w = calls.find((c) => (c.body as any)?.pointer?.type === "record_write")?.body as any
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
    const writes = () => discovery.seen.filter((c) => c.path === "/resolve" && (c.body as any)?.pointer?.type === "record_write")
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

  test("[MUST-FAIL] a read the owner marks shown: its rows count as shown and are cited, whatever they cite; the mark is not sent; an invented id is still refused", async () => {
    const keep = (SCHEMA as any).schema
    ;(SCHEMA as any).reads = [{ type: "record_lapsed", deadline_shape: "due", answer_shape: "answer", shown: true }]
    ;(SCHEMA as any).schema = {
      type: "object", required: ["evidence_refs"],
      properties: { evidence_refs: { type: "array", items: { type: "string", "x-shown": true } } },
    }
    const before = discovery.seen.length
    llmContent = JSON.stringify({ evidence_refs: ["d9"] }) // another request's deadline: citable only because the owner marked the read
    const across = await produce(NODE_KEY)
    const calls = discovery.seen.slice(before)
    const sent = calls.map((c) => (c.body as any)?.pointer).find((p) => p?.type === "record_lapsed")
    const row = calls.map((c) => (c.body as any)?.pointer).filter((p) => p?.type === "record_write").at(-1)?.row
    llmContent = JSON.stringify({ evidence_refs: ["zz-invented"] })
    const invented = await produce(NODE_KEY)
    ;(SCHEMA as any).schema = keep
    delete (SCHEMA as any).reads
    llmContent = JSON.stringify({ text: "hi" })
    expect([across.status, "shown" in (sent ?? {}), (row?.input_refs as string[]).includes("d9")]).toEqual([200, false, true])
    expect([invented.status, String(invented.body.failure?.body).includes('"zz-invented" is not a row it was shown')]).toEqual([422, true])
  })

  test("[MUST-FAIL] a row the walk's record of a call carried whole may be cited, as records holds it; input_refs stay what was given", async () => {
    const keep = (SCHEMA as any).schema
    ;(SCHEMA as any).schema = {
      type: "object", required: ["evidence_refs"],
      properties: { evidence_refs: { type: "array", items: { type: "string", "x-shown": true } } },
    }
    const writes = () => discovery.seen.filter((c) => c.path === "/resolve" && (c.body as any)?.pointer?.type === "record_write")
    const answer = async (ref: string, refs: string[]) => {
      llmContent = JSON.stringify({ evidence_refs: [ref] })
      return produce(NODE_KEY, { input_refs: refs })
    }
    const before = writes().length
    const nested = await answer("cw1", ["w1", "h2"])
    const written = writes().at(-1)?.body as any
    const afterNested = writes().length
    const clipped = await answer("cw2", ["w1", "h3"])
    const named = await answer("w7", ["w1", "h2"])
    const forged = await answer("cw3", ["w1", "h4"])
    const notRecorded = await answer("cw1", ["w1", "h5"])
    const after = writes().length
    ;(SCHEMA as any).schema = keep
    llmContent = JSON.stringify({ text: "hi" })
    expect(nested.status).toBe(200)
    expect(afterNested - before).toBe(1)
    expect(written.pointer.row.input_refs).toEqual(["w1", "h2"]) // lineage: what was given, not what a given row carried
    for (const [r, id] of [[clipped, "cw2"], [named, "w7"], [forged, "cw3"], [notRecorded, "cw1"]] as const) {
      expect([id, r.status]).toEqual([id, 422])
      expect(r.body.failure.body).toContain(`"${id}" is not a row it was shown`)
    }
    expect(after - afterNested).toBe(0) // the refused answers wrote nothing
  })

  test("[MUST-FAIL] a read pointer value {x-inputs} is bound to the input rows shown, so a scoped read answers about this request alone", async () => {
    ;(SCHEMA as any).reads = [{ type: "record_lapsed", deadline_shape: "due", answer_shape: "answer", asks: { "x-inputs": true } }]
    const before = discovery.seen.length
    const r = await produce(NODE_KEY)
    delete (SCHEMA as any).reads
    const calls = discovery.seen.slice(before)
    const read = calls.find((c) => (c.body as any)?.pointer?.type === "record_lapsed")?.body as any
    const prompt = String((calls.find((c) => (c.body as any)?.pointer?.type === "llm_completion")?.body as any)?.pointer?.prompt ?? "")
    expect(r.status).toBe(200)
    expect(read.pointer.asks).toEqual(["w1"])
    expect(prompt).toContain('"d1"')
    expect(prompt).not.toContain('"d9"')
  })

  // D1: a handed row made on another root (its root is not the selection's) is context, never an input, even when its
  // shape is an input shape: not bound by an x-inputs read, and never displacing the request's own row under an input
  // entry's latest_by. Rows in the live forms: a walk selection with root, pool_refs [root] and seen_key; outcomes as
  // described writes them (root and selection_ref from the selection); a gap episode of detector rows of one gap_id.
  describe("a row made on another root", () => {
    const sel = (id: string, root: string | undefined) => ({ shape: "selection", id, seq: 300, role: "walk", writer: "walk-test", arm: "arm1",
      a: "produce/answer/ch1", cell: "produce/answer/ch1|asker:person,age:0", context: ["asker:person", "age:0"], cell_scheme: "reads",
      ...(root === undefined ? {} : { root }), pool_refs: root === undefined ? [] : [root], seen_key: `k-${id}` })
    const outcome = (id: string, seq: number, root: string, ask: string) => ({ shape: "outcome", id, seq, role: "described", writer: "described-test",
      r: 1, why: `graded on ${root}`, input_refs: [ask, `a-${id}`], evidence_refs: [`a-${id}`], context_omitted: 0, root, selection_ref: `so-${id}`,
      call_id: `c-${id}`, producer: "model" })
    const gap = (id: string, seq: number, gapId = "failing-test-x") => ({ shape: "gap", id, seq, role: "detector", writer: "pull-sync",
      gap_id: gapId, status: "open", repo: "super", input_refs: [] })
    const rows = [
      sel("sel-w1", "w1"), sel("sel-none", undefined), sel("sel-g3", "g3"),
      outcome("o-own", 310, "w1", "w1"), outcome("o-far", 320, "w9", "w9"),
      gap("g2", 380), gap("g3", 400), gap("k1", 390, "failing-test-y"), outcome("o-g2", 395, "g2", "g2"), outcome("o-k1", 396, "k1", "k1"),
    ]
    const run = async (selection: string, refs: string[], inputs: unknown[]) => {
      const keep = { inputs: SCHEMA.inputs, n: INPUTS.length }
      ;(SCHEMA as any).inputs = inputs
      ;(SCHEMA as any).reads = [{ type: "record_lapsed", deadline_shape: "due", answer_shape: "answer", asks: { "x-inputs": true } }]
      INPUTS.push(...(rows as any[]))
      const before = discovery.seen.length
      const r = await produce(NODE_KEY, { input_refs: refs, selection_ref: selection })
      INPUTS.splice(keep.n)
      ;(SCHEMA as any).inputs = keep.inputs
      delete (SCHEMA as any).reads
      const calls = discovery.seen.slice(before)
      const read = calls.find((c) => (c.body as any)?.pointer?.type === "record_lapsed")?.body as any
      const prompt = String((calls.find((c) => (c.body as any)?.pointer?.type === "llm_completion")?.body as any)?.pointer?.prompt ?? "")
      const row = (calls.find((c) => (c.body as any)?.pointer?.type === "record_write")?.body as any)?.pointer?.row
      return { status: r.status, asks: read?.pointer?.asks as string[] | undefined, prompt, row }
    }
    const byShape = ["world_changed", "outcome"]
    const newest = ["world_changed", { shape: "outcome", latest_by: "shape" }] // as the seed's activity_template takes outcome

    test("[MUST-FAIL] another root's outcome is not an input: not bound by x-inputs, yet still shown and cited", async () => {
      const r = await run("sel-w1", ["w1", "o-own", "o-far"], byShape)
      expect(r.status).toBe(200)
      expect(r.asks).toEqual(["w1", "o-own"])
      expect(r.prompt).toContain('"o-far"')
      expect(r.row.input_refs).toContain("o-far")
      expect(r.row.root).toBe("w1")
    })
    test("[MUST-FAIL] another root's newer outcome does not displace the request's own under an input's latest_by", async () => {
      const r = await run("sel-w1", ["w1", "o-own", "o-far"], newest)
      expect(r.status).toBe(200)
      expect(r.asks).toEqual(["w1", "o-own"])
    })
    test("[GUARD] a row of the selection's own root is an input as before; with no other root's row, nothing changes", async () => {
      const r = await run("sel-w1", ["w1", "o-own"], newest)
      expect(r.asks).toEqual(["w1", "o-own"])
    })
    test("[GUARD] a selection naming no root: rows are classed by shape as before", async () => {
      const r = await run("sel-none", ["w1", "o-own", "o-far"], byShape)
      expect(r.asks).toEqual(["w1", "o-own", "o-far"])
    })
    test("[MUST-FAIL] on a gap, an outcome made under an earlier row of the same gap is an input; one of another gap is not", async () => {
      const r = await run("sel-g3", ["g2", "g3", "k1", "o-g2", "o-k1"], ["gap", "outcome"])
      expect(r.status).toBe(200)
      expect(r.asks).toContain("o-g2")
      expect(r.asks).not.toContain("o-k1")
    })

    // Every site that treats an input row apart treats another root's input-shaped row as context.
    const go = async (o: { inputs: unknown[]; extra: Array<Record<string, unknown>>; share?: number; reqs?: Array<Record<string, unknown>>; hops?: number; selection?: string; refs?: string[] }) => {
      const keep = { inputs: SCHEMA.inputs, context: (SCHEMA as any).context, n: INPUTS.length }
      ;(SCHEMA as any).inputs = o.inputs
      ;(SCHEMA as any).context = ["hop"]
      ;(SCHEMA as any).reads = [{ type: "record_lapsed", deadline_shape: "due", answer_shape: "answer", asks: { "x-inputs": true } }]
      if (o.share !== undefined) (SCHEMA as any).keep_share = o.share
      REQUIRES_ROWS = o.reqs ?? []
      // newer context than the rows under test, more than the budget holds (each hop about 3 KB)
      const hops = Array.from({ length: o.hops ?? 0 }, (_, i) => ({ shape: "hop", id: `hf${i}`, seq: 1000 + i, output: { text: `fstep-${i}. ` + "x".repeat(3000) } }))
      const add = [...(rows as any[]), ...o.extra, ...hops]
      INPUTS.push(...(add as any[]))
      const before = discovery.seen.length
      const r = await produce(NODE_KEY, { input_refs: o.refs ?? ["w1", "o-own", ...o.extra.map((x) => String(x.id)), ...hops.map((h) => h.id)], selection_ref: o.selection ?? "sel-w1" })
      INPUTS.splice(keep.n)
      ;(SCHEMA as any).inputs = keep.inputs
      ;(SCHEMA as any).context = keep.context
      delete (SCHEMA as any).reads
      delete (SCHEMA as any).keep_share
      REQUIRES_ROWS = []
      const calls = discovery.seen.slice(before)
      const read = calls.find((c) => (c.body as any)?.pointer?.type === "record_lapsed")?.body as any
      const prompt = String((calls.find((c) => (c.body as any)?.pointer?.type === "llm_completion")?.body as any)?.pointer?.prompt ?? "")
      const row = (calls.find((c) => (c.body as any)?.pointer?.type === "record_write")?.body as any)?.pointer?.row
      return { status: r.status, body: r.body, asks: read?.pointer?.asks as string[] | undefined, prompt, row }
    }
    // another root's grade, citing this request's ask (its producer was shown it), of a given size
    const far = (id: string, bytes: number, extra: Record<string, unknown> = {}) =>
      ({ ...outcome(id, 330, "w9", "w9"), input_refs: ["w1"], body: `HEAD_${id} ` + "b".repeat(bytes) + ` TAIL_${id}`, ...extra })

    test("[MUST-FAIL] another root's input-shaped row past the input cap is not refused as too big: it is cut as context", async () => {
      const r = await go({ inputs: byShape, extra: [far("o-big", 100 * 1024)] })
      expect(r.status).toBe(200)
      expect(r.prompt).toContain("HEAD_o-big")
      expect(r.prompt).not.toContain("TAIL_o-big")
      expect(r.row.input_refs).toContain("o-big")
      expect(r.asks).toEqual(["w1", "o-own"])
    })
    test("[MUST-FAIL] another root's input-shaped row the context budget left out is not counted as seen", async () => {
      const r = await go({ inputs: byShape, extra: [far("o-out", 7000)], hops: 80 })
      expect(r.status).toBe(200)
      expect(r.prompt).toContain("fstep-79.")
      expect(r.prompt).not.toContain("HEAD_o-out")
      expect(r.row.input_refs).not.toContain("o-out")
      expect(r.row.input_refs).toContain("o-own")
    })
    test("[MUST-FAIL] another root's input-shaped row citing this request's input is kept first as a context row is, under a keep entry", async () => {
      const r = await go({ inputs: ["world_changed", { shape: "outcome", keep: true }], extra: [far("o-kept", 7000)], hops: 80, share: 0.25 })
      expect(r.status).toBe(200)
      expect(r.prompt).toContain("HEAD_o-kept")
      expect(r.row.input_refs).toContain("o-kept")
      expect(r.asks).toEqual(["w1", "o-own"])
    })
    test("[MUST-FAIL] another root's input-shaped row citing this request's input is shown first as a context row is, when a call requires its shape", async () => {
      const req = { shape: "requires", id: "rq-far", seq: 1, role: "owner", for: "git_land", needs: "outcome" }
      const r = await go({ inputs: byShape, extra: [far("o-req", 7000)], hops: 80, share: 0.25, reqs: [req] })
      expect(r.status).toBe(200)
      expect(r.prompt).toContain("HEAD_o-req")
      expect(r.row.input_refs).toContain("o-req")
    })
    test("[GUARD] with none of these, the same budget leaves the row out", async () => {
      const r = await go({ inputs: byShape, extra: [far("o-req", 7000)], hops: 80, share: 0.25 })
      expect(r.prompt).not.toContain("HEAD_o-req")
    })
    test("[MUST-FAIL] on a gap, a row naming a row of another shape, or a gap row of another role, with the same gap_id is not the gap's", async () => {
      const fx = { shape: "failure", id: "fx", seq: 391, role: "detector", writer: "pull-sync", gap_id: "failing-test-x", input_refs: [] }
      const gx = { ...gap("gx", 392), role: "owner", writer: "owner" }
      const r = await go({ inputs: ["gap", "outcome"], extra: [fx, gx, outcome("o-fx", 397, "fx", "fx"), outcome("o-gx", 398, "gx", "gx")],
        selection: "sel-g3", refs: ["g2", "g3", "fx", "gx", "o-g2", "o-fx", "o-gx"] })
      expect(r.status).toBe(200)
      expect(r.asks).toContain("o-g2")
      expect(r.asks).not.toContain("o-fx")
      expect(r.asks).not.toContain("o-gx")
    })
    test("[GUARD] on a gap whose gap_id is a number, an outcome made under an earlier row of the same gap is an input", async () => {
      const r = await go({ inputs: ["gap", "outcome"], extra: [{ ...gap("gn2", 380), gap_id: 7 }, { ...gap("gn3", 400), gap_id: 7 }, sel("sel-gn3", "gn3"), outcome("o-gn2", 395, "gn2", "gn2")],
        selection: "sel-gn3", refs: ["gn2", "gn3", "o-gn2"] })
      expect(r.status).toBe(200)
      expect(r.asks).toContain("o-gn2")
    })
    // gap_ids are compared by value and type: two distinct object ids are two gaps, and 7 and "7" are two gaps, since one
    // writer's id never changes type and a coerced match would join another writer's gap
    for (const [a, b] of [[{ a: 1 }, { b: 2 }], [[1], "1"], [7, "7"]] as unknown[][]) {
      test(`[GUARD] two gaps whose gap_ids are ${JSON.stringify(a)} and ${JSON.stringify(b)} are not one gap: the other's outcome is not an input`, async () => {
        const r = await go({ inputs: ["gap", "outcome"], extra: [{ ...gap("go2", 380), gap_id: a }, { ...gap("go3", 400), gap_id: b }, sel("sel-go3", "go3"), outcome("o-go2", 395, "go2", "go2")],
          selection: "sel-go3", refs: ["go2", "go3", "o-go2"] })
        expect(r.status).toBe(200)
        expect(r.asks).not.toContain("o-go2")
      })
    }
    // two asks of one shape and role that are not gaps: one with no gap_id, then null, then empty
    const ask = (id: string, gapId: unknown) => ({ shape: "world_changed", id, seq: 200, role: "person", writer: "hsv", input_refs: [],
      ...(gapId === "absent" ? {} : { gap_id: gapId }) })
    for (const none of ["absent", null, ""]) {
      test(`[MUST-FAIL] two roots that are not gaps (gap_id ${JSON.stringify(none)}): the other ask's input-shaped row is context, not an input`, async () => {
        const r = await go({ inputs: byShape, extra: [ask("n1", none), ask("n2", none), sel("sel-n1", "n1"), outcome("o-n1", 330, "n1", "n1"), outcome("o-n2", 331, "n2", "n2")],
          selection: "sel-n1", refs: ["n1", "n2", "o-n1", "o-n2"] })
        expect(r.status).toBe(200)
        expect(r.asks).toContain("o-n1")
        expect(r.asks).not.toContain("o-n2")
        expect(r.prompt).toContain('"o-n2"')
      })
    }
    test("[MUST-FAIL] another root's input-shaped row under an input entry shown whole is shown whole as context is, not cut short", async () => {
      const r = await go({ inputs: ["world_changed", { shape: "outcome", whole: true }], extra: [far("o-whole", 20000)] })
      expect(r.status).toBe(200)
      expect(r.prompt).toContain("TAIL_o-whole")
      expect(r.asks).toEqual(["w1", "o-own"])
    })
    test("[MUST-FAIL] another root's input-shaped row naming the rows it compared pulls them in first, as a context row does", async () => {
      const namedHop = { shape: "hop", id: "h-named", seq: 340, output: { text: "NAMED_HOP " + "n".repeat(6000) } }
      const r = await go({ inputs: byShape, extra: [namedHop, far("o-name", 500, { against_refs: ["h-named"] })], hops: 80 })
      expect(r.status).toBe(200)
      expect(r.prompt).toContain("NAMED_HOP")
      expect(r.row.input_refs).toContain("h-named")
    })
  })

  // A window: a read the owner scopes to "since that shape was last written" (the USER: a retrospective "on this one horizon").
  const sinceRun = async (newest: number | null, down = false) => {
    ;(SCHEMA as any).reads = [{ type: "record_summary", shape: "failure", summarize: ["kind"], after_seq: { "x-since": "retrospective" } }]
    SUMMARY_NEWEST = newest; summaryDown = down
    const before = discovery.seen.length
    const r = await produce(NODE_KEY)
    delete (SCHEMA as any).reads; SUMMARY_NEWEST = null; summaryDown = false
    const calls = discovery.seen.slice(before)
    const reads = calls.map((c) => (c.body as any)?.pointer).filter((p) => p?.type === "record_summary")
    return { status: r.status, body: r.body, reads, llm: calls.some((c) => (c.body as any)?.pointer?.type === "llm_completion") }
  }

  test("[MUST-FAIL] a read pointer value {x-since: shape} is bound to that shape's newest seq, counted without reading a row", async () => {
    const r = await sinceRun(4200)
    expect(r.status).toBe(200)
    expect(r.reads.find((p) => p.shape === "retrospective")).toMatchObject({ shape: "retrospective", summarize: ["shape"] })
    expect(r.reads.find((p) => p.shape === "failure")?.after_seq).toBe(4200)
  })

  test("[MUST-FAIL] with no row of that shape the window starts at 0; a count that fails refuses the produce by name, with no model call", async () => {
    expect((await sinceRun(null)).reads.find((p) => p.shape === "failure")?.after_seq).toBe(0)
    const down = await sinceRun(5, true)
    expect([down.status, JSON.stringify(down.body).includes("after_seq: the newest retrospective could not be counted"), down.llm]).toEqual([502, true, false])
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
    const writes = () => discovery.seen.filter((c) => c.path === "/resolve" && (c.body as any)?.pointer?.type === "record_write").length
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
    const llm = discovery.seen.slice(before).find((c) => (c.body as any)?.pointer?.type === "llm_completion")?.body as any
    expect(llm.pointer.prompt.length).toBeLessThan(40_000)
    expect(llm.pointer.prompt).toContain('"cut":true')
    expect(llm.pointer.prompt).toContain("data a request fetched") // a small row is shown whole
    const w = discovery.seen.slice(before).find((c) => (c.body as any)?.pointer?.type === "record_write")?.body as any
    expect(w.pointer.row.input_refs).toContain("h-big") // still counted as used
  })

  const askWith = async (ids: string[]) => {
    const before = discovery.seen.length
    const r = await fetch(`http://127.0.0.1:${port}/v2/impulses/resolve`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `ApiKey ${NODE_KEY}` },
      body: JSON.stringify({ impulse: { pointer: { type: "answer", shape: "answer", via_ref: "ch1", input_refs: ids, selection_ref: "s-w", call_id: "c" } } }),
    })
    const seen = discovery.seen.slice(before)
    const llm = seen.find((c) => (c.body as any)?.pointer?.type === "llm_completion")?.body as any
    const w = seen.find((c) => (c.body as any)?.pointer?.type === "record_write")?.body as any
    return { status: r.status, prompt: String(llm?.pointer.prompt ?? ""), cited: (w?.pointer.row.input_refs ?? []) as string[] }
  }
  const WHOLE = { shape: "fileContent", whole: true, latest_by: "path", covers: { shape: "hop", on: "call_id" } }

  test("[MUST-FAIL] a context row the owner asks shown whole is shown whole; an older read of the same path, and the call that fetched it, are not", async () => {
    const context = SCHEMA.context
    ;(SCHEMA as any).context = ["hop", WHOLE]
    const path = "/trees/demo-vessel-mwabc123-1a2b3c4d/src/login.ts"
    const rows = [
      { shape: "fileContent", id: "fc-old", seq: 1, path, content: "OLD_TEXT_BEFORE_THE_EDIT", call_id: "c1" },
      { shape: "fileContent", id: "fc-new", seq: 3, path, content: `${"a".repeat(20_000)}TAIL_OF_THE_FILE`, call_id: "c9" },
      { shape: "hop", id: "h-c9", seq: 2, call_id: "c9", output: { content: `${"a".repeat(10_000)}HOP_COPY` } },
    ]
    INPUTS.push(...rows)
    const r = await askWith(["w1", "h1", "fc-old", "fc-new", "h-c9"])
    INPUTS.splice(INPUTS.length - rows.length, rows.length)
    ;(SCHEMA as any).context = context
    expect(r.status).toBe(200)
    expect(r.prompt).toContain("TAIL_OF_THE_FILE") // past 8 KiB: shown whole, not cut
    expect(r.prompt).not.toContain("OLD_TEXT_BEFORE_THE_EDIT") // the newer read of the same path replaces it
    expect(r.prompt).not.toContain("HOP_COPY") // the call that fetched it does not spend the budget again
    expect(r.cited).toContain("fc-new")
    expect(r.cited).not.toContain("fc-old")
    expect(r.cited).not.toContain("h-c9")
    expect(r.cited).toContain("h1") // other context still shown
  })

  test("[MUST-FAIL] an input named as {shape, latest_by} is an input: its newest row is shown whole, the older one not at all", async () => {
    const inputs = SCHEMA.inputs
    ;(SCHEMA as any).inputs = ["world_changed", { shape: "gitDiff", latest_by: "shape" }]
    const rows = [
      { shape: "gitDiff", id: "gd-old", seq: 2, tree: "t-old", diff: "OLD_DIFF_THAT_WAS_SUPERSEDED" },
      { shape: "gitDiff", id: "gd-new", seq: 4, tree: "t-new", diff: `${"x".repeat(20_000)}TAIL_OF_THE_NEW_DIFF` },
    ]
    INPUTS.push(...rows)
    const r = await askWith(["w1", "gd-old", "gd-new"])
    INPUTS.splice(INPUTS.length - rows.length, rows.length)
    ;(SCHEMA as any).inputs = inputs
    expect(r.status).toBe(200)
    expect(r.prompt).toContain("TAIL_OF_THE_NEW_DIFF") // an input: never cut to a context row's size
    expect(r.prompt).not.toContain("OLD_DIFF_THAT_WAS_SUPERSEDED")
    expect(r.cited).toContain("gd-new")
    expect(r.cited).not.toContain("gd-old")
  })

  test("[MUST-FAIL] a value the schema binds to a shown row (x-equals) must be what that row holds", async () => {
    const [inputs, schema, content] = [SCHEMA.inputs, SCHEMA.schema, llmContent]
    ;(SCHEMA as any).inputs = ["world_changed", "gitDiff"]
    ;(SCHEMA as any).schema = {
      type: "object", required: ["text", "ran"],
      properties: { text: { type: "string" }, ran: { type: "boolean", "x-equals": { shape: "gitDiff", path: "typecheck.ran" } } },
    }
    const diff = { shape: "gitDiff", id: "gd-x", seq: 3, typecheck: { ran: false, passed: false, why: "not fast-forward" } }
    INPUTS.push(diff)
    llmContent = JSON.stringify({ text: "typecheck failed", ran: true }) // says a check ran that never did
    const lie = await askWith(["w1", "gd-x"])
    llmContent = JSON.stringify({ text: "typecheck did not run: not fast-forward", ran: false })
    const truth = await askWith(["w1", "gd-x"])
    INPUTS.splice(INPUTS.length - 1, 1)
    ;(SCHEMA as any).inputs = inputs
    ;(SCHEMA as any).schema = schema
    llmContent = content
    expect(lie.status).toBe(422)
    expect(truth.status).toBe(200)
  })

  test("[MUST-FAIL] a grade of 1 on a request with targets must cite a read of the target made after the change, never the change's own reply", async () => {
    // b8277fa0's shape: an ask to put the view back to its default; its change_wanted names the target; a read before the
    // change, the change (whose reply says the view is the default), and a read after it. Which call answers with the
    // view and which changes it are the vessels' declarations (discovery), not names here.
    const [inputs, ctx, schema, content] = [SCHEMA.inputs, (SCHEMA as any).context, SCHEMA.schema, llmContent]
    DECL = { shape_answers: { "human_surface:ui_view": "uiViewState" }, shape_changes: { uiView_write: ["uiViewState"] } }
    const target = { shape: "uiViewState", where: { region: "landing", "view.drawsDefault": true } }
    const rows = [
      { shape: "change_wanted", id: "cw-t", seq: 2, role: "described", wanted: false, targets: [target], input_refs: ["w1"] },
      { shape: "hop", id: "hs-r0", seq: 3, role: "walk", phase: "started", call_id: "r0", pointer_type: "human_surface:ui_view" },
      { shape: "uiViewState", id: "vs-old", seq: 4, role: "walk", call_id: "r0", region: "landing", view: { drawsDefault: true } },
      { shape: "hop", id: "hs-w", seq: 5, role: "walk", phase: "started", call_id: "w", pointer_type: "uiView_write" },
      { shape: "uiViewState", id: "vs-own", seq: 6, role: "walk", call_id: "w", region: "landing", view: { drawsDefault: true } },
      { shape: "failure", id: "f-w", seq: 7, role: "walk", call_id: "w", status: 422 }, // the change failed
      { shape: "hop", id: "hs-r1", seq: 8, role: "walk", phase: "started", call_id: "r1", pointer_type: "human_surface:ui_view" },
      { shape: "uiViewState", id: "vs-new", seq: 9, role: "walk", call_id: "r1", region: "landing", view: { drawsDefault: true } },
      { shape: "uiViewState", id: "vs-other", seq: 10, role: "walk", call_id: "r1", region: "landing", view: { drawsDefault: false } },
      // a producer's own row of the target shape (role described), newer than the change, naming a reading call's id: a
      // model wrote it, so it is no read whatever call it names
      { shape: "uiViewState", id: "vs-model", seq: 11, role: "described", call_id: "r1", region: "landing", view: { drawsDefault: true } },
    ]
    INPUTS.push(...(rows as any))
    ;(SCHEMA as any).inputs = ["world_changed"]
    ;(SCHEMA as any).context = ["hop", { "x-target": { from: "change_wanted", field: "targets" } }]
    ;(SCHEMA as any).schema = {
      type: "object", required: ["r", "evidence_refs"], "x-reach": { from: "change_wanted", field: "targets" },
      properties: { r: { type: "number" }, evidence_refs: { type: "array", items: { type: "string" } } },
    }
    const ids = ["w1", ...rows.map((r) => r.id)]
    const grade = async (r: number, cite: string[]) => { llmContent = JSON.stringify({ r, evidence_refs: cite }); return askWith(ids) }
    const after = await grade(1, ["vs-new"]) // a read after the change, holding the target: reached, the failed change notwithstanding
    const own = await grade(1, ["vs-own"]) // the change's own reply
    // even when the changing call also declares it answers with the shape (its reply reads the state back): still its own
    DECL = { shape_answers: { "human_surface:ui_view": "uiViewState", uiView_write: "uiViewState" }, shape_changes: { uiView_write: ["uiViewState"] } }
    const ownDeclared = await grade(1, ["vs-own"])
    DECL = { shape_answers: { "human_surface:ui_view": "uiViewState" }, shape_changes: { uiView_write: ["uiViewState"] } }
    const before = await grade(1, ["vs-old"]) // a read made before the change
    const unmet = await grade(1, ["vs-other"]) // a read after it that does not hold the target
    const claim = await grade(1, ["hs-w"]) // the change's hop alone
    const modelRow = await grade(1, ["vs-model"]) // a row a producer wrote, not the walk's record of a read
    const zero = await grade(0, [])
    // with no target listed, a grade is held to nothing new (as before)
    ;(rows[0] as any).targets = undefined
    const untargeted = await grade(1, ["hs-w"])
    // a target no call answers with (a person's grade) is met by the row itself
    ;(rows[0] as any).targets = [{ shape: "outcome", where: { role: "person", r: 1 } }]
    INPUTS.push({ shape: "outcome", id: "o-p", seq: 11, role: "person", r: 1 } as any, { shape: "outcome", id: "o-d", seq: 12, role: "described", r: 1 } as any)
    const person = (llmContent = JSON.stringify({ r: 1, evidence_refs: ["o-p"] }), await askWith([...ids, "o-p", "o-d"]))
    const model = (llmContent = JSON.stringify({ r: 1, evidence_refs: ["o-d"] }), await askWith([...ids, "o-p", "o-d"]))
    INPUTS.splice(INPUTS.length - rows.length - 2, rows.length + 2)
    ;(SCHEMA as any).inputs = inputs
    ;(SCHEMA as any).context = ctx
    ;(SCHEMA as any).schema = schema
    llmContent = content
    DECL = {}
    expect(after.status).toBe(200)
    expect(after.prompt).toContain("vs-new") // the target rows are shown (x-target), the unmet one too
    expect(after.prompt).toContain("vs-other")
    expect([own.status, ownDeclared.status, before.status, unmet.status, claim.status, modelRow.status]).toEqual([422, 422, 422, 422, 422, 422])
    expect(zero.status).toBe(200)
    expect(untargeted.status).toBe(200)
    expect([person.status, model.status]).toEqual([200, 422])
  })

  test("[MUST-FAIL] targets are held to the producing schema when made: too many or malformed refused, an accepted row is what the judge reads", async () => {
    // The owner's schema says what a target is and how many (items, maxItems): a row breaking it is refused (422, the
    // producer told why), so the targets a person is shown are exactly those a grade is held to (check.ts targetsOf).
    const { targetsOf } = await import("../src/check")
    const [schema, content] = [SCHEMA.schema, llmContent]
    ;(SCHEMA as any).schema = { type: "object", required: ["targets"], properties: { targets: { type: "array", minItems: 1, maxItems: 3,
      items: { type: "object", required: ["shape"], additionalProperties: false, properties: { shape: { type: "string" }, where: { type: "object" } } } } } }
    const make = async (targets: unknown) => {
      llmContent = JSON.stringify({ targets })
      const before = discovery.seen.length
      const r = await askWith(["w1"])
      const row = (discovery.seen.slice(before).find((c) => (c.body as any)?.pointer?.type === "record_write")?.body as any)?.pointer.row
      return { status: r.status, row }
    }
    const four = await make([1, 2, 3, 4].map((n) => ({ shape: `s${n}` })))
    const listWhere = await make([{ shape: "s", where: ["region"] }])
    const ok = await make([{ shape: "uiViewState", where: { region: "landing", "view.drawsDefault": true } }])
    ;(SCHEMA as any).schema = schema
    llmContent = content
    expect([four.status, listWhere.status]).toEqual([422, 422])
    expect([four.row, listWhere.row]).toEqual([undefined, undefined])
    expect(ok.status).toBe(200)
    expect(targetsOf({ from: "answer", field: "targets" }, [{ ...ok.row, shape: "answer", seq: 1 }])).toEqual(ok.row.targets)
  })

  test("[MUST-FAIL] a target the schema would refuse, on a row from before it, holds no grade of 1: refused by name; a 0 is taken", async () => {
    const [inputs, ctx, schema, content] = [SCHEMA.inputs, (SCHEMA as any).context, SCHEMA.schema, llmContent]
    ;(SCHEMA as any).inputs = ["world_changed"]
    ;(SCHEMA as any).context = [{ "x-target": { from: "change_wanted", field: "targets" } }]
    ;(SCHEMA as any).schema = { type: "object", required: ["r"], "x-reach": { from: "change_wanted", field: "targets" },
      properties: { r: { type: "number" }, evidence_refs: { type: "array", items: { type: "string" } } } }
    const grade = async (target: unknown, r: number) => {
      const rows = [
        { shape: "change_wanted", id: "cw-old", seq: 2, role: "described", targets: [target], input_refs: ["w1"] },
        { shape: "uiViewState", id: "vs-old2", seq: 3, role: "walk", call_id: "r", region: "landing" },
      ]
      INPUTS.push(...(rows as any))
      llmContent = JSON.stringify({ r, evidence_refs: ["vs-old2"] })
      const res = await fetch(`http://127.0.0.1:${port}/v2/impulses/resolve`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `ApiKey ${NODE_KEY}` },
        body: JSON.stringify({ impulse: { pointer: { type: "answer", shape: "answer", via_ref: "ch1", input_refs: ["w1", "cw-old", "vs-old2"], selection_ref: "s-w", call_id: "c" } } }),
      })
      INPUTS.splice(INPUTS.length - rows.length, rows.length)
      return { status: res.status, said: String(((await res.json()) as any)?.failure?.body ?? "") }
    }
    const cases: Array<[unknown, string]> = [
      [{ shape: "uiViewState", where: ["region"] }, "target 0's where is not a map of fields to values"],
      [{ where: { region: "landing" } }, "target 0 names no shape"],
      [{ shape: "uiViewState", where: "region" }, "target 0's where is not a map of fields to values"],
      [{ shape: "uiViewState", where: null }, "target 0's where is not a map of fields to values"],
    ]
    const ones = []
    for (const [target] of cases) ones.push(await grade(target, 1))
    const zero = await grade({ where: null }, 0) // a grade of 0 is held to nothing: taken whatever the targets
    ;(SCHEMA as any).inputs = inputs
    ;(SCHEMA as any).context = ctx
    ;(SCHEMA as any).schema = schema
    llmContent = content
    cases.forEach(([, why], i) => {
      expect(ones[i].status).toBe(422)
      expect(ones[i].said).toContain(`change_wanted row cw-old: ${why}`)
    })
    expect(zero.status).toBe(200)
  })

  test("[MUST-FAIL] when the declarations cannot be read, a grade held to reach fails as the read's outage: no refusal, no row", async () => {
    // A discovery that cannot answer is not the model's wrong answer: reported as a schema refusal it would debit the
    // producer and tell it asking again is refused the same way (deployment). The grade fails with the read's status.
    const [inputs, ctx, schema, content] = [SCHEMA.inputs, (SCHEMA as any).context, SCHEMA.schema, llmContent]
    const rows = [
      { shape: "change_wanted", id: "cw-down", seq: 2, role: "described", targets: [{ shape: "uiViewState" }], input_refs: ["w1"] },
      { shape: "uiViewState", id: "vs-down", seq: 3, role: "walk", call_id: "r", region: "landing" },
    ]
    INPUTS.push(...(rows as any))
    ;(SCHEMA as any).inputs = ["world_changed"]
    ;(SCHEMA as any).context = [{ "x-target": { from: "change_wanted", field: "targets" } }]
    ;(SCHEMA as any).schema = { type: "object", required: ["r"], "x-reach": { from: "change_wanted", field: "targets" },
      properties: { r: { type: "number" }, evidence_refs: { type: "array", items: { type: "string" } } } }
    llmContent = JSON.stringify({ r: 1, evidence_refs: ["vs-down"] })
    readsDown = true
    const before = discovery.seen.length
    const r = await fetch(`http://127.0.0.1:${port}/v2/impulses/resolve`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `ApiKey ${NODE_KEY}` },
      body: JSON.stringify({ impulse: { pointer: { type: "answer", shape: "answer", via_ref: "ch1", input_refs: ["w1", "cw-down", "vs-down"], selection_ref: "s-w", call_id: "c" } } }),
    })
    const body = (await r.json()) as any
    const wrote = discovery.seen.slice(before).some((c) => (c.body as any)?.pointer?.type === "record_write")
    readsDown = false
    INPUTS.splice(INPUTS.length - rows.length, rows.length)
    ;(SCHEMA as any).inputs = inputs
    ;(SCHEMA as any).context = ctx
    ;(SCHEMA as any).schema = schema
    llmContent = content
    expect(r.status).toBe(503)
    expect(body?.failure?.refused).toBeUndefined()
    expect(wrote).toBe(false)
  })

  test("[MUST-FAIL] every row written carries the request it was made for (root: the selection's), never a root the model wrote", async () => {
    const content = llmContent
    INPUTS.push({ shape: "selection", id: "s-root", seq: 1, role: "walk", root: "w1" } as any)
    const write = async (said: Record<string, unknown>) => {
      llmContent = JSON.stringify(said)
      const before = discovery.seen.length
      await fetch(`http://127.0.0.1:${port}/v2/impulses/resolve`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `ApiKey ${NODE_KEY}` },
        body: JSON.stringify({ impulse: { pointer: { type: "answer", shape: "answer", via_ref: "ch1", input_refs: ["w1", "h1"], selection_ref: "s-root", call_id: "c" } } }),
      })
      return (discovery.seen.slice(before).find((c) => (c.body as any)?.pointer?.type === "record_write")?.body as any)?.pointer.row
    }
    const plain = await write({ text: "t" })
    const forged = await write({ text: "t", root: "w-other" })
    ;(INPUTS[INPUTS.length - 1] as any).root = undefined // a selection naming no root: the model's root is still dropped
    const errAt = vesselErr.length
    const rootless = await write({ text: "t", root: "w-other" })
    await Bun.sleep(50) // the journal is read from the vessel's stderr as it comes
    const said = vesselErr.slice(errAt)
    INPUTS.splice(INPUTS.length - 1, 1)
    llmContent = content
    expect(plain?.root).toBe("w1")
    expect(forged?.root).toBe("w1")
    expect(rootless !== undefined && "root" in rootless).toBe(false)
    expect(said).toContain("the selection names no root or could not be read; this answer row is written without one")
  })

  test("[MUST-FAIL] a value the schema says is one of what shown rows hold (x-in) must be one of them; read through an owner-marked read", async () => {
    const [schema, content] = [SCHEMA.schema, llmContent]
    ;(SCHEMA as any).schema = {
      type: "object", required: ["text", "class"],
      properties: { text: { type: "string" }, class: { type: ["string", "null"], "x-in": { shape: "cause_class", path: "name" } } },
    }
    const causes = [{ shape: "cause_class", id: "cc1", seq: 1, role: "owner", name: "not_shown" }, { shape: "cause_class", id: "cc2", seq: 2, role: "detector", name: "stale_base" }]
    INPUTS.push(...(causes as any))
    const run = async (cls: string | null, shown: boolean) => {
      ;(SCHEMA as any).reads = [{ type: "record_read", ids: ["cc1", "cc2"], ...(shown ? { shown: true } : {}) }]
      llmContent = JSON.stringify({ text: "t", class: cls })
      return (await produce(NODE_KEY)).status
    }
    const listed = await run("stale_base", true)
    const unlisted = await run("made_up", true)
    const none = await run(null, true)
    const unmarked = await run("not_shown", false) // the same rows, read without the owner's mark: not shown, nothing allowed
    // a cause_class row anyone wrote, GIVEN as an input: it does not widen the list (only the owner's marked reads do)
    INPUTS.push({ shape: "cause_class", id: "cc-given", seq: 3, role: "described", name: "invented_here" } as any)
    ;(SCHEMA as any).reads = [{ type: "record_read", ids: ["cc1", "cc2"], shown: true }]
    const ctx = (SCHEMA as any).context
    ;(SCHEMA as any).context = ["hop", "cause_class"] // the producer is shown the given row, so it is among the rows seen
    llmContent = JSON.stringify({ text: "t", class: "invented_here" })
    const given = (await produce(NODE_KEY, { input_refs: ["w1", "cc-given"] })).status
    ;(SCHEMA as any).context = ctx
    INPUTS.splice(INPUTS.length - 1, 1)
    // a cause_class row anyone wrote, answered by a read WITHOUT the owner's mark and citing this request's input (so it
    // is among the rows the reads showed): it does not widen the list either (qa)
    INPUTS.push({ shape: "cause_class", id: "cc-read", seq: 4, role: "described", name: "from_unmarked_read", input_refs: ["w1"] } as any)
    ;(SCHEMA as any).reads = [{ type: "record_read", ids: ["cc1", "cc2"], shown: true }, { type: "record_read", ids: ["cc-read"] }]
    llmContent = JSON.stringify({ text: "t", class: "from_unmarked_read" })
    const readUnmarked = (await produce(NODE_KEY)).status
    INPUTS.splice(INPUTS.length - 1, 1)
    INPUTS.splice(INPUTS.length - causes.length, causes.length)
    delete (SCHEMA as any).reads
    ;(SCHEMA as any).schema = schema
    llmContent = content
    expect([listed, unlisted, none, unmarked, given, readUnmarked]).toEqual([200, 422, 200, 422, 422, 422])
  })

  test("[MUST-FAIL] an input bound to the clone's newest tree (x-latest) is a diff of that tree only: never an older one, never a model's row", async () => {
    const inputs = SCHEMA.inputs
    const XL = { "x-latest": { shapes: ["gitCommitResult", "gitWorktree", "gitDiff"], moves: ["gitCommitResult", "gitWorktree"], same: "cwd", field: "tree" } }
    // the owner's entry: a diff a tool recorded (role walk), of the clone's newest tree
    ;(SCHEMA as any).inputs = ["world_changed", { shape: "gitDiff", latest_by: "shape", where: { tree: XL, role: "walk" } }]
    const tool = (id: string, seq: number, shape: string, tree?: string, extra: Record<string, unknown> = {}) =>
      ({ shape, id, seq, role: "walk", call_id: `c-${id}`, cwd: "/c", ...(tree ? { tree } : {}), input_refs: ["w1"], ...extra })
    const rows = [
      { shape: "selection", id: "s-w", seq: 9, role: "walk", root: "w1" }, // the selection names the root whose clone it is
      tool("wt", 10, "gitWorktree"),
      tool("k1", 11, "gitCommitResult", "TREE_ONE"),
      tool("dA", 12, "gitDiff", "TREE_ONE", { diff: "DIFF_OF_ONE" }),
      tool("k2", 13, "gitCommitResult", "TREE_TWO"),
      tool("dB", 14, "gitDiff", "TREE_TWO", { diff: "DIFF_OF_TWO" }),
      tool("k3", 15, "gitCommitResult", "TREE_THREE"),
      { shape: "gitDiff", id: "dM", seq: 16, role: "described", cwd: "/c", tree: "TREE_THREE", diff: "DIFF_BY_A_MODEL" },
      { shape: "gitCommitResult", id: "kM", seq: 17, role: "described", cwd: "/c", tree: "TREE_NINE" }, // a model's row naming a tree
      tool("wt2", 18, "gitWorktree"), // a move that does not say its tree
      tool("dX", 19, "gitDiff", "TREE_X", { cwd: "/x", diff: "DIFF_OF_ANOTHER_CLONE" }), // another clone's newer diff
      tool("dT", 20, "gitDiff", undefined, { diff: "DIFF_WITH_NO_TREE" }), // a diff that names no tree
      // another request's clone, newer, among the rows given: never this request's
      tool("wtY", 21, "gitWorktree", undefined, { cwd: "/y", input_refs: ["another-root"] }),
      tool("kY", 22, "gitCommitResult", "TREE_Y", { cwd: "/y", input_refs: ["another-root"] }),
      { shape: "gitWorktree", id: "wtZ", seq: 23, role: "described", cwd: "/z", input_refs: ["w1"] }, // a model's clone row
    ]
    INPUTS.push(...(rows as any))
    const at = async (ids: string[]) => (await askWith(["w1", ...ids])).prompt
    const newest = await at(["wt", "k1", "dA", "k2", "dB"]) // the clone is at TREE_TWO: its diff is the input
    const moved = await at(["wt", "k1", "dA", "k2", "dB", "k3", "dM"]) // a commit since: no diff of TREE_THREE by a tool (a model's names it)
    const modelRow = await at(["wt", "k1", "dA", "k2", "dB", "kM"]) // a model's newer tree moves nothing: still TREE_TWO
    const unknown = await at(["wt", "k1", "dA", "k2", "dB", "wt2"]) // the clone moved without its tree: no diff is of it
    const other = await at(["wt", "k1", "dA", "k2", "dB", "dX"]) // another clone's newer diff: still TREE_TWO's
    const treeless = await at(["wt", "k1", "dA", "k2", "dB", "wt2", "dT"]) // unknown meets nothing, a tree-less diff included
    const twoClones = await at(["wt", "k1", "dA", "k2", "dB", "wtY", "kY"]) // the root's clone, not the newest clone given
    const modelClone = await at(["wt", "k1", "dA", "k2", "dB", "wtZ"]) // a model's row never sets the clone
    INPUTS.splice(INPUTS.length - rows.length, rows.length)
    ;(SCHEMA as any).inputs = inputs
    expect([newest.includes("DIFF_OF_TWO"), newest.includes("DIFF_OF_ONE")]).toEqual([true, false])
    expect([moved.includes("DIFF_OF_TWO"), moved.includes("DIFF_BY_A_MODEL"), moved.includes("DIFF_OF_ONE")]).toEqual([false, false, false])
    expect([modelRow.includes("DIFF_OF_TWO"), unknown.includes("DIFF_OF_TWO")]).toEqual([true, false])
    expect([other.includes("DIFF_OF_TWO"), other.includes("DIFF_OF_ANOTHER_CLONE"), treeless.includes("DIFF_WITH_NO_TREE")]).toEqual([true, false, false])
    expect([twoClones.includes("DIFF_OF_TWO"), modelClone.includes("DIFF_OF_TWO")]).toEqual([true, true])
  })

  test("[MUST-FAIL] a gap opened again takes the clone of the gap it continues (same gap_id), never another gap's newer clone", async () => {
    const inputs = SCHEMA.inputs
    const XL = { "x-latest": { shapes: ["gitCommitResult", "gitWorktree", "gitDiff"], moves: ["gitCommitResult", "gitWorktree"], same: "cwd", field: "tree", continues: "gap_id" } }
    ;(SCHEMA as any).inputs = ["world_changed", { shape: "gitDiff", latest_by: "shape", where: { tree: XL, role: "walk" } }]
    const tool = (id: string, seq: number, shape: string, cwd: string, cites: string, extra: Record<string, unknown> = {}) =>
      ({ shape, id, seq, role: "walk", call_id: `c-${id}`, cwd, input_refs: [cites], ...extra })
    const rows = [
      { shape: "gap", id: "gA", seq: 30, role: "detector", gap_id: "the-gap", input_refs: [] },
      { shape: "gap", id: "gD", seq: 31, role: "detector", gap_id: "another-gap", input_refs: [] },
      { shape: "gap", id: "gR", seq: 40, role: "detector", gap_id: "the-gap", input_refs: [] }, // opened again: no clone of its own
      tool("wtA", 32, "gitWorktree", "/a", "gA"),
      tool("kA", 33, "gitCommitResult", "/a", "gA", { tree: "TREE_A" }),
      tool("dA2", 34, "gitDiff", "/a", "gA", { tree: "TREE_A", diff: "DIFF_OF_THE_GAP" }),
      tool("wtD", 35, "gitWorktree", "/d", "gD"), // another gap's clone, newer
      { shape: "selection", id: "s-w", seq: 41, role: "walk", root: "gR" },
    ]
    INPUTS.push(...(rows as any))
    const r = await askWith(["w1", ...rows.map((x) => x.id)])
    INPUTS.splice(INPUTS.length - rows.length, rows.length)
    ;(SCHEMA as any).inputs = inputs
    expect(r.prompt.includes("DIFF_OF_THE_GAP")).toBe(true)
  })

  test("[MUST-FAIL] a whole row the context budget cannot hold is left out and counted, never cut to fit", async () => {
    const context = SCHEMA.context
    ;(SCHEMA as any).context = ["hop", { shape: "fileContent", whole: true, latest_by: "path" }]
    const rows = [
      { shape: "fileContent", id: "fc-a", seq: 5, path: "/a.ts", content: `${"b".repeat(90_000)}A_END` },
      { shape: "fileContent", id: "fc-b", seq: 4, path: "/b.ts", content: `${"c".repeat(90_000)}B_END` },
      { shape: "fileContent", id: "fc-c", seq: 3, path: "/c.ts", content: `${"d".repeat(90_000)}C_END` },
    ]
    INPUTS.push(...rows)
    const r = await askWith(["w1", "fc-a", "fc-b", "fc-c"])
    INPUTS.splice(INPUTS.length - rows.length, rows.length)
    ;(SCHEMA as any).context = context
    expect(r.status).toBe(200)
    expect(r.prompt).toContain("A_END")
    expect(r.prompt).toContain("B_END")
    expect(r.prompt).not.toContain("C_END") // the budget is spent: left out whole
    expect(r.prompt).not.toContain('"cut":true') // nothing cut to fit
    expect(r.prompt).toContain("older context rows are not shown")
    expect(r.cited).not.toContain("fc-c")
    // and named, with the field its entry keeps the newest of, so the producer knows a read of /c.ts exists unseen
    const named = (JSON.parse(r.prompt) as { not_shown_whole?: Array<Record<string, unknown>> }).not_shown_whole ?? []
    expect(named.map((x) => [x.shape, x.id, x.path])).toEqual([["fileContent", "fc-c", "/c.ts"]])
  })

  // The owner seed's request entries: the clone kept, then the clone's newest diff, whole, kept and covering its own hop.
  const XLT = { "x-latest": { shapes: ["gitCommitResult", "gitWorktree", "gitDiff"], moves: ["gitCommitResult", "gitWorktree"], same: "cwd", field: "tree" } }
  const keptRun = async (context: unknown[], rows: Array<Record<string, unknown>>) => {
    const saved = SCHEMA.context
    ;(SCHEMA as any).context = context
    ;(SCHEMA as any).keep_share = 0.25
    INPUTS.push(...(rows as any))
    try {
      const r = await askWith(["w1", ...rows.map((x) => String(x.id))])
      const named = ((JSON.parse(r.prompt) as { not_shown_whole?: Array<Record<string, unknown>> }).not_shown_whole ?? []).map((x) => x.id)
      return { ...r, named }
    } finally {
      INPUTS.splice(INPUTS.length - rows.length, rows.length)
      ;(SCHEMA as any).context = saved
      delete (SCHEMA as any).keep_share
    }
  }
  const newerHops = Array.from({ length: 80 }, (_, i) => ({ shape: "hop", id: `hk${i}`, seq: 100 + i, output: { text: `kstep-${i}. ` + "x".repeat(3000) } }))

  test("[MUST-FAIL] kept rows are fitted in the order the owner lists their entries: a large diff never pushes out the clone listed before it", async () => {
    const context = ["hop", "failure", { shape: "gitWorktree", latest_by: "repo", keep: true },
      { shape: "gitDiff", latest_by: "shape", where: { tree: XLT, role: "walk" }, whole: true, keep: true, covers: { shape: "hop", on: "call_id" } }]
    const base = [
      { shape: "selection", id: "s-w", seq: 9, role: "walk", root: "w1" }, // the produce's own selection names the request
      { shape: "gitWorktree", id: "gw-own", seq: 50, role: "walk", call_id: "c-w", repo: "hsv", cwd: "/trees/OWN_CLONE", tree: "TREE_K", input_refs: ["w1"], note: "c".repeat(1000) },
    ]
    const diffOf = (bytes: number) => ({ shape: "gitDiff", id: "gd-own", seq: 60, role: "walk", call_id: "c-d", cwd: "/trees/OWN_CLONE", tree: "TREE_K",
      input_refs: ["w1"], diff: "d".repeat(bytes), check: { passed: false, out: "CHECK_SAID_WHY" } })
    // a diff that fits the keep share alone but not beside the clone (the share is a quarter of the context budget):
    // listed after the clone, it is the one left out, and named, since its entry shows it whole; never the clone
    const tight = await keptRun(context, [...base, diffOf(48_500), ...newerHops])
    expect(tight.status).toBe(200)
    expect(tight.prompt).toContain("OWN_CLONE")
    expect(tight.prompt.includes("CHECK_SAID_WHY") || tight.named.includes("gd-own")).toBe(true)
    expect(tight.prompt).not.toContain('"cut":true')
    expect(tight.named).toContain("gd-own")
    // a diff that fits beside the clone: both are shown, the diff whole with what its check said
    const fits = await keptRun(context, [...base, diffOf(40_000), ...newerHops])
    expect(fits.prompt).toContain("OWN_CLONE")
    expect(fits.prompt).toContain("CHECK_SAID_WHY")
  })

  test("[GUARD] with one kept entry, its rows are fitted newest first, as before", async () => {
    // a schema with a single kept entry (the outcome grader's request_acts) fits exactly what it did before the order:
    // the newest rows of the entry while they fit, the oldest left to the budget, which the newer hops have spent
    const acts = Array.from({ length: 8 }, (_, i) => ({ shape: "request_acts", id: `ra${i}`, seq: 40 + i, role: "walk", input_refs: ["w1"], note: `ACTS_${i} ` + "a".repeat(9000) }))
    const r = await keptRun(["hop", { shape: "request_acts", where: {}, keep: true }], [...acts, ...newerHops])
    expect(r.status).toBe(200)
    expect([7, 6, 5].map((i) => r.prompt.includes(`ACTS_${i} `))).toEqual([true, true, true])
    expect([0, 1].map((i) => r.prompt.includes(`ACTS_${i} `))).toEqual([false, false])
  })

  test("[GUARD] the answer schema's kept entries, in their order, still show the newest skip", async () => {
    // request_acts (newest only) is listed before the walk's skip failures (newest per request): fitted first, it takes
    // one row of the share, and the skips that follow are fitted newest first in what remains
    const acts = { shape: "request_acts", id: "ra-n", seq: 45, role: "walk", input_refs: ["w1"], note: "ACTS_NEWEST " + "a".repeat(6000) }
    const skips = Array.from({ length: 30 }, (_, i) => ({ shape: "failure", id: `fs${i}`, seq: 50 + i, role: "walk", kind: "skip",
      request_ref: `rq${i}`, input_refs: ["w1"], body: `SKIP_${i} ` + "s".repeat(2000) }))
    const r = await keptRun(["hop", { shape: "request_acts", latest_by: "shape", keep: true },
      { shape: "failure", where: { kind: "skip" }, latest_by: "request_ref", keep: true }], [acts, ...skips, ...newerHops])
    expect(r.status).toBe(200)
    expect(r.prompt).toContain("ACTS_NEWEST")
    expect(r.prompt).toContain("SKIP_29 ")
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
    expect(discovery.seen.slice(before).some((c) => (c.body as any)?.pointer?.type === "llm_completion")).toBe(false)
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

  test("[MUST-FAIL] a model call that never reached a producer says so on the failure (unserved), as a field", async () => {
    llmUnrouted = true
    const routed = await produce(NODE_KEY)
    llmUnrouted = false
    expect(routed.status).toBe(404)
    expect(routed.body.failure).toMatchObject({ status: 404, unserved: "llm_completion" })
    llmFailure = { resolved: false, shape: "llmCompletion", unserved: "llm_completion", requested_model: "model-asked", error: "cooling" }
    const cooled = await produce(NODE_KEY)
    llmFailure = { resolved: false, error: "provider refused the request" }
    const refused = await produce(NODE_KEY)
    llmFailure = null
    expect(cooled.status).toBe(502)
    expect(cooled.body.failure).toMatchObject({ status: 502, unserved: "llm_completion" })
    // the same refusal forwarded from a peer comes back in a content envelope: read there too
    llmFailure = { content: { resolved: false, unserved: "llm_completion", error: "cooling" }, metadata: {} }
    const forwarded = await produce(NODE_KEY)
    llmFailure = null // later tests call the model: never leave a failure set
    expect(forwarded.body.failure).toMatchObject({ status: 502, unserved: "llm_completion" })
    // a resolver that was reached and failed is not unserved
    expect(refused.status).toBe(502)
    expect(refused.body.failure.unserved).toBeUndefined()
  })

  // d929 (qa, database): request_acts is one row per act, each restating every act so far. Kept without latest_by, 76 of
  // them filled the keep share before the request's clone and commit rows could fit, and the producer asked for a new
  // clone. The seed's entries (walk-owner-seed.ts, request schema): only the newest request_acts row is kept.
  const actsRun = async (actsEntry: Record<string, unknown>) => {
    const ctx = (SCHEMA as any).context
    ;(SCHEMA as any).context = ["hop", { shape: "gitWorktree", latest_by: "repo", keep: true },
      { shape: "gitCommitResult", latest_by: "shape", keep: true }, actsEntry]
    ;(SCHEMA as any).keep_share = 0.25
    const clone = { shape: "gitWorktree", id: "gw-d", seq: 10, repo: "hsv", cwd: "/trees/D929_CLONE", input_refs: ["w1"] }
    const commit = { shape: "gitCommitResult", id: "gc-d", seq: 11, sha: "COMMIT_2C73FC3", tree: "t1", input_refs: ["w1"] }
    const acts = Array.from({ length: 76 }, (_, i) => ({ shape: "request_acts", id: `ra${i}`, seq: 20 + i, input_refs: ["w1"],
      acts: Array.from({ length: i + 1 }, (_, j) => `act-${j} ` + "a".repeat(90)) }))
    const rows = [clone, commit, ...acts]
    INPUTS.push(...(rows as any))
    const before = discovery.seen.length
    const r = await produce(NODE_KEY, { input_refs: ["w1", ...rows.map((x) => x.id)] })
    INPUTS.splice(INPUTS.length - rows.length, rows.length)
    ;(SCHEMA as any).context = ctx
    delete (SCHEMA as any).keep_share
    const calls = discovery.seen.slice(before)
    return { status: r.status, prompt: String((calls.find((c) => (c.body as any)?.pointer?.type === "llm_completion")?.body as any)?.pointer?.prompt ?? "") }
  }

  test("[MUST-FAIL] with request_acts kept newest-only (the seed's entry), the request's clone and commit are shown past 76 growing acts rows", async () => {
    const r = await actsRun({ shape: "request_acts", latest_by: "shape", keep: true })
    expect(r.status).toBe(200)
    expect(r.prompt).toContain("/trees/D929_CLONE")
    expect(r.prompt).toContain("COMMIT_2C73FC3")
    expect(r.prompt).toContain("act-75 ") // the newest acts row is still shown
  })

  test("[GUARD] request_acts kept without latest_by (the parent seed's entry) no longer leaves out the clone listed before it", async () => {
    // on d929, 76 growing acts rows, fitted newest first across every kept entry, filled the keep share before the clone
    // and commit; fitted in the order the owner lists the entries, the clone and commit, listed first, are fitted first
    const r = await actsRun({ shape: "request_acts", keep: true })
    expect(r.prompt).toContain("/trees/D929_CLONE")
    expect(r.prompt).toContain("COMMIT_2C73FC3")
  })

  test("[MUST-FAIL] a file read whole is shown whole in place of its cut hop (the seed's answer entry)", async () => {
    const ctx = (SCHEMA as any).context
    ;(SCHEMA as any).context = [{ shape: "hop", join: { on: "call_id", take: ["pointer_type"] } },
      { shape: "fileContent", whole: true, latest_by: "path", covers: { shape: "hop", on: "call_id" } }]
    const body = "BEGIN_OF_FILE " + "r".repeat(43_000) + " END_OF_FILE"
    const hop = { shape: "hop", id: "h-read", seq: 30, call_id: "c-read", phase: "ended", output: { cut: true, bytes: 43_100, start: body.slice(0, 16_000) } }
    const file = { shape: "fileContent", id: "fc-read", seq: 31, call_id: "c-read", path: "ui/src/Reports.tsx", content: body, input_refs: ["w1"] }
    INPUTS.push(hop as any, file as any)
    const before = discovery.seen.length
    await produce(NODE_KEY, { input_refs: ["w1", "h-read", "fc-read"] })
    INPUTS.splice(INPUTS.length - 2, 2)
    ;(SCHEMA as any).context = ctx
    const calls = discovery.seen.slice(before)
    const prompt = String((calls.find((c) => (c.body as any)?.pointer?.type === "llm_completion")?.body as any)?.pointer?.prompt ?? "")
    expect(prompt).toContain("END_OF_FILE")
    const row = (calls.find((c) => (c.body as any)?.pointer?.type === "record_write")?.body as any)?.pointer?.row
    expect(row.input_refs).toContain("fc-read")
    expect(row.input_refs).not.toContain("h-read")
  })
})

describe("an entry by relation: the answer of a tool call this request's root made", () => {
  // the request's own selection names root w1; B is this root, A another, N a selection with no root
  const rows = [
    { shape: "selection", id: "sel-1", root: "w1" },
    { shape: "selection", id: "sB", root: "w1" },
    { shape: "selection", id: "sA", root: "wA", input_refs: ["w1"] }, // A's selection cites this root's ask
    { shape: "selection", id: "sN" },
    { shape: "hop", id: "hB", role: "walk", phase: "started", kind: "call", call_id: "kB", selection_ref: "sB", pointer_type: "bounded_shell" },
    { shape: "hop", id: "hB2", role: "walk", phase: "started", kind: "call", call_id: "kB2", selection_ref: "sB", pointer_type: "fs_edit" },
    { shape: "hop", id: "hR", role: "walk", phase: "started", kind: "run", call_id: "kR", selection_ref: "sB", pointer_type: "code_search" },
    { shape: "hop", id: "hA", role: "walk", phase: "started", kind: "call", call_id: "kA", selection_ref: "sA", pointer_type: "bounded_shell" },
    { shape: "hop", id: "hN", role: "walk", phase: "started", kind: "call", call_id: "kN", selection_ref: "sN", pointer_type: "bounded_shell" },
    { shape: "hop", id: "hP", role: "walk", phase: "started", kind: "produce", call_id: "kP", selection_ref: "sB", pointer_type: "request" },
    { shape: "hop", id: "hBe", role: "walk", phase: "ended", kind: "call", call_id: "kB", selection_ref: "sB", output: { text: "the ended hop of kB" } },
    { shape: "boundedShellResult", id: "aB", role: "walk", call_id: "kB", selection_ref: "sB", stdout: "grep found it in B" },
    { shape: "failure", id: "fB", role: "walk", call_id: "kB2", selection_ref: "sB", status: 200, body: "old_string not found in B" },
    { shape: "codeSearchResult", id: "aR", role: "walk", call_id: "kR", selection_ref: "sB", matches: "a template run's answer in B" },
    { shape: "boundedShellResult", id: "aA", role: "walk", call_id: "kA", selection_ref: "sA", stdout: "an answer of root A" },
    { shape: "boundedShellResult", id: "aN", role: "walk", call_id: "kN", selection_ref: "sN", stdout: "an answer of no root" },
    { shape: "request", id: "dP", role: "described", call_id: "kP", selection_ref: "sB", text: "a draft the producer wrote" },
  ]
  const ids = ["w1", ...rows.filter((r) => r.id !== "sel-1").map((r) => r.id)]
  const promptFor = async (context: unknown[]) => {
    INPUTS.push(...(rows as any[]))
    const keep = SCHEMA.context
    ;(SCHEMA as any).context = context
    const before = discovery.seen.length
    const r = await produce(NODE_KEY, { input_refs: ids })
    ;(SCHEMA as any).context = keep
    INPUTS.splice(INPUTS.length - rows.length, rows.length)
    const calls = discovery.seen.slice(before)
    const prompt = String((calls.find((c) => (c.body as any)?.pointer?.type === "llm_completion")?.body as any)?.pointer?.prompt ?? "")
    return { status: r.status, prompt }
  }

  test("[MUST-FAIL] this root's tool-call answers are admitted, success, failure and a template run's alike (d)", async () => {
    const { status, prompt } = await promptFor([{ answers_a_call: true, latest_by: "call_id" }])
    expect(status).toBe(200)
    expect(prompt).toContain("grep found it in B")
    expect(prompt).toContain("old_string not found in B")
    expect(prompt).toContain("a template run's answer in B")
  })
  test("[MUST-FAIL] a hop is never a call's answer, though it carries the call's call_id (d)", async () => {
    // no latest_by here: with it, the ended hop and the answer of kB share a key and one drops the other either way
    const { prompt } = await promptFor([{ answers_a_call: true }])
    expect(prompt).toContain("grep found it in B")
    expect(prompt).not.toContain("the ended hop of kB")
  })
  // (a)-(c) are guards: before a relational entry existed one admitted nothing, so they hold there too; what they
  // pin is that the relation admits no more than this root's tool-call answers.
  test("another root's call is not admitted, though its selection cites this root's ask (a, a guard)", async () => {
    const { prompt } = await promptFor([{ answers_a_call: true, latest_by: "call_id" }])
    expect(prompt).not.toContain("an answer of root A")
  })
  test("a call whose selection names no root admits nothing (b, fails closed; a guard)", async () => {
    const { prompt } = await promptFor([{ answers_a_call: true, latest_by: "call_id" }])
    expect(prompt).not.toContain("an answer of no root")
  })
  test("a producer's row carrying its produce's call_id is not a call's answer (c, a guard)", async () => {
    const { prompt } = await promptFor([{ answers_a_call: true, latest_by: "call_id" }])
    expect(prompt).not.toContain("a draft the producer wrote")
  })
  test("[MUST-FAIL] an answer a named entry also matches follows the named entry's rules, listed first; the others keep the relation's (e)", async () => {
    // two reads of one path by two calls: the named entry keeps the newest per path; by relation both would show
    const reads = [
      { shape: "hop", id: "hF1", role: "walk", phase: "started", kind: "call", call_id: "kF1", selection_ref: "sB", pointer_type: "fs_read" },
      { shape: "hop", id: "hF2", role: "walk", phase: "started", kind: "call", call_id: "kF2", selection_ref: "sB", pointer_type: "fs_read" },
      { shape: "fileContent", id: "c1", seq: 1, role: "walk", call_id: "kF1", selection_ref: "sB", path: "src/a.ts", content: "the older read v1" },
      { shape: "fileContent", id: "c2", seq: 2, role: "walk", call_id: "kF2", selection_ref: "sB", path: "src/a.ts", content: "the newer read v2" },
    ]
    rows.push(...(reads as any[])); ids.push(...reads.map((r) => r.id))
    const { prompt } = await promptFor([{ shape: "fileContent", latest_by: "path" }, { answers_a_call: true, latest_by: "call_id" }])
    rows.splice(rows.length - reads.length, reads.length); ids.splice(ids.length - reads.length, reads.length)
    expect(prompt).toContain("the newer read v2")
    expect(prompt).not.toContain("the older read v1")
    // the named entry admits only its own shape: the other answers are still shown, one per call
    expect(prompt).toContain("grep found it in B")
    expect(prompt).toContain("old_string not found in B")
  })
  test("without a relational entry nothing of these is admitted, as before (a guard)", async () => {
    const { prompt } = await promptFor(["world_changed"])
    for (const t of ["grep found it in B", "old_string not found in B", "an answer of root A", "a draft the producer wrote"]) expect(prompt).not.toContain(t)
  })
  // A call is a started HOP's call_id, as a string: a row of another shape claiming the same phase and kind, or a hop
  // whose call_id is a number, makes no call.
  const withRows = async (extra: Array<Record<string, unknown>>, context: unknown[], share?: number) => {
    rows.push(...(extra as any[])); ids.push(...extra.map((r) => String(r.id)))
    if (share !== undefined) (SCHEMA as any).keep_share = share
    try { return await promptFor(context) } finally {
      rows.splice(rows.length - extra.length, extra.length); ids.splice(ids.length - extra.length, extra.length)
      delete (SCHEMA as any).keep_share
    }
  }
  test("[MUST-FAIL] a row that is not a hop makes no call, though it says started, a call kind, a call_id and this root's selection", async () => {
    const { prompt } = await withRows([
      { shape: "activity_template", id: "xT", role: "walk", phase: "started", kind: "call", call_id: "kX", selection_ref: "sB" },
      { shape: "boundedShellResult", id: "aX", role: "walk", call_id: "kX", selection_ref: "sB", stdout: "an answer to no hop" },
    ], [{ answers_a_call: true, latest_by: "call_id" }])
    expect(prompt).toContain("grep found it in B")
    expect(prompt).not.toContain("an answer to no hop")
  })
  test("a hop whose call_id is not a string makes no call: an answer naming the same digits is not admitted (a guard)", async () => {
    const { prompt } = await withRows([
      { shape: "hop", id: "hNum", role: "walk", phase: "started", kind: "call", call_id: 5, selection_ref: "sB" },
      { shape: "boundedShellResult", id: "aNum", role: "walk", call_id: "5", selection_ref: "sB", stdout: "an answer to a numbered call" },
    ], [{ answers_a_call: true, latest_by: "call_id" }])
    expect(prompt).not.toContain("an answer to a numbered call")
  })
  test("an entry saying answers_a_call false admits nothing, and leaves the prompt as it is without it (a guard)", async () => {
    const without = await promptFor(["world_changed"])
    const withFalse = await promptFor(["world_changed", { answers_a_call: false }])
    expect(withFalse.prompt).toBe(without.prompt)
  })
  // The entry a relational row was admitted by is its entry everywhere after: its latest_by, its place in the owner's
  // list, and its own key apart from another relational entry's.
  test("[MUST-FAIL] a relational entry's latest_by applies to the answers it admits: of two answers to one call, the newer only", async () => {
    const { prompt } = await withRows([
      { shape: "boundedShellResult", id: "aBold", seq: -1, role: "walk", call_id: "kB", selection_ref: "sB", stdout: "the older answer to kB" },
    ], [{ answers_a_call: true, latest_by: "call_id" }])
    expect(prompt).not.toContain("the older answer to kB")
    expect(prompt).toContain("grep found it in B")
  })
  test("[MUST-FAIL] two relational entries keep their newest apart: one per entry, not one for both", async () => {
    const { prompt } = await promptFor([
      { answers_a_call: true, where: { shape: "boundedShellResult" }, latest_by: "role" },
      { answers_a_call: true, where: { shape: "failure" }, latest_by: "role" },
    ])
    expect(prompt).toContain("grep found it in B")
    expect(prompt).toContain("old_string not found in B")
  })
  test("[MUST-FAIL] a relational kept entry is fitted where the owner lists it: a named entry listed before it is fitted first", async () => {
    const hops = Array.from({ length: 80 }, (_, i) => ({ shape: "hop", id: `hK${i}`, seq: 100 + i, role: "walk", output: { text: `kstep-${i}. ` + "x".repeat(3000) } }))
    const { prompt } = await withRows([
      { shape: "gitWorktree", id: "gwK", seq: 5, role: "walk", call_id: "kG", selection_ref: "sB", input_refs: ["w1"], cwd: "/trees/LISTED_FIRST", note: "c".repeat(15000) },
      { shape: "hop", id: "hS", seq: 6, role: "walk", phase: "started", kind: "call", call_id: "kS", selection_ref: "sB" },
      { shape: "boundedShellResult", id: "aS", seq: 7, role: "walk", call_id: "kS", selection_ref: "sB", input_refs: ["w1"], stdout: "LISTED_SECOND " + "s".repeat(6000) },
      ...hops,
    ], ["hop", { shape: "gitWorktree", keep: true }, { answers_a_call: true, keep: true }], 0.05)
    expect(prompt).toContain("/trees/LISTED_FIRST")
  })
  test("[MUST-FAIL] only answers_a_call: true is the relation; another value is no entry of it, even beside a true one", async () => {
    // the "yes" entry would admit the shell result; the true entry admits only failures
    const { prompt } = await promptFor([{ answers_a_call: "yes", where: { shape: "boundedShellResult" } }, { answers_a_call: true, where: { shape: "failure" } }])
    expect(prompt).toContain("old_string not found in B")
    expect(prompt).not.toContain("grep found it in B")
  })
  test("[MUST-FAIL] a relational entry's where must hold too", async () => {
    const { prompt } = await promptFor([{ answers_a_call: true, where: { shape: "boundedShellResult" } }])
    expect(prompt).toContain("grep found it in B")
    expect(prompt).not.toContain("old_string not found in B")
  })
})

describe("an entry by relation under a gap's root: the same gap's earlier detector row, another gap, no root", () => {
  // the request is for gap G, whose detector row is now gN (rewritten from gO); its calls were made under both
  const rows = [
    { shape: "gap", id: "gO", role: "detector", gap_id: "G", summary: "the gap as first written" },
    { shape: "gap", id: "gN", role: "detector", gap_id: "G", summary: "the gap as rewritten" },
    { shape: "gap", id: "gH", role: "detector", gap_id: "H", summary: "another gap" },
    { shape: "gap", id: "gZ", role: "detector", gap_id: null, summary: "a gap row naming no gap" },
    { shape: "selection", id: "sel-g", root: "gN" },
    { shape: "selection", id: "sO", root: "gO" },
    { shape: "selection", id: "sH", root: "gH" },
    { shape: "selection", id: "sZ", root: "gZ" },
    { shape: "hop", id: "hO", role: "walk", phase: "started", kind: "call", call_id: "kO", selection_ref: "sO", pointer_type: "bounded_shell" },
    { shape: "hop", id: "hH", role: "walk", phase: "started", kind: "call", call_id: "kH", selection_ref: "sH", pointer_type: "bounded_shell" },
    { shape: "hop", id: "hZ", role: "walk", phase: "started", kind: "call", call_id: "kZ", selection_ref: "sZ", pointer_type: "bounded_shell" },
    { shape: "boundedShellResult", id: "aO", role: "walk", call_id: "kO", selection_ref: "sO", stdout: "found under the gap's first row" },
    { shape: "boundedShellResult", id: "aH", role: "walk", call_id: "kH", selection_ref: "sH", stdout: "found under another gap" },
    { shape: "boundedShellResult", id: "aZ", role: "walk", call_id: "kZ", selection_ref: "sZ", stdout: "found under a gap naming none" },
  ]
  const run = async (selection_ref: string) => {
    INPUTS.push(...(rows as any[]))
    const keep = SCHEMA.context
    ;(SCHEMA as any).context = [{ answers_a_call: true, latest_by: "call_id" }]
    const before = discovery.seen.length
    const ids = ["w1", ...rows.filter((r) => !r.id.startsWith("sel-")).map((r) => r.id)]
    const r = await produce(NODE_KEY, { input_refs: ids, selection_ref })
    ;(SCHEMA as any).context = keep
    INPUTS.splice(INPUTS.length - rows.length, rows.length)
    const prompt = String((discovery.seen.slice(before).find((c) => (c.body as any)?.pointer?.type === "llm_completion")?.body as any)?.pointer?.prompt ?? "")
    return { status: r.status, prompt }
  }
  test("[MUST-FAIL] a call made under the same gap's earlier detector row is this root's: admitted", async () => {
    const { status, prompt } = await run("sel-g")
    expect(status).toBe(200)
    expect(prompt).toContain("found under the gap's first row")
  })
  test("another gap's call, and one under a gap row naming no gap, are not admitted (guards)", async () => {
    const { prompt } = await run("sel-g")
    expect(prompt).not.toContain("found under another gap")
    expect(prompt).not.toContain("found under a gap naming none")
  })
  test("a request whose root cannot be read admits no call's answer (fails closed; a guard)", async () => {
    const { prompt } = await run("sel-unreadable")
    for (const t of ["found under the gap's first row", "found under another gap", "found under a gap naming none"]) expect(prompt).not.toContain(t)
  })
})
