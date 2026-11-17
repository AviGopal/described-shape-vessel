// SPDX-License-Identifier: MIT
// The reach rule's clauses, one leg each (check.ts targetsOf, reachIn): which row names the targets, what a target is,
// what counts as a read of one, and after what.
import { describe, expect, test } from "bun:test"
import { reachIn, targetsOf } from "../src/check"

const src = { from: "change_wanted", field: "targets" }
const T = { shape: "viewState" }
const answers = { view_read: "viewState", other_read: "otherState" }
const changes = { view_write: ["viewState"] }
const hop = (id: string, seq: number, call: string, type: string, phase = "started") => ({ shape: "hop", id, seq, phase, call_id: call, pointer_type: type })
const state = (id: string, seq: number, call: string, more: Record<string, unknown> = {}) => ({ shape: "viewState", id, seq, role: "walk", call_id: call, ...more })

describe("which targets a request names", () => {
  test("[MUST-FAIL] the newest row of the source decides", () => {
    const rows = [{ shape: "change_wanted", id: "c1", seq: 1, targets: [{ shape: "old" }] }, { shape: "change_wanted", id: "c2", seq: 2, targets: [{ shape: "new" }] }]
    expect(targetsOf(src, rows).map((t) => t.shape)).toEqual(["new"])
  })
  test("[MUST-FAIL] the row is read as written: every target it lists, none dropped", () => {
    // what a target may be and how many is the producing schema's, refused at the write (described.test.ts); the judge
    // reads the row as the person sees it
    const four = [1, 2, 3, 4].map((n) => ({ shape: `s${n}` }))
    expect(targetsOf(src, [{ shape: "change_wanted", id: "c", seq: 1, targets: four }])).toEqual(four)
  })
})

describe("what counts as a read of a target, and after what", () => {
  const all = [hop("hw", 5, "w", "view_write"), hop("hr", 7, "r", "view_read"), state("s-read", 8, "r")]
  test("[MUST-FAIL] a later hop of a changing call that is not its start does not move the change", () => {
    // the change started at 5; its end (phase ended, seq 9) is not a new change: the read at 8 is after it
    const ended = [...all, hop("hwe", 9, "w", "view_write", "ended")]
    expect(reachIn([T], ["s-read"], ended, ended, answers, changes)).toBeUndefined()
  })
  test("[MUST-FAIL] a walk row of the shape from a call that answers with another shape is no read of it", () => {
    const rows = [...all, hop("ho", 10, "o", "other_read"), state("s-other", 11, "o")]
    expect(reachIn([T], ["s-other"], rows, rows, answers, changes)).toBeDefined()
  })
  test("[MUST-FAIL] only a row the grader was shown counts, whatever the request holds", () => {
    expect(reachIn([T], ["s-read"], all.filter((r) => r.id !== "s-read"), all, answers, changes)).toBeDefined()
    expect(reachIn([T], ["s-read"], all, all, answers, changes)).toBeUndefined()
  })
})
