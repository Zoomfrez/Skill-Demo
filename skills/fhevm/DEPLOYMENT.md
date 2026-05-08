# DEPLOYMENT.md

Shipping FHEVM contracts. Sepolia and mainnet are different beasts — keep them separated.

> Some of this content is general smart-contract deployment hygiene; FHEVM-specific items are flagged. Verify SDK/Hardhat versions in `CHANGELOG.md` before reproducing the install commands.

---

## QUICK START — Sepolia

```bash
# 1. Install (note: legacy-peer-deps is required, see CHANGELOG.md)
npm install --save-dev hardhat@2.22.0 @fhevm/hardhat-plugin \
  @nomicfoundation/hardhat-ethers@3.1.3 @nomicfoundation/hardhat-toolbox@3.0.0 \
  ethers@6.13.0 typescript ts-node @types/node --legacy-peer-deps

npm install @fhevm/solidity @zama-fhe/relayer-sdk@0.4.1 --legacy-peer-deps

# 2. Set env (use Codespaces Secrets or .env, not export)
SEPOLIA_RPC_URL=https://...
PRIVATE_KEY=0x...
ETHERSCAN_API_KEY=...

# 3. Compile + test
npx hardhat compile
npx hardhat test

# 4. Deploy
npx hardhat run scripts/deploy.ts --network sepolia

# 5. Verify
./node_modules/.bin/hardhat verify --network sepolia <address>
```

---

## §1 — Environment variables

### §1.1 — Required

| Var | Sepolia | Mainnet | Notes |
|---|---|---|---|
| `SEPOLIA_RPC_URL` / `MAINNET_RPC_URL` | ✓ | ✓ | Use a paid provider for mainnet (Alchemy, Infura). |
| `PRIVATE_KEY` | ✓ | ✓ | **Deployer key only.** Never the same key that holds funds long-term. |
| `ETHERSCAN_API_KEY` | ✓ | ✓ | For contract verification. |
| `ZAMA_RELAYER_API_KEY` | — | ✓ | Required for mainnet decryption. |

### §1.2 — Storage

- **MUST** use environment-specific secret storage:
  - Local: `.env` + `.gitignore`. Never commit.
  - GitHub Codespaces: **Settings → Codespaces → Secrets**. `export` in a terminal is lost on session end.
  - CI: GitHub Actions Encrypted Secrets, or equivalent.
  - Production scripts: AWS SSM Parameter Store / GCP Secret Manager / 1Password CLI.
- **NEVER** include real `PRIVATE_KEY` in `hardhat.config.ts` even as a placeholder. A copy-paste mistake will commit it.

### §1.3 — `hardhat.config.ts` pattern

```typescript
import "@fhevm/hardhat-plugin";
import "@nomicfoundation/hardhat-chai-matchers";
import { HardhatUserConfig } from "hardhat/config";

const config: HardhatUserConfig = {
  solidity: { version: "0.8.24", settings: { optimizer: { enabled: true, runs: 200 } } },
  networks: {
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL ?? "",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: 11155111,
    },
    mainnet: {
      url: process.env.MAINNET_RPC_URL ?? "",
      accounts: process.env.MAINNET_PRIVATE_KEY ? [process.env.MAINNET_PRIVATE_KEY] : [],
      chainId: 1,
    },
  },
  etherscan: { apiKey: process.env.ETHERSCAN_API_KEY },
};
export default config;
```

- **MUST** keep `PRIVATE_KEY` and `MAINNET_PRIVATE_KEY` separate. Different threat model, different keys.

---

## §2 — Pre-deploy checklist (both networks)

Run before every deploy. Fail-fast on any item.

### §2.1 — Contract correctness (run audit pass from `CORE_RULES.md` §9)

- [ ] Inherits `ZamaEthereumConfig`.
- [ ] No `FHE.*` in any constructor.
- [ ] Every `externalEuintXX` consumed by `FHE.fromExternal`.
- [ ] Every state assignment followed by `FHE.allowThis`.
- [ ] User-readable handles have `FHE.allow(h, user)`.
- [ ] No `if (encryptedBool)`.
- [ ] No `FHE.div`/`rem` with encrypted RHS.
- [ ] Overflow guarded with `FHE.select`.
- [ ] No arithmetic on `euint256`.
- [ ] Cross-contract handles use `allowTransient`.
- [ ] `checkSignatures` order matches `publicDecrypt` order.
- [ ] Replay protection on every `checkSignatures`-consuming function.
- [ ] No plaintext or derived values in events.

