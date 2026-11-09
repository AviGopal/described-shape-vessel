// SPDX-License-Identifier: MIT
import { DISCOVERY_URL, ENDPOINT, KEY, VESSEL_ID } from "./config"
import { AUTH_SCHEME, HEARTBEAT, REGISTER } from "./routes"

type Answer = { nextHeartbeatMs: number }

const post = async (path: string, payload: object): Promise<Answer> => {
  const init = {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `${AUTH_SCHEME} ${KEY}` },
    body: JSON.stringify(payload),
    timeout: false,
  }
  const r = await fetch(new URL(path, DISCOVERY_URL).href, init)
  if (!r.ok) {
    process.exit(1)
  }
  return (await r.json()) as Answer
}

export const register = async (shapes: string[]): Promise<void> => {
  await post(REGISTER, { vesselId: VESSEL_ID, endpoint: ENDPOINT, shapes })
}

export const beat = async (): Promise<void> => {
  while (true) {
    const a = await post(HEARTBEAT, { vesselId: VESSEL_ID })
    await Bun.sleep(a.nextHeartbeatMs)
  }
}
