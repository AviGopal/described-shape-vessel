// SPDX-License-Identifier: MIT
import { authenticate } from "./auth"
import { check, matches, shapeIn, shownIn } from "./check"
import { DISCOVERY_URL, KEY, VESSEL_ID } from "./config"
import { AUTH_SCHEME, RESOLVE } from "./routes"
import { CHANNEL, DESCRIBED, RECORD_READ, RECORD_WRITE, SHAPE_SCHEMA } from "./shapes"

type Row = { id: string; [k: string]: unknown }
type ChannelCall = {
  pointer: Record<string, unknown>
  input_field: string
  output_field: string
  producer_field: string
}
type Ask = { shape: string; via_ref: string; input_refs: string[]; selection_ref: string; call_id: string; variant?: string }
type Answer = { ok: boolean; status: number; body: unknown; text: string }

// Room for a gitDiff capped at 64 KiB of text where it is made, once JSON-escaped and with its fields.
const INPUT_ROW_MAX = 96 * 1024
const CONTEXT_ROW_MAX = 8 * 1024
// How much of a prompt the context rows may take together. A constant: named debt (agf_j6rpnacxgn8s), to come from an
// owner row once one writes it.
const CONTEXT_BUDGET = 192 * 1024
const clip = (r: Row, max: number): Row => {
  const whole = JSON.stringify(r)
  return whole.length <= max ? r : ({ id: r.id, shape: r.shape, role: r.role, cut: true, bytes: whole.length, start: whole.slice(0, max) } as Row)
}

export const fail = (status: number, body: string): Response => Response.json({ failure: { status, body } }, { status })
// The producer's answer did not fit the schema. Marked, so a caller tells this apart from a 422 passed through from a read
// or a write: asking again over the same inputs is likely refused the same way, which a pass-through says nothing about.
const refusedBySchema = (body: string): Response =>
  Response.json({ failure: { status: 422, body, refused: "schema" } }, { status: 422 })

