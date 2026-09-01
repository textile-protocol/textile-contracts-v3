import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { network } from 'hardhat'

export const CANONICAL_PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3'

let permit2Runtime: string | undefined

/** Etch the real Permit2 runtime at its canonical address on the local chain. */
export async function etchPermit2(): Promise<void> {
  permit2Runtime ??= readFileSync(
    join(__dirname, '../../../scripts/v3/fixtures/permit2-runtime.hex'),
    'utf8'
  ).trim()
  await network.provider.send('hardhat_setCode', [CANONICAL_PERMIT2, permit2Runtime])
}
