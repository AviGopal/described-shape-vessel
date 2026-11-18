// SPDX-License-Identifier: MIT
import Ajv from "ajv"

const ajv = new Ajv({ strict: false })

// A schema property may say its value must be a key of what one of the schema's reads returned:
// "x-shape-in": {"read": <the read's type>, "keys_of": <the dotted path, in that read's answer, of the object whose keys
// count>}.
// The schema's owner writes the rule; this only enforces it, against the answer the prompt was built from.
type ShapeIn = { read: string; keys_of: string }
export const shapeIn = (schema: unknown, body: unknown, reads: Array<{ type: string; answer: unknown }>, at = "") : string[] => {
  if (typeof schema !== "object" || schema === null) return []
  const s = schema as { "x-shape-in"?: ShapeIn; properties?: Record<string, unknown>; items?: unknown }
  const bad: string[] = []
  const rule = s["x-shape-in"]
  if (rule && typeof body === "string") {
    const keys = String(rule.keys_of).split(".").reduce<unknown>(
      (v, k) => (typeof v === "object" && v !== null ? (v as Record<string, unknown>)[k] : undefined),
      reads.find((r) => r.type === rule.read)?.answer)
    if (typeof keys !== "object" || keys === null || !Object.hasOwn(keys, body)) bad.push(`${at || "/"} ${JSON.stringify(body)} is not in ${rule.read}.${rule.keys_of}`)
  }
  if (s.properties && typeof body === "object" && body !== null && !Array.isArray(body)) {
    for (const [k, sub] of Object.entries(s.properties)) {
      if (k in body) bad.push(...shapeIn(sub, (body as Record<string, unknown>)[k], reads, `${at}/${k}`))
    }
  }
  if (s.items && Array.isArray(body)) body.forEach((v, i) => bad.push(...shapeIn(s.items, v, reads, `${at}/${i}`)))
  return bad
}

// A schema property may say its value must be the id of a row the producer was shown ("x-shown": true): an answer that
// cites a row it was never given is refused, by name, rather than written with a reference no reader can resolve.
export const shownIn = (schema: unknown, body: unknown, ids: Set<string>, at = ""): string[] => {
  if (typeof schema !== "object" || schema === null) return []
  const s = schema as { "x-shown"?: boolean; properties?: Record<string, unknown>; items?: unknown }
  const bad: string[] = []
  if (s["x-shown"] === true && typeof body === "string" && !ids.has(body)) bad.push(`${at || "/"} ${JSON.stringify(body)} is not a row it was shown`)
  if (s.properties && typeof body === "object" && body !== null && !Array.isArray(body)) {
    for (const [k, sub] of Object.entries(s.properties)) {
      if (k in body) bad.push(...shownIn(sub, (body as Record<string, unknown>)[k], ids, `${at}/${k}`))
    }
  }
  if (s.items && Array.isArray(body)) body.forEach((v, i) => bad.push(...shownIn(s.items, v, ids, `${at}/${i}`)))
  return bad
}

// A schema property may say its value must be ONE OF what the rows of a shape hold at a path, among the rows the
// owner's marked reads returned (produce.ts): "x-in": {"shape": <shape>, "path": <dotted path>}. A list the owner keeps as
// rows (the names a retrospective may give a cause) is then read at use time, never written into the schema. With no
// such row of the shape, nothing is allowed. The match is exact.
type InIn = { shape: string; path: string }
export const inIn = (schema: unknown, body: unknown, rows: Array<Record<string, unknown>>, at = ""): string[] => {
  if (typeof schema !== "object" || schema === null) return []
  const s = schema as { "x-in"?: InIn; properties?: Record<string, unknown>; items?: unknown }
  const bad: string[] = []
  const rule = s["x-in"]
  if (rule && body !== null && body !== undefined) {
    const held = new Set(rows.filter((r) => String(r.shape) === String(rule.shape)).map((r) => JSON.stringify(at_(r, rule.path))))
    if (!held.has(JSON.stringify(body))) {
      bad.push(`${at || "/"} ${JSON.stringify(body)} is not one of what the ${rule.shape} rows shown hold at ${rule.path} (${[...held].join(" | ") || "none shown"})`)
    }
  }
  if (s.properties && typeof body === "object" && body !== null && !Array.isArray(body)) {
    for (const [k, sub] of Object.entries(s.properties)) {
      if (k in body) bad.push(...inIn(sub, (body as Record<string, unknown>)[k], rows, `${at}/${k}`))
    }
  }
  if (s.items && Array.isArray(body)) body.forEach((v, i) => bad.push(...inIn(s.items, v, rows, `${at}/${i}`)))
  return bad
}

