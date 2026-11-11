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

// Whether a row is one an inputs or context entry names: a shape, or {shape, where} with each where field equal to the
// row's (a list: any of its values).
export const matches = (r: Record<string, unknown>, e: unknown): boolean => {
  if (typeof e === "string") return String(r.shape) === e
  if (typeof e !== "object" || e === null) return false
  const { shape, where } = e as { shape?: unknown; where?: Record<string, unknown> }
  return String(r.shape) === String(shape) &&
    Object.entries(where ?? {}).every(([k, v]) => Array.isArray(v) ? v.includes(r[k]) : r[k] === v)
}

export const check = (schema: object, body: unknown): { ok: boolean; errors: string } => {
  const validate = ajv.compile(schema)
  const valid = validate(body)
  if (!valid) {
    return { ok: false, errors: ajv.errorsText(validate.errors) }
  }
  return { ok: true, errors: "" }
}
