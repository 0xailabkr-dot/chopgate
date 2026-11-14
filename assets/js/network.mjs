/**
 * U4 network slots. One file. Testnet is the only enabled network.
 * Mainnet slots follow U0 r2-4: enabled false, endpoints empty, the chain id
 * is the known name, the gate code hash is the confirmed wasm hash.
 * tourGate is one constant. If u1-testnet/rund-state.json exists when the
 * site is built, point tourGate at that gate account and set tourLabel to
 * "Run D gate". Read 2026-11-14: gate.account is the Run D gate.
 */
export const TESTNET = {
  enabled: true,
  networkId: "testnet",
  chainId: "testnet",
  rpc: [
    "https://test.rpc.fastnear.com",
    "https://rpc.testnet.near.org",
    "https://archival-rpc.testnet.fastnear.com",
    "https://archival-rpc.testnet.near.org",
  ],
  archivalRpc: [
    "https://archival-rpc.testnet.fastnear.com",
    "https://archival-rpc.testnet.near.org",
  ],
  txIndexer: "https://tx.test.fastnear.com/v0/account",
  accountFull: "https://test.api.fastnear.com/v1/account/{id}/full",
  explorerTx: "https://testnet.nearblocks.io/txns/",
  explorerAddress: "https://testnet.nearblocks.io/address/",
  factoryAccountId: "cg-u1f-fdf59d31.testnet",
  tourGate: "cg-u3g-b7f26e6c.testnet",
  tourLabel: "Run D gate",
  faucet: "https://docs.near.org/getting-started/faucet",
  walletCreate: "https://wallet.intear.tech/",
  gateCodeHash: "8Qtk3jf4RLpfiB7PeXeuPGYcp4USV2yeN5Zn3d5NpAMj",
  globalCodePublished: false,
  deploymentLabelPrefix: "chopgate-f1",
  emptyCodeHash: "11111111111111111111111111111111",
};

export const MAINNET = {
  enabled: false,
  networkId: "mainnet",
  chainId: "mainnet",
  rpc: null,
  archivalRpc: null,
  txIndexer: null,
  accountFull: null,
  explorerTx: null,
  explorerAddress: null,
  nearblocksApi: null,
  factoryAccountId: null,
  tourGate: null,
  faucet: null,
  gateCodeHash: "8Qtk3jf4RLpfiB7PeXeuPGYcp4USV2yeN5Zn3d5NpAMj",
  globalCodePublished: false,
  deploymentLabelPrefix: null,
};

export const ACTIVE = TESTNET;

/** keep in sync with C2 wallet list. Ids are the testnet wallets in the NEAR Connect manifest (commit b57880c2, read 2026-11-14). */
export const WALLET_ALLOWLIST = ["meteor-wallet", "intear-wallet", "ledger", "nightly-wallet", "ethereum-wallets", "near-cli"];

/** Intear create page. C2 recorded this URL. Render the sentence and the link together. */
export const INTEAR_TESTNET_CREATE_URL = "https://wallet.intear.tech/";

/** Added to a live required_deposit() for the guidance total and the unlock check. Measured create_gate gas was 0.018344 NEAR. */
export const GAS_MARGIN_NEAR = "0.02";

/** Shown when required_deposit() cannot be read. Create stays locked on that path. */
export const FALLBACK_TOTAL_NEAR = "5.6";

/** Faucet measured on testnet: 5 NEAR per request. The page does not show a request limit. */
export const FAUCET_URL = "https://docs.near.org/getting-started/faucet";

/** When false, the console hides Create agent account and /agent shows the CLI path. */
export const FEATURE_CREATE_AGENT_ACCOUNT = true;

/** NEAR attached when the owner creates an agent sub-account. 1 covers a 300 Tgas call. */
export const AGENT_ACCOUNT_FUNDING_NEAR = "1";

/** The tiered agent payment method in the gate contract. */
export const AGENT_METHOD_NAMES = ["authorize_and_pay_tiered"];

export function explorerTxUrl(hash) {
  if (!hash || !TESTNET.explorerTx) return "";
  return TESTNET.explorerTx + hash;
}

export function explorerAddressUrl(account) {
  if (!account || !TESTNET.explorerAddress) return "";
  return TESTNET.explorerAddress + account;
}