### §2.2 — Toolchain

- [ ] Hardhat **2.x** (not 3.x). See `CHANGELOG.md` §1.
- [ ] All `npm install` ran with `--legacy-peer-deps`.
- [ ] `tsconfig.json` has `"rootDir": "."`.
- [ ] `npx hardhat compile` succeeds with no warnings (or only known warnings).
- [ ] All tests pass: `npx hardhat test`.

### §2.3 — Test coverage

- [ ] Happy path for each role-gated function.
- [ ] Reverts: unauthorized callers, uninitialized handles, replay attempts.
- [ ] ACL: every "allow" path is exercised by a follow-up tx that uses the handle.
- [ ] Overflow: explicit test that adding `MAX_UINT64 + 1` is a no-op.
- [ ] Decryption: full 3-step flow tested end-to-end (mock environment is sufficient for logic; real Sepolia for cryptography).

---

## §3 — Sepolia deploy

### §3.1 — Steps

```bash
# Compile (one-shot, do not --force after this)
npx hardhat compile

# Deploy
npx hardhat run scripts/deploy.ts --network sepolia

# Capture address — log it AND save it to deployments/sepolia.json

# Generate Standard JSON Input for verification (BEFORE any --force recompile)
cat artifacts/build-info/*.json | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d['input'], indent=2))" > standard-input.json
```

### §3.2 — Verification

Three options, in order of preference:

1. **CLI verify** (works in unrestricted networks):
   ```bash
   ./node_modules/.bin/hardhat verify --network sepolia <address> [constructor args]
   ```
   Use the local binary — `npx hardhat verify` may be intercepted by npx prompting to install a different version.

2. **Standard JSON Input via Etherscan UI** (works behind firewalls):
   `sepolia.etherscan.io` → your contract → Verify and Publish → Standard JSON Input → upload `standard-input.json`.

3. **Sourcify** (alternative): `verify.sourcify.dev`.

If verification fails with bytecode mismatch, see `CHANGELOG.md` §verification-bytecode.

### §3.3 — Post-deploy smoke test

Run a single tx of every state-modifying function. Confirm:

- [ ] Function executes successfully.
- [ ] Subsequent reads work (no `"FHE: not allowed"` revert — proves ACL was correct).
- [ ] User decryption returns the expected plaintext.
- [ ] If applicable: full public-decryption flow runs end-to-end with the real coprocessor latency (5–15s on Sepolia).

---

## §4 — Mainnet deploy

Mainnet has additional requirements beyond Sepolia.

### §4.1 — Pre-deploy hardening

- [ ] Sepolia deploy has been live for ≥7 days with real-world traffic and no incidents.
- [ ] External audit completed on the exact deployed bytecode (or formal review documented).
- [ ] Deployer key generated specifically for this deploy, never reused.
- [ ] **Multisig prepared** to receive ownership immediately post-deploy.
- [ ] `ZAMA_RELAYER_API_KEY` provisioned and confirmed working from a server-side environment.
- [ ] Gas budget calculated:
  - Per-op gas estimates from `CORE_RULES.md` §3.1 are Sepolia-derived. Multiply by mainnet base-fee × 5–10× for budgeting.
  - Total deploy cost = constructor cost + initial state setup. For a typical confidential ERC20 with one-time `initialize`, budget 0.05–0.2 ETH at moderate gas.

### §4.2 — Key security

- [ ] Deployer key in a hardware wallet OR ephemeral environment (deploy → transfer ownership → discard).
- [ ] **Ownership transferred to multisig within the same session as deploy.** Do not leave EOA-owned overnight.
- [ ] Multisig signers verified on hardware devices.
- [ ] Multisig threshold ≥ 2-of-3 for sandbox, ≥ 3-of-5 for live funds.

