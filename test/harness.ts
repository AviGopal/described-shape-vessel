// SPDX-License-Identifier: MIT
// Test-only stand-ins for discovery and identity, and a way to run the vessel as its unit would.
import { join } from "node:path"

export type Seen = { path: string; body: unknown; auth: string | null }
export type Fake = { url: string; seen: Seen[]; stop: () => void }
type Answer = (path: string, body: any, auth: string | null) => Response | Promise<Response>

export const fake = (answer: Answer): Fake => {
  const seen: Seen[] = []
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname
      const body = req.method === "POST" ? await req.json().catch(() => null) : null
      const auth = req.headers.get("authorization")
      seen.push({ path, body, auth })
      return answer(path, body, auth)
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, seen, stop: () => server.stop(true) }
}

export const freePort = (): number => {
  const s = Bun.serve({ port: 0, fetch: () => new Response() })
  const port = s.port as number
  s.stop(true)
  return port
}

const ROOT = join(import.meta.dir, "..")

export const run = (entry: string, env: Record<string, string>) =>
  Bun.spawn([process.execPath, entry], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  })

export const healthy = async (port: number): Promise<Response> => {
  for (let i = 0; i < 200; i++) {
    const r = await fetch(`http://127.0.0.1:${port}/health`).catch(() => undefined)
    if (r?.ok) return r
    await Bun.sleep(25)
  }
  throw new Error(`no /health on ${port}`)
}

// A missing boot value exits 1 and names the variable, never a value.
export const exitsNaming = async (entry: string, env: Record<string, string>) => {
  const p = run(entry, env)
  const code = await p.exited
  return { code, stderr: await new Response(p.stderr).text() }
}
