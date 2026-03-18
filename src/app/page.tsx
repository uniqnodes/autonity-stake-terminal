"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BrowserProvider,
  Contract,
  Interface,
  JsonRpcProvider,
  ZeroAddress,
  formatUnits,
  getAddress,
  isAddress,
  parseUnits,
  zeroPadValue,
} from "ethers";
import styles from "./page.module.css";
import {
  AUT_CHAIN_ID,
  AUTONITY_ABI,
  AUTONITY_CHAIN_CONFIG,
  AUTONITY_CONTRACT,
  AUT_RPC_URL,
  EXPLORER_TX_BASE,
  LIQUID_ABI,
  STAKING_MANAGER_ADDRESS,
  VAULT_ABI,
  VAULT_CREATED_TOPIC,
} from "@/lib/autonity";
import Image from "next/image";

type EvmProvider = {
  request: (args: { method: string; params?: unknown[] | object }) => Promise<unknown>;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
  isMetaMask?: boolean;
  isCoinbaseWallet?: boolean;
  isBraveWallet?: boolean;
  providers?: EvmProvider[];
  connect?: () => Promise<void>;
  enable?: () => Promise<string[]>;
  accounts?: string[];
  disconnect?: () => Promise<void> | void;
};

declare global {
  interface Window {
    ethereum?: EvmProvider;
  }
}

type DelegationRow = {
  validator: string;
  liquidContract: string;
  locked: bigint;
  unlocked: bigint;
  total: bigint;
  unclaimedRewards: bigint;
  conversionRatio: bigint;
  validatorStatus: "active" | "inactive" | "jailed";
};

type ActiveValidatorOption = {
  address: string;
  liquidContract: string;
  commissionRate: bigint;
  totalStake: bigint;
  selfBondedStake: bigint;
  delegatorCount: number | null;
  conversionRatio: bigint;
  moniker: string | null;
  logoPath: string | null;
  validatorStatus: "active" | "inactive" | "jailed";
};

type ValidatorRegistryMeta = {
  moniker: string | null;
  logoPath: string | null;
};

type QueueRow = {
  id: string;
  validator: string;
  amount: bigint;
  requestBlock: number;
  phase: "waiting" | "ready" | "done";
  action: "Unstake" | "Stake";
  tokenSymbol: "LNTN" | "NTN";
  remainingBlocks: number | null;
};

const ZERO = BigInt(0);
const WAD = BigInt("1000000000000000000");
const ATN_SIX_DP_FLOOR = BigInt("1000000000000"); // 0.000001 ATN (18 decimals)
const VAULT_VESTING_STATE_TOPIC =
  "0xb19316214d9e28227641ca749a201b334fb33066fa8537dd222a365e5e073f9e";
const VAULT_FUNDS_RELEASED_TOPIC =
  "0xeed10c470424824e4a4309075162f10b9989088b23fbed2349698cedd44493fb";
const MANUAL_DISCONNECT_KEY = "autodesk:manual_disconnect";
const WALLETCONNECT_PROJECT_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "";
const HAS_WALLETCONNECT = WALLETCONNECT_PROJECT_ID.length > 0;

type ActionPanel = "stake" | "unstake" | "claim";
type PositionInlineAction = { type: "stake" | "unstake"; validator: string };
type ValidatorIdentityView = {
  moniker: string | null;
  logoPath: string | null;
  validatorStatus?: "active" | "inactive" | "jailed";
};

function sameAddress(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase();
}

function shortAddress(address: string) {
  return `${address.slice(0, 8)}...${address.slice(-6)}`;
}

