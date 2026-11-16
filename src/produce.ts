// SPDX-License-Identifier: MIT
import { authenticate } from "./auth"
import { check, equalsIn, inIn, matches, shapeIn, shownIn } from "./check"
import { DISCOVERY_URL, KEY, VESSEL_ID } from "./config"
import { AUTH_SCHEME, RESOLVE } from "./routes"
import { CHANNEL, DESCRIBED, OWNER, RECORD_READ, RECORD_SUMMARY, RECORD_WRITE, REQUIRES, SHAPE_SCHEMA } from "./shapes"

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

/**
 * The rows nested inside the walk's own records of what a call returned (rows of role walk: a hop's output is what a
 * vessel answered, records' stamped row included), by id: objects carrying a string id and shape and records' stamps
 * (a numeric seq, a writer, a role). Rows a model wrote (an answer, a judgement) are not walked: an object shaped like a
 * row inside one is text a model produced, not a row it was shown.
 */
export const embeddedRows = (rows: unknown[]): Map<string, Record<string, unknown>> => {
  const out = new Map<string, Record<string, unknown>>()
  const walk = (v: unknown, nested: boolean): void => {
    if (typeof v !== "object" || v === null) return
    if (Array.isArray(v)) { for (const x of v) walk(x, true); return }
    const o = v as Record<string, unknown>
    if (nested && typeof o.id === "string" && typeof o.shape === "string" && typeof o.seq === "number" && typeof o.writer === "string" && typeof o.role === "string") out.set(o.id, o)
    for (const x of Object.values(o)) walk(x, true)
  }
  for (const r of rows) if ((r as { role?: unknown })?.role === "walk") walk(r, false)
  return out
}
const clip = (r: Row, max: number): Row => {
  const whole = JSON.stringify(r)
  return whole.length <= max ? r : ({ id: r.id, shape: r.shape, role: r.role, cut: true, bytes: whole.length, start: whole.slice(0, max) } as Row)
}

export const fail = (status: number, body: string, unserved?: string): Response =>
  Response.json({ failure: { status, body, ...(unserved !== undefined ? { unserved } : {}) } }, { status })
// What a call this producer made says when it never reached a producer: discovery's own answer for a shape no one serves,
// or a resolver's refusal for a model it could not serve now, both carry `unserved` (the shape). Read as a field, never
// from words; carried on the failure so the walk can tell "nothing was there" from "the answer was wrong".
export const unservedOf = (answer: unknown): string | undefined => {
  const a = typeof answer === "string" ? ((): unknown => { try { return JSON.parse(answer) } catch { return undefined } })() : answer
  if (typeof a !== "object" || a === null) return undefined
  const top = (a as { unserved?: unknown }).unserved
  const inner = (a as { content?: { unserved?: unknown } }).content?.unserved
  return typeof top === "string" && top !== "" ? top : typeof inner === "string" && inner !== "" ? inner : undefined
}
// The producer's answer did not fit the schema. Marked, so a caller tells this apart from a 422 passed through from a read
// or a write: asking again over the same inputs is likely refused the same way, which a pass-through says nothing about.
const refusedBySchema = (body: string, end: Ending = {}): Response =>
  Response.json({ failure: { status: 422, body, refused: "schema", ...end } }, { status: 422 })
