// SPDX-License-Identifier: MIT
const need = (name: string, v: string | undefined): string => {
  if (v === undefined) {
    console.error(`missing env ${name}`)
    process.exit(1)
  }
  return v
}
export const VESSEL_ID = need("DESCRIBED_VESSEL_ID", process.env.DESCRIBED_VESSEL_ID)
export const PORT = Number(need("DESCRIBED_PORT", process.env.DESCRIBED_PORT))
export const DISCOVERY_URL = need("DISCOVERY_URL", process.env.DISCOVERY_URL)
export const ENDPOINT = need("DESCRIBED_ENDPOINT", process.env.DESCRIBED_ENDPOINT)
export const IDENTITY_URL = need("IDENTITY_VESSEL_URL", process.env.IDENTITY_VESSEL_URL)
export const KEY = need("METABOB_API_KEY", process.env.METABOB_API_KEY)