function formatToken(value: bigint, decimals = 18, precision = 6) {
  const text = formatUnits(value, decimals);
  const [wholeRaw, fracRaw = ""] = text.split(".");
  const whole = wholeRaw.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = fracRaw.slice(0, precision).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

function formatConversionRatio(ratio: bigint | null | undefined, precision = 6) {
  if (!ratio || ratio <= ZERO) {
    return "-";
  }
  return formatToken(ratio, 18, precision);
}

function parseError(error: unknown) {
  const message =
    (error as { shortMessage?: string })?.shortMessage ||
    (error as { reason?: string })?.reason ||
    (error as { message?: string })?.message ||
    String(error);
  return message
    .replace(/^execution reverted:?\s*/i, "")
    .replace(/^Error: /, "")
    .trim();
}

const AUTONITY_CHAIN_NAME = AUTONITY_CHAIN_CONFIG.chainName || "Autonity";

const chainSwitchErrorMessage = (error: unknown) => {
  const code = (error as { code?: number })?.code;
  const message = (error as { message?: string })?.message || "";
  if (code === 4902) {
    return `Could not add ${AUTONITY_CHAIN_NAME} to your wallet. Please add chain ID ${AUT_CHAIN_ID} manually.`;
  }
  if (code === 4001) {
    return `Chain switch cancelled. Please approve switching to ${AUTONITY_CHAIN_NAME}.`;
  }
  if (code === 4900) {
    return "Wallet is disconnected from a network. Reconnect and retry.";
  }
  if (code === 4100) {
    return "Wallet not authorized. Reconnect and approve network/signature requests.";
  }
  if (code === 4200) {
    return "Wallet does not support this network method. Add Autonity Mainnet manually.";
  }
  const normalized = message.trim();
  if (normalized) {
    return `Chain switch failed. ${normalized}`;
  }
  return `Please switch your wallet to ${AUTONITY_CHAIN_NAME}.`;
};

function formatCommissionRate(rate: bigint) {
  const percent = Number(rate) / 100;
  if (!Number.isFinite(percent)) return "-";
  return `${percent.toFixed(2)}%`;
}

function toAddressTopic(topic: string) {
  return getAddress(`0x${topic.slice(26)}`);
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function deriveValidatorStatus(
  inActiveCommittee: boolean,
  jailReleaseBlock: bigint,
  currentBlock: number
): "active" | "inactive" | "jailed" {
  if (jailReleaseBlock > ZERO && Number(jailReleaseBlock) > currentBlock) {
    return "jailed";
  }
  return inActiveCommittee ? "active" : "inactive";
}

function formatValidatorStatus(status: "active" | "inactive" | "jailed") {
  if (status === "active") return "Active";
  if (status === "jailed") return "Jailed";
  return "Inactive";
}

function formatClaimAtn(value: bigint) {
  if (value === ZERO) return "0";
  if (value > ZERO && value < ATN_SIX_DP_FLOOR) return "< 0.000001";
  return formatToken(value, 18, 6);
}

function lntnToNtn(lntnAmount: bigint, conversionRatio: bigint) {
  if (lntnAmount <= ZERO || conversionRatio <= ZERO) return ZERO;
  return (lntnAmount * conversionRatio) / WAD;
}

function sumDelegationNtnEquivalent(rows: DelegationRow[]) {
  return rows.reduce((sum, row) => sum + lntnToNtn(row.total, row.conversionRatio), ZERO);
}

export default function HomePage() {
  const rpcProvider = useMemo(() => new JsonRpcProvider(AUT_RPC_URL), []);

  const [account, setAccount] = useState("");
  const [chainId, setChainId] = useState<number | null>(null);
  const [selectedDelegator, setSelectedDelegator] = useState("");
  const [currentBlock, setCurrentBlock] = useState<number | null>(null);
  const [vaults, setVaults] = useState<string[]>([]);

  const [walletAtn, setWalletAtn] = useState<bigint>(ZERO);
  const [walletNtn, setWalletNtn] = useState<bigint>(ZERO);
  const [vaultNtnBalance, setVaultNtnBalance] = useState<bigint | null>(null);
  const [portfolioNtnEquivalent, setPortfolioNtnEquivalent] = useState<bigint>(ZERO);
  const [portfolioStakedNtn, setPortfolioStakedNtn] = useState<bigint>(ZERO);
  const [vaultReleasableNtn, setVaultReleasableNtn] = useState<bigint | null>(null);
  const [vaultVestingTotalNtn, setVaultVestingTotalNtn] = useState<bigint | null>(null);
  const [vaultVestingReleasedNtnApprox, setVaultVestingReleasedNtnApprox] = useState<bigint | null>(
    null
  );
  const [activeValidators, setActiveValidators] = useState<ActiveValidatorOption[]>([]);
  const [delegations, setDelegations] = useState<DelegationRow[]>([]);
  const [unbondings, setUnbondings] = useState<QueueRow[]>([]);

  const [activeAction, setActiveAction] = useState<ActionPanel | null>(null);
  const [positionInlineAction, setPositionInlineAction] = useState<PositionInlineAction | null>(
    null
  );
  const [positionInlineAmount, setPositionInlineAmount] = useState("");
  const [positionInlineExactMaxAmount, setPositionInlineExactMaxAmount] = useState<bigint | null>(
    null
  );

  const [bondValidator, setBondValidator] = useState("");
  const [unbondDropdownOpen, setUnbondDropdownOpen] = useState(false);
  const [unbondSearch, setUnbondSearch] = useState("");
  const [claimDropdownOpen, setClaimDropdownOpen] = useState(false);
  const [claimSearch, setClaimSearch] = useState("");
  const [bondAmount, setBondAmount] = useState("");
  const [bondExactMaxAmount, setBondExactMaxAmount] = useState<bigint | null>(null);
  const [unbondValidator, setUnbondValidator] = useState("");
  const [unbondAmount, setUnbondAmount] = useState("");
  const [unbondExactMaxAmount, setUnbondExactMaxAmount] = useState<bigint | null>(null);
  const [claimValidator, setClaimValidator] = useState("");
  const [walletHydrated, setWalletHydrated] = useState(false);
  const [hasInjectedWallet, setHasInjectedWallet] = useState(false);
  const [activeWalletProvider, setActiveWalletProvider] = useState<EvmProvider | null>(null);

  const [statusLine, setStatusLine] = useState("Connect your wallet to start.");
  const [actionLine, setActionLine] = useState("");
  const [lastTxHash, setLastTxHash] = useState("");
  const [copiedAddressType, setCopiedAddressType] = useState<"wallet" | "vault" | null>(null);
  const [walletMenuOpen, setWalletMenuOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [queuePage, setQueuePage] = useState(1);
  const [brokenLogos, setBrokenLogos] = useState<Record<string, true>>({});

  const unbondDropdownRef = useRef<HTMLDivElement | null>(null);
  const claimDropdownRef = useRef<HTMLDivElement | null>(null);
  const walletMenuRef = useRef<HTMLDivElement | null>(null);
  const validatorRegistryCacheRef = useRef<Record<string, ValidatorRegistryMeta>>({});
  const validatorRegistryLoadRef = useRef<Promise<Record<string, ValidatorRegistryMeta>> | null>(
    null
  );
  const apiSessionAddressRef = useRef("");

  const isConnected = account.length > 0;
  const onCorrectChain = chainId === AUT_CHAIN_ID;
  const isVaultMode =
    isConnected && selectedDelegator.length > 0 && !sameAddress(selectedDelegator, account);

  const claimableRewards = delegations.reduce((sum, row) => sum + row.unclaimedRewards, ZERO);
  const canReleaseVaultFunds = isVaultMode && vaultReleasableNtn !== null && vaultReleasableNtn > ZERO;

  const selectedUnbondValidatorRow = unbondValidator
    ? delegations.find((row) => sameAddress(row.validator, unbondValidator))
    : null;

  const selectedBondValidatorInfo = activeValidators.find((item) =>
    sameAddress(item.address, bondValidator)
  );
  const unbondableRows = delegations.filter((row) => row.unlocked > ZERO);
  const rewardRows = delegations.filter((row) => row.unclaimedRewards > ZERO);
  const selectedClaimValidatorRow = claimValidator
    ? rewardRows.find((row) => sameAddress(row.validator, claimValidator))
    : null;

  const myStakeByValidator = useMemo(() => {
    const map = new Map<string, bigint>();
    for (const row of delegations) {
      map.set(row.validator.toLowerCase(), row.total);
    }
    return map;
  }, [delegations]);

  const validatorRankMap = useMemo(() => {
    const map = new Map<string, number>();
    activeValidators.forEach((item, index) => {
      map.set(item.address.toLowerCase(), index + 1);
    });
    return map;
  }, [activeValidators]);

  const validatorIdentityMap = useMemo(() => {
    const map = new Map<string, ValidatorIdentityView>();

    for (const [address, meta] of Object.entries(validatorRegistryCacheRef.current)) {
      map.set(address.toLowerCase(), {
        moniker: meta.moniker,
        logoPath: meta.logoPath,
      });
    }

    for (const item of activeValidators) {
      const key = item.address.toLowerCase();
      const prev = map.get(key);
      map.set(key, {
        moniker: item.moniker ?? prev?.moniker ?? null,
        logoPath: item.logoPath ?? prev?.logoPath ?? null,
        validatorStatus: item.validatorStatus,
      });
    }

    for (const row of delegations) {
      const key = row.validator.toLowerCase();
      const prev = map.get(key);
      map.set(key, {
        moniker: prev?.moniker ?? null,
        logoPath: prev?.logoPath ?? null,
        validatorStatus: row.validatorStatus,
      });
    }

    return map;
  }, [activeValidators, delegations]);

  const getValidatorIdentity = useCallback(
    (address: string) => validatorIdentityMap.get(address.toLowerCase()) || null,
    [validatorIdentityMap]
  );

  const getValidatorLabel = useCallback(
    (address: string) => {
      const identity = getValidatorIdentity(address);
      return identity?.moniker || shortAddress(address);
    },
    [getValidatorIdentity]
  );

  const filteredUnbondableRows = useMemo(() => {
    const q = unbondSearch.trim().toLowerCase();
    if (!q) return unbondableRows;
    return unbondableRows.filter((row) => {
      const label = `${getValidatorLabel(row.validator)} ${row.validator}`.toLowerCase();
      return label.includes(q);
    });
  }, [getValidatorLabel, unbondSearch, unbondableRows]);

  const filteredRewardRows = useMemo(() => {
    const q = claimSearch.trim().toLowerCase();
    if (!q) return rewardRows;
    return rewardRows.filter((row) => {
      const label = `${getValidatorLabel(row.validator)} ${row.validator}`.toLowerCase();
      return label.includes(q);
    });
  }, [claimSearch, getValidatorLabel, rewardRows]);

  const renderValidatorIdentity = useCallback(
    (address: string) => {
      const identity = getValidatorIdentity(address);
      const lower = address.toLowerCase();
      const displayName = identity?.moniker || shortAddress(address);
      const fallbackInitials = (identity?.moniker || address.slice(2, 4)).slice(0, 2).toUpperCase();
      const logoPath = identity?.logoPath || null;

      return (
        <span className={`${styles.validatorIdentity} ${styles.validatorIdentityCompact}`}>
          {logoPath && !brokenLogos[lower] ? (
            <Image
              src={logoPath}
              alt={displayName}
              className={`${styles.validatorLogo} ${styles.validatorLogoCompact}`}
              width={18}
              height={18}
              onError={() =>
                setBrokenLogos((prev) => ({
                  ...prev,
                  [lower]: true,
                }))
              }
            />
          ) : (
            <span className={`${styles.validatorLogoFallback} ${styles.validatorLogoCompact}`}>
              {fallbackInitials}
            </span>
          )}
          <span className={`${styles.validatorText} ${styles.validatorTextCompact}`}>
            <strong>{displayName}</strong>
            <small>{shortAddress(address)}</small>
          </span>
        </span>
      );
    },
    [brokenLogos, getValidatorIdentity]
  );

  const readyToStakeNtn = isVaultMode ? vaultNtnBalance ?? ZERO : walletNtn;
  const readyToClaimAtn = claimableRewards;
  const readyToWithdrawNtn = isVaultMode ? vaultReleasableNtn ?? ZERO : ZERO;
  const vestingLockedFromHistory =
    isVaultMode && vaultVestingTotalNtn !== null && vaultVestingReleasedNtnApprox !== null
      ? vaultVestingTotalNtn > vaultVestingReleasedNtnApprox
        ? vaultVestingTotalNtn - vaultVestingReleasedNtnApprox
        : ZERO
      : null;
  const vestingLockedNtn =
    vestingLockedFromHistory !== null
      ? vestingLockedFromHistory
      : isVaultMode && vaultNtnBalance !== null
        ? vaultNtnBalance > readyToWithdrawNtn
          ? vaultNtnBalance - readyToWithdrawNtn
          : ZERO
      : ZERO;

  const getInjectedProvider = useCallback(() => {
    const provider = window.ethereum;
    if (!provider) return null as EvmProvider | null;
    if (Array.isArray(provider.providers) && provider.providers.length > 0) {
      const metaMaskProvider = provider.providers.find((entry) => entry.isMetaMask);
      return metaMaskProvider || provider.providers[0];
    }
    return provider;
  }, []);

  const getActiveWalletProvider = useCallback(() => {
    return activeWalletProvider || getInjectedProvider();
  }, [activeWalletProvider, getInjectedProvider]);

  const createWalletConnectProvider = useCallback(async () => {
    if (!HAS_WALLETCONNECT) {
      throw new Error("WalletConnect is not configured. Set NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID.");
    }

    const module = await import("@walletconnect/ethereum-provider");
    const EthereumProvider = module.EthereumProvider as unknown as {
      init: (options: unknown) => Promise<EvmProvider>;
    };

    const walletConnectProvider = (await EthereumProvider.init({
      projectId: WALLETCONNECT_PROJECT_ID,
      chains: [AUT_CHAIN_ID],
      showQrModal: true,
      rpcMap: {
        [AUT_CHAIN_ID]: AUT_RPC_URL,
      },
      metadata: {
        name: "Autonity Staking Terminal",
        description: "Stake and manage AUTONITY liquid staking",
        url: typeof window !== "undefined" ? window.location.origin : "https://autonity-staking.uniqnodes.com",
        icons: ["https://walletconnect.com/walletconnect-logo.png"],
      },
    })) as EvmProvider;

    if (typeof walletConnectProvider.connect === "function") {
      await walletConnectProvider.connect();
    } else if (typeof walletConnectProvider.enable === "function") {
      await walletConnectProvider.enable();
    }
    return walletConnectProvider;
  }, []);

  const getWalletAccounts = useCallback(async (provider: EvmProvider) => {
    const normalize = (value: unknown): string | null => {
      if (typeof value !== "string") return null;
      try {
        return getAddress(value);
      } catch {
        return null;
      }
    };

    try {
      const requested = await provider.request({ method: "eth_requestAccounts" });
      const requestedAccounts = Array.isArray(requested) ? requested : [];
      const normalized = requestedAccounts.map(normalize).filter((item): item is string => Boolean(item));
      if (normalized.length > 0) return normalized;
    } catch {
      // some providers (notably WalletConnect) can fail this method until connected;
      // fallback to eth_accounts and provider cache.
    }

    try {
      const accountsResult = await provider.request({ method: "eth_accounts" });
      const accounts = Array.isArray(accountsResult) ? accountsResult : [];
      const normalized = accounts.map(normalize).filter((item): item is string => Boolean(item));
      if (normalized.length > 0) return normalized;
    } catch {
      // fallback handled below
    }

    const providerAccounts = (provider as { accounts?: unknown }).accounts;
    const cached: unknown[] = Array.isArray(providerAccounts) ? (providerAccounts as unknown[]) : [];
    const normalizedCached = cached.map(normalize).filter((item): item is string => Boolean(item));
    return normalizedCached;
  }, []);

  const ensureAutonityChain = useCallback(async (provider?: EvmProvider) => {
    const walletProvider = provider || getActiveWalletProvider();
    if (!walletProvider) {
      throw new Error("EVM wallet provider not found.");
    }
    try {
      const activeChain = (await walletProvider.request({ method: "eth_chainId" })) as string;
      if (
        typeof activeChain === "string" &&
        activeChain.toLowerCase() === AUTONITY_CHAIN_CONFIG.chainId.toLowerCase()
      ) {
        return;
      }

      await walletProvider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: AUTONITY_CHAIN_CONFIG.chainId }],
      });
    } catch (error) {
      const code = (error as { code?: number }).code;
      if (code === 4902) {
        try {
          await walletProvider.request({
            method: "wallet_addEthereumChain",
            params: [AUTONITY_CHAIN_CONFIG],
          });
          await walletProvider.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: AUTONITY_CHAIN_CONFIG.chainId }],
          });
          return;
        } catch (addError) {
          throw new Error(chainSwitchErrorMessage(addError));
        }
      }

      throw new Error(chainSwitchErrorMessage(error));
    }
  }, [getActiveWalletProvider]);

  const getSigner = useCallback(async (walletProviderOverride?: EvmProvider) => {
    const walletProvider = walletProviderOverride || getActiveWalletProvider();
    if (!walletProvider) {
      throw new Error("EVM wallet provider not found.");
    }
    const browserProvider = new BrowserProvider(walletProvider);
    return browserProvider.getSigner();
  }, [getActiveWalletProvider]);

  const parseApiErrorMessage = useCallback(async (res: Response, fallback: string) => {
    try {
      const payload = (await res.json()) as { error?: { message?: string } };
      const message = payload.error?.message;
      if (message) {
        return message;
      }
    } catch {}
    return `${fallback} (${res.status})`;
  }, []);

  const ensureApiSession = useCallback(
    async (address: string, interactive: boolean, providerOverride?: EvmProvider) => {
      const normalized = address.toLowerCase();
      const params = new URLSearchParams({ address });
      try {
        const sessionRes = await fetch(`/api/auth/session?${params.toString()}`, {
          cache: "no-store",
        });
        if (sessionRes.ok) {
          const sessionJson = (await sessionRes.json()) as { authenticated?: boolean };
          if (sessionJson.authenticated) {
            apiSessionAddressRef.current = normalized;
            return true;
          }
        }
      } catch {}

      if (!interactive) {
        if (apiSessionAddressRef.current === normalized) {
          apiSessionAddressRef.current = "";
        }
        return false;
      }

      const nonceRes = await fetch("/api/auth/nonce", {
        method: "POST",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ address }),
      });
      if (!nonceRes.ok) {
        throw new Error(await parseApiErrorMessage(nonceRes, "Session challenge failed"));
      }

      const nonceJson = (await nonceRes.json()) as { message?: string };
      const message = nonceJson.message || "";
      if (!message) {
        throw new Error("Session challenge payload is empty.");
      }

      const signer = await getSigner(providerOverride);
      const signature = await signer.signMessage(message);

      const verifyRes = await fetch("/api/auth/verify", {
        method: "POST",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ address, signature }),
      });
      if (!verifyRes.ok) {
        throw new Error(await parseApiErrorMessage(verifyRes, "Session verification failed"));
      }

      apiSessionAddressRef.current = normalized;
      return true;
    },
    [getSigner, parseApiErrorMessage]
  );

  const discoverVaults = useCallback(
    async (beneficiary: string) => {
      const beneficiaryTopic = zeroPadValue(beneficiary, 32);
      const logs = await rpcProvider.getLogs({
        address: STAKING_MANAGER_ADDRESS,
        topics: [VAULT_CREATED_TOPIC, null, beneficiaryTopic],
        fromBlock: 0,
        toBlock: "latest",
      });

      const candidateByAddress = new Map<
        string,
        { vault: string; blockNumber: number; logIndex: number }
      >();
      for (const log of logs) {
        const vault = toAddressTopic(log.topics[1]);
        const key = vault.toLowerCase();
        const blockNumber = Number(log.blockNumber);
        const logIndex = typeof log.index === "number" ? log.index : 0;
        const prev = candidateByAddress.get(key);
        if (
          !prev ||
          blockNumber < prev.blockNumber ||
          (blockNumber === prev.blockNumber && logIndex < prev.logIndex)
        ) {
          candidateByAddress.set(key, { vault, blockNumber, logIndex });
        }
      }

      const candidates = [...candidateByAddress.values()].sort(
        (a, b) =>
          a.blockNumber - b.blockNumber ||
          a.logIndex - b.logIndex ||
          a.vault.toLowerCase().localeCompare(b.vault.toLowerCase())
      );
      if (candidates.length === 0) {
        return [];
      }

      const verified = await Promise.all(
        candidates.map(async ({ vault }) => {
          try {
            const contract = new Contract(vault, VAULT_ABI, rpcProvider);
            const owner = getAddress(await contract.getBeneficiary());
            return sameAddress(owner, beneficiary) ? vault : null;
          } catch {
            return null;
          }
        })
      );

      return verified.filter((item): item is string => Boolean(item));
    },
    [rpcProvider]
  );

  const ensureValidatorRegistryCache = useCallback(async () => {
    if (Object.keys(validatorRegistryCacheRef.current).length > 0) {
      return validatorRegistryCacheRef.current;
    }
    if (validatorRegistryLoadRef.current) {
      return validatorRegistryLoadRef.current;
    }

    validatorRegistryLoadRef.current = (async () => {
      try {
        const res = await fetch("/api/validator-registry", { cache: "force-cache" });
        if (!res.ok) {
          return {};
        }
        const json = (await res.json()) as {
          validators?: Record<string, ValidatorRegistryMeta>;
        };
        const validators = json.validators || {};
        validatorRegistryCacheRef.current = validators;
        return validators;
      } catch {
        return {};
      } finally {
        validatorRegistryLoadRef.current = null;
      }
    })();

    return validatorRegistryLoadRef.current;
  }, []);

  const loadLiquidHolderCounts = useCallback(async (liquidContracts: string[]) => {
    const unique = [...new Set(liquidContracts.map((item) => item.toLowerCase()))].filter(Boolean);
    if (unique.length === 0) {
      return new Map<string, number>();
    }

    try {
      const params = new URLSearchParams({
        addresses: unique.join(","),
      });
      const res = await fetch(`/api/liquid-holder-counts?${params.toString()}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        return new Map<string, number>();
      }
      const json = (await res.json()) as {
        holdersByToken?: Record<string, number>;
      };
      const map = new Map<string, number>();
      for (const [token, count] of Object.entries(json.holdersByToken || {})) {
        if (typeof count === "number" && Number.isFinite(count)) {
          map.set(token.toLowerCase(), count);
        }
      }
      return map;
    } catch {
      return new Map<string, number>();
    }
  }, []);

  const loadActiveValidatorOptions = useCallback(
    async (
      activeAddresses: string[],
      autRead: Contract,
      registryMap: Record<string, ValidatorRegistryMeta>,
      currentBlock: number
    ) => {
      const options: ActiveValidatorOption[] = [];

      for (const batch of chunk(activeAddresses, 6)) {
        const rows = await Promise.all(
          batch.map(async (validatorAddress) => {
            try {
              const info = await autRead.getValidator(validatorAddress);
              const meta = registryMap[validatorAddress.toLowerCase()] || {
                moniker: null,
                logoPath: null,
              };
              const liquidContract = getAddress(info.liquidStateContract as string);
              return {
                address: getAddress(validatorAddress),
                liquidContract,
                commissionRate: (info.commissionRate as bigint) || ZERO,
                totalStake: (info.bondedStake as bigint) || ZERO,
                selfBondedStake: (info.selfBondedStake as bigint) || ZERO,
                delegatorCount: null,
                conversionRatio: (info.conversionRatio as bigint) || ZERO,
                moniker: meta.moniker,
                logoPath: meta.logoPath,
                validatorStatus: deriveValidatorStatus(
                  true,
                  (info.jailReleaseBlock as bigint) || ZERO,
                  currentBlock
                ),
              } satisfies ActiveValidatorOption;
            } catch {
              return {
                address: getAddress(validatorAddress),
                liquidContract: ZeroAddress,
                commissionRate: ZERO,
                totalStake: ZERO,
                selfBondedStake: ZERO,
                delegatorCount: null,
                conversionRatio: ZERO,
                moniker: null,
                logoPath: null,
                validatorStatus: "active",
              } satisfies ActiveValidatorOption;
            }
          })
        );

        options.push(...rows);
      }

      const holderCounts = await loadLiquidHolderCounts(
        options
          .map((item) => item.liquidContract)
          .filter((item) => !sameAddress(item, ZeroAddress))
      );
      for (const item of options) {
        const count = holderCounts.get(item.liquidContract.toLowerCase());
        if (typeof count === "number") {
          item.delegatorCount = count;
        }
      }

      options.sort((a, b) => {
        if (a.totalStake !== b.totalStake) {
          return a.totalStake > b.totalStake ? -1 : 1;
        }
        return a.address.localeCompare(b.address);
      });

      return options;
    },
    [loadLiquidHolderCounts]
  );

  const getLikelyValidators = useCallback(
    async (delegator: string, active: string[], isVaultDelegator: boolean) => {
      if (isVaultDelegator) {
        try {
          const vault = new Contract(delegator, VAULT_ABI, rpcProvider);
          const set = (await vault.getValidatorSet()) as string[];
          if (set.length > 0) {
            return [...new Set(set.map((item) => getAddress(item)))];
          }
        } catch {
          // continue with log-based fallback
        }
      }

      const iface = new Interface(AUTONITY_ABI);
      const bondingEvent = iface.getEvent("NewBondingRequest");
      const unbondingEvent = iface.getEvent("NewUnbondingRequest");
      if (!bondingEvent || !unbondingEvent) {
        return [...new Set(active)];
      }
      const bondingTopic = bondingEvent.topicHash;
      const unbondingTopic = unbondingEvent.topicHash;
      const delegatorTopic = zeroPadValue(delegator, 32);

      const [bondingLogs, unbondingLogs] = await Promise.all([
        rpcProvider.getLogs({
          address: AUTONITY_CONTRACT,
          topics: [bondingTopic, null, delegatorTopic],
          fromBlock: 0,
          toBlock: "latest",
        }),
        rpcProvider.getLogs({
          address: AUTONITY_CONTRACT,
          topics: [unbondingTopic, null, delegatorTopic],
          fromBlock: 0,
          toBlock: "latest",
        }),
      ]);

      const fromLogs = [
        ...bondingLogs.map((log) => toAddressTopic(log.topics[1])),
        ...unbondingLogs.map((log) => toAddressTopic(log.topics[1])),
      ];

      if (fromLogs.length > 0) {
        return [...new Set(fromLogs)];
      }
      return [...new Set(active)];
    },
    [rpcProvider]
  );

  const loadDelegations = useCallback(
    async (
      delegator: string,
      active: string[],
      allValidators: string[],
      isVaultDelegator: boolean,
      currentBlock: number
    ) => {
      const autRead = new Contract(AUTONITY_CONTRACT, AUTONITY_ABI, rpcProvider);
      const likely = await getLikelyValidators(delegator, active, isVaultDelegator);
      const candidates = [...new Set([...likely, ...allValidators])];
      const activeSet = new Set(active.map((item) => item.toLowerCase()));
      const rows: DelegationRow[] = [];

      for (const batch of chunk(candidates, 6)) {
        const result = await Promise.all(
          batch.map(async (validator) => {
            try {
              const info = await autRead.getValidator(validator);
              const liquidContract = getAddress(info.liquidStateContract as string);
              if (sameAddress(liquidContract, ZeroAddress)) {
                return null;
              }

              const liquid = new Contract(liquidContract, LIQUID_ABI, rpcProvider);
              const [locked, unlocked, unclaimedRewards] = await Promise.all([
                liquid.lockedBalanceOf(delegator) as Promise<bigint>,
                liquid.unlockedBalanceOf(delegator) as Promise<bigint>,
                liquid.unclaimedRewards(delegator) as Promise<bigint>,
              ]);

              const total = locked + unlocked;
              if (total === ZERO && unclaimedRewards === ZERO) {
                return null;
              }

              return {
                validator: getAddress(validator),
                liquidContract,
                locked,
                unlocked,
                total,
                unclaimedRewards,
                conversionRatio: (info.conversionRatio as bigint) || ZERO,
                validatorStatus: deriveValidatorStatus(
                  activeSet.has(validator.toLowerCase()),
                  (info.jailReleaseBlock as bigint) || ZERO,
                  currentBlock
                ),
              } satisfies DelegationRow;
            } catch {
              return null;
            }
          })
        );

        for (const row of result) {
          if (row) rows.push(row);
        }
      }

      rows.sort((a, b) => {
        if (a.total === b.total) {
          return a.validator.localeCompare(b.validator);
        }
        return a.total > b.total ? -1 : 1;
      });

      return rows;
    },
    [getLikelyValidators, rpcProvider]
  );

  const loadUnbondings = useCallback(
    async (
      delegator: string,
      unbondingPeriod: number,
      epochPeriod: number,
      currentBlock: number
    ) => {
      const autRead = new Contract(AUTONITY_CONTRACT, AUTONITY_ABI, rpcProvider);
      const iface = new Interface(AUTONITY_ABI);
      const unbondingEvent = iface.getEvent("NewUnbondingRequest");
      const bondingEvent = iface.getEvent("NewBondingRequest");
      if (!unbondingEvent || !bondingEvent) {
        return [];
      }
      const delegatorTopic = zeroPadValue(delegator, 32);

      const [unbondingLogs, bondingLogs] = await Promise.all([
        rpcProvider.getLogs({
          address: AUTONITY_CONTRACT,
          topics: [unbondingEvent.topicHash, null, delegatorTopic],
          fromBlock: 0,
          toBlock: "latest",
        }),
        rpcProvider.getLogs({
          address: AUTONITY_CONTRACT,
          topics: [bondingEvent.topicHash, null, delegatorTopic],
          fromBlock: 0,
          toBlock: "latest",
        }),
      ]);

      const items = [
        ...unbondingLogs.map((log) => ({ kind: "unbond" as const, log })),
        ...bondingLogs.map((log) => ({ kind: "bond" as const, log })),
      ].sort((a, b) => Number(b.log.blockNumber) - Number(a.log.blockNumber));

      const rows: QueueRow[] = [];
      const seen = new Set<string>();

      for (const item of items) {
        if (rows.length >= 40) break;
        const parsed = iface.parseLog(item.log);
        if (!parsed) continue;

        const requestId =
          item.kind === "unbond"
            ? String(parsed.args.headUnbondingID)
            : String(parsed.args.headBondingID);
        const uniq = `${item.kind}:${requestId}`;
        if (!requestId || seen.has(uniq)) continue;
        seen.add(uniq);

        try {
          if (item.kind === "unbond") {
            const req = await autRead.getUnbondingRequestByID(requestId);
            const requestBlock = Number(req.requestBlock);
            const releaseBlock = requestBlock + unbondingPeriod;
            let phase: "waiting" | "ready" | "done" = "waiting";
            let remainingBlocks: number | null = null;

            if (req.released) {
              phase = "done";
            } else if (currentBlock >= releaseBlock) {
              phase = "ready";
              remainingBlocks = 0;
            } else {
              phase = "waiting";
              remainingBlocks = Math.max(0, releaseBlock - currentBlock);
            }

            rows.push({
              id: uniq,
              validator: getAddress(req.delegatee as string),
              amount: req.amount as bigint,
              requestBlock,
              phase,
              action: "Unstake",
              tokenSymbol: "LNTN",
              remainingBlocks,
            });
            continue;
          }

          const req = await autRead.getBondingRequestByID(requestId);
          const requestBlock = Number(req.requestBlock);
          const settledBlock = requestBlock + epochPeriod;
          const phase: "waiting" | "ready" | "done" =
            currentBlock >= settledBlock ? "done" : "waiting";
          const remainingBlocks =
            phase === "waiting" ? Math.max(0, settledBlock - currentBlock) : null;

          rows.push({
            id: uniq,
            validator: getAddress(req.delegatee as string),
            amount: req.amount as bigint,
            requestBlock,
            phase,
            action: "Stake",
            tokenSymbol: "NTN",
            remainingBlocks,
          });
        } catch {
          // ignore malformed rows
        }
      }

      rows.sort((a, b) => b.requestBlock - a.requestBlock);
      return rows;
    },
    [rpcProvider]
  );

  const loadVaultVestingMetrics = useCallback(
    async (vaultAddress: string, beneficiary: string) => {
      const transferIface = new Interface([
        "event Transfer(address indexed from,address indexed to,uint256 value)",
      ]);
      const transferTopic = transferIface.getEvent("Transfer")?.topicHash;
      if (!transferTopic) {
        return { total: null, releasedApprox: null };
      }

      const vaultTopic = zeroPadValue(vaultAddress, 32);
      const beneficiaryTopic = zeroPadValue(beneficiary, 32);
      const autRead = new Contract(AUTONITY_CONTRACT, AUTONITY_ABI, rpcProvider);

      const incomingNtnLogs = await rpcProvider.getLogs({
        address: AUTONITY_CONTRACT,
        topics: [transferTopic, null, vaultTopic],
        fromBlock: 0,
        toBlock: "latest",
      });

      let total = ZERO;
      for (const log of incomingNtnLogs) {
        const parsed = transferIface.parseLog(log);
        if (!parsed) continue;
        const from = getAddress(parsed.args.from as string);
        if (sameAddress(from, beneficiary)) continue;
        const value = parsed.args.value as bigint;
        if (value <= ZERO) continue;
        total += value;
      }

      const [releasedTokenLogsA, releasedTokenLogsB] = await Promise.all([
        rpcProvider.getLogs({
          address: vaultAddress,
          topics: [VAULT_FUNDS_RELEASED_TOPIC, beneficiaryTopic],
          fromBlock: 0,
          toBlock: "latest",
        }),
        rpcProvider.getLogs({
          address: vaultAddress,
          topics: [VAULT_VESTING_STATE_TOPIC, beneficiaryTopic],
          fromBlock: 0,
          toBlock: "latest",
        }),
      ]);

      const candidateTokens = new Set<string>([AUTONITY_CONTRACT.toLowerCase()]);
      for (const log of [...releasedTokenLogsA, ...releasedTokenLogsB]) {
        if (log.topics.length > 2) {
          candidateTokens.add(toAddressTopic(log.topics[2]).toLowerCase());
        }
      }

      const validators = (await autRead.getValidators()) as string[];
      const liquidToRatio = new Map<string, bigint>();
      for (const batch of chunk(validators, 6)) {
        const rows = await Promise.all(
          batch.map(async (validator) => {
            try {
              const info = await autRead.getValidator(validator);
              const liquid = getAddress(info.liquidStateContract as string);
              if (sameAddress(liquid, ZeroAddress)) return null;
              return {
                liquid: liquid.toLowerCase(),
                ratio: (info.conversionRatio as bigint) || ZERO,
              };
            } catch {
              return null;
            }
          })
        );
        for (const row of rows) {
          if (!row) continue;
          liquidToRatio.set(row.liquid, row.ratio);
        }
      }

      let releasedApprox = ZERO;
      for (const token of candidateTokens) {
        const logs = await rpcProvider.getLogs({
          address: getAddress(token),
          topics: [transferTopic, vaultTopic, beneficiaryTopic],
          fromBlock: 0,
          toBlock: "latest",
        });

        let tokenSum = ZERO;
        for (const log of logs) {
          const parsed = transferIface.parseLog(log);
          if (!parsed) continue;
          tokenSum += parsed.args.value as bigint;
        }
        if (tokenSum <= ZERO) continue;

        if (sameAddress(token, AUTONITY_CONTRACT)) {
          releasedApprox += tokenSum;
          continue;
        }

        const ratio = liquidToRatio.get(token.toLowerCase());
        if (!ratio || ratio <= ZERO) continue;
        releasedApprox += (tokenSum * ratio) / WAD;
      }

      return { total: total > ZERO ? total : null, releasedApprox };
    },
    [rpcProvider]
  );

  const refreshData = useCallback(
    async (walletAddress?: string, preferredDelegator?: string) => {
      const activeAccount = walletAddress || account;
      if (!activeAccount) return;

      setIsLoading(true);
      setStatusLine("Syncing on-chain data...");

      try {
        const normalizedWallet = getAddress(activeAccount);
        const autRead = new Contract(AUTONITY_CONTRACT, AUTONITY_ABI, rpcProvider);
        const registryMap = await ensureValidatorRegistryCache();

        const [
          nativeBalance,
          ntnBalance,
          committee,
          validators,
          unbondingPeriod,
          epochPeriod,
          chainBlock,
          foundVaults,
        ] =
          await Promise.all([
            rpcProvider.getBalance(normalizedWallet),
            autRead.balanceOf(normalizedWallet) as Promise<bigint>,
            autRead.getCommittee() as Promise<Array<{ addr: string }>>,
            autRead.getValidators() as Promise<string[]>,
            autRead.getUnbondingPeriod() as Promise<bigint>,
            autRead.getEpochPeriod() as Promise<bigint>,
            rpcProvider.getBlockNumber(),
            discoverVaults(normalizedWallet),
          ]);

        setCurrentBlock(chainBlock);

        const activeAddresses = committee.map((item) => getAddress(item.addr));
        const allValidatorAddresses = validators.map((item) => getAddress(item));
        const activeOptions = await loadActiveValidatorOptions(
          activeAddresses,
          autRead,
          registryMap,
          Number(chainBlock)
        );
        setActiveValidators(activeOptions);
        setWalletAtn(nativeBalance);
        setWalletNtn(ntnBalance);
        setVaults(foundVaults);

        const knownDelegators = [normalizedWallet, ...foundVaults];
        const nextDelegator = preferredDelegator
          ? knownDelegators.find((item) => sameAddress(item, preferredDelegator)) ||
            foundVaults[0] ||
            normalizedWallet
          : knownDelegators.find((item) => sameAddress(item, selectedDelegator)) ||
            foundVaults[0] ||
            normalizedWallet;

        setSelectedDelegator(nextDelegator);

        const delegationsByDelegator = new Map<string, DelegationRow[]>(
          await Promise.all(
            knownDelegators.map(
              async (delegator) =>
                [
                  delegator.toLowerCase(),
                  await loadDelegations(
                    delegator,
                    activeAddresses,
                    allValidatorAddresses,
                    !sameAddress(delegator, normalizedWallet),
                    Number(chainBlock)
                  ),
                ] as const
            )
          )
        );

        const vaultBalanceEntries = await Promise.all(
          foundVaults.map(async (vault) => {
            try {
              const balance = (await autRead.balanceOf(vault)) as bigint;
              return [vault.toLowerCase(), balance] as const;
            } catch {
              return [vault.toLowerCase(), ZERO] as const;
            }
          })
        );
        const vaultBalancesByAddress = new Map<string, bigint>(vaultBalanceEntries);
        const totalVaultLiquidNtn = vaultBalanceEntries.reduce((sum, [, balance]) => sum + balance, ZERO);

        const walletDelegations = delegationsByDelegator.get(normalizedWallet.toLowerCase()) || [];
        const walletStakedNtn = sumDelegationNtnEquivalent(walletDelegations);
        const vaultStakedNtn = foundVaults.reduce(
          (sum, vault) =>
            sum + sumDelegationNtnEquivalent(delegationsByDelegator.get(vault.toLowerCase()) || []),
          ZERO
        );
        const totalStakedNtn = walletStakedNtn + vaultStakedNtn;
        const totalPortfolioNtnEq = ntnBalance + totalVaultLiquidNtn + totalStakedNtn;
        setPortfolioStakedNtn(totalStakedNtn);
        setPortfolioNtnEquivalent(totalPortfolioNtnEq);

        const delegatorIsVault = !sameAddress(nextDelegator, normalizedWallet);
        let nextVaultBalance: bigint | null = null;
        let nextVaultReleasable: bigint | null = null;
        let nextVaultVestingTotal: bigint | null = null;
        let nextVaultVestingReleasedApprox: bigint | null = null;
        if (delegatorIsVault) {
          nextVaultBalance = vaultBalancesByAddress.get(nextDelegator.toLowerCase()) ?? ZERO;
          try {
            const vaultRead = new Contract(nextDelegator, VAULT_ABI, rpcProvider);
            const [releasable, vestingMetrics] = await Promise.all([
              vaultRead.unlockedFunds() as Promise<bigint>,
              loadVaultVestingMetrics(nextDelegator, normalizedWallet),
            ]);
            nextVaultReleasable = releasable;
            nextVaultVestingTotal = vestingMetrics.total;
            nextVaultVestingReleasedApprox = vestingMetrics.releasedApprox;
          } catch {
            nextVaultReleasable = null;
            nextVaultVestingTotal = null;
            nextVaultVestingReleasedApprox = null;
          }
        }
        setVaultNtnBalance(nextVaultBalance);
        setVaultReleasableNtn(nextVaultReleasable);
        setVaultVestingTotalNtn(nextVaultVestingTotal);
        setVaultVestingReleasedNtnApprox(nextVaultVestingReleasedApprox);

        const nextDelegations = delegationsByDelegator.get(nextDelegator.toLowerCase()) || [];
        setDelegations(nextDelegations);

        const nextUnbondings = await loadUnbondings(
          nextDelegator,
          Number(unbondingPeriod),
          Number(epochPeriod),
          Number(chainBlock)
        );
        setUnbondings(nextUnbondings);

        if (
          activeAddresses.length > 0 &&
          (!bondValidator ||
            !activeAddresses.some((address) => sameAddress(address, bondValidator)))
        ) {
          setBondValidator(activeAddresses[0]);
        }
        if (!unbondValidator) {
          const first = nextDelegations.find((row) => row.unlocked > ZERO)?.validator || "";
          setUnbondValidator(first);
        }
        if (!claimValidator) {
          const firstReward =
            nextDelegations.find((row) => row.unclaimedRewards > ZERO)?.validator || "";
          setClaimValidator(firstReward);
        }

        setStatusLine("Synced.");
      } catch (error) {
        setStatusLine(parseError(error));
      } finally {
        setIsLoading(false);
      }
    },
    [
      account,
      bondValidator,
      discoverVaults,
      ensureValidatorRegistryCache,
      loadActiveValidatorOptions,
      loadDelegations,
      loadVaultVestingMetrics,
      loadUnbondings,
      rpcProvider,
      selectedDelegator,
      claimValidator,
      unbondValidator,
    ]
  );

  const resetAppSession = useCallback((status: string) => {
    apiSessionAddressRef.current = "";
    setAccount("");
    setSelectedDelegator("");
    setCurrentBlock(null);
    setWalletAtn(ZERO);
    setWalletNtn(ZERO);
    setVaults([]);
    setVaultNtnBalance(null);
    setPortfolioNtnEquivalent(ZERO);
    setPortfolioStakedNtn(ZERO);
    setVaultReleasableNtn(null);
    setVaultVestingTotalNtn(null);
    setVaultVestingReleasedNtnApprox(null);
    setActiveValidators([]);
    setDelegations([]);
    setUnbondings([]);
    setBondValidator("");
    setUnbondValidator("");
    setClaimValidator("");
    setBondExactMaxAmount(null);
    setUnbondExactMaxAmount(null);
    setPositionInlineAction(null);
    setPositionInlineAmount("");
    setPositionInlineExactMaxAmount(null);
    setLastTxHash("");
    setActionLine("");
    setStatusLine(status);
    setActiveAction(null);
    setUnbondDropdownOpen(false);
    setClaimDropdownOpen(false);
    setCopiedAddressType(null);
    setWalletMenuOpen(false);
  }, []);

  const connectWallet = useCallback(async () => {
    const provider = getInjectedProvider() || (HAS_WALLETCONNECT ? await createWalletConnectProvider() : null);
    if (!provider) {
      setStatusLine(
        HAS_WALLETCONNECT
          ? "No wallet found to connect. WalletConnect is not configured in this deployment."
          : "No injected EVM wallet found. Install a wallet extension."
      );
      setWalletHydrated(true);
      return;
    }
    try {
      window.localStorage.removeItem(MANUAL_DISCONNECT_KEY);
      const accounts = await getWalletAccounts(provider);

      if (!Array.isArray(accounts) || accounts.length === 0) {
        setStatusLine("No wallet account found.");
        return;
      }

      const nextAccount = getAddress(accounts[0]);
      const sessionReady = await ensureApiSession(nextAccount, true, provider);
      if (!sessionReady) {
        setStatusLine("Wallet session setup failed.");
        return;
      }

      await ensureAutonityChain(provider);
      const chainHex = (await provider.request({ method: "eth_chainId" })) as string;
      setActiveWalletProvider(provider);
      setAccount(nextAccount);
      setChainId(parseInt(chainHex, 16));
      setLastTxHash("");
      setActionLine("");
      setWalletMenuOpen(false);
      setClaimValidator("");
      setBondExactMaxAmount(null);
      setUnbondExactMaxAmount(null);
      await refreshData(nextAccount, nextAccount);
      setWalletHydrated(true);
    } catch (error) {
      setActiveWalletProvider(null);
      setStatusLine(parseError(error));
      setWalletHydrated(true);
    }
  }, [
    ensureAutonityChain,
    ensureApiSession,
    getWalletAccounts,
    getInjectedProvider,
    createWalletConnectProvider,
    refreshData,
  ]);

  const runTx = useCallback(
    async (
      label: string,
      sender: (
        signer: Awaited<ReturnType<typeof getSigner>>
      ) => Promise<{ hash: string; wait: () => Promise<unknown> }>
    ) => {
      if (!account) return false;

      setIsSending(true);
      setActionLine(`${label}: preparing transaction...`);
      setLastTxHash("");

      try {
        await ensureAutonityChain();
        const signer = await getSigner();
        const tx = await sender(signer);
        setLastTxHash(tx.hash);
        setActionLine(`${label}: tx sent, waiting confirmation...`);
        await tx.wait();
        setActionLine(`${label}: confirmed.`);
        await refreshData(account, selectedDelegator);
        return true;
      } catch (error) {
        setActionLine(`${label}: ${parseError(error)}`);
        return false;
      } finally {
        setIsSending(false);
      }
    },
    [account, ensureAutonityChain, getSigner, refreshData, selectedDelegator]
  );


  const onStake = useCallback(async () => {
    if (!account || !selectedDelegator) return;

    if (!isAddress(bondValidator)) {
      setActionLine("Stake: choose a valid validator.");
      return;
    }

    let amount: bigint;
    try {
      amount =
        bondExactMaxAmount !== null && bondAmount.length > 0
          ? bondExactMaxAmount
          : parseUnits(bondAmount || "0", 18);
      if (amount <= ZERO) throw new Error("Amount must be greater than 0.");
      if (amount > readyToStakeNtn) {
        setActionLine("Stake: amount is greater than available NTN.");
        return;
      }
    } catch {
      setActionLine("Stake: amount must be a valid NTN value.");
      return;
    }

    const success = await runTx("Stake", async (signer) => {
      if (sameAddress(selectedDelegator, account)) {
        const autWrite = new Contract(AUTONITY_CONTRACT, AUTONITY_ABI, signer);
        return autWrite.bond(bondValidator, amount);
      }
      const vaultWrite = new Contract(selectedDelegator, VAULT_ABI, signer);
      return vaultWrite.bond(bondValidator, amount);
    });

    if (success) {
      setBondAmount("");
      setBondExactMaxAmount(null);
      setActiveAction(null);
    }
  }, [
    account,
    bondAmount,
    bondExactMaxAmount,
    bondValidator,
    readyToStakeNtn,
    runTx,
    selectedDelegator,
  ]);

  const onUnstake = useCallback(async () => {
    if (!account || !selectedDelegator) return;

    if (!isAddress(unbondValidator)) {
      setActionLine("Unstake: choose a valid delegated validator.");
      return;
    }

    let amount: bigint;
    try {
      amount =
        unbondExactMaxAmount !== null && unbondAmount.length > 0
          ? unbondExactMaxAmount
          : parseUnits(unbondAmount || "0", 18);
      if (amount <= ZERO) throw new Error("Amount must be greater than 0.");
    } catch {
      setActionLine("Unstake: amount must be a valid LNTN value.");
      return;
    }

    const row = delegations.find((item) => sameAddress(item.validator, unbondValidator));
    if (!row) {
      setActionLine("Unstake: validator not found in your delegation list.");
      return;
    }
    if (amount > row.unlocked) {
      setActionLine(
        `Unstake: max unlockable for selected validator is ${formatToken(row.unlocked)} LNTN.`
      );
      return;
    }

    const success = await runTx("Unstake", async (signer) => {
      if (sameAddress(selectedDelegator, account)) {
        const autWrite = new Contract(AUTONITY_CONTRACT, AUTONITY_ABI, signer);
        return autWrite.unbond(unbondValidator, amount);
      }
      const vaultWrite = new Contract(selectedDelegator, VAULT_ABI, signer);
      return vaultWrite.unbond(unbondValidator, amount);
    });

    if (success) {
      setUnbondAmount("");
      setUnbondExactMaxAmount(null);
      setActiveAction(null);
    }
  }, [
    account,
    delegations,
    runTx,
    selectedDelegator,
    unbondAmount,
    unbondExactMaxAmount,
    unbondValidator,
  ]);

  const onClaim = useCallback(async () => {
    if (!account || !selectedDelegator) return;

    if (sameAddress(selectedDelegator, account)) {
      const row =
        rewardRows.find((item) => sameAddress(item.validator, claimValidator)) || rewardRows[0];
      if (!row) {
        setActionLine("No claimable rewards available.");
        return;
      }

      const success = await runTx("Claim", async (signer) => {
        const liquidWrite = new Contract(row.liquidContract, LIQUID_ABI, signer);
        return liquidWrite.claimRewards();
      });
      if (success) {
        setActiveAction(null);
      }
      return;
    }

    const success = await runTx("Claim", async (signer) => {
      const vaultWrite = new Contract(selectedDelegator, VAULT_ABI, signer);
      return vaultWrite.claimAllStakingRewards();
    });
    if (success) {
      setActiveAction(null);
    }
  }, [account, claimValidator, rewardRows, runTx, selectedDelegator]);

  const onClaimRow = useCallback(
    async (row: DelegationRow) => {
      if (!account || !selectedDelegator) return;
      if (row.unclaimedRewards <= ZERO) {
        setActionLine("Claim: no rewards for selected validator.");
        return;
      }

      if (sameAddress(selectedDelegator, account)) {
        const success = await runTx("Claim", async (signer) => {
          const liquidWrite = new Contract(row.liquidContract, LIQUID_ABI, signer);
          return liquidWrite.claimRewards();
        });
        if (success) {
          setActiveAction(null);
        }
        return;
      }

      const success = await runTx("Claim", async (signer) => {
        const vaultWrite = new Contract(selectedDelegator, VAULT_ABI, signer);
        return vaultWrite.claimAllStakingRewards();
      });
      if (success) {
        setActiveAction(null);
      }
    },
    [account, runTx, selectedDelegator]
  );

  const onPositionInlineSubmit = useCallback(async () => {
    if (!account || !selectedDelegator || !positionInlineAction) return;

    if (!isAddress(positionInlineAction.validator)) {
      setActionLine("Action: invalid validator address.");
      return;
    }

    let amount: bigint;
    try {
      amount =
        positionInlineExactMaxAmount !== null && positionInlineAmount.length > 0
          ? positionInlineExactMaxAmount
          : parseUnits(positionInlineAmount || "0", 18);
      if (amount <= ZERO) throw new Error("Amount must be greater than 0.");
    } catch {
      setActionLine("Action: amount must be a valid value.");
      return;
    }

    if (positionInlineAction.type === "stake") {
      if (amount > readyToStakeNtn) {
        setActionLine("Stake: amount is greater than available NTN.");
        return;
      }

      const success = await runTx("Stake", async (signer) => {
        if (sameAddress(selectedDelegator, account)) {
          const autWrite = new Contract(AUTONITY_CONTRACT, AUTONITY_ABI, signer);
          return autWrite.bond(positionInlineAction.validator, amount);
        }
        const vaultWrite = new Contract(selectedDelegator, VAULT_ABI, signer);
        return vaultWrite.bond(positionInlineAction.validator, amount);
      });

      if (success) {
        setPositionInlineAction(null);
        setPositionInlineAmount("");
        setPositionInlineExactMaxAmount(null);
      }
      return;
    }

    const row = delegations.find((item) => sameAddress(item.validator, positionInlineAction.validator));
    if (!row) {
      setActionLine("Unstake: validator not found in your delegation list.");
      return;
    }
    if (amount > row.unlocked) {
      setActionLine(`Unstake: max unlockable is ${formatToken(row.unlocked)} LNTN.`);
      return;
    }

    const success = await runTx("Unstake", async (signer) => {
      if (sameAddress(selectedDelegator, account)) {
        const autWrite = new Contract(AUTONITY_CONTRACT, AUTONITY_ABI, signer);
        return autWrite.unbond(positionInlineAction.validator, amount);
      }
      const vaultWrite = new Contract(selectedDelegator, VAULT_ABI, signer);
      return vaultWrite.unbond(positionInlineAction.validator, amount);
    });

    if (success) {
      setPositionInlineAction(null);
      setPositionInlineAmount("");
      setPositionInlineExactMaxAmount(null);
    }
  }, [
    account,
    delegations,
    positionInlineAction,
    positionInlineAmount,
    positionInlineExactMaxAmount,
    readyToStakeNtn,
    runTx,
    selectedDelegator,
  ]);

  const onRelease = useCallback(async () => {
    if (!account || !selectedDelegator || sameAddress(selectedDelegator, account)) {
      return;
    }
    if (readyToWithdrawNtn <= ZERO) {
      setActionLine("Withdraw: no releasable NTN in vault.");
      return;
    }

    const success = await runTx("Withdraw", async (signer) => {
      const vaultWrite = new Contract(selectedDelegator, VAULT_ABI, signer);
      return vaultWrite.releaseFunds();
    });

    if (success) {
      setActiveAction(null);
    }
  }, [account, readyToWithdrawNtn, runTx, selectedDelegator]);

  useEffect(() => {
    const walletProvider = activeWalletProvider || getInjectedProvider();
    if (!walletProvider?.on) return;

    const onAccountsChanged = (nextAccounts: unknown) => {
      const list = Array.isArray(nextAccounts) ? (nextAccounts as string[]) : [];
      if (list.length === 0) {
        setActiveWalletProvider(null);
        resetAppSession("Wallet disconnected.");
        return;
      }

      const next = getAddress(list[0]);
      void (async () => {
        try {
          const sessionReady = await ensureApiSession(next, true);
          if (!sessionReady) {
            resetAppSession("Session signature required.");
            return;
          }

          window.localStorage.removeItem(MANUAL_DISCONNECT_KEY);
          setAccount(next);
          setSelectedDelegator(next);
          setWalletMenuOpen(false);
          setClaimValidator("");
          setBondExactMaxAmount(null);
          setUnbondExactMaxAmount(null);
          setPositionInlineAction(null);
          setPositionInlineAmount("");
          setPositionInlineExactMaxAmount(null);
          setUnbondDropdownOpen(false);
          setClaimDropdownOpen(false);
          await refreshData(next, next);
        } catch (error) {
          resetAppSession(parseError(error));
        }
      })();
    };

    const onChainChanged = (chainHex: unknown) => {
      if (typeof chainHex === "string") {
        setChainId(parseInt(chainHex, 16));
      }
      if (account) {
        void refreshData(account, selectedDelegator || account);
      }
    };

    walletProvider.on("accountsChanged", onAccountsChanged);
    walletProvider.on("chainChanged", onChainChanged);

    return () => {
      walletProvider?.removeListener?.("accountsChanged", onAccountsChanged);
      walletProvider?.removeListener?.("chainChanged", onChainChanged);
    };
  }, [activeWalletProvider, account, ensureApiSession, getInjectedProvider, refreshData, resetAppSession, selectedDelegator]);

  useEffect(() => {
    let cancelled = false;

    const hydrateWalletSession = async () => {
      setHasInjectedWallet(Boolean(getInjectedProvider()));
      if (!window.ethereum) {
        if (!cancelled) {
          setHasInjectedWallet(false);
          setStatusLine(
            HAS_WALLETCONNECT
              ? "Connect your wallet to continue."
              : "No injected EVM wallet found. Install a wallet extension."
          );
          setActiveWalletProvider(null);
          setWalletHydrated(true);
        }
        return;
      }

      try {
        const [accountsResp, chainResp] = await Promise.all([
          window.ethereum.request({ method: "eth_accounts" }),
          window.ethereum.request({ method: "eth_chainId" }),
        ]);

        if (cancelled) return;

        if (typeof chainResp === "string") {
          setChainId(parseInt(chainResp, 16));
        }

        if (window.localStorage.getItem(MANUAL_DISCONNECT_KEY) === "1") {
          setStatusLine("Connect your wallet to start.");
          return;
        }

        const accounts = Array.isArray(accountsResp) ? (accountsResp as string[]) : [];
        if (accounts.length === 0) {
          setStatusLine("Connect your wallet to start.");
          return;
        }

        const nextAccount = getAddress(accounts[0]);
        const sessionReady = await ensureApiSession(nextAccount, false);
        if (!sessionReady) {
          setStatusLine("Connect your wallet to start.");
          return;
        }
        setActiveWalletProvider(getInjectedProvider());
        setAccount(nextAccount);
        setLastTxHash("");
        setActionLine("");
        setClaimValidator("");
        setBondExactMaxAmount(null);
        setUnbondExactMaxAmount(null);
        const savedDelegator =
          window.localStorage.getItem(`autodesk:delegator:${nextAccount.toLowerCase()}`) ||
          nextAccount;
        await refreshData(nextAccount, savedDelegator);
      } catch (error) {
        if (!cancelled) {
          setStatusLine(parseError(error));
        }
      } finally {
        if (!cancelled) {
          setWalletHydrated(true);
        }
      }
    };

    void hydrateWalletSession();
    return () => {
      cancelled = true;
    };
  }, [ensureApiSession, refreshData]);

  useEffect(() => {
    setHasInjectedWallet(Boolean(getInjectedProvider()));
  }, [getInjectedProvider]);

  useEffect(() => {
    if (!account || !selectedDelegator) return;
    window.localStorage.setItem(`autodesk:delegator:${account.toLowerCase()}`, selectedDelegator);
  }, [account, selectedDelegator]);

  useEffect(() => {
    setPositionInlineAction(null);
    setPositionInlineAmount("");
    setPositionInlineExactMaxAmount(null);
    setUnbondDropdownOpen(false);
    setClaimDropdownOpen(false);
  }, [selectedDelegator]);

  useEffect(() => {
    if (!positionInlineAction) return;
    const stillExists = delegations.some((row) =>
      sameAddress(row.validator, positionInlineAction.validator)
    );
    if (stillExists) return;
    setPositionInlineAction(null);
    setPositionInlineAmount("");
    setPositionInlineExactMaxAmount(null);
  }, [delegations, positionInlineAction]);

  useEffect(() => {
    if (!unbondDropdownOpen) return;

    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (unbondDropdownRef.current && !unbondDropdownRef.current.contains(target)) {
        setUnbondDropdownOpen(false);
      }
    };

    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [unbondDropdownOpen]);

  useEffect(() => {
    if (!claimDropdownOpen) return;

    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (claimDropdownRef.current && !claimDropdownRef.current.contains(target)) {
        setClaimDropdownOpen(false);
      }
    };

    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [claimDropdownOpen]);

  useEffect(() => {
    if (!walletMenuOpen) return;

    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (walletMenuRef.current && !walletMenuRef.current.contains(target)) {
        setWalletMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [walletMenuOpen]);

  useEffect(() => {
    if (unbondableRows.length === 0) {
      if (unbondValidator) {
        setUnbondValidator("");
      }
      setUnbondExactMaxAmount(null);
      return;
    }

    const stillValid = unbondableRows.some((row) => sameAddress(row.validator, unbondValidator));
    if (!stillValid) {
      setUnbondValidator(unbondableRows[0].validator);
      setUnbondExactMaxAmount(null);
    }
  }, [unbondableRows, unbondValidator]);

  useEffect(() => {
    if (rewardRows.length === 0) {
      if (claimValidator) {
        setClaimValidator("");
      }
      return;
    }

    const stillValid = rewardRows.some((row) => sameAddress(row.validator, claimValidator));
    if (!stillValid) {
      setClaimValidator(rewardRows[0].validator);
    }
  }, [claimValidator, rewardRows]);

  const refreshNow = useCallback(async () => {
    if (!account) return;
    await refreshData(account, selectedDelegator || account);
  }, [account, refreshData, selectedDelegator]);

  const copyAddress = useCallback(async (label: "Wallet" | "Vault", address: string) => {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(address);
      } else {
        const input = document.createElement("textarea");
        input.value = address;
        input.setAttribute("readonly", "true");
        input.style.position = "absolute";
        input.style.left = "-9999px";
        document.body.appendChild(input);
        input.select();
        document.execCommand("copy");
        document.body.removeChild(input);
      }
      setActionLine(`${label} address copied.`);
      setCopiedAddressType(label === "Wallet" ? "wallet" : "vault");
      window.setTimeout(() => setCopiedAddressType(null), 1500);
    } catch {
      setActionLine(`${label} address could not be copied.`);
    }
  }, []);

  const disconnectWallet = useCallback(async () => {
    const provider = activeWalletProvider;
    if (provider && typeof provider.disconnect === "function") {
      try {
        await provider.disconnect();
      } catch {
        setActionLine("Wallet disconnect failed, continuing.");
      }
    }

    await fetch("/api/auth/logout", {
      method: "POST",
      cache: "no-store",
      keepalive: true,
    }).catch(() => undefined);

    if (typeof window !== "undefined") {
      window.localStorage.setItem(MANUAL_DISCONNECT_KEY, "1");
      if (account) {
        window.localStorage.removeItem(`autodesk:delegator:${account.toLowerCase()}`);
      }
    }
    resetAppSession("Disconnected from app.");
    setActiveWalletProvider(null);
  }, [account, activeWalletProvider, resetAppSession]);

  const fillStakeMax = () => {
    setBondAmount(formatToken(readyToStakeNtn, 18, 6));
    setBondExactMaxAmount(readyToStakeNtn);
  };

  const fillUnstakeMax = () => {
    const source = selectedUnbondValidatorRow || unbondableRows[0];
    if (!source) return;
    setUnbondAmount(formatToken(source.unlocked, 18, 6));
    setUnbondExactMaxAmount(source.unlocked);
  };

  const fillPositionInlineMax = () => {
    if (!positionInlineAction) return;
    if (positionInlineAction.type === "stake") {
      setPositionInlineAmount(formatToken(readyToStakeNtn, 18, 6));
      setPositionInlineExactMaxAmount(readyToStakeNtn);
      return;
    }
    const row = delegations.find((item) => sameAddress(item.validator, positionInlineAction.validator));
    if (!row) return;
    setPositionInlineAmount(formatToken(row.unlocked, 18, 6));
    setPositionInlineExactMaxAmount(row.unlocked);
  };

  const toggleInlineStake = (validator: string) => {
    setActiveAction(null);
    setPositionInlineAmount("");
    setPositionInlineExactMaxAmount(null);
    setPositionInlineAction((prev) =>
      prev && prev.type === "stake" && sameAddress(prev.validator, validator)
        ? null
        : { type: "stake", validator }
    );
  };

  const toggleInlineUnstake = (validator: string) => {
    setActiveAction(null);
    setPositionInlineAmount("");
    setPositionInlineExactMaxAmount(null);
    setPositionInlineAction((prev) =>
      prev && prev.type === "unstake" && sameAddress(prev.validator, validator)
        ? null
        : { type: "unstake", validator }
    );
  };

  const networkLabel = isConnected
    ? onCorrectChain
      ? "Autonity Mainnet"
      : "Wrong Network"
    : "Not connected";
  const networkTone = isConnected && onCorrectChain ? styles.ok : styles.bad;

  const canStake = activeValidators.length > 0 && readyToStakeNtn > ZERO && !isLoading && !isSending;
  const canUnstake = unbondableRows.length > 0 && !isLoading && !isSending;
  const canClaim =
    (isVaultMode ? claimableRewards > ZERO : rewardRows.length > 0) &&
    !isLoading &&
    !isSending &&
    onCorrectChain;
  const hasVault = vaults.length > 0;
  const activeVault = vaults[0];
  const vaultIndexByAddress = useMemo(() => {
    const map = new Map<string, number>();
    vaults.forEach((vault, index) => {
      map.set(vault.toLowerCase(), index + 1);
    });
    return map;
  }, [vaults]);
  const getVaultLabel = useCallback(
    (address: string) => {
      const index = vaultIndexByAddress.get(address.toLowerCase());
      return index ? `Vault ${index}` : "Vault";
    },
    [vaultIndexByAddress]
  );
  const canRefresh = onCorrectChain && !isLoading && !isSending;
  const primaryActionDisabled = !onCorrectChain;
  const canWithdraw = isVaultMode && canReleaseVaultFunds && !isLoading && !isSending;
  const modeDescription = isVaultMode
    ? "Transactions are executed by the selected vault."
    : "Transactions are sent directly from your connected wallet.";
  const queuePageSize = 10;
  const queueTotalPages = Math.max(1, Math.ceil(unbondings.length / queuePageSize));
  const queueCurrentPage = Math.min(queuePage, queueTotalPages);
  const pagedQueueRows = useMemo(() => {
    const start = (queueCurrentPage - 1) * queuePageSize;
    return unbondings.slice(start, start + queuePageSize);
  }, [queueCurrentPage, unbondings]);

  useEffect(() => {
    setQueuePage((prev) => Math.min(prev, queueTotalPages));
  }, [queueTotalPages]);

  useEffect(() => {
    setQueuePage(1);
  }, [selectedDelegator]);

  if (!isConnected) {
    return (
      <main className={styles.appWrap}>
        <section className={styles.connectShell}>
          <section className={styles.connectPanel}>
            <div className={styles.connectHeader}>
              <p className={styles.kicker}>Autonity Staking Terminal</p>
              <h1 className={styles.connectTitle}>Staking</h1>
              <p className={styles.connectLead}>
                Wallet and vault staking in one flow. Connect once and continue from a clear protocol
                state.
              </p>
            </div>
            <div className={styles.connectMeta}>
              <span className={styles.connectNetworkPill}>Autonity Mainnet</span>
            </div>
            {!hasInjectedWallet ? (
              <div className={styles.connectHelp}>
                {HAS_WALLETCONNECT ? (
                  <button
                    type="button"
                    className={`${styles.primaryBtn} ${styles.connectCta}`}
                    onClick={connectWallet}
                    disabled={!walletHydrated}
                  >
                    <span className={styles.connectCtaTitle}>
                      {walletHydrated ? "Connect Wallet" : "Checking session..."}
                    </span>
                  </button>
                ) : (
                  <>
                    <p className={styles.connectHelpText}>
                      No EVM wallet detected in this browser. Install one to continue:
                    </p>
                    <div className={styles.connectLinks}>
                      <a
                        href="https://metamask.io/download/"
                        className={styles.connectLink}
                        target="_blank"
                        rel="noreferrer"
                      >
                        MetaMask
                      </a>
                      <a
                        href="https://www.coinbase.com/wallet/downloads"
                        className={styles.connectLink}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Coinbase Wallet
                      </a>
                      <a
                        href="https://rabby.io/download"
                        className={styles.connectLink}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Rabby
                      </a>
                    </div>
                  </>
                )}
              </div>
            ) : (
              <button
                className={`${styles.primaryBtn} ${styles.connectCta}`}
                onClick={connectWallet}
                disabled={!walletHydrated}
              >
                <span className={styles.connectCtaTitle}>
                  {walletHydrated ? "Connect Wallet" : "Checking session..."}
                </span>
              </button>
            )}
          </section>
        </section>
      </main>
    );
  }

  return (
    <main className={styles.appWrap}>
      <header className={styles.topPanel}>
        <div className={styles.brandBlock}>
          <p className={styles.kicker}>Autonity Staking Terminal</p>
          <h1 className={styles.pageTitle}>Staking</h1>
          <p className={styles.contextTitle}>Wallet and vault staking control panel</p>
        </div>
        <div className={styles.topPanelActions}>
          <span className={styles.atnChip}>{`${formatToken(walletAtn)} ATN`}</span>
          <span className={`${styles.badge} ${networkTone}`}>
            {networkLabel}
          </span>
          {isVaultMode && (
            <div className={styles.addressChips}>
              <button
                type="button"
                className={`${styles.walletChip} ${styles.copyChip} ${
                  copiedAddressType === "vault" ? styles.copiedChip : ""
                }`}
                onClick={() => void copyAddress("Vault", selectedDelegator)}
                title={selectedDelegator}
              >
                {copiedAddressType === "vault"
                  ? `${getVaultLabel(selectedDelegator)} copied`
                  : `${getVaultLabel(selectedDelegator)} ${shortAddress(selectedDelegator)}`}
              </button>
            </div>
          )}
          <div className={styles.walletMenu} ref={walletMenuRef}>
            <button
              type="button"
              className={`${styles.walletChip} ${styles.copyChip} ${styles.walletChipConnected} ${
                walletMenuOpen ? styles.walletChipOpen : ""
              } ${copiedAddressType === "wallet" ? styles.copiedChip : ""}`}
              onClick={() => setWalletMenuOpen((prev) => !prev)}
              title={account}
              aria-haspopup="menu"
              aria-expanded={walletMenuOpen}
            >
              <svg
                viewBox="0 0 24 24"
                className={styles.walletIcon}
                aria-hidden="true"
                focusable="false"
              >
                <path
                  d="M4 7.5a2 2 0 0 1 2-2h11a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H6a2 2 0 0 1-2-2v-9Z"
                  fill="none"
                />
                <path d="M16 12h4v3h-4a1.5 1.5 0 0 1 0-3Z" fill="none" />
                <circle cx="16.8" cy="13.5" r="0.8" />
              </svg>
              <span>{copiedAddressType === "wallet" ? "Copied" : shortAddress(account)}</span>
            </button>
            {walletMenuOpen && (
              <div className={styles.walletMenuPanel} role="menu">
                <button
                  type="button"
                  className={styles.walletMenuItem}
                  role="menuitem"
                  onClick={() => {
                    setWalletMenuOpen(false);
                    void copyAddress("Wallet", account);
                  }}
                >
                  Copy address
                </button>
                <button
                  type="button"
                  className={`${styles.walletMenuItem} ${styles.walletMenuItemDanger}`}
                  role="menuitem"
                  onClick={disconnectWallet}
                >
                  Disconnect
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <section className={styles.contextStrip}>
        <div className={styles.contextBlock}>
          <p className={styles.contextLabel}>Mode</p>
          <div className={styles.segmentStrip}>
            <button
              type="button"
              className={`${styles.segmentOption} ${!isVaultMode ? styles.segmentOptionActive : ""}`}
              onClick={() => {
                setActiveAction(null);
                setSelectedDelegator(account);
                void refreshData(account, account);
              }}
              disabled={selectedDelegator === account}
            >
              Wallet
            </button>
            <button
              type="button"
              className={`${styles.segmentOption} ${isVaultMode ? styles.segmentOptionActive : ""}`}
              onClick={() => {
                if (!activeVault) return;
                setActiveAction(null);
                setSelectedDelegator(activeVault);
                void refreshData(account, activeVault);
              }}
              disabled={!hasVault || isVaultMode}
            >
              {hasVault && activeVault ? getVaultLabel(activeVault) : "Vault"}
            </button>
          </div>
          <p className={styles.contextTitle}>{modeDescription}</p>
        </div>

        <label className={styles.contextBlockSelect}>
          <p className={styles.contextLabel}>Active delegator</p>
          <select
            className={styles.inlineSelect}
            value={selectedDelegator || ""}
            onChange={(event) => {
              const next = event.target.value;
              setActiveAction(null);
              setSelectedDelegator(next);
              void refreshData(account, next);
            }}
            disabled={isLoading || isSending}
          >
            <option value={account}>{`${shortAddress(account)} - Wallet`}</option>
            {vaults.map((vault) => (
              <option key={vault} value={vault}>{`${getVaultLabel(vault)} - ${shortAddress(vault)}`}</option>
            ))}
          </select>
          <p className={styles.contextTitle}>
            Acting as {isVaultMode ? getVaultLabel(selectedDelegator) : "Wallet"}
          </p>
          <button
            type="button"
            className={`${styles.secondaryBtn} ${styles.contextRefreshBtn}`}
            onClick={refreshNow}
            disabled={!canRefresh}
          >
            {isLoading ? "Refreshing..." : "Refresh"}
          </button>
        </label>
      </section>

      <section className={styles.tokenLegend}>
        <span>ATN = gas token</span>
        <span>NTN = staking token</span>
        <span>LNTN = liquid validator token</span>
      </section>

      <section className={styles.primaryCards}>
        <article className={styles.primaryCard}>
          <p className={styles.cardLabel}>Available to stake</p>
          <p className={styles.cardValue}>
            {formatToken(readyToStakeNtn)} <span className={styles.cardToken}>NTN</span>
          </p>
          <p className={styles.cardHint}>
            {isVaultMode ? "From selected vault balance." : "From connected wallet balance."}
          </p>
          <div
            className={`${styles.cardActions} ${styles.cardActionsSingle}`}
          >
            <button
              type="button"
              className={styles.primaryBtn}
              onClick={() => setActiveAction((prev) => (prev === "stake" ? null : "stake"))}
              disabled={primaryActionDisabled || activeValidators.length === 0 || isLoading || isSending}
            >
              Stake
            </button>
          </div>
        </article>

        {!isVaultMode && (
          <article className={styles.primaryCard}>
            <p className={styles.cardLabel}>Total portfolio</p>
            <p className={styles.cardValue}>
              {formatToken(portfolioNtnEquivalent)} <span className={styles.cardToken}>NTN</span>
            </p>
            <p className={styles.cardHint}>All balances (NTN + LNTN converted to NTN).</p>
            <p className={styles.cardHint}>Total staked: {formatToken(portfolioStakedNtn)} NTN</p>
          </article>
        )}

        {isVaultMode && (
          <>
            <article className={styles.primaryCard}>
              <p className={styles.cardLabel}>Claimable rewards</p>
              <p className={styles.cardValue}>
                {formatClaimAtn(readyToClaimAtn)} <span className={styles.cardToken}>ATN</span>
              </p>
              <p className={styles.cardHint}>Claimed separately from unstake.</p>
              <div className={`${styles.cardActions} ${styles.cardActionsSingle}`}>
                <button
                  type="button"
                  className={styles.primaryBtn}
                  onClick={() => setActiveAction((prev) => (prev === "claim" ? null : "claim"))}
                  disabled={!canClaim}
                >
                  Claim
                </button>
              </div>
            </article>

            <article className={styles.primaryCard}>
              <p className={styles.cardLabel}>Vesting locked</p>
              <p className={styles.cardValue}>
                {formatToken(vestingLockedNtn)} <span className={styles.cardToken}>NTN</span>
              </p>
              <p className={styles.cardHint}>
                {vaultVestingTotalNtn !== null && vaultVestingReleasedNtnApprox !== null
                  ? `Total ${formatToken(vaultVestingTotalNtn)} / released ${formatToken(
                      vaultVestingReleasedNtnApprox
                    )} NTN`
                  : "Not yet vested for vault withdraw."}
              </p>
              <button
                type="button"
                className={`${styles.secondaryBtn} ${styles.cardSecondaryStacked}`}
                onClick={() => void onRelease()}
                disabled={!canWithdraw}
              >
                <span>Withdraw to wallet</span>
                <span className={styles.buttonSubValue}>
                  Withdrawable now: {formatToken(readyToWithdrawNtn)} NTN
                </span>
              </button>
            </article>
          </>
        )}

      </section>

      {activeAction !== null && (
        <section className={styles.actionPanel}>
          {activeAction === "stake" && (
            <>
              <div className={styles.actionPanelHeader}>
                <h2>Stake</h2>
                <button
                  className={`${styles.ghostBtn} ${styles.iconCloseBtn}`}
                  type="button"
                  onClick={() => setActiveAction(null)}
                  aria-label="Close"
                >
                  ×
                </button>
              </div>

              <label className={styles.fieldGroup}>
                <span>{`Active validators (${activeValidators.length})`}</span>
                <div className={styles.stakeValidatorPanel}>
                  <div className={styles.stakeSelectedCard}>
                    {selectedBondValidatorInfo ? (
                      <>
                        <span className={styles.validatorIdentity}>
                          {selectedBondValidatorInfo.logoPath &&
                          !brokenLogos[selectedBondValidatorInfo.address.toLowerCase()] ? (
                            <Image
                              src={selectedBondValidatorInfo.logoPath}
                              alt={
                                selectedBondValidatorInfo.moniker ||
                                shortAddress(selectedBondValidatorInfo.address)
                              }
                              className={styles.validatorLogo}
                              width={22}
                              height={22}
                              onError={() =>
                                setBrokenLogos((prev) => ({
                                  ...prev,
                                  [selectedBondValidatorInfo.address.toLowerCase()]: true,
                                }))
                              }
                            />
                          ) : (
                            <span className={styles.validatorLogoFallback}>
                              {(selectedBondValidatorInfo.moniker ||
                                selectedBondValidatorInfo.address.slice(2, 4))
                                .slice(0, 2)
                                .toUpperCase()}
                            </span>
                          )}
                          <span className={styles.validatorText}>
                            <strong>
                              {selectedBondValidatorInfo.moniker ||
                                shortAddress(selectedBondValidatorInfo.address)}
                            </strong>
                            <small title={selectedBondValidatorInfo.address}>
                              {shortAddress(selectedBondValidatorInfo.address)}
                            </small>
                            <small>
                              <span className={styles.validatorStatLine}>
                                <span>Stake {formatToken(selectedBondValidatorInfo.totalStake)} NTN</span>
                                <span>
                                  1 LNTN = {formatConversionRatio(selectedBondValidatorInfo.conversionRatio)} NTN
                                </span>
                              </span>
                            </small>
                          </span>
                        </span>
                        <span className={styles.validatorMetaRight}>
                          <span className={styles.validatorFeeBadge}>
                            Fee {formatCommissionRate(selectedBondValidatorInfo.commissionRate)}
                          </span>
                          <span
                            className={`${styles.statusPill} ${
                              selectedBondValidatorInfo.validatorStatus === "active"
                                ? styles.statusActive
                                : selectedBondValidatorInfo.validatorStatus === "jailed"
                                  ? styles.statusJailed
                                  : styles.statusInactive
                            }`}
                          >
                            {formatValidatorStatus(selectedBondValidatorInfo.validatorStatus)}
                          </span>
                        </span>
                      </>
                    ) : (
                      <span className={styles.validatorPlaceholder}>No active validator available</span>
                    )}
                  </div>

                  <div className={styles.stakeValidatorGrid}>
                    <div className={`${styles.validatorOptionList} ${styles.stakeValidatorRows}`}>
                      <div className={`${styles.stakeValidatorHeader} ${styles.stakeValidatorHeaderSticky}`}>
                        <span>#</span>
                        <span>Node</span>
                        <span>Fee</span>
                        <span>Total Stake</span>
                        <span>Self-Bonded</span>
                        <span>Live ratio</span>
                        <span>My Stake</span>
                      </div>
                      {activeValidators.length === 0 ? (
                        <div className={styles.validatorNoResult}>No active validator found.</div>
                      ) : (
                        activeValidators.map((validator) => {
                          const rank = validatorRankMap.get(validator.address.toLowerCase()) || "-";
                          const myStake = myStakeByValidator.get(validator.address.toLowerCase()) || ZERO;
                          const isSelected = sameAddress(validator.address, bondValidator);

                          return (
                            <button
                              type="button"
                              key={validator.address}
                              className={`${styles.validatorOption} ${styles.stakeValidatorOption} ${
                                isSelected ? styles.stakeValidatorOptionSelected : ""
                              }`}
                              onClick={() => {
                                setBondValidator(validator.address);
                                setBondExactMaxAmount(null);
                              }}
                            >
                              <span className={styles.stakeColRank}>{rank}</span>
                              <span className={`${styles.validatorIdentity} ${styles.stakeColNode}`}>
                                {validator.logoPath && !brokenLogos[validator.address.toLowerCase()] ? (
                                  <Image
                                    src={validator.logoPath}
                                    alt={validator.moniker || shortAddress(validator.address)}
                                    className={styles.validatorLogo}
                                    width={22}
                                    height={22}
                                    onError={() =>
                                      setBrokenLogos((prev) => ({
                                        ...prev,
                                        [validator.address.toLowerCase()]: true,
                                      }))
                                    }
                                  />
                                ) : (
                                  <span className={styles.validatorLogoFallback}>
                                    {(validator.moniker || validator.address.slice(2, 4))
                                      .slice(0, 2)
                                      .toUpperCase()}
                                  </span>
                                )}
                                <span className={styles.validatorText}>
                                  <strong>{validator.moniker || shortAddress(validator.address)}</strong>
                                  <small title={validator.address}>{shortAddress(validator.address)}</small>
                                </span>
                              </span>
                              <span className={styles.stakeColFee}>
                                {formatCommissionRate(validator.commissionRate)}
                              </span>
                              <span className={styles.stakeColTotal}>
                                {formatToken(validator.totalStake, 18, 2)} NTN
                              </span>
                              <span className={styles.stakeColSelfBonded}>
                                {formatToken(validator.selfBondedStake, 18, 2)} NTN
                              </span>
                              <span className={styles.stakeColRatio}>
                                1 LNTN = {formatConversionRatio(validator.conversionRatio)} NTN
                              </span>
                              <span
                                className={`${styles.stakeColMyStake} ${
                                  myStake > ZERO ? styles.stakeMyStakeValue : styles.stakeMyStakeEmpty
                                }`}
                              >
                                {myStake > ZERO ? `${formatToken(myStake, 18, 4)} LNTN` : "-"}
                              </span>
                            </button>
                          );
                        })
                      )}
                    </div>
                  </div>
                </div>
              </label>

              <label className={styles.fieldGroup}>
                <span>Amount</span>
                <div className={styles.amountRow}>
                  <input
                    value={bondAmount}
                    onChange={(event) => {
                      setBondAmount(event.target.value.trim());
                      setBondExactMaxAmount(null);
                    }}
                    placeholder="Amount in NTN"
                    disabled={isLoading || isSending}
                  />
                  <button
                    type="button"
                    className={styles.ghostBtn}
                    onClick={fillStakeMax}
                    disabled={readyToStakeNtn === ZERO || isLoading || isSending}
                  >
                    Max
                  </button>
                </div>
              </label>

              <p className={styles.actionHint}>
                Bond requests are processed by protocol timing and can settle after epoch boundary.
              </p>

              <button
                className={styles.primaryBtn}
                type="button"
                onClick={onStake}
                disabled={!canStake || bondAmount.length === 0 || isLoading || isSending}
              >
                Stake
              </button>
            </>
          )}

          {activeAction === "unstake" && (
            <>
              <div className={styles.actionPanelHeader}>
                <h2>Unstake</h2>
                <button
                  className={`${styles.ghostBtn} ${styles.iconCloseBtn}`}
                  type="button"
                  onClick={() => setActiveAction(null)}
                  aria-label="Close"
                >
                  ×
                </button>
              </div>

              <label className={styles.fieldGroup}>
                <span>Validator</span>
                <div className={styles.validatorPicker} ref={unbondDropdownRef}>
                  <button
                    type="button"
                    className={styles.validatorPickerTrigger}
                    onClick={() => {
                      setUnbondDropdownOpen((prev) => !prev);
                      setUnbondSearch("");
                    }}
                    disabled={isLoading || isSending || unbondableRows.length === 0}
                  >
                    {selectedUnbondValidatorRow ? (
                      <>
                        {renderValidatorIdentity(selectedUnbondValidatorRow.validator)}
                        <span className={styles.validatorCommission}>
                          Max {formatToken(selectedUnbondValidatorRow.unlocked)} LNTN
                        </span>
                      </>
                    ) : (
                      <span className={styles.validatorPlaceholder}>Select validator</span>
                    )}
                  </button>
                  {unbondDropdownOpen && (
                    <div className={styles.validatorPickerMenu}>
                      <input
                        value={unbondSearch}
                        onChange={(event) => setUnbondSearch(event.target.value)}
                        placeholder="Search validator by name or address"
                        className={styles.validatorSearch}
                        autoFocus
                      />
                      <div className={styles.validatorOptionList}>
                        {filteredUnbondableRows.length === 0 ? (
                          <div className={styles.validatorNoResult}>No validator found.</div>
                        ) : (
                          filteredUnbondableRows.map((row) => (
                            <button
                              type="button"
                              key={row.validator}
                              className={styles.validatorOption}
                              onClick={() => {
                                setUnbondValidator(row.validator);
                                setUnbondExactMaxAmount(null);
                                setUnbondDropdownOpen(false);
                                setUnbondSearch("");
                              }}
                            >
                              {renderValidatorIdentity(row.validator)}
                              <span className={styles.validatorCommission}>
                                Max {formatToken(row.unlocked)} LNTN
                              </span>
                              <span
                                className={`${styles.statusPill} ${
                                  row.validatorStatus === "active"
                                    ? styles.statusActive
                                    : row.validatorStatus === "jailed"
                                      ? styles.statusJailed
                                      : styles.statusInactive
                                }`}
                              >
                                {formatValidatorStatus(row.validatorStatus)}
                              </span>
                            </button>
                          ))
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </label>

              <label className={styles.fieldGroup}>
                <span>Amount</span>
                <div className={styles.amountRow}>
                  <input
                    value={unbondAmount}
                    onChange={(event) => {
                      setUnbondAmount(event.target.value.trim());
                      setUnbondExactMaxAmount(null);
                    }}
                    placeholder="Amount in LNTN"
                    disabled={isLoading || isSending}
                  />
                  <button
                    type="button"
                    className={styles.ghostBtn}
                    onClick={() => {
                      fillUnstakeMax();
                    }}
                    disabled={unbondableRows.length === 0 || isLoading || isSending}
                  >
                    Max
                  </button>
                </div>
              </label>

              <button
                className={styles.primaryBtn}
                type="button"
                onClick={onUnstake}
                disabled={!canUnstake || unbondAmount.length === 0 || isLoading || isSending}
              >
                Unstake
              </button>
            </>
          )}

          {activeAction === "claim" && (
            <>
              <div className={styles.actionPanelHeader}>
                <h2>Claim</h2>
                <button
                  className={`${styles.ghostBtn} ${styles.iconCloseBtn}`}
                  type="button"
                  onClick={() => setActiveAction(null)}
                  aria-label="Close"
                >
                  ×
                </button>
              </div>

              {sameAddress(selectedDelegator, account) && (
                <label className={styles.fieldGroup}>
                  <span>Validator</span>
                  <div className={styles.validatorPicker} ref={claimDropdownRef}>
                    <button
                      type="button"
                      className={styles.validatorPickerTrigger}
                      onClick={() => {
                        setClaimDropdownOpen((prev) => !prev);
                        setClaimSearch("");
                      }}
                      disabled={isLoading || isSending || rewardRows.length === 0}
                    >
                      {selectedClaimValidatorRow ? (
                        <>
                          {renderValidatorIdentity(selectedClaimValidatorRow.validator)}
                          <span className={styles.validatorCommission}>
                            Rewards {formatClaimAtn(selectedClaimValidatorRow.unclaimedRewards)} ATN
                          </span>
                        </>
                      ) : (
                        <span className={styles.validatorPlaceholder}>Select validator</span>
                      )}
                    </button>
                    {claimDropdownOpen && (
                      <div className={styles.validatorPickerMenu}>
                        <input
                          value={claimSearch}
                          onChange={(event) => setClaimSearch(event.target.value)}
                          placeholder="Search validator by name or address"
                          className={styles.validatorSearch}
                          autoFocus
                        />
                        <div className={styles.validatorOptionList}>
                          {filteredRewardRows.length === 0 ? (
                            <div className={styles.validatorNoResult}>No validator found.</div>
                          ) : (
                            filteredRewardRows.map((row) => (
                              <button
                                type="button"
                                key={row.validator}
                                className={styles.validatorOption}
                                onClick={() => {
                                  setClaimValidator(row.validator);
                                  setClaimDropdownOpen(false);
                                  setClaimSearch("");
                                }}
                              >
                                {renderValidatorIdentity(row.validator)}
                                <span className={styles.validatorCommission}>
                                  Rewards {formatClaimAtn(row.unclaimedRewards)} ATN
                                </span>
                                <span
                                  className={`${styles.statusPill} ${
                                    row.validatorStatus === "active"
                                      ? styles.statusActive
                                      : row.validatorStatus === "jailed"
                                        ? styles.statusJailed
                                        : styles.statusInactive
                                  }`}
                                >
                                  {formatValidatorStatus(row.validatorStatus)}
                                </span>
                              </button>
                            ))
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </label>
              )}

              {isVaultMode && (
                <p className={styles.actionHint}>
                  Claims all staking rewards for the selected vault.
                </p>
              )}

              <button
                className={styles.primaryBtn}
                type="button"
                onClick={onClaim}
                disabled={isLoading || isSending || !canClaim}
              >
                Claim
              </button>
            </>
          )}

        </section>
      )}

      <section className={styles.panelsGrid}>
        <article className={`${styles.panel} ${styles.positionsPanel}`}>
          <div className={styles.panelHeader}>
            <h3>Positions</h3>
          </div>

          {delegations.length === 0 ? (
            <div className={styles.emptyStateWrap}>
              <p className={styles.emptyState}>No staking positions.</p>
            </div>
          ) : (
            <div className={styles.tableWrap}>
              <table>
                <thead>
                  <tr>
                    <th>Validator</th>
                    <th>Staked</th>
                    <th>Live ratio</th>
                    <th>Rewards</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {delegations.map((row) => {
                    const canAddStakeForRow =
                      readyToStakeNtn > ZERO &&
                      activeValidators.some((item) => sameAddress(item.address, row.validator));
                    const canUnstakeForRow = row.unlocked > ZERO;
                    const canClaimForRow = row.unclaimedRewards > ZERO;
                    const inlineOpenForRow = Boolean(
                      positionInlineAction &&
                        sameAddress(positionInlineAction.validator, row.validator)
                    );
                    const inlineType = inlineOpenForRow ? positionInlineAction!.type : null;
                    const maxForInline = inlineType === "stake" ? readyToStakeNtn : row.unlocked;
                    const inlineSubmitDisabled =
                      !inlineType ||
                      primaryActionDisabled ||
                      positionInlineAmount.length === 0 ||
                      isLoading ||
                      isSending ||
                      maxForInline <= ZERO;

                    return (
                      <Fragment key={row.validator}>
                        <tr>
                          <td title={row.validator}>{renderValidatorIdentity(row.validator)}</td>
                          <td>{formatToken(row.total)} LNTN</td>
                          <td>1 LNTN = {formatConversionRatio(row.conversionRatio)} NTN</td>
                          <td>{formatClaimAtn(row.unclaimedRewards)} ATN</td>
                          <td>
                            <span
                              className={`${styles.statusPill} ${
                                row.validatorStatus === "active"
                                  ? styles.statusActive
                                  : row.validatorStatus === "jailed"
                                    ? styles.statusJailed
                                    : styles.statusInactive
                              }`}
                            >
                              {formatValidatorStatus(row.validatorStatus)}
                            </span>
                          </td>
                          <td>
                            <div className={styles.positionActions}>
                              <button
                                type="button"
                                className={styles.ghostBtn}
                                onClick={() => toggleInlineStake(row.validator)}
                                disabled={
                                  primaryActionDisabled || !canAddStakeForRow || isLoading || isSending
                                }
                              >
                                Add stake
                              </button>
                              <button
                                type="button"
                                className={styles.ghostBtn}
                                onClick={() => toggleInlineUnstake(row.validator)}
                                disabled={
                                  primaryActionDisabled || !canUnstakeForRow || isLoading || isSending
                                }
                              >
                                Unstake
                              </button>
                              <button
                                type="button"
                                className={styles.secondaryBtn}
                                onClick={() => void onClaimRow(row)}
                                disabled={
                                  primaryActionDisabled || !canClaimForRow || isLoading || isSending
                                }
                              >
                                Claim
                              </button>
                            </div>
                          </td>
                        </tr>
                        {inlineOpenForRow && inlineType && (
                          <tr className={styles.inlineActionRow}>
                            <td colSpan={6}>
                              <div
                                className={`${styles.inlineActionPanel} ${
                                  inlineType === "stake"
                                    ? styles.inlineStakePanel
                                    : styles.inlineUnstakePanel
                                }`}
                              >
                                <div className={styles.inlineActionHeader}>
                                  <div className={styles.inlineActionTitle}>
                                    <p>{inlineType === "stake" ? "Add stake" : "Unstake"}</p>
                                    {renderValidatorIdentity(row.validator)}
                                  </div>
                                  <button
                                    type="button"
                                    className={`${styles.ghostBtn} ${styles.iconCloseBtn}`}
                                    onClick={() => {
                                      setPositionInlineAction(null);
                                      setPositionInlineAmount("");
                                      setPositionInlineExactMaxAmount(null);
                                    }}
                                    aria-label="Close"
                                  >
                                    ×
                                  </button>
                                </div>
                                <div className={styles.inlineActionControls}>
                                  <input
                                    value={positionInlineAmount}
                                    onChange={(event) => {
                                      setPositionInlineAmount(event.target.value.trim());
                                      setPositionInlineExactMaxAmount(null);
                                    }}
                                    placeholder={
                                      inlineType === "stake" ? "Amount in NTN" : "Amount in LNTN"
                                    }
                                    disabled={isLoading || isSending}
                                  />
                                  <button
                                    type="button"
                                    className={styles.ghostBtn}
                                    onClick={fillPositionInlineMax}
                                    disabled={maxForInline <= ZERO || isLoading || isSending}
                                  >
                                    Max
                                  </button>
                                  <button
                                    type="button"
                                    className={styles.primaryBtn}
                                    onClick={() => void onPositionInlineSubmit()}
                                    disabled={inlineSubmitDisabled}
                                  >
                                    {inlineType === "stake" ? "Stake" : "Unstake"}
                                  </button>
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </article>

        <article className={`${styles.panel} ${styles.queuePanel}`}>
          <div className={styles.panelHeader}>
            <h3>Protocol queue</h3>
          </div>
          <div className={styles.tableWrap}>
            <table>
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Validator</th>
                  <th>Amount</th>
                  <th>Request block</th>
                  <th>Status</th>
                  <th>Remaining</th>
                </tr>
              </thead>
              <tbody>
                {unbondings.length === 0 ? (
                  <tr>
                    <td colSpan={6} className={styles.emptyRow}>
                      No protocol actions found.
                    </td>
                  </tr>
                ) : (
                  pagedQueueRows.map((row) => {
                    const status =
                      row.phase === "waiting"
                        ? "Waiting"
                        : row.phase === "ready"
                          ? "Ready"
                          : "Done";
                    const remaining =
                      row.phase === "waiting"
                        ? `${row.remainingBlocks ?? 0} blocks`
                        : row.phase === "ready"
                          ? row.action === "Unstake"
                            ? "Ready to withdraw"
                            : "-"
                          : "Completed";
                    return (
                      <tr key={row.id}>
                        <td>{row.action}</td>
                        <td title={row.validator}>{renderValidatorIdentity(row.validator)}</td>
                        <td>{`${formatToken(row.amount)} ${row.tokenSymbol}`}</td>
                        <td>{row.requestBlock}</td>
                        <td>{status}</td>
                        <td>{remaining}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
          {unbondings.length > 0 && (
            <div className={styles.queuePager}>
              <button
                type="button"
                className={styles.ghostBtn}
                onClick={() => setQueuePage((prev) => Math.max(1, prev - 1))}
                disabled={queueCurrentPage === 1}
              >
                Previous
              </button>
              <span className={styles.queuePagerInfo}>
                Page {queueCurrentPage} / {queueTotalPages}
              </span>
              <button
                type="button"
                className={styles.ghostBtn}
                onClick={() => setQueuePage((prev) => Math.min(queueTotalPages, prev + 1))}
                disabled={queueCurrentPage === queueTotalPages}
              >
                Next
              </button>
            </div>
          )}
          <p className={styles.queueNote}>
            Stake and unstake requests are listed from newest to oldest by request block. In vault
            mode, ready unstakes can still show zero withdrawable NTN until vault releasable funds
            are available.
          </p>
        </article>
      </section>

      <footer className={`${styles.footer} ${styles.infoPanel}`}>
        <div className={styles.footerTop}>
          <p className={styles.status}>{statusLine}</p>
          <p className={styles.footerMadeWith}>
            made with{" "}
            <a
              href="https://blockscout.akeyra.klazomenai.dev/address/0xBA917955E2c1b3bF67dfdaAe9D78508f11ccE862"
              target="_blank"
              rel="noreferrer"
              className={styles.footerHeartLink}
              aria-label="Open support address"
              title="Open support address"
            >
              {"\u2764"}
            </a>
          </p>
          <div className={styles.footerRightMeta}>
            <a
              href="https://github.com/uniqnodes/autonity-stake-terminal"
              target="_blank"
              rel="noreferrer"
              className={styles.footerGithubLink}
              aria-label="Open GitHub repository"
              title="Open GitHub repository"
            >
              <svg viewBox="0 0 24 24" className={styles.footerGithubIcon} aria-hidden="true">
                <path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48l-.01-1.7c-2.78.6-3.37-1.19-3.37-1.19-.45-1.15-1.11-1.45-1.11-1.45-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.9 1.53 2.35 1.09 2.92.84.09-.64.35-1.08.63-1.33-2.22-.25-4.55-1.11-4.55-4.95 0-1.09.39-1.98 1.03-2.67-.11-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.62 9.62 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.21 2.4.1 2.65.64.69 1.03 1.58 1.03 2.67 0 3.85-2.34 4.7-4.57 4.95.36.31.68.92.68 1.86l-.01 2.76c0 .26.18.58.69.48A10 10 0 0 0 12 2Z" />
              </svg>
            </a>
            <span className={styles.blockInfo}>Block: {currentBlock ?? "-"}</span>
          </div>
        </div>
        {actionLine && <p className={styles.status}>{actionLine}</p>}
        {lastTxHash && (
          <a href={`${EXPLORER_TX_BASE}${lastTxHash}`} target="_blank" rel="noreferrer">
            View transaction: {shortAddress(lastTxHash)}
          </a>
        )}
      </footer>

    </main>
  );
}
