// SPDX-License-Identifier: MIT
import { IDENTITY_URL } from "./config"
import { IDENTITY_RESOLVE } from "./routes"
import { AUTHENTICATION } from "./shapes"

export type Who = { ok: boolean; keyId: string }
type Answer = { success: boolean; data: { authenticated: boolean; keyId: string } }

const known = new Map<string, string>()

const validate = async (key: string): Promise<string | undefined> => {
  const h = new Bun.CryptoHasher("sha256").update(key).digest("hex")
  const hit = known.get(h)
  if (hit !== undefined) {
    return hit
  }
  const init = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ impulse: { type: AUTHENTICATION, pointer: { type: "apiKey", apiKey: key } } }),
    timeout: false,
  }
  const r = await fetch(new URL(IDENTITY_RESOLVE, IDENTITY_URL).href, init)
  if (!r.ok) {
    return undefined
  }
  const a = (await r.json()) as Answer
  if (!a.success) {
    return undefined
  }
  if (!a.data.authenticated) {
    return undefined
  }
  known.set(h, String(a.data.keyId))
  return String(a.data.keyId)
}

export const authenticate = async (req: Request): Promise<Who> => {
  const keyId = await validate(String(req.headers.get("authorization")).split(" ").slice(1).join(" "))
  if (keyId === undefined) {
    return { ok: false, keyId: "" }
  }
  return { ok: true, keyId }
}
