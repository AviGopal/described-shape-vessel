// SPDX-License-Identifier: MIT
// How soon discovery is asked again after no answer or a refusal: a second, doubling each time to a minute, and a second
// again once it answers. A pure schedule, so a test reads it without a vessel. records carries the same copy.
export const AGAIN_MS = 1000
export const AGAIN_MAX_MS = 60_000
export const again = (wait: number): number => Math.min(wait * 2, AGAIN_MAX_MS)
