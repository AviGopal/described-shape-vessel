// SPDX-License-Identifier: MIT
// What a request that threw is answered: 500, its stack logged. The throw is that request's failure alone; ending the
// process would end every call in flight with it and each vessel that needs this one, and anyone able to make one request
// throw (a reset connection on a call it makes) could do that again and again.
export const onServeError = (e: unknown): Response => {
  console.error(e instanceof Error ? (e.stack ?? String(e)) : String(e))
  return Response.json({ failure: { status: 500, body: "" } }, { status: 500 })
}