```typescript
// Deploy → transfer → verify, all in one script
const contract = await Factory.deploy();
await contract.waitForDeployment();
const tx = await contract.transferOwnership(MULTISIG_ADDRESS);
await tx.wait();
const owner = await contract.owner();
if (owner.toLowerCase() !== MULTISIG_ADDRESS.toLowerCase()) {
  throw new Error("Ownership transfer failed — DO NOT PROCEED");
}
```

### §4.3 — Multisig pattern

- **MUST** transfer admin roles, not just `owner()`. If your contract has `setAdmin`, `pauseRole`, etc., transfer all of them.
- **MUST** test multisig signing flow on testnet first, with the same signer set.
- **SHOULD** prefer Safe (formerly Gnosis Safe) for EVM multisigs.

### §4.4 — Monitoring

Set up before announcing the deploy:

- **Block explorer alerts** on the contract address (Etherscan watchlist or Tenderly).
- **Tenderly Web3 Actions** or **OpenZeppelin Defender Sentinels** on critical events:
  - Owner change.
  - Pause toggle.
  - Large `setSalary` / `mint` calls (above an absolute threshold).
  - Failed `checkSignatures` calls (signal of attack or bug).
- **Relayer health check** — script that calls `publicDecrypt` on a known handle every 5 minutes. Page on failure.
- **Gas price alerts** — if a critical op (e.g., `finalize`) costs >X ETH at current gas, postpone non-urgent operations.

### §4.5 — Rollback / incident response

FHEVM contracts cannot be "rolled back" — onchain state is immutable. Strategy:

1. **Pause first.** Every contract should have a multisig-controlled pause that halts state-modifying functions. **MUST** include this from day one.
2. **Communicate.** Public post within 1 hour of confirmed incident.
3. **Migrate.** Deploy fixed contract. Build a one-shot migration that re-encrypts critical state. Users re-grant ACL.
4. **Document.** Post-mortem within 7 days.

```solidity
contract Pausable is ZamaEthereumConfig {
    bool public paused;
    address public guardian;
    modifier whenNotPaused() { require(!paused, "paused"); _; }
    function pause() external { require(msg.sender == guardian); paused = true; }
}
```

- **NEVER** use `selfdestruct` to "kill" a broken contract. ACL permissions become orphaned (see `CORE_RULES.md` §7).

---

## §5 — Upgradeability cautions

- **SHOULD** prefer immutable contracts. Most projects don't need upgradeability and adding it doubles the attack surface.
- If using UUPS/Transparent proxy:
  - **MUST** call `_disableInitializers()` in the implementation constructor (see `CORE_RULES.md` §7).
  - **MUST** test upgrade migrations on a fork of mainnet, not a fresh testnet.
  - **MUST** preserve ACL state across upgrades — the proxy address stays the same, so existing ACL permissions remain valid.
  - **SHOULD** add a 24–72h timelock on upgrade execution. Multisig with no timelock is not enough.

---

## §6 — Post-deploy verification

After every deploy (Sepolia or mainnet):

- [ ] Deployed address recorded in `deployments/<network>.json`.
- [ ] `standard-input.json` archived in case verification fails later.
- [ ] Contract verified on Etherscan (or marked as deferred with reason).
- [ ] `owner()` matches expected (multisig on mainnet, deployer or null on Sepolia).
- [ ] At least one of each public-facing function tested with a real wallet.
- [ ] Frontend `network.ts` updated with new address.
- [ ] Frontend tested against deployed contract (encrypt → submit → decrypt full loop).
- [ ] Deploy block number noted for indexer backfill.

---

## §7 — Toolchain-specific gotchas (deploy time)

These are deployment-time issues. For development-time issues see `CHANGELOG.md`.

### §7.1 — `npx hardhat verify` intercepted by npx

Running `npx hardhat verify` when Hardhat is local-only may prompt to install Hardhat globally. Answer **n**, then call the local binary:
```bash
./node_modules/.bin/hardhat verify --network sepolia <address>
```

### §7.2 — `solc-bin.ethereum.org` blocked

