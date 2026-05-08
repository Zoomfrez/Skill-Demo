# CHANGELOG.md

Version assumptions, pinning, and known breaking changes. **Verify against current Zama docs before relying on specifics.**

Last updated: 2026-05-08
Source baseline: Hardhat 2.22 + Node.js v24 + GitHub Codespaces, FHEVM v0.9.

> ⚠ All version numbers below were correct at the source date. Newer SDK releases may have shifted compatibility. Confirm at https://docs.zama.ai before pinning a new project.

---

## QUICK REFERENCE — known-good install

Tested combination as of 2026-04-30. Use exactly these versions if you encounter peer-dep hell.

```bash
npm install --save-dev \
  hardhat@2.22.0 \
  @fhevm/hardhat-plugin \
  @nomicfoundation/hardhat-ethers@3.1.3 \
  @nomicfoundation/hardhat-toolbox@3.0.0 \
  ethers@6.13.0 \
  typescript ts-node @types/node \
  --legacy-peer-deps

npm install \
  @fhevm/solidity \
  @zama-fhe/relayer-sdk@0.4.1 \
  --legacy-peer-deps

npm install --save-dev \
  "@fhevm/mock-utils@0.4.2" \
  "@nomicfoundation/hardhat-chai-matchers@hh2" \
  chai @types/chai \
  --legacy-peer-deps
```

---

## §1 — Hardhat version

**Use Hardhat 2.x. Do not use Hardhat 3.**

As of `@fhevm/hardhat-plugin@0.4.x`, the plugin targets Hardhat 2. Hardhat 3 changed init flow, ESM requirements, and plugin registration.

Symptoms of accidental Hardhat 3:
- `HH303: Unrecognized task` on every `npx hardhat` command.
- `Hardhat only supports ESM projects. Please make sure you have "type": "module" in your package.json`.

**Do not** "fix" by adding `"type": "module"` — that compounds the breakage. Downgrade:
```bash
npm install --save-dev hardhat@2.22.0 --legacy-peer-deps
```

If `npx hardhat` prompts "Need to install hardhat@3.x — Ok to proceed?", answer **n** and use the local binary:
```bash
./node_modules/.bin/hardhat <command>
```

---

## §2 — Peer-dep conflicts: `--legacy-peer-deps` is mandatory

FHEVM packages have peer-dep version mismatches between each other (`@fhevm/mock-utils`, `@fhevm/hardhat-plugin`, `@zama-fhe/relayer-sdk`). Without `--legacy-peer-deps`, npm refuses to install.

**Always install in one shot.** Incremental installs accumulate `ERESOLVE unable to resolve dependency tree` errors that require manual unwinding.

Failure mode: forgetting `--legacy-peer-deps` on a follow-up install (e.g., adding chai) breaks the previously-working tree.

---

## §3 — SDK version pinning

`@fhevm/hardhat-plugin@0.4.2` requires **exactly** `@zama-fhe/relayer-sdk@0.4.1`. Newer relayer SDK versions trigger:

```
Error in plugin @fhevm/hardhat-plugin: Invalid @zama-fhe/relayer-sdk version.
Expecting 0.4.1. Got 0.4.2
```

Pin explicitly:
```bash
npm install @zama-fhe/relayer-sdk@0.4.1 --legacy-peer-deps
```

When upgrading the Hardhat plugin in the future, check the new plugin's required SDK version before bumping the SDK.

---

## §4 — `tsconfig.json` requirements

Tests fail with:
```
error TS5011: The common source directory of 'tsconfig.json' is './test'.
The 'rootDir' setting must be explicitly set
```

Required `tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "esModuleInterop": true,
    "strict": true,
    "outDir": "dist",
    "rootDir": "."
  },
  "include": ["hardhat.config.ts", "contracts", "test", "scripts"]
}
```

---

## §5 — Chai matchers — pin `@hh2`

`expect(...).to.be.revertedWith(...)` requires `@nomicfoundation/hardhat-chai-matchers`. **Install the Hardhat-2-compatible version**, not the latest:

```bash
npm install --save-dev "@nomicfoundation/hardhat-chai-matchers@hh2" --legacy-peer-deps
```

Then in `hardhat.config.ts`:
```typescript
import "@nomicfoundation/hardhat-chai-matchers";
```

Installing the latest (without `@hh2`) prints:
```
Warning: You installed the `latest` version which does not work with Hardhat 2 or 3.
```

---

## §6 — Missing peer deps

Even after a clean install, `npx hardhat compile` may fail with `Cannot find module` for these unlisted peers:

| Missing module | Install |
|---|---|
| `@nomicfoundation/hardhat-ethers` | `npm install --save-dev @nomicfoundation/hardhat-ethers --legacy-peer-deps` |
| `@fhevm/mock-utils` | `npm install --save-dev "@fhevm/mock-utils@0.4.2" --legacy-peer-deps` |
| `chai` | `npm install --save-dev chai @types/chai --legacy-peer-deps` |

Avoid by using the one-shot install in the Quick Reference.