// A schema property may say its value must be what a row the producer was shown holds:
// "x-equals": {"shape": <the shown rows' shape>, "path": <the dotted path in those rows>}. A grader then cannot state a
// fact about its inputs (whether a check ran, say) that the input does not hold. With no shown row of the shape, or
// shown rows that disagree at the path, the value is refused too: there is nothing it could equal.
type EqualsIn = { shape: string; path: string }
const at_ = (v: unknown, path: string): unknown =>
  String(path).split(".").reduce<unknown>((x, k) => (typeof x === "object" && x !== null ? (x as Record<string, unknown>)[k] : undefined), v)
export const equalsIn = (schema: unknown, body: unknown, rows: Array<Record<string, unknown>>, at = ""): string[] => {
  if (typeof schema !== "object" || schema === null) return []
  const s = schema as { "x-equals"?: EqualsIn; properties?: Record<string, unknown>; items?: unknown }
  const bad: string[] = []
  const rule = s["x-equals"]
  if (rule) {
    const held = [...new Set(rows.filter((r) => String(r.shape) === String(rule.shape)).map((r) => JSON.stringify(at_(r, rule.path))))]
    if (held.length !== 1 || held[0] !== JSON.stringify(body)) {
      bad.push(`${at || "/"} ${JSON.stringify(body)} is not what the ${rule.shape} row shown holds at ${rule.path} (${held.join(" | ") || "none shown"})`)
    }
  }
  if (s.properties && typeof body === "object" && body !== null && !Array.isArray(body)) {
    for (const [k, sub] of Object.entries(s.properties)) {
      if (k in body) bad.push(...equalsIn(sub, (body as Record<string, unknown>)[k], rows, `${at}/${k}`))
    }
  }
  if (s.items && Array.isArray(body)) body.forEach((v, i) => bad.push(...equalsIn(s.items, v, rows, `${at}/${i}`)))
  return bad
}

// Whether a row is one an inputs or context entry names: a shape, or {shape, where} with each where field equal to the
// row's (a list: any of its values).
// An entry names a shape, or a relation in its place: {answers_a_call: true} admits the answer of a tool call this
// request's root made, success or failure alike, whatever its shape (answersOf, produce.ts). Either way its where fields
// must hold too. Without answersOf a relational entry admits nothing.
export const matches = (r: Record<string, unknown>, e: unknown, answersOf?: (r: Record<string, unknown>) => boolean): boolean => {
  if (typeof e === "string") return String(r.shape) === e
  if (typeof e !== "object" || e === null) return false
  const { shape, where, answers_a_call } = e as { shape?: unknown; where?: Record<string, unknown>; answers_a_call?: unknown }
  const admitted = answers_a_call === true ? answersOf?.(r) === true : String(r.shape) === String(shape)
  return admitted && Object.entries(where ?? {}).every(([k, v]) => Array.isArray(v) ? v.includes(r[k]) : r[k] === v)
}

export const check = (schema: object, body: unknown): { ok: boolean; errors: string } => {
  const validate = ajv.compile(schema)
  const valid = validate(body)
  if (!valid) {
    return { ok: false, errors: ajv.errorsText(validate.errors) }
  }
  return { ok: true, errors: "" }
}

