// SPDX-License-Identifier: MIT
import { authenticate } from "./auth"
import { check } from "./check"
import { DISCOVERY_URL, KEY } from "./config"
import { AUTH_SCHEME, RESOLVE } from "./routes"
import { CHANNEL, RECORD_READ, RECORD_WRITE, SHAPE_SCHEMA, VESSEL_CAPABILITY } from "./shapes"

type Entry = { endpoint: string; resolve_endpoint: string }
type Row = { id: string; [k: string]: unknown }
type ChannelCall = {
  endpoint: string
  resolve_endpoint: string
  pointer: Record<string, unknown>
  input_field: string
  output_field: string
  producer_field: string
}
type Ask = { shape: string; via_ref: string; input_refs: string[]; selection_ref: string; call_id: string }
type Answer = { ok: boolean; status: number; body: unknown; text: string }

export const fail = (status: number, body: string): Response => Response.json({ failure: { status, body } }, { status })

const call = async (url: string, payload: object): Promise<Response> => {
  const init = {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `${AUTH_SCHEME} ${KEY}` },
    body: JSON.stringify(payload),
    timeout: false,
  }
  return fetch(url, init)
}

export const records = async (shape: string, pointer: object): Promise<Answer> => {
  const d = await call(new URL(RESOLVE, DISCOVERY_URL).href, { pointer: { type: VESSEL_CAPABILITY, shape } })
  if (!d.ok) {
    return { ok: false, status: d.status, body: null, text: await d.text() }
  }
  const [e] = ((await d.json()) as { content: { vessels: Entry[] } }).content.vessels
  const r = await call(new URL(e.resolve_endpoint, e.endpoint).href, { impulse: { pointer: { ...pointer, type: shape } } })
  if (!r.ok) {
    return { ok: false, status: r.status, body: null, text: await r.text() }
  }
  return { ok: true, status: r.status, body: (await r.json()) as unknown, text: "" }
}

const make = async (p: Ask, callerKey: string): Promise<Response> => {
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
  let text = JSON.stringify({ description: schema.description, schema: schema.schema, inputs: ins.body })
  let last = { url: "", result: {} as Record<string, unknown>, field: "" }
  for (const c of channel.calls as ChannelCall[]) {
    const pointer = { ...c.pointer, [c.input_field]: text }
    const url = new URL(c.resolve_endpoint, c.endpoint).href
    const r = await call(url, { impulse: { pointer } })
    if (!r.ok) {
      return fail(r.status, await r.text())
    }
    const result = (await r.json()) as Record<string, unknown>
    text = String(result[c.output_field])
    last = { url, result, field: c.producer_field }
  }
  let body: Record<string, unknown>
  try {
    body = JSON.parse(text) as Record<string, unknown>
  } catch (e) {
    return fail(422, String(e))
  }
  const checked = check(schema.schema as object, body)
  if (!checked.ok) {
    return fail(422, checked.errors)
  }
  const row = {
    ...body,
    shape: p.shape,
    input_refs: p.input_refs,
    selection_ref: p.selection_ref,
    call_id: p.call_id,
    caller_key: callerKey,
    producer: [last.url, String(last.result[last.field])].join(" "),
  }
  const w = await records(RECORD_WRITE, { row })
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
  try {
    const p = ((await req.json()) as { impulse: { pointer: Ask } }).impulse.pointer
    return await make(p, who.keyId)
  } catch (e) {
    return fail(500, String(e))
  }
}