---

## §7 — Known SDK API differences (mock vs real)

### `fhevm.createEIP712` signature

In `@fhevm/hardhat-plugin@0.4.2` mock environment, `createEIP712` takes a single contract address, not an array:

```typescript
// WRONG (older docs / real SDK may use array form)
fhevm.createEIP712(publicKey, [contractAddress])

// CORRECT in the mock
fhevm.createEIP712(publicKey, contractAddress)
```

Wrong form raises: `Error: Fhevm assertion failed: contractAddresses is not an array`.

Real relayer SDK on Sepolia may differ. **MUST** check the SDK version's TypeScript definitions before calling.

### `fhevm.debugDecrypt64` does not exist in 0.4.2

Earlier docs reference `fhevm.debugDecrypt64`. It is not exported by `@fhevm/mock-utils@0.4.2`.

What `@fhevm/mock-utils@0.4.2` actually exports: `relayer`, `utils`, `contracts`, `MockCoprocessor`, `MockFhevmInstance`, `userDecryptHandleBytes32`.

**Workaround for mock tests:** assert the handle is non-zero, not its decrypted value. Cryptographic correctness is verified on Sepolia, not in mock.
```typescript
const handle = await contract.getEncryptedBalance(user);
expect(handle).to.not.equal(ethers.ZeroHash);
```

### Solidity enums return BigInt in ethers v6

```typescript
// WRONG
expect(await contract.roles(addr)).to.equal(3);

// CORRECT
expect(await contract.roles(addr)).to.equal(3n);
```

Same applies to any value passed to a function that accepts an enum parameter.

---

## §8 — Verification toolchain

### `solc-bin.ethereum.org` blocked

Verification plugins (`@nomicfoundation/hardhat-verify`, `@nomiclabs/hardhat-etherscan`) fetch compiler binaries from `solc-bin.ethereum.org`. In restricted networks (Codespaces, corporate proxies):
```
Error: getaddrinfo ENOTFOUND solc-bin.ethereum.org
```

Workarounds in order of preference:
1. **Standard JSON Input via Etherscan UI** — see `DEPLOYMENT.md` §3.2.
2. **Sourcify** — upload at `verify.sourcify.dev`. Set contract identifier as `contracts/File.sol:Contract`.
3. Skip verification, document the deployed address; verify later from an unrestricted machine.

### `npx hardhat verify` intercepted by npx

When Hardhat is local-only, `npx hardhat verify` may prompt to install Hardhat globally. Answer **n**, then use the local binary:
```bash
./node_modules/.bin/hardhat verify --network sepolia <address>
```

### Hardhat flatten produces broken output

`npx hardhat flatten` with pipes silently truncates. FHEVM contracts flatten to ~11k+ lines.

```bash
# WRONG — pipes truncate
npx hardhat flatten contracts/X.sol | grep ... > flat.sol

# CORRECT
npx hardhat flatten contracts/X.sol > /tmp/flat.sol
wc -l /tmp/flat.sol   # expect 11k+ for FHEVM
```

Strip duplicate SPDX lines before submitting:
```bash
grep -v "^// SPDX-License-Identifier" /tmp/flat.sol | \
  awk 'NR==1{print "// SPDX-License-Identifier: BSD-3-Clause-Clear"} {print}' \
  > /tmp/flat_clean.sol
```

Even after this, prefer Standard JSON Input — flattening can shift metadata hash and produce bytecode mismatch.

### Bytecode mismatch on verify

Cause: `--force` recompile after deploy changes the metadata hash appended to bytecode.

**Prevention:** Generate `standard-input.json` immediately after the first successful compile, before any `--force` recompile.
```bash
cat artifacts/build-info/*.json | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d['input'], indent=2))" > standard-input.json
```

If already affected: contract is functional on-chain; verification can wait. Re-deploy from a clean compile and verify with the standard input from that compile run.

---

## §9 — Codespaces-specific

### Environment variables don't persist

`export VAR=...` in the terminal is lost on session end or Codespace restart.

**Fix:** GitHub → Settings → Codespaces → Secrets. Variables saved here inject automatically on Codespace start.

Required as Codespaces Secrets:
- `SEPOLIA_RPC_URL`
- `PRIVATE_KEY`
- `ETHERSCAN_API_KEY`
- `ZAMA_RELAYER_API_KEY` (if working with mainnet)

---

## §10 — Scaffold-ETH / Next.js specific issues

These were encountered building and deploying a confidential salary registry on the Scaffold-ETH + Next.js stack. All three hit during CI/GitHub Pages deployment and pass silently in local dev.

### MetaMask SDK → `@react-native-async-storage` webpack crash

`@metamask/sdk` transitively requires `@react-native-async-storage/async-storage`. In a Next.js browser build, webpack tries to resolve this package, fails, and crashes with `Module not found`. Fix by aliasing to `false` in `next.config.ts`:

```typescript
config.resolve.alias["@react-native-async-storage/async-storage"] = false;
```

### Gitignored `.local.ts` contract stubs break CI builds