// AN ASK'S TARGET, AND REACH JUDGED ON IT. The owner's row a request's targets live in (x-target / x-reach: {from, field}:
// the request's newest row of shape `from`, its field `field`) lists what would show the ask was met: rows of a shape,
// holding values (where: dotted paths to plain values). Read as written, never filtered: what a target may be and how
// many are allowed is the producing schema's (items, maxItems), and a row breaking it is refused when it is made, so the
// row a person is shown and the targets a grade is held to are the same list.
export type Target = { shape: string; where?: Record<string, unknown> }
export type TargetSource = { from: string; field: string }
export const targetSourceOf = (x: unknown): TargetSource | undefined => {
  const o = typeof x === "object" && x !== null && !Array.isArray(x) ? x as Record<string, unknown> : undefined
  return o && typeof o.from === "string" && typeof o.field === "string" ? { from: o.from, field: o.field } : undefined
}
export const targetRowOf = (src: TargetSource, rows: Array<Record<string, unknown>>): Record<string, unknown> | undefined =>
  rows.filter((r) => r.shape === src.from).sort((a, b) => Number(b.seq ?? 0) - Number(a.seq ?? 0))[0]
// A target the producing schema would have refused (a row written before the schema said what a target is): which one,
// and why, so a grade held to it fails closed, said by name, never skipped and never a crash.
export const malformedTarget = (targets: unknown[]): string | undefined => {
  for (const [i, t] of targets.entries()) {
    const o = typeof t === "object" && t !== null && !Array.isArray(t) ? t as Record<string, unknown> : undefined
    if (o === undefined || typeof o.shape !== "string") return `target ${i} names no shape`
    if (o.where !== undefined && (typeof o.where !== "object" || o.where === null || Array.isArray(o.where))) return `target ${i}'s where is not a map of fields to values`
  }
  return undefined
}
export const targetsOf = (src: TargetSource, rows: Array<Record<string, unknown>>): Target[] => {
  const newest = targetRowOf(src, rows)
  const raw = newest?.[src.field]
  return Array.isArray(raw) ? raw as Target[] : []
}

// An r of 1 on a request with targets must cite (in `cite`, ids) a row it was shown that meets one: of the target's shape,
// holding its where values, and read after the change. Read: when some call declares it answers with that shape
// (shape_answers), the row is a call's answer (the walk's, with a call_id) whose call so declares and does not also
// declare it changes it (shape_changes): a changing call's own reply is the change reporting on itself, never its effect.
// After: newer than the newest started call, failed or not, of any type that declares it changes that shape; a change
// that failed while the target already held is reached, since the effect is there. A shape no call answers with (a
// person's grade) is met by the row itself. Returns the refusal, or undefined when met. Names no shape.
export const reachIn = (targets: Target[], cited: unknown, shown: Array<Record<string, unknown>>, all: Array<Record<string, unknown>>,
  answers: Record<string, string>, changes: Record<string, string[]>): string | undefined => {
  const started = all.filter((h) => h.shape === "hop" && h.phase === "started")
  const typeOf = new Map(started.map((h) => [String(h.call_id), String(h.pointer_type)]))
  const ids = new Set([cited ?? []].flat().map(String))
  const answered = new Set(Object.values(answers))
  const changedAt = (shape: string): number =>
    Math.max(-Infinity, ...started.filter((h) => (changes[String(h.pointer_type)] ?? []).includes(shape)).map((h) => Number(h.seq ?? 0)))
  const meets = (r: Record<string, unknown>, t: Target): boolean =>
    r.shape === t.shape && Object.entries(t.where ?? {}).every(([k, v]) => JSON.stringify(at_(r, k)) === JSON.stringify(v))
  const readOf = (r: Record<string, unknown>, shape: string): boolean => {
    if (!answered.has(shape)) return true
    const type = typeOf.get(String(r.call_id))
    return r.role === "walk" && type !== undefined && answers[type] === shape && !(changes[type] ?? []).includes(shape)
  }
  for (const r of shown.filter((x) => ids.has(String(x.id)))) {
    for (const t of targets) {
      if (meets(r, t) && readOf(r, t.shape) && Number(r.seq ?? 0) > changedAt(t.shape)) return undefined
    }
  }
  const said = targets.map((t) => `${t.shape}${t.where ? ` ${JSON.stringify(t.where)}` : ""}`).join(" or ")
  return `r 1 needs a cited row it was shown of ${said}, read after the newest change of it; none cited is one`
}
