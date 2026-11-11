// SPDX-License-Identifier: MIT
import { authenticate } from "./auth"
import { check, shapeIn } from "./check"
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
type Ask = { shape: string; via_ref: string; input_refs: string[]; selection_ref: string; call_id: string }
type Answer = { ok: boolean; status: number; body: unknown; text: string }

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
  const [schema] = (sch.body as Row[]).reverse()
  const chs = await records(RECORD_READ, { shape: CHANNEL, ids: [p.via_ref] })
  if (!chs.ok) {
    return fail(chs.status, chs.text)
  }
  const [channel] = chs.body as Row[]
  const ins = await records(RECORD_READ, { ids: p.input_refs })
  if (!ins.ok) {
    return fail(ins.status, ins.text)
  }
  if (!Array.isArray(schema.inputs)) {
    return fail(422, SHAPE_SCHEMA)
  }
  const wanted = new Set([schema.inputs, schema.context ?? []].flat().map(String))
  const used = (ins.body as Row[]).filter((r) => wanted.has(String(r.shape)))
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
  let text = JSON.stringify({ description: schema.description, schema: schema.schema, inputs: used, reads: looked })
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
  const row = {
    ...body,
    shape: p.shape,
    input_refs: used.map((r) => r.id),
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
