// SPDX-License-Identifier: MIT
import { AGAIN_MS, again } from "./again"
import { DISCOVERY_URL, ENDPOINT, KEY, VESSEL_ID } from "./config"
import { AUTH_SCHEME, HEARTBEAT, REGISTER } from "./routes"

type Answer = { nextHeartbeatMs: number }
type Posted = { ok: true; answer: Answer } | { ok: false; status: number; why: string }

const NO_LIMIT_MS = 2147483647

// One post to discovery: its answer, or why there was none (status 0: nothing came back), never a throw.
const post = async (path: string, payload: object): Promise<Posted> => {
  const init = {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `${AUTH_SCHEME} ${KEY}` },
    body: JSON.stringify(payload),
    timeout: false,
  }
  try {
    const r = await fetch(new URL(path, DISCOVERY_URL).href, init)
    if (!r.ok) return { ok: false, status: r.status, why: (await r.text().catch(() => "")).slice(0, 200) }
    return { ok: true, answer: (await r.json()) as Answer }
  } catch (e) {
    return { ok: false, status: 0, why: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }
  }
}

// Discovery not answering, or refusing, never ends this vessel: a restart cuts every produce in flight. It says why and
// asks again, waiting longer each time.
const said = (path: string, p: { status: number; why: string }, wait: number): void =>
  console.error(`[described] ${path} ${p.status === 0 ? "had no answer" : `answered ${p.status}`} (${p.why}); asking again in ${Math.round(wait / 1000)} s`)

export const register = async (shapes: string[]): Promise<void> => {
  for (let wait = AGAIN_MS; ; wait = again(wait)) {
    const p = await post(REGISTER, { vesselId: VESSEL_ID, endpoint: ENDPOINT, shapes, resolve_timeout_ms: NO_LIMIT_MS })
    if (p.ok) return
    said(REGISTER, p, wait)
    await Bun.sleep(wait)
  }
}

// Between beats the shapes served are read again (targets): a schema the owner writes later is served from the next beat,
// not from the next restart. A read that fails keeps what is registered. A heartbeat discovery answers 404 for does not
// know this vessel (discovery restarted): it is registered again with what it serves now.
export const beat = async (shapes: string[], targets: () => Promise<string[] | null>): Promise<void> => {
  let served = [...shapes].sort()
  for (let wait = AGAIN_MS; ;) {
    const p = await post(HEARTBEAT, { vesselId: VESSEL_ID })
    if (!p.ok) {
      said(HEARTBEAT, p, wait)
      if (p.status === 404) {
        await register(served)
        continue
      }
      await Bun.sleep(wait)
      wait = again(wait)
      continue
    }
    wait = AGAIN_MS
    await Bun.sleep(p.answer.nextHeartbeatMs)
    // a read that throws (discovery gone between beats) has failed like any other
    const now = await targets().catch(() => null)
    if (now !== null && JSON.stringify([...now].sort()) !== JSON.stringify(served)) {
      await register(now)
      served = [...now].sort()
    }
  }
}