// How the model's answer ended, as the resolver that answered says it (stop_reason, usage.output_tokens): read as fields
// of that answer, never from the text. A refused produce carries them, so a reader can tell an answer cut at the model's
// output limit (stop_reason "max_tokens") from a complete one that is wrong; a parse failure alone could not say which.
type Ending = { stop_reason?: string; output_tokens?: number }
const endingOf = (result: Record<string, unknown>): Ending => {
  const stop = result.stop_reason
  const out = (result.usage as { output_tokens?: unknown } | undefined)?.output_tokens
  return { ...(typeof stop === "string" && stop !== "" ? { stop_reason: stop } : {}), ...(typeof out === "number" ? { output_tokens: out } : {}) }
}
// One journal line per refused produce: what was asked for, why, how the answer ended and how big the prompt was. Never
// the prompt or the answer (they carry whatever the rows did).
const journalRefused = (shape: string, why: string, end: Ending, promptBytes: number): void =>
  console.error(`[described] produce ${shape} refused 422 (${why}): stop_reason ${end.stop_reason ?? "unknown"}, output_tokens ${end.output_tokens ?? "unknown"}, prompt ${promptBytes} bytes`)

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
    return fail(sch.status, sch.text, unservedOf(sch.text))
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
    return fail(chs.status, chs.text, unservedOf(chs.text))
  }
  const [channel] = chs.body as Row[]
  // A call that names no channel (a template replaying a stored row as its pointer) is refused by name, not a crash.
  if (channel === undefined || !Array.isArray(channel.calls)) {
    return fail(422, `via_ref ${JSON.stringify(p.via_ref ?? null)} names no channel row`)
  }
  const ins = await records(RECORD_READ, { ids: p.input_refs })
  if (!ins.ok) {
    return fail(ins.status, ins.text, unservedOf(ins.text))
  }
  if (!Array.isArray(schema.inputs)) {
    return fail(422, SHAPE_SCHEMA)
  }
  // An entry of inputs or context is a shape, or {shape, where, join}: rows of that shape whose fields hold where's
  // values (a list: any of them). The owner says which rows of a shape the producer is shown, so a grader can be given
  // what a tool call returned without the walk's own steps. join {on, take} copies the fields take names onto a shown
  // row from another row of its shape with the same value at on (an ended hop names no shape called; its started hop
  // does); that other row is neither shown nor cited.
  const all = ins.body as Row[]
  // THE CLONE'S NEWEST TREE (x-latest), with the walk's own definition (walk applicable.ts): a where value {"x-latest":
  // {shapes, moves, same, field, continues}} is the field of the newest row of those shapes the walk recorded from a
  // tool's answer (role walk, with a call_id) on the request's clone, that holds the field; a newer `moves` row without
  // it leaves it unknown, and an unknown value meets nothing, a row without the field included. The request's clone is
  // the `same` of the newest such `moves` row citing the root (the selection's), else of the newest earlier root of the
  // root's shape with the same `continues` field. The root is read from the selection only when some value needs it.
  const hasLatest = (x: unknown): boolean => JSON.stringify(x ?? null).includes('"x-latest"')
  let rootId: string | undefined
  const rootOf = async (): Promise<void> => {
    if (rootId !== undefined) return
    const given = all.find((r) => r.id === p.selection_ref)
    const sel = given ?? await records(RECORD_READ, { ids: [p.selection_ref] }).then((a) => (a.ok && Array.isArray(a.body) ? (a.body as Row[])[0] : undefined))
    rootId = typeof sel?.root === "string" ? sel.root : ""
  }
  const UNKNOWN = Symbol("unknown")
  const latestOf = (v: unknown): { value: unknown } | undefined => {
    const s = typeof v === "object" && v !== null && !Array.isArray(v) ? (v as { "x-latest"?: unknown })["x-latest"] : undefined
    if (typeof s !== "object" || s === null) return undefined
    const o = s as Record<string, unknown>
    const list = (x: unknown): string[] => Array.isArray(x) ? x.filter((y): y is string => typeof y === "string") : []
    const [shapes, moves] = [list(o.shapes), list(o.moves)]
    if (typeof o.same !== "string" || typeof o.field !== "string" || shapes.length === 0) return { value: UNKNOWN }
    const [same, field, continues] = [o.same, o.field, typeof o.continues === "string" ? o.continues : undefined]
    const byTool = all.filter((r) => r.role === "walk" && typeof r.call_id === "string").sort((a, b) => Number(b.seq ?? 0) - Number(a.seq ?? 0))
    const cites = (r: Row, id: string): boolean => [r.input_refs].flat().map(String).includes(id)
    const root = all.find((r) => r.id === rootId)
    const roots = rootId === undefined || rootId === "" ? [] : [rootId, ...(root !== undefined && continues !== undefined && root[continues] !== undefined
      ? all.filter((r) => r.shape === root.shape && r.id !== root.id && Number(r.seq ?? 0) < Number(root.seq ?? 0)
        && JSON.stringify(r[continues]) === JSON.stringify(root[continues])).sort((a, b) => Number(b.seq ?? 0) - Number(a.seq ?? 0)).map((r) => r.id) : [])]
    let at: unknown
    for (const id of roots) {
      at = byTool.find((r) => moves.includes(String(r.shape)) && r[same] !== undefined && cites(r, id))?.[same]
      if (at !== undefined) break
    }
    if (at === undefined) return { value: UNKNOWN }
    for (const r of byTool.filter((x) => shapes.includes(String(x.shape)) && JSON.stringify(x[same]) === JSON.stringify(at))) {
      if (r[field] !== undefined) return { value: r[field] }
      if (moves.includes(String(r.shape))) break
    }
    return { value: UNKNOWN }
  }
  const resolve_ = (e: unknown): unknown => {
    if (typeof e !== "object" || e === null || Array.isArray(e)) return e
    const where = (e as { where?: unknown }).where
    if (typeof where !== "object" || where === null) return e
    const w = Object.fromEntries(Object.entries(where as Record<string, unknown>).map(([k, v]) => {
      const l = latestOf(v)
      // unknown: a value no row field equals (a fresh object), so it meets nothing, a row without the field included
      return [k, l === undefined ? v : l.value === UNKNOWN ? { unknown: true } : l.value]
    }))
    return { ...(e as object), where: w }
  }
  if (hasLatest([schema.inputs, schema.context])) await rootOf()
  const wanted = [schema.inputs, schema.context ?? []].flat().map(resolve_)
  let used = all.flatMap((r) => {
    const e = wanted.find((x) => matches(r, x)) as { join?: { on?: unknown; take?: unknown } } | undefined
    if (e === undefined) return []
    const on = String(e.join?.on ?? "")
    const take = [e.join?.take ?? []].flat().map(String).filter((k) => r[k] === undefined)
    const from = on && take.length > 0 ? all.find((x) => x !== r && x.shape === r.shape && x[on] !== undefined && x[on] === r[on]) : undefined
    return [from === undefined ? r : { ...r, ...Object.fromEntries(take.filter((k) => from[k] !== undefined).map((k) => [k, from[k]])) }]
  })
  // A context entry may also say how its rows are shown: whole (unclipped, as an input is, up to the same per-row cap,
  // within the context budget: a file the producer must quote is no use cut), latest_by <field> (only the newest row per
  // value of that field: a file read again after an edit replaces the older read), and covers {shape, on} (rows of that
  // shape with the same value at on are left out once a whole row is shown: the tool call that fetched the row would
  // otherwise spend the budget on the same text again). The shapes and fields are the owner's; this names none.
  type Entry = { whole?: unknown; latest_by?: unknown; covers?: { shape?: unknown; on?: unknown }; keep?: unknown }
  const entryOf = (r: Row): Entry | undefined => wanted.find((x) => matches(r, x)) as Entry | undefined
  const left = new Set<string>()
  const newest = new Map<string, Row>()
  for (const r of [...used].sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0))) {
    const by = entryOf(r)?.latest_by
    if (typeof by !== "string") continue
    const k = `${wanted.findIndex((x) => matches(r, x))}|${JSON.stringify(r[by])}`
    const older = newest.get(k)
    if (older !== undefined) left.add(older.id)
    newest.set(k, r)
  }
  for (const w of used.filter((r) => !left.has(r.id) && entryOf(r)?.whole === true)) {
    const c = entryOf(w)?.covers
    if (typeof c?.shape !== "string" || typeof c.on !== "string" || w[c.on] === undefined) continue
    for (const r of used) if (r !== w && r.shape === c.shape && r[c.on] === w[c.on]) left.add(r.id)
  }
  used = used.filter((r) => !left.has(r.id))
  // An input entry is a shape or {shape, ...} (latest_by among them), as a context entry is: its shape is the input.
  const inputs = new Set((schema.inputs as unknown[]).map((e) => typeof e === "object" && e !== null ? String((e as { shape?: unknown }).shape) : String(e)))
  const isWhole = (r: Row): boolean => !inputs.has(String(r.shape)) && entryOf(r)?.whole === true
  const shownAs = (r: Row): Row => inputs.has(String(r.shape)) ? r : clip(r, isWhole(r) ? INPUT_ROW_MAX : CONTEXT_ROW_MAX)
  const looked: unknown[] = []
  const answered: Array<{ type: string; answer: unknown }> = []
  // A read pointer value {"x-inputs": true} is bound to the ids of the input rows shown, so a read the owner scopes to
  // the request (record_lapsed's asks) answers about this request alone.
  const inputIds = used.filter((r) => inputs.has(String(r.shape))).map((r) => r.id)
  // A read pointer value {"x-since": "<shape>"} is bound to the sequence number of the newest row of that shape (0 when
  // there is none), so a read the owner scopes to a window (after_seq) reads what happened since that shape was last
  // written: a retrospective reads since the previous one (the USER: "on this one horizon"). Counted by records'
  // record_summary, so no row is read for it; a summary that fails binds nothing and the read is refused by name.
  const sinceOf = async (shape: string): Promise<number | undefined> => {
    const a = await records(RECORD_SUMMARY, { shape, summarize: ["shape"] })
    if (!a.ok) return undefined
    const n = (a.body as { newest_seq?: unknown } | undefined)?.newest_seq
    return typeof n === "number" && Number.isFinite(n) ? n : 0
  }
  const bound = async (pointer: object): Promise<object | { unbound: string }> => {
    const out: Array<[string, unknown]> = []
    for (const [k, v] of Object.entries(pointer)) {
      const o = typeof v === "object" && v !== null ? v as Record<string, unknown> : undefined
      if (o?.["x-inputs"] === true) { out.push([k, inputIds]); continue }
      if (typeof o?.["x-since"] === "string") {
        const n = await sinceOf(String(o["x-since"]))
        if (n === undefined) return { unbound: `${k}: the newest ${String(o["x-since"])} could not be counted` }
        out.push([k, n]); continue
      }
      out.push([k, v])
    }
    return Object.fromEntries(out)
  }
  // A read the owner marks shown (shown: true, taken off before it is sent): its rows count as shown, and are cited,
  // whatever they cite. Without it a read row counts only when it cites an input row (below), which keeps a grader of one
  // request from citing another's rows; a producer whose work is to look across requests (a retrospective, the USER:
  // "on this one horizon") is given that by the owner, per read.
  const ownerShown: unknown[] = []
  for (const marked of [schema.reads ?? []].flat() as object[]) {
    const { shown: mark, ...pointer } = marked as Record<string, unknown>
    const p = await bound(pointer)
    if ("unbound" in p) return fail(502, String(p.unbound))
    const r = await resolve(p)
    if (!r.ok) {
      return fail(r.status, r.text, unservedOf(r.text))
    }
    looked.push(r.body)
    if (mark === true) ownerShown.push(r.body)
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
  // out, the row records it (context_omitted, oldest_shown_seq), and the row cites only the rows it was shown.
  // A row that does not fit is skipped and the fill goes on: stopping at it hid every older row behind one big one.
  // Some rows matter however old they are (a request's own clone: its cwd is where every call works). The owner marks
  // such an entry keep: true, and its rows are fitted first, newest first, within a share of the budget the schema row
  // gives (keep_share, 0 to 1; with none, nothing is fitted first). Only a row that cites one of this produce's inputs is
  // kept so: the request's own, never a row another request's lineage reached.
  const order = new Map(used.map((r, i) => [r.id, typeof r.seq === "number" ? r.seq : i]))
  const newestFirst = (rs: Row[]): Row[] => [...rs].sort((a, b) => (order.get(b.id) ?? 0) - (order.get(a.id) ?? 0))
  const share = typeof schema.keep_share === "number" && schema.keep_share > 0 && schema.keep_share <= 1 ? schema.keep_share : 0
  const own = (r: Row): boolean => [r.input_refs].flat().some((id) => inputIds.includes(String(id)))
  const kept = share > 0 ? used.filter((r) => !inputs.has(String(r.shape)) && entryOf(r)?.keep === true && own(r)) : []
  // WHAT A CALL REQUIRES IS SHOWN EARLY. The owner's requires rows ({for, needs, where, latest_by}) gate a call on rows of
  // a shape (the walk offers fs_edit only once its file was read); a producer that writes such a call must be shown
  // those rows, or the gate and the prompt disagree (52d7196f: an edit written by a producer shown none of the file it
  // edited, its read dropped by the budget for older hops). So the rows that would meet some requires row are fitted
  // right after the kept rows, newest first, within a share of their own the size of the keep share: read as the walk reads them, the newest owner row per (for, needs), its
  // where with the values the call's own pointer gives (x-pointer) left open, since the call is not written yet; newest
  // per its latest_by; only the request's own rows. The shapes and fields are the owner's rows'; this names none. Taken
  // from the rows given, else read; a read that fails shows nothing first rather than refuse the produce.
  const reqRows = all.some((r) => r.shape === REQUIRES) ? all.filter((r) => r.shape === REQUIRES)
    : await records(RECORD_READ, { shape: REQUIRES }).then((a) => (a.ok && Array.isArray(a.body) ? a.body as Row[] : []))
  const reqs = [...reqRows.filter((r) => r.role === OWNER).sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0))
    .reduce((m, r) => m.set(JSON.stringify([String(r.for), String(r.needs)]), r), new Map<string, Row>()).values()]
  if (hasLatest(reqs.map((q) => q.where))) await rootOf()
  const meets = (r: Row, q: Row): boolean => String(r.shape) === String(q.needs) &&
    Object.entries((q.where ?? {}) as Record<string, unknown>).every(([k, v]) => {
      const l = latestOf(v)
      if (l !== undefined) return l.value !== UNKNOWN && r[k] !== undefined && JSON.stringify(r[k]) === JSON.stringify(l.value)
      return typeof v === "object" && v !== null && !Array.isArray(v) ? true : Array.isArray(v) ? v.includes(r[k]) : r[k] === v
    })
  const required: Row[] = []
  for (const q of reqs) {
    const newestOf = new Map<string, Row>()
    for (const r of [...used].sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0))) {
      if (inputs.has(String(r.shape)) || !own(r) || !meets(r, q)) continue
      newestOf.set(typeof q.latest_by === "string" ? JSON.stringify(r[q.latest_by]) : r.id, r)
    }
    required.push(...newestOf.values())
  }
  const fitted = new Set<string>()
  let spent = 0
  const fill = (rs: Row[], budget: number): void => {
    for (const r of newestFirst(rs)) {
      if (fitted.has(r.id)) continue
      const size = JSON.stringify(shownAs(r)).length
      // a row that does not fit is left out and counted as not shown, never cut to fit; a smaller one may still
      if (spent + size > budget) continue
      spent += size
      fitted.add(r.id)
    }
  }
  // kept first, within its share, as before; the required rows then get a share of their own on top, so a call's large
  // file reads never push out the request's clone or its commit (qa: one shared share starved the kept rows)
  fill(kept, CONTEXT_BUDGET * share)
  fill(required, spent + CONTEXT_BUDGET * share)
  // WHAT A SHOWN REFUSAL NAMES COMES WITH IT. A row naming the rows its reasons compared (against_refs: the walk's skip
  // saying a requirement was not met, and by which row) is fitted next, and then those rows, ahead of the walk's older
  // rows: a producer told "r: required 1 ≠ land_verdict's 0" was shown neither the verdict nor its diff, and asked for a
  // read instead (90b4ece3, research). The newest five such rows at most; only a row that is itself fitted pulls its rows
  // in, and only the rows it names; a
  // named row that does not fit is said, by id, not dropped in silence. No shape is named here.
  const naming = newestFirst(used.filter((r) => !inputs.has(String(r.shape)) && Array.isArray(r.against_refs) && r.against_refs.length > 0)).slice(0, 5)
  fill(naming, CONTEXT_BUDGET)
  const named = new Set(naming.filter((r) => fitted.has(r.id)).flatMap((r) => (r.against_refs as unknown[]).map(String)))
  fill(used.filter((r) => named.has(r.id) && !inputs.has(String(r.shape))), CONTEXT_BUDGET)
  const namedNotShown = [...named].filter((id) => used.some((r) => r.id === id) && !fitted.has(id)).slice(0, 20)
  fill(used.filter((x) => !inputs.has(String(x.shape))), CONTEXT_BUDGET)
  const seen = used.filter((r) => inputs.has(String(r.shape)) || fitted.has(r.id))
  const omitted = used.length - seen.length
  // A whole row the budget left out is named, not only counted: it is one the owner asked to be shown whole (a file the
  // producer must quote), and the hop that fetched it may already be left out as covered, so a count alone would hide
  // that a read happened at all. Named by its shape, id and size, and by the value of the field its entry keeps the
  // newest of (latest_by), when it has one; the fields are the owner's, as the entry's are.
  const notShownWhole = used.filter((r) => !inputs.has(String(r.shape)) && !fitted.has(r.id) && isWhole(r)).slice(0, 20).map((r) => {
    const by = entryOf(r)?.latest_by
    return { shape: r.shape, id: r.id, bytes: JSON.stringify(r).length, ...(typeof by === "string" && r[by] !== undefined ? { [by]: r[by] } : {}) }
  })
  // Rows a read answered with are shown too. One that cites an input row (a deadline of this request) is cited beside the
  // inputs, so a grade judging it names a row it was given; one that does not (another request's deadline, a gap) is
  // not, so nothing may be judged from it.
  const ofInputs = (x: Row): boolean => [x.input_refs].flat().some((id) => inputIds.includes(String(id)))
  const read = looked.flatMap((a) => Array.isArray(a)
    ? a.filter((x): x is Row => typeof x?.id === "string" && typeof x?.shape === "string" && (ofInputs(x) || ownerShown.includes(a))) : [])
  const cited = [...new Set([...seen, ...read].map((r) => r.id))]
  const shown = seen.map(shownAs)
  let text = JSON.stringify({
    description: schema.description, schema: schema.schema, inputs: shown, reads: looked,
    ...(omitted > 0 ? { omitted: `${omitted} older context rows are not shown` } : {}),
    ...(namedNotShown.length > 0 ? { named_not_shown: `rows a shown refusal names that did not fit: ${namedNotShown.join(", ")}` } : {}),
    ...(notShownWhole.length > 0 ? { not_shown_whole: notShownWhole } : {}),
  })
  const promptBytes = Buffer.byteLength(text)
  let last = { result: {} as Record<string, unknown>, field: "" }
  for (const c of channel.calls as ChannelCall[]) {
    const r = await resolve({ ...c.pointer, [c.input_field]: text })
    if (!r.ok) {
      return fail(r.status, r.text, unservedOf(r.text))
    }
    const result = r.body as Record<string, unknown>
    // A channel that answers without its output field failed upstream (a provider error comes back as
    // {resolved: false, error}); say what it returned instead of parsing the word "undefined".
    if (typeof result?.[c.output_field] !== "string") {
      return fail(502, JSON.stringify({ channel: c.pointer.type, missing: c.output_field, result }).slice(0, 1000), unservedOf(result))
    }
    text = String(result[c.output_field])
    last = { result, field: c.producer_field }
  }
  let body: Record<string, unknown>
  try {
    body = JSON.parse(unfenced(text)) as Record<string, unknown>
  } catch (e) {
    // The text that failed to parse is the evidence of why; carry its start. An answer the model's output limit cut short
    // says so first, in plain words, so it is not read as a malformed answer: what fixes it is a smaller answer.
    const end = endingOf(last.result)
    const why = end.stop_reason === "max_tokens" ? `output cut at the model's output limit after ${end.output_tokens ?? "an unknown number of"} tokens` : String(e)
    journalRefused(p.shape, end.stop_reason === "max_tokens" ? "output cut" : "not JSON", end, promptBytes)
    return Response.json({ failure: { status: 422, body: `${why}; text began: ${JSON.stringify(text.slice(0, 200))}`, ...end } }, { status: 422 })
  }
  const ending = endingOf(last.result)
  const refused = (body: string): Response => {
    journalRefused(p.shape, "schema", ending, promptBytes)
    return refusedBySchema(body, ending)
  }
  const checked = check(schema.schema as object, body)
  if (!checked.ok) {
    return refused(checked.errors)
  }
  // A value the schema says must name something a read returned (a shape to call, among those served) is held to it
  // here: a description alone did not stop a model copying names that are not shapes.
  const outside = shapeIn(schema.schema, body, answered)
  if (outside.length > 0) {
    return refused(outside.join("; ").slice(0, 1000))
  }
  // And a value it says names a row the producer was shown must be one of those rows. A row the walk's record of a call
  // carried whole (a hop's output: the row a vessel answered with) was shown too, as the prompt rendered it (after the
  // clip, so a row the clip cut was not). Such a row is cited as shown only when records holds it with the same stamps
  // (shape, seq, writer, role): read by id only when an answer cites one, so most answers cost nothing more. It widens
  // only what an answer may cite, never input_refs, which stay the rows the producer was given.
  const shownIds = new Set(cited)
  let unseen = shownIn(schema.schema, body, shownIds)
  if (unseen.length > 0) {
    const carried = embeddedRows([...shown, ...read])
    const asked = [...new Set(unseen.map((u) => /"([^"]+)" is not a row it was shown/.exec(u)?.[1]).filter((id): id is string => !!id && carried.has(id)))]
    if (asked.length > 0) {
      const held = await records(RECORD_READ, { ids: asked })
      const stored = held.ok && Array.isArray(held.body) ? held.body as Row[] : []
      for (const r of stored) {
        const e = carried.get(String(r.id))
        if (e && e.shape === r.shape && e.seq === r.seq && e.writer === r.writer && e.role === r.role) shownIds.add(String(r.id))
      }
      unseen = shownIn(schema.schema, body, shownIds)
    }
  }
  if (unseen.length > 0) {
    return refused(unseen.join("; ").slice(0, 1000))
  }
  // And a value it says must be what a shown row holds must be exactly that.
  const unequal = equalsIn(schema.schema, body, seen)
  if (unequal.length > 0) {
    return refused(unequal.join("; ").slice(0, 1000))
  }
  // And a value it says must be one of what shown rows hold (x-in) must be one of them, read from the owner's marked
  // reads only: the owner chose that source (and, in the read's where, whose rows count). A row of the shape given as an
  // input, or read without the mark, could have been written by anyone and would widen the list (qa).
  const marked = ownerShown.flatMap((a) => Array.isArray(a) ? a.filter((x): x is Row => typeof x?.id === "string" && typeof x?.shape === "string") : [])
  const outside_ = inIn(schema.schema, body, marked)
  if (outside_.length > 0) {
    return refused(outside_.join("; ").slice(0, 1000))
  }
  const shownSeqs = used.filter((r) => fitted.has(r.id) && typeof r.seq === "number").map((r) => Number(r.seq))
  // What the context budget left out, kept on the row so a reader can tell a row the producer was not shown from one it
  // ignored. Always this vessel's count, never the model's: the same fields in what the model wrote are dropped.
  const { context_omitted: _o, oldest_shown_seq: _s, ...said } = body as Record<string, unknown>
  const row = {
    ...said,
    shape: p.shape,
    input_refs: cited,
    context_omitted: omitted,
    ...(shownSeqs.length > 0 ? { oldest_shown_seq: Math.min(...shownSeqs) } : {}),
    selection_ref: p.selection_ref,
    call_id: p.call_id,
    producer: String(last.result[last.field]),
  }
  const w = await records(RECORD_WRITE, { row, writer: VESSEL_ID, role: DESCRIBED })
  if (!w.ok) {
    return fail(w.status, w.text, unservedOf(w.text))
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
