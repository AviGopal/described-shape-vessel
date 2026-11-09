// SPDX-License-Identifier: MIT
import Ajv from "ajv"

const ajv = new Ajv({ strict: false })

export const check = (schema: object, body: unknown): { ok: boolean; errors: string } => {
  const validate = ajv.compile(schema)
  const valid = validate(body)
  if (!valid) {
    return { ok: false, errors: ajv.errorsText(validate.errors) }
  }
  return { ok: true, errors: "" }
}
