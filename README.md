# Autonity Stake Terminal

Production-oriented Autonity wallet/vault dashboard.

## What it does

- Injected EVM wallet connect + Autonity chain switch/add
- Auto vault discovery for connected beneficiary
- Wallet ATN / NTN balances
- Delegation table (locked/unlocked/total LNTN + claimable rewards)
- Bond / Unbond flows
- Claim rewards
  - Wallet mode: per-validator claim
  - Vault mode: claim all staking rewards
- Unbonding request tracking
- Vault release funds action

## Acknowledgements

<img src="./public/validator-logos/0x05e5417c65f5f81bf6dccd3bded30fa779a5ec78.png" alt="Stakeflow logo" width="20" height="20" />

Thanks to [`stakeflow/network-registry`](https://github.com/stakeflow/network-registry) for
providing validator moniker and logo data used in this project.

## Production build

```bash
npm run lint
npm run build
npm start
```

Environment variables are documented in `./.env.sample`.

<sub>for donations: <code>0xBA917955E2c1b3bF67dfdaAe9D78508f11ccE862</code></sub>
