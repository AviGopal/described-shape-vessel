// SPDX-License-Identifier: MIT
// How a row past its max is shown (produce.ts clip): never larger cut than whole, and its rendered cut form within max.
import { beforeAll, describe, expect, test } from "bun:test"

type Row = { id: string; [k: string]: unknown }
let clip: (r: Row, max: number) => Row

beforeAll(async () => {
  // produce.ts reads the unit's settings on import; none of them is used here
  for (const [k, v] of Object.entries({ DESCRIBED_VESSEL_ID: "clip-test", DESCRIBED_PORT: "0", DISCOVERY_URL: "http://127.0.0.1:1",
    DESCRIBED_ENDPOINT: "http://127.0.0.1:1", IDENTITY_VESSEL_URL: "http://127.0.0.1:1", METABOB_API_KEY: "clip-test-key" })) process.env[k] ??= v
  clip = ((await import("../src/produce")) as unknown as { clip: typeof clip }).clip
})

const CONTEXT = 8 * 1024
const WHOLE = 96 * 1024
const size = (v: unknown): number => JSON.stringify(v).length
// today's cut form, unbounded: the first max characters of the row's JSON
const today = (r: Row, max: number): number => {
  const whole = JSON.stringify(r)
  return size({ id: r.id, shape: r.shape, role: r.role, cut: true, bytes: whole.length, start: whole.slice(0, max) })
}
// a row of exactly n characters as JSON: a head, then pad repeated, then plain characters up to n
const rowOf = (n: number, head = "", pad = "a", more: Record<string, unknown> = {}): Row => {
  const base: Row = { id: "r1", shape: "hop", role: "walk", ...more, text: head }
  const per = size(pad) - 2
  const times = Math.floor((n - size(base)) / per)
  const r: Row = { ...base, text: head + pad.repeat(times) + "a".repeat(n - size(base) - times * per) }
  if (size(r) !== n) throw new Error(`rowOf(${n}) is ${size(r)}`)
  return r
}
const startOf = (c: Row): string => String(c.start)

describe("a row just past its max", () => {
  test("[MUST-FAIL] a row of max+15 or max+23, plain, is shown whole: its cut form would be no smaller", () => {
    for (const n of [CONTEXT + 15, CONTEXT + 23]) {
      const r = rowOf(n)
      expect(today(r, CONTEXT)).toBeGreaterThanOrEqual(n)
      const c = clip(r, CONTEXT)
      expect(c).toBe(r)
      expect(size(c)).toBe(n)
    }
  })

  test("[MUST-FAIL] a row whose cut form would be exactly its size is shown whole; one character more is cut, within max", () => {
    let n = CONTEXT + 1
    while (today(rowOf(n), CONTEXT) !== n) n++
    const r = rowOf(n)
    expect(clip(r, CONTEXT)).toBe(r)
    const past = rowOf(n + 1)
    expect(today(past, CONTEXT)).toBeLessThan(n + 1)
    const c = clip(past, CONTEXT)
    expect(c.cut).toBe(true)
    expect(size(c)).toBeLessThanOrEqual(CONTEXT)
  })

  test("[MUST-FAIL] a row of exactly max is unchanged; one of max+1, plain, is shown whole", () => {
    const at = rowOf(CONTEXT)
    expect(clip(at, CONTEXT)).toBe(at)
    const over = rowOf(CONTEXT + 1)
    expect(clip(over, CONTEXT)).toBe(over)
  })
})

describe("a cut row stays within its max, as rendered", () => {
  test("[MUST-FAIL] a quote-heavy row of about 20 KB is shown cut at no more than 8192 rendered", () => {
    const r = rowOf(20_000, "", '"\\')
    const c = clip(r, CONTEXT)
    expect(c.cut).toBe(true)
    expect(size(c)).toBeLessThanOrEqual(CONTEXT)
    expect(startOf(c).length).toBeGreaterThan(0)
  })

  test("[MUST-FAIL] a plain row of 20 KB is cut to the longest start that fits: one character more would not", () => {
    const r = rowOf(20_000)
    const c = clip(r, CONTEXT)
    const whole = JSON.stringify(r)
    const k = startOf(c).length
    expect(k).toBeGreaterThan(0)
    expect(startOf(c)).toBe(whole.slice(0, k))
    expect(size(c)).toBeLessThanOrEqual(CONTEXT)
    expect(size({ ...c, start: whole.slice(0, k + 1) })).toBeGreaterThan(CONTEXT)
  })

  test("a cut row carries exactly id, shape, role, cut, bytes and start: no seq, no writer", () => {
    const r = rowOf(20_000, "", "a", { seq: 4242, writer: "a-writer" })
    const c = clip(r, CONTEXT)
    expect(Object.keys(c)).toEqual(["id", "shape", "role", "cut", "bytes", "start"])
    expect(c.seq).toBeUndefined()
    expect(c.writer).toBeUndefined()
    expect([c.id, c.shape, c.role, c.cut, c.bytes]).toEqual(["r1", "hop", "walk", true, 20_000])
  })

  test("[MUST-FAIL] a surrogate pair at the cut is not split, and the start is still the longest whole characters that fit", () => {
    // pads one apart, under ids of different lengths: some put the bound inside a pair
    for (const id of ["r1", "r12", "r123", "r1234"]) for (const lead of [0, 1, 2, 3]) {
      const r: Row = { id, shape: "hop", role: "walk", text: "a".repeat(lead) + "\u{1F600}".repeat(10_000) }
      const whole = JSON.stringify(r)
      const c = clip(r, CONTEXT)
      const k = startOf(c).length
      expect(c.cut).toBe(true)
      expect(size(c)).toBeLessThanOrEqual(CONTEXT)
      expect(/[\uD800-\uDBFF]$/.test(startOf(c))).toBe(false)
      expect(startOf(c)).toBe(whole.slice(0, k))
      const next = k + (/[\uD800-\uDBFF]/.test(whole[k]) ? 2 : 1)
      expect(size({ ...c, start: whole.slice(0, next) })).toBeGreaterThan(CONTEXT)
    }
  })

  test("[MUST-FAIL] a whole entry's max (96 KiB) is bounded the same way", () => {
    // past twice the max: a quote-heavy start doubles when escaped again, so a smaller row's cut would be no smaller
    const quoted = clip(rowOf(250_000, "", '"\\'), WHOLE)
    expect(quoted.cut).toBe(true)
    expect(size(quoted)).toBeLessThanOrEqual(WHOLE)
    const plain = clip(rowOf(140_000), WHOLE)
    const k = startOf(plain).length
    expect(size(plain)).toBeLessThanOrEqual(WHOLE)
    expect(size({ ...plain, start: JSON.stringify(rowOf(140_000)).slice(0, k + 1) })).toBeGreaterThan(WHOLE)
    const near = rowOf(WHOLE + 15)
    expect(clip(near, WHOLE)).toBe(near)
  })
})