Scaffold-ETH generates `deployedContracts.local.ts` (and similar `*.local.ts` files) for the local chain. These are gitignored. A sibling file imports them statically. In CI (GitHub Actions), the repo is cloned without these files and `next build` fails.

**Fix:** Generate empty stubs as a CI step before the build (see `DEPLOYMENT.md` §8.2). Alternatively, add a `postinstall` script in `package.json` that creates them.

### `scaffold.config.ts` hard-throw on optional API key

The Scaffold-ETH template `scaffold.config.ts` may throw if `NEXT_PUBLIC_ALCHEMY_API_KEY` is not set. This crashes CI builds that don't have the secret. Replace with a public-RPC fallback (see `ANTI_PATTERNS.md` §25 and `DEPLOYMENT.md` §8.2).

---

## §11 — Foundry support

Foundry support is partial as of FHEVM v0.9. The `@fhevm/hardhat-plugin` mock environment is not available — you must deploy mock FHE contracts manually via `vm.etch` or `foundry.toml` preloads, and inherit `ZamaFoundryConfig` instead of `ZamaEthereumConfig` in tests.

```solidity
import { ZamaFoundryConfig } from "@fhevm/solidity/config/ZamaConfig.sol";
import "forge-std/Test.sol";

contract PayrollTest is Test, ZamaFoundryConfig {
    function setUp() public {
        _deployFHEContracts();   // provided by ZamaFoundryConfig
    }
}
```

**Caveats:**
- The Foundry mock stores values in plaintext internally — tests verify logic but not cryptographic correctness.
- Mock API has changed across FHEVM minor versions. Check `@fhevm/solidity/config/ZamaConfig.sol` in your installed version for the exact config contract name before writing tests.

---

## §12 — Mainnet vs Sepolia config differences

Tracked here because addresses change across SDK releases. **MUST** pull from the SDK's `SepoliaConfig` / `MainnetConfig` exports — never hardcode.

Sepolia (as of FHEVM v0.9, observed values — verify before pinning):
- `aclContractAddress`: `0x687820221192C5B662b25367F70076A37bc79b6c`
- `kmsContractAddress`: `0x1364cBBf2cDF5032C47d8226a6f6FBD2AFCDacAC`
- `inputVerifierContractAddress`: `0xbc91f3daD1A5F19F8390c400196e58073B6a0BC4`
- `verifyingContractAddressDecryption`: `0xb6E160B1ff80D67Bfe90A85eE06Ce0A2613607D1`
- `verifyingContractAddressInputVerification`: `0x7048C39f048125eDa9d678AEbaDfB22F7900a29F`

Behavior differences:
- Sepolia relayer is open (no API key); mainnet requires `relayerApiKey`.
- Public-decryption latency: ~5–15s (Sepolia) vs 30–120s (mainnet).
- Gas: mainnet is 5–10× Sepolia at moderate gas prices.
- The gas-cost table in `CORE_RULES.md` §3.1 is Sepolia-derived — multiply for mainnet.

---

## §13 — Stale / needs-verification list

Items below are likely correct but should be re-checked before any mainnet work:

- Exact gas costs in `CORE_RULES.md` §3.1 — derived from FHEVM v0.9 Sepolia, may have shifted.
- Sepolia contract addresses in §11 — verify against the SDK config object at install time.
- `@fhevm/hardhat-plugin@0.4.2` ↔ `@zama-fhe/relayer-sdk@0.4.1` pinning — check current plugin's required SDK version when upgrading.
- `@nomicfoundation/hardhat-chai-matchers@hh2` — the `@hh2` tag may be deprecated once Hardhat 3 support is mainstream.
- Foundry mock API in `ZamaFoundryConfig` — known to change between FHEVM minor versions.
- The `createEIP712(publicKey, contractAddress)` signature in mock vs real SDK — recheck per SDK release.

---

## §14 — Deprecated patterns

| Pattern | Status | Replacement |
|---|---|---|
| `FHE.decrypt(handle)` synchronous call | never existed; some early docs implied it | 3-step async flow |
| `fhevm.debugDecrypt64` in tests | not exported in `@fhevm/mock-utils@0.4.2` | assert handle is non-zero |
| Hardcoded `aclContractAddress` etc. | breaks on network switch and SDK upgrade | use `SepoliaConfig` / `MainnetConfig` |
| `selfdestruct` for contract retirement | orphans ACL permissions | deploy new contract + migrate |
| `if (encryptedBool)` | always took true branch silently | `FHE.select` |
| `euint256 counter` for math | no arithmetic on `euint256` | `euint64` or `euint128` |

---

## §15 — Update protocol

When you pull a newer SDK or plugin:

1. Read this file's `§7 — Known SDK API differences`. Items there are most likely to break.
2. Re-run the install in `Quick Reference`. If peer-deps complain, regenerate the lock file from scratch.
3. Re-run the full test suite against the mock environment.
4. Deploy to Sepolia; run smoke tests.
5. Update this file's "Last updated" date and any version pins that changed.
