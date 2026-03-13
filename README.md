# Autonity Stake Terminal

Autonity Stake Terminal is a full-lifecycle staking interface for Autonity delegators.

The product goal is simple: staking UI should reveal protocol state, not hide it. Wallet mode and
vault mode are handled in one coherent surface so users can see where value is, what is pending,
and what can be executed now.

Note: To initiate on-chain operations, connect your address through an injected EVM wallet.

## Protocol-First Design

Autonity staking is not a one-click flow. It is a state machine with delayed transitions, queue
timing, validator ratios, and vault-specific interpretation layers. This terminal is designed to
make those mechanics explicit and operational for everyday delegators.

## What You Can Do

- Connect an injected EVM wallet and operate directly on Autonity staking flows.
- Discover and switch between wallet and vault delegation contexts.
- Stake (`bond`) NTN to active validators.
- Unstake (`unbond`) LNTN with queue-aware status tracking.
- Claim rewards from validator positions.
- Release ready vault funds to wallet when protocol conditions are met.
- Inspect validator and position context in one place: identity, fee, total stake, self-bonded,
  live conversion ratio (`1 LNTN = x NTN`), and your stake.
- Track protocol requests in chronological order with clear phase labels.
- View balances and staking totals across wallet and vault contexts without ambiguity.

## Protocol Model

```text
Wallet NTN
  -> bond
Bonded position
  -> represented as
LNTN
  -> unbond
Queue request created
  -> waiting period
Ready / Released
  -> vault release
Withdrawable NTN
  -> withdraw
Wallet NTN
```

Behavioral truth:

- `bond` is instant from user perspective after transaction confirmation.
- `unbond` is delayed by protocol queue timing.
- `ready queue` is not always equal to immediate wallet-ready value.
- `vault mode` adds one more interpretation layer on top of the same protocol mechanics.

## UX Direction

- Full-width terminal-style layout for high-density state visibility.
- State-first hierarchy with minimal admin noise.
- Action controls placed where intent occurs: card-level global actions and inline row actions.
- Consistent token-location language: staked, claimable, vesting-locked, releasable, withdrawable.

## Stack

- Next.js, React, TypeScript
- Ethers.js for chain interaction
- Validator metadata enrichment from a cached registry source

## ABIs & Contract Reads

The terminal uses minimal ABI surfaces focused on staking lifecycle operations.

- Autonity Protocol Contract
  - Reads: `getCommittee`, `getValidators`, `getValidator`, `getUnbondingPeriod`,
    request lookup methods
  - Writes: `bond`, `unbond`
  - Events: bonding/unbonding request events
- Liquid Newton (per validator)
  - Reads: `balanceOf`, `lockedBalanceOf`, `unlockedBalanceOf`, `unclaimedRewards`
  - Writes: `claimRewards`
- Vault Contract
  - Reads: `getBeneficiary`, `getValidatorSet`, `liquidBalance`, `unlockedFunds`
  - Writes: `bond`, `unbond`, `claimAllStakingRewards`, `releaseFunds`

Runtime ABI override is not exposed in the UI. ABI updates are handled in source control and
released with app updates to keep behavior deterministic.

## References

- Autonity Contract Interface: https://docs.autonity.org/reference/api/aut/
- Liquid Newton Contract Interface: https://docs.autonity.org/reference/api/liquid-newton/
- Bond / Unbond guide: https://docs.autonity.org/delegators/bond-stake/
- Claim rewards guide: https://docs.autonity.org/delegators/claim-rewards/
- Stakeflow network registry: https://github.com/stakeflow/network-registry

## Disclaimer

This software is provided for informational and operational tooling purposes. It is provided
"as is", without warranties of any kind. Users are responsible for verifying all on-chain actions,
addresses, amounts, and network parameters before confirming transactions.

## License

MIT - see `LICENSE`.
