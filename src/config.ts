// SPDX-License-Identifier: MIT
const need = (v: string | undefined): string => {
  if (v === undefined) {
    process.exit(1)
  }
  return v
}
export const VESSEL_ID = need(process.env.DESCRIBED_VESSEL_ID)
export const PORT = Number(need(process.env.DESCRIBED_PORT))
export const DISCOVERY_URL = need(process.env.DISCOVERY_URL)
export const ENDPOINT = need(process.env.DESCRIBED_ENDPOINT)
export const IDENTITY_URL = need(process.env.IDENTITY_VESSEL_URL)
export const KEY = need(process.env.METABOB_API_KEY)