Verification plugins fetch compiler binaries from `solc-bin.ethereum.org`. In restricted networks (Codespaces, corporate proxies):
```
Error: getaddrinfo ENOTFOUND solc-bin.ethereum.org
```

Workaround: use Standard JSON Input upload via the Etherscan UI (see §3.2 option 2).

### §7.3 — Hardhat flatten

`npx hardhat flatten contracts/X.sol > flat.sol` — **MUST NOT** pipe through `grep`/`awk`; truncation is silent and breaks the parser. FHEVM contracts flatten to ~11k+ lines; if `wc -l` shows much less, it was truncated.

Strip duplicate SPDX lines before submitting:
```bash
grep -v "^// SPDX-License-Identifier" flat.sol | \
  awk 'NR==1{print "// SPDX-License-Identifier: BSD-3-Clause-Clear"} {print}' > flat_clean.sol
```

Even after this, **prefer Standard JSON Input over flattened source** — flattening can shift metadata hash and cause bytecode mismatch.

### §7.4 — Bytecode mismatch on verify

Cause: `--force` recompile after deploy changes the metadata hash. Prevention: generate `standard-input.json` immediately after the first successful compile, before any `--force`.

If already affected: contract is functional on-chain. Document the address; verify later from a clean compile.

---

## §8 — Static frontend hosting

### §8.1 — Vercel: WASM content-type header

Vercel does not serve `.wasm` files with `Content-Type: application/wasm` by default. The Zama SDK fails to initialize without the correct MIME type — Chrome throws `WebAssembly.instantiate(): incorrect response MIME type` and the instance is non-functional.

Fix with `vercel.json` committed alongside the frontend:

```json
{
  "headers": [
    {
      "source": "/(.*).wasm",
      "headers": [{ "key": "Content-Type", "value": "application/wasm" }]
    }
  ]
}
```

Set **Root Directory** to `frontend/` in the Vercel project settings when deploying a subdirectory.

### §8.2 — Cloudflare + Vercel: disable proxy on CNAME

When pointing a Cloudflare-managed domain to Vercel via CNAME, the Cloudflare proxy (orange cloud) causes SSL certificate conflicts. Vercel cannot provision its certificate while Cloudflare terminates TLS first.

Fix: set the CNAME record to **DNS-only** (grey cloud).

```
Type:   CNAME
Name:   your-subdomain
Target: cname.vercel-dns.com
Proxy:  OFF (DNS only)
```

Vercel handles SSL directly. The certificate generates within 2–5 minutes of DNS propagation. This same fix applies to any Vercel custom domain behind Cloudflare — including non-FHEVM projects.

---

## PRE-SHIP CHECKLIST (deploy)

Master list. Run before sending the first mainnet tx.

### Contract
- [ ] All items in `CORE_RULES.md` §9 invariants pass.
- [ ] External audit complete (mainnet only).
- [ ] Pause mechanism present and tested.

### Toolchain
- [ ] Hardhat 2.x pinned.
- [ ] All deps installed with `--legacy-peer-deps`.
- [ ] `tsconfig.json` has `"rootDir": "."`.
- [ ] `compile` clean.
- [ ] `test` all green.

### Environment
- [ ] Secrets in proper storage (not `export`, not committed).
- [ ] Mainnet uses a separate deployer key from Sepolia.
- [ ] `ZAMA_RELAYER_API_KEY` set (mainnet).
- [ ] RPC provider is paid-tier for mainnet.

### Deploy
- [ ] `standard-input.json` generated immediately after first compile.
- [ ] Deploy script transfers ownership to multisig in same session (mainnet).
- [ ] Owner verified post-deploy.
- [ ] Deployed address recorded.
- [ ] Verification successful (or deferred with reason).

### Operations
- [ ] Block explorer watchlist set.
- [ ] Monitoring alerts configured (Tenderly / Defender / equivalent).
- [ ] Relayer health check running.
- [ ] Pause runbook documented and tested by an off-call team member.
- [ ] Incident response template ready.

### Frontend
- [ ] Production build does not contain `ZAMA_RELAYER_API_KEY`.
- [ ] Network badge shows correct chain.
- [ ] Tested against the actual deployed contract on the target network.

If any item is unchecked, do not deploy.
