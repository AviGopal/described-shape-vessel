// SPDX-License-Identifier: MIT
import { timingSafeEqual } from "node:crypto"
import { IDENTITY_URL, KEY } from "./config"
import { IDENTITY_RESOLVE } from "./routes"
import { AUTHENTICATION } from "./shapes"

// transient: refused because identity gave no answer (a 429, a 5xx, the connection reset), not because it said no: the
// caller is told to ask again later (503), never that its key is refused. No key is taken on it.
export type Who = { ok: boolean; self: boolean; keyId: string; transient?: true }
type Answer = { success: boolean; data: { authenticated: boolean; keyId: string } }

const known = new Map<string, string>()

const digest = (key: string): Buffer => new Bun.CryptoHasher("sha256").update(key).digest()

const OWN = digest(KEY)

export const keyOf = (req: Request): string => String(req.headers.get("authorization")).split(" ").slice(1).join(" ")

// What validate says when identity gave no answer, apart from a refusal (undefined).
const UNANSWERED = { transient: true } as const

// Identity's answer: the key's id; a refusal (it did not authenticate, or said 401/403); or no answer (any other status,
// the connection refused or reset, the body broken off). No answer is identity's outage, not the caller's refusal, and
// never a throw out of the request: one reset on the way to identity must not end this vessel.
const validate = async (key: string): Promise<string | typeof UNANSWERED | undefined> => {
  const h = digest(key).toString("hex")
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
  const r = await fetch(new URL(IDENTITY_RESOLVE, IDENTITY_URL).href, init).catch(() => undefined)
  if (r === undefined) {
    return UNANSWERED
  }
  if (!r.ok) {
    return r.status === 401 || r.status === 403 ? undefined : UNANSWERED
  }
  const a = (await r.json().catch(() => undefined)) as Answer | undefined
  if (a === undefined) {
    return UNANSWERED
  }
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
  const key = keyOf(req)
  if (timingSafeEqual(digest(key), OWN)) {
    return { ok: true, self: true, keyId: "" }
  }
  const keyId = await validate(key)
  if (keyId === undefined || typeof keyId !== "string") {
    return { ok: false, self: false, keyId: "", ...keyId }
  }
  return { ok: true, self: false, keyId }
}