// A model often wraps its JSON in a fenced code block, with or without prose around it. When the text holds exactly
// one fenced block, parse its body; otherwise (none, or several, which is ambiguous) parse the text as it is, so
// several blocks fail rather than one being guessed. Nothing else is repaired.
const FENCE = /```[^\n`]*\n?([\s\S]*?)```/g

const unfenced = (text: string): string => {
  const blocks = [...text.matchAll(FENCE)]
  if (blocks.length !== 1) {
    return text
  }
  return blocks[0][1]
}

const resolve = async (pointer: object): Promise<Answer> => {
  const init = {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `${AUTH_SCHEME} ${KEY}` },
    body: JSON.stringify({ pointer }),
    timeout: false,
  }
  const r = await fetch(new URL(RESOLVE, DISCOVERY_URL).href, init)
  if (!r.ok) {
    return { ok: false, status: r.status, body: null, text: await r.text() }
  }
  return { ok: true, status: r.status, body: (await r.json()) as unknown, text: "" }
}

export const records = async (shape: string, pointer: object): Promise<Answer> => resolve({ ...pointer, type: shape })

const make = async (p: Ask): Promise<Response> => {
  const sch = await records(RECORD_READ, { shape: SHAPE_SCHEMA, where: { target: p.shape } })
  if (!sch.ok) {
    return fail(sch.status, sch.text)
  }
  // The newest row of the variant asked for (another way the owner makes the same shape, from other inputs); a row
  // naming no variant, and an ask naming none, are the variant "".
  const want = String(p.variant ?? "")
  const [schema] = (sch.body as Row[]).filter((r) => String(r.variant ?? "") === want).reverse()
  if (schema === undefined) {
    return fail(422, `no shape_schema for ${p.shape}${want ? ` variant ${want}` : ""}`)
  }
  const chs = await records(RECORD_READ, { shape: CHANNEL, ids: [p.via_ref] })
  if (!chs.ok) {
    return fail(chs.status, chs.text)
  }
  const [channel] = chs.body as Row[]
  // A call that names no channel (a template replaying a stored row as its pointer) is refused by name, not a crash.
  if (channel === undefined || !Array.isArray(channel.calls)) {
    return fail(422, `via_ref ${JSON.stringify(p.via_ref ?? null)} names no channel row`)
  }
  const ins = await records(RECORD_READ, { ids: p.input_refs })
  if (!ins.ok) {
    return fail(ins.status, ins.text)
  }
  if (!Array.isArray(schema.inputs)) {
    return fail(422, SHAPE_SCHEMA)
  }
  // An entry of inputs or context is a shape, or {shape, where, join}: rows of that shape whose fields hold where's
  // values (a list: any of them). The owner says which rows of a shape the producer is shown, so a grader can be given
  // what a tool call returned without the walk's own steps. join {on, take} copies the fields take names onto a shown
  // row from another row of its shape with the same value at on (an ended hop names no shape called; its started hop
  // does); that other row is neither shown nor cited.
  const wanted = [schema.inputs, schema.context ?? []].flat()
  const all = ins.body as Row[]
  const used = all.flatMap((r) => {
    const e = wanted.find((x) => matches(r, x)) as { join?: { on?: unknown; take?: unknown } } | undefined
    if (e === undefined) return []
    const on = String(e.join?.on ?? "")
    const take = [e.join?.take ?? []].flat().map(String).filter((k) => r[k] === undefined)
    const from = on && take.length > 0 ? all.find((x) => x !== r && x.shape === r.shape && x[on] !== undefined && x[on] === r[on]) : undefined
    return [from === undefined ? r : { ...r, ...Object.fromEntries(take.filter((k) => from[k] !== undefined).map((k) => [k, from[k]])) }]
  })
  const inputs = new Set((schema.inputs as unknown[]).map(String))
  const looked: unknown[] = []
  const answered: Array<{ type: string; answer: unknown }> = []
  for (const pointer of [schema.reads ?? []].flat() as object[]) {
    const r = await resolve(pointer)
    if (!r.ok) {
      return fail(r.status, r.text)
    }
    looked.push(r.body)
    answered.push({ type: String((pointer as { type?: unknown }).type), answer: r.body })
  }
  // A row the schema shows only as context is cut past a size and marked as cut, so one oversized row (a tool's whole
  // stdout recorded in a hop) cannot push every prompt that reads it past the model's input ceiling; it still counts as
  // used. A row the schema takes as an INPUT is what the answer is about, and a cut one could be judged as if it were
  // whole (a grader shown part of a diff), so an input past the size is refused, by name, rather than cut.
  const tooBig = used.filter((r) => inputs.has(String(r.shape)) && JSON.stringify(r).length > INPUT_ROW_MAX)
  if (tooBig.length > 0) {
    return fail(422, `input rows too big to show whole: ${tooBig.map((r) => `${String(r.shape)} ${r.id} (${JSON.stringify(r).length} bytes)`).join(", ")}`)
  }
  // Context rows grow with a request's age (every hop and failure of a long change), and a prompt holding them all went
  // past the model's input ceiling: the producer was refused and the request went dark. So the context rows are taken
  // newest first while they fit the budget; the inputs are always whole. The prompt says how many older ones it left
  // out, and the row cites only the rows it was shown.
  const order = new Map(used.map((r, i) => [r.id, typeof r.seq === "number" ? r.seq : i]))
  const fitted = new Set<string>()
  let spent = 0
  for (const r of used.filter((x) => !inputs.has(String(x.shape))).sort((a, b) => (order.get(b.id) ?? 0) - (order.get(a.id) ?? 0))) {
    const size = JSON.stringify(clip(r, CONTEXT_ROW_MAX)).length
    if (spent + size > CONTEXT_BUDGET) break
    spent += size
    fitted.add(r.id)
  }
  const seen = used.filter((r) => inputs.has(String(r.shape)) || fitted.has(r.id))
  const omitted = used.length - seen.length
  // Rows a read answered with are shown too, so the row cites them beside its inputs: a grade judging a deadline a read
  // returned names a row it was given.
  const read = looked.flatMap((a) => Array.isArray(a) ? a.filter((x): x is Row => typeof x?.id === "string" && typeof x?.shape === "string") : [])
  const cited = [...new Set([...seen, ...read].map((r) => r.id))]
  const shown = seen.map((r) => inputs.has(String(r.shape)) ? r : clip(r, CONTEXT_ROW_MAX))
  let text = JSON.stringify({
    description: schema.description, schema: schema.schema, inputs: shown, reads: looked,
    ...(omitted > 0 ? { omitted: `${omitted} older context rows are not shown` } : {}),
  })
  let last = { result: {} as Record<string, unknown>, field: "" }
  for (const c of channel.calls as ChannelCall[]) {
    const r = await resolve({ ...c.pointer, [c.input_field]: text })
    if (!r.ok) {
      return fail(r.status, r.text)
    }
    const result = r.body as Record<string, unknown>
    // A channel that answers without its output field failed upstream (a provider error comes back as
    // {resolved: false, error}); say what it returned instead of parsing the word "undefined".
    if (typeof result?.[c.output_field] !== "string") {
      return fail(502, JSON.stringify({ channel: c.pointer.type, missing: c.output_field, result }).slice(0, 1000))
    }
    text = String(result[c.output_field])
    last = { result, field: c.producer_field }
  }
  let body: Record<string, unknown>
  try {
    body = JSON.parse(unfenced(text)) as Record<string, unknown>
  } catch (e) {
    // The text that failed to parse is the evidence of why; carry its start.
    return Response.json({ failure: { status: 422, body: `${String(e)}; text began: ${JSON.stringify(text.slice(0, 200))}` } }, { status: 422 })
  }
  const checked = check(schema.schema as object, body)
  if (!checked.ok) {
    return refusedBySchema(checked.errors)
  }
  // A value the schema says must name something a read returned (a shape to call, among those served) is held to it
  // here: a description alone did not stop a model copying names that are not shapes.
  const outside = shapeIn(schema.schema, body, answered)
  if (outside.length > 0) {
    return refusedBySchema(outside.join("; ").slice(0, 1000))
  }
  // And a value it says names a row the producer was shown must be one of those rows.
  const unseen = shownIn(schema.schema, body, new Set(cited))
  if (unseen.length > 0) {
    return refusedBySchema(unseen.join("; ").slice(0, 1000))
  }
  const row = {
    ...body,
    shape: p.shape,
    input_refs: cited,
    selection_ref: p.selection_ref,
    call_id: p.call_id,
    producer: String(last.result[last.field]),
  }
  const w = await records(RECORD_WRITE, { row, writer: VESSEL_ID, role: DESCRIBED })
  if (!w.ok) {
    return fail(w.status, w.text)
  }
  return Response.json(w.body)
}

export const produce = async (req: Request): Promise<Response> => {
  const who = await authenticate(req)
  if (!who.ok) {
    return fail(401, "")
  }
  if (!who.self) {
    return fail(403, "")
  }
  try {
    const p = ((await req.json()) as { impulse: { pointer: Ask } }).impulse.pointer
    return await make(p)
  } catch (e) {
    return Response.json({ failure: { status: 500, body: String(e) } }, { status: 500 })
  }
}
