export const AUT_CHAIN_ID = Number(process.env.NEXT_PUBLIC_AUT_CHAIN_ID || 65000000);
export const AUT_RPC_URL =
  process.env.NEXT_PUBLIC_AUT_RPC_URL || "https://rpc.autonity-apis.com";
export const AUTONITY_CONTRACT =
  process.env.NEXT_PUBLIC_AUTONITY_CONTRACT ||
  "0xBd770416a3345F91E4B34576cb804a576fa48EB1";
export const STAKING_MANAGER_ADDRESS =
  process.env.NEXT_PUBLIC_STAKING_MANAGER ||
  "0x5FDEF1B5c7147Bff81C2Dc1726b4F71F4b24948F";

export const VAULT_CREATED_TOPIC =
  "0x6fe2c2f097ea0c7b2bdef0a3e4a51d811803070a419a58a1eee7e8217917b890";

export const EXPLORER_TX_BASE =
  process.env.NEXT_PUBLIC_EXPLORER_TX_BASE ||
  "https://blockscout.akeyra.klazomenai.dev/tx/";

export const AUTONITY_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function bond(address _validator, uint256 _amount) returns (uint256)",
  "function unbond(address _validator, uint256 _amount) returns (uint256)",
  "function getCommittee() view returns ((address addr,uint256 votingPower,bytes consensusKey)[])",
  "function getValidators() view returns (address[])",
  "function getValidator(address _addr) view returns ((address treasury,address nodeAddress,address oracleAddress,string enode,uint256 commissionRate,uint256 bondedStake,uint256 unbondingStake,uint256 unbondingShares,uint256 selfBondedStake,uint256 selfUnbondingStake,uint256 selfUnbondingShares,uint256 selfUnbondingStakeLocked,address liquidStateContract,uint256 liquidSupply,uint256 registrationBlock,uint256 totalSlashed,uint256 jailReleaseBlock,bytes consensusKey,uint8 state,uint256 conversionRatio))",
  "function getEpochPeriod() view returns (uint256)",
  "function getUnbondingPeriod() view returns (uint256)",
  "function getBondingRequestByID(uint256 _id) view returns (address delegator,address delegatee,uint256 amount,uint256 requestBlock)",
  "function getUnbondingRequestByID(uint256 _id) view returns ((address delegator,address delegatee,uint256 amount,uint256 unbondingShare,uint256 requestBlock,bool unlocked,bool released,bool selfDelegation))",
  "event NewBondingRequest(address indexed validator,address indexed delegator,address indexed caller,bool selfBonded,uint256 amount,uint256 headBondingID)",
  "event NewUnbondingRequest(address indexed validator,address indexed delegator,address indexed caller,bool selfBonded,uint256 amount,uint256 headUnbondingID)",
] as const;

export const LIQUID_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function lockedBalanceOf(address) view returns (uint256)",
  "function unlockedBalanceOf(address) view returns (uint256)",
  "function unclaimedRewards(address) view returns (uint256)",
  "function claimRewards()",
] as const;

export const VAULT_ABI = [
  "function getBeneficiary() view returns (address)",
  "function getValidatorSet() view returns (address[])",
  "function liquidBalance(address validator) view returns (uint256)",
  "function unlockedFunds() view returns (uint256)",
  "function bond(address validator, uint256 amount)",
  "function unbond(address validator, uint256 amount)",
  "function claimAllStakingRewards()",
  "function releaseFunds()",
] as const;

export const AUTONITY_CHAIN_CONFIG = {
  chainId: `0x${AUT_CHAIN_ID.toString(16)}`,
  chainName: "Autonity Mainnet",
  nativeCurrency: {
    name: "Autonity",
    symbol: "ATN",
    decimals: 18,
  },
  rpcUrls: [AUT_RPC_URL],
  blockExplorerUrls: ["https://blockscout.akeyra.klazomenai.dev"],
};
