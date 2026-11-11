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

export const check = (schema: object, body: unknown): { ok: boolean; errors: string } => {
  const validate = ajv.compile(schema)
  const valid = validate(body)
  if (!valid) {
    return { ok: false, errors: ajv.errorsText(validate.errors) }
  }
  return { ok: true, errors: "" }
}
