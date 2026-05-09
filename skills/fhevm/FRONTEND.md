# FRONTEND.md

Building UIs that encrypt inputs and decrypt outputs against FHEVM contracts.

> Most of this file is FHEVM-specific. The "UX/Product" and "UI patterns" sections include general web3 frontend best practices applied to encrypted state — flagged where relevant. Test on mobile early; do not assume desktop-only users.

---

## QUICK START

```bash
npm create vite@latest my-fhe-app -- --template react-ts
cd my-fhe-app
npm install @zama-fhe/relayer-sdk ethers
```

```typescript
import { createInstance, SepoliaConfig } from "@zama-fhe/relayer-sdk";
const instance = await createInstance(SepoliaConfig);
```

That is the full happy path on Sepolia. Mainnet adds an API key. Read on for what breaks.

---

## §1 — Bundler & WASM

### §1.1 — Use Vite

The relayer SDK ships a WASM module. Vite handles WASM out of the box. Webpack and Next.js do not, and produce confusing errors.

- **MUST** use Vite for new projects unless you have a specific reason not to.
- **SHOULD** use the SDK's `/node` entry point for server-side rendering or Node.js scripts:
  ```typescript
  import { createInstance, SepoliaConfig } from "@zama-fhe/relayer-sdk/node";
  ```

### §1.2 — Webpack / Next.js (if you must)

Required `next.config.js` additions:
```javascript
module.exports = {
  webpack: (config) => {
    config.experiments = { ...config.experiments, asyncWebAssembly: true, layers: true };
    config.module.rules.push({ test: /\.wasm$/, type: "asset/resource" });
    return config;
  },
  // SDK initializes only on the client
  experimental: { esmExternals: "loose" },
};
```

Wrap SDK init in a `useEffect` and a `typeof window !== "undefined"` guard. Server-rendering `createInstance(SepoliaConfig)` will throw.

### §1.3 — esbuild (no-framework static HTML)

When Vite is unavailable — single-file static deployment, no build framework — esbuild works. Critical flag:

```bash
npx esbuild node_modules/@zama-fhe/relayer-sdk/lib/web.js \
  --bundle --format=esm --platform=browser \
  --outfile=frontend/sdk-bundle.js \
  --external:*.wasm   # MUST — do not inline WASM

npx esbuild node_modules/ethers/lib.esm/ethers.js \
  --bundle --format=esm --platform=browser \
  --outfile=frontend/ethers-bundle.js
```

`--external:*.wasm` keeps the WASM files as separate static assets. Without it, esbuild tries to inline them and the bundle breaks at runtime. The `.wasm` files (`kms_lib_bg.wasm`, `tfhe_bg.wasm`, `workerHelpers.js`) must be served in the same directory as the bundle.

In the HTML file, load bundles as ESM:
```html
<script type="module">
  const { createInstance, SepoliaConfig, initSDK } = await import('./sdk-bundle.js');
  await initSDK(); // required before createInstance in this context
  const instance = await createInstance({ ...SepoliaConfig, network: RPC_URL });
</script>
```

### §1.4 — Common WASM failures

| Symptom | Likely cause |
|---|---|
| `instance.createEncryptedInput is undefined` | WASM didn't load. Check Network tab for the `.wasm` request. |
| `__wbindgen_malloc` errors | WASM partially loaded, version mismatch, or CSP blocking `wasm-unsafe-eval`. |
| Hangs on `createInstance` | `relayerUrl`/`gatewayUrl` unreachable. Check from a fresh tab. |
| Works in dev, fails in prod | Build pipeline strips WASM. Check `dist/` for the `.wasm` file. |

If you see CSP errors, add `'wasm-unsafe-eval'` to `script-src`.

---

## §2 — Instance configuration

### §2.1 — Sepolia (testnet)

```typescript
import { createInstance, SepoliaConfig } from "@zama-fhe/relayer-sdk";
const instance = await createInstance(SepoliaConfig);
```

No API key. Open relayer.

### §2.2 — Mainnet

```typescript
import { createInstance, MainnetConfig } from "@zama-fhe/relayer-sdk";

const instance = await createInstance({
  ...MainnetConfig,
  relayerApiKey: process.env.ZAMA_RELAYER_API_KEY,
});
```

- **MUST** keep the API key out of client-side bundles. Proxy through your backend, or use a build-time injection scheme that is rotation-friendly.
- **NEVER** ship the mainnet API key in a Vite `import.meta.env.VITE_*` variable. Anything `VITE_*` ends up in the public bundle.

### §2.3 — Network separation

Keep configs in distinct files keyed by `chainId`:

```typescript
// config/network.ts
export const NETWORKS = {
  11155111: { // Sepolia
    name: "Sepolia",
    rpc: import.meta.env.VITE_SEPOLIA_RPC,
    contractAddress: "0x...",
    sdkConfig: SepoliaConfig,
  },
  1: { // Mainnet
    name: "Mainnet",
    rpc: import.meta.env.VITE_MAINNET_RPC,
    contractAddress: "0x...",
    // sdkConfig built at runtime with API key from server
  },
} as const;
```

- **MUST** never hardcode `aclContractAddress`, `kmsContractAddress`, etc. They differ between networks and may change between SDK versions. Pull from `SepoliaConfig` / `MainnetConfig`.
- **MUST** show the active network in the header. Confused users sign mainnet txs thinking they're on testnet.

### §2.4 — Mainnet differences worth surfacing in UI

- Public decryption latency: **30–120s** on mainnet vs ~5–15s on Sepolia. Show explicit progress, never just a spinner.
- Gas: 5–10× Sepolia estimates. The §3.1 table in `CORE_RULES.md` is from Sepolia.
- Contract addresses for ACL/KMS/InputVerifier are different. SDK config handles this; do not paper over with manual addresses.

### §2.5 — No-framework browser: `initSDK()` and `network` string

In non-Vite contexts (esbuild bundles, plain `<script type="module">`), the SDK does not self-initialize. Two extra requirements:

**1. Call `initSDK()` before `createInstance`.**

```javascript
import { createInstance, SepoliaConfig, initSDK } from './sdk-bundle.js';
await initSDK(); // MUST — skipping this causes silent failure
const instance = await createInstance({ ...SepoliaConfig, network: RPC_URL });
```

Skipping `initSDK()` returns a non-functional instance with no error. `createEncryptedInput` will be undefined or fail silently.

**2. Pass `network` as a plain RPC URL string, not a provider object.**

```javascript
// WRONG — provider object silently fails
const instance = await createInstance({ ...SepoliaConfig, network: provider });

// CORRECT
const RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const instance = await createInstance({ ...SepoliaConfig, network: RPC });
```

This only applies to the esbuild/vanilla JS path. Vite + React handles initialization automatically.

---

## §3 — Wallet integration

### §3.1 — Connection (ethers v6)

```typescript
import { BrowserProvider } from "ethers";

async function connect() {
  if (!window.ethereum) throw new Error("No wallet detected");
  const provider = new BrowserProvider(window.ethereum);
  const signer = await provider.getSigner();
  const network = await provider.getNetwork();
  return { provider, signer, chainId: Number(network.chainId) };
}
```

### §3.2 — Chain switching

If user is on the wrong chain, request a switch. Adding the chain (if missing) requires a separate call.

```typescript
async function ensureChain(targetChainId: number, chainParams: any) {
  const current = await window.ethereum.request({ method: "eth_chainId" });
  if (parseInt(current, 16) === targetChainId) return;

  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: `0x${targetChainId.toString(16)}` }],
    });
  } catch (err: any) {
    if (err.code === 4902) {
      // Chain not added — add it
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [chainParams],
      });
    } else {
      throw err;
    }
  }
}
```

- **MUST** listen for `chainChanged` and `accountsChanged` events and re-initialize the SDK instance. The instance is bound to a chain.
- **MUST** invalidate cached encrypted handles on `accountsChanged` — they belonged to the previous user.
- **COMMON FAILURE MODE:** user switches wallets mid-session, frontend keeps old `instance`, encryption proofs fail with "invalid proof" because the proof was bound to the old signer.

### §3.3 — Wallet rejection

Distinguish three cases. Show different copy for each.

```typescript
try {
  await tx;
} catch (err: any) {
  if (err.code === 4001 || err.code === "ACTION_REJECTED") {
    // User rejected — soft state, no error toast
    setStatus("idle");
  } else if (err.code === -32603 || err.message?.includes("insufficient funds")) {
    setError("Not enough ETH to cover gas. Add funds and retry.");
  } else if (err.message?.includes("user denied")) {
    setStatus("idle");
  } else {
    setError(`Transaction failed: ${err.shortMessage ?? err.message}`);
  }
}
```

- **MUST NOT** show an error toast for user rejection. It's a deliberate action, not a failure.
- **SHOULD** show the human-readable error from `err.shortMessage` (ethers v6) before falling back to `err.message`.

---

## §4 — Encrypting inputs

### §4.1 — Basic flow

```typescript
const input = instance.createEncryptedInput(contractAddress, userAddress);
input.add64(BigInt(amount));
const enc = await input.encrypt(); // → { handles: bytes32[], inputProof: bytes }

const tx = await contract.deposit(enc.handles[0], enc.inputProof);
await tx.wait();
```

### §4.2 — Multiple inputs in one call

```typescript
const input = instance.createEncryptedInput(contractAddress, userAddress);
input.add64(amount);   // index 0
input.addBool(flag);   // index 1
input.add8(kind);      // index 2
const enc = await input.encrypt();

await contract.complexOp(enc.handles[0], enc.handles[1], enc.handles[2], enc.inputProof);
```

- **MUST** match handle index to the order in your Solidity function signature, not the order they're declared in the input builder.
- **SHOULD** pre-validate amounts client-side (positive, within bounds) before encrypting. Encryption is wasteful on bad inputs.

### §4.3 — Form validation

Encrypt only after client-side validation passes. The user sees instant feedback for bad inputs; only valid inputs hit the relayer.

```typescript
function validateAmount(raw: string): { valid: true; value: bigint } | { valid: false; error: string } {
  if (!raw) return { valid: false, error: "Required" };
  if (!/^\d+(\.\d+)?$/.test(raw)) return { valid: false, error: "Numbers only" };
  const value = parseUnits(raw, decimals);
  if (value <= 0n) return { valid: false, error: "Must be positive" };
  if (value > MAX_UINT64) return { valid: false, error: "Exceeds maximum" };
  return { valid: true, value };
}
```

### §4.4 — Encryption is slow — show progress

`input.encrypt()` takes 1–5s on desktop, longer on mobile. Block the submit button and show what's happening:

```tsx
{status === "encrypting" && <span>Encrypting your amount locally…</span>}
{status === "submitting" && <span>Awaiting wallet confirmation…</span>}
{status === "mining" && <span>Confirming on-chain…</span>}
```

---

## §5 — Decrypting outputs

### §5.1 — User decryption flow

```typescript
async function decryptMyBalance() {
  const rawHandle = await contract.getEncryptedBalance(); // returns BigInt in ethers v6
  if (BigInt(rawHandle) === 0n) return null; // not initialized

  // Convert BigInt handle to 0x-prefixed hex string the SDK expects
  const handle = '0x' + BigInt(rawHandle).toString(16).padStart(64, '0');

  const { publicKey, privateKey } = instance.generateKeypair();
  const startTimestamp = Math.floor(Date.now() / 1000);
  const durationDays = 1;

  // createEIP712 takes: publicKey, contractAddresses[], startTimestamp, durationDays
  const eip712 = instance.createEIP712(publicKey, [contractAddress], startTimestamp, durationDays);

  // ethers v6: strip EIP712Domain from types before signTypedData — it rejects if present
  const { EIP712Domain: _, ...types } = eip712.types;
  const signature = await signer.signTypedData(eip712.domain, types, eip712.message);

  // userDecrypt full signature:
  // (HandleContractPair[], privateKey, publicKey, sig, contractAddresses[], userAddress, startTimestamp, durationDays)
  const result = await instance.userDecrypt(
    [{ handle, contractAddress }],
    privateKey,
    publicKey,
    signature.replace('0x', ''), // SDK expects raw hex — strip 0x prefix
    [contractAddress],
    await signer.getAddress(),
    startTimestamp,
    durationDays
  );

  return result[handle]; // plaintext BigInt, keyed by handle string
}
```

- **MUST** check for zero handle (uninitialized) before attempting decryption. Decrypting zero-handle reverts.
- **MUST** convert the contract's `uint256` return to a `0x`-prefixed 64-char hex string. ethers v6 returns `BigInt`; the SDK expects hex.
- **MUST** strip `EIP712Domain` from `eip712.types` when using ethers v6 `signTypedData`. It rejects with a type error if `EIP712Domain` is present.
- **MUST** treat the EIP-712 signature as a session credential — cache it for the duration of the user's session, do not re-prompt for every read.
- **NEVER** persist `privateKey` to localStorage. It's a one-shot keypair; regenerate per session.

### §5.2 — Caching strategy

Decryption is expensive (signature + relayer round-trip). Cache aggressively, invalidate on relevant events:

```typescript
// Pseudocode
const cache = new Map<string, { value: bigint; handleAtFetch: string }>();

async function getBalance(user: string) {
  const handle = await contract.getEncryptedBalance(user);
  const cached = cache.get(user);
  if (cached && cached.handleAtFetch === handle) return cached.value;

  const value = await decryptViaRelayer(handle);
  cache.set(user, { value, handleAtFetch: handle });
  return value;
}
```

Use the **handle itself** as the cache key — when state changes on-chain, the handle changes, and cache misses naturally.

### §5.3 — Public decryption + finalization

```typescript
async function reveal() {
  // Step 1: trigger on-chain marking
  let tx = await contract.markRevealable();
  await tx.wait();

  // Step 2: decrypt via relayer (this is the slow part — 30–120s on mainnet)
  setStatus("waiting-on-relayer");
  const handles = [resultHandle1, resultHandle2];
  const r = await instance.publicDecrypt(handles);

  // Step 3: submit proof for finalization
  setStatus("finalizing");
  tx = await contract.finalize(
    r.clearValues[handles[0]],
    r.clearValues[handles[1]],
    r.decryptionProof
  );
  await tx.wait();

  setStatus("done");
}
```

### §5.4 — Retry logic

The relayer can be slow or transiently fail. Retry with exponential backoff, capped:

```typescript
async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fn();
    } catch (err: any) {
      const isTransient =
        err.message?.includes("timeout") ||
        err.message?.includes("network") ||
        err.code === "NETWORK_ERROR" ||
        (err.status >= 500 && err.status < 600);
      if (!isTransient || i === maxAttempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i)); // 1s, 2s, 4s
    }
  }
  throw new Error("unreachable");
}
```

- **MUST NOT** retry on 4xx responses or "invalid proof" errors. Those are deterministic — retrying wastes the user's time.
- **SHOULD** distinguish "relayer is slow" from "relayer is broken" in the UI. After 60s, show a "this is taking longer than expected" message with a refresh option.

---

## §6 — UX patterns

### §6.1 — State model

Track at least these states for any encrypted operation:

```typescript
type OpState =
  | { kind: "idle" }
  | { kind: "encrypting" }      // local WASM work
  | { kind: "awaiting-wallet" } // sig prompt visible
  | { kind: "submitting" }      // tx sent, mempool
  | { kind: "mining" }          // tx mined, waiting for confirms
  | { kind: "decrypting" }      // relayer round-trip
  | { kind: "done" }
  | { kind: "error"; message: string }
  | { kind: "rejected" };       // user said no
```

Conflating "submitting" and "mining" is the most common UX failure. Users panic when a tx sits in mempool for 30s without explanation.

### §6.2 — Optimistic vs confirmed state

Encrypted state cannot be optimistically computed by the frontend (the frontend cannot decrypt before the contract grants permission). Two patterns:

**Pattern A — pessimistic display.** Show a placeholder during pending tx, real value after confirm + decrypt. Safe but slow-feeling.

**Pattern B — local shadow ledger.** Maintain a plaintext shadow on the client of operations the user just submitted. Show "your balance after this transfer should be X" as a secondary line below the confirmed balance. Reconcile when the new handle arrives.

```tsx
<div>
  <div className="text-2xl">{confirmedBalance ?? "•••••"}</div>
  {pendingDelta !== 0n && (
    <div className="text-sm text-muted">
      After pending tx: ~{formatUnits(confirmedBalance + pendingDelta, decimals)}
    </div>
  )}
</div>
```

- **NEVER** show a fake "success" state before the tx is mined. The user will close the tab and the tx will revert in the mempool.

### §6.3 — Loading states for decryption

Decryption has three distinct phases. Don't collapse them into one spinner.

| Phase | Duration | UI |
|---|---|---|
| Sign EIP-712 | <1s | "Sign in your wallet to read your balance" |
| Relayer call | 5–120s | Progress bar with elapsed timer, optional cancel |
| Render | instant | The decrypted value with a small "decrypted" badge |

### §6.4 — Empty / uninitialized states

When a mapping slot has never been written, the handle is zero. Frontend distinguishes:

| Handle state | Display |
|---|---|
| Zero (`0x000…000`) | "Not set yet" — show CTA to initialize |
| Non-zero, decryption pending | Skeleton loader with "Decrypting…" |
| Non-zero, decryption failed | "Could not load — retry" with retry button |
| Non-zero, decrypted | Plaintext value |

```tsx
{handle === ZeroHash ? (
  <EmptyState action="Set initial balance" onAction={openInitDialog} />
) : status === "decrypting" ? (
  <Skeleton width={120} />
) : status === "error" ? (
  <ErrorBlock onRetry={retry}>Couldn't load your balance.</ErrorBlock>
) : (
  <Balance value={value} />
)}
```

### §6.5 — Encrypted balance display

Conventional patterns:

- Show the plaintext value in a privileged user's view (their own balance).
- Show `•••••` or "Encrypted" for values the viewer doesn't have permission to decrypt.
- Add a small lock icon to signal "this value is encrypted on-chain."

```tsx
<div className="flex items-center gap-2">
  <Lock className="h-3 w-3 text-muted" aria-label="Encrypted on-chain" />
  <span>{viewerCanDecrypt ? formatBalance(value) : "•••••"}</span>
</div>
```

### §6.6 — Transaction history

For confidential apps, transaction history is harder. The handle-as-event pattern (see `CORE_RULES.md` §4.5) lets you:

1. Index events emitting the handle.
2. For each event, attempt user-decryption to show the amount.
3. Show timestamp + counterparty + decrypted amount per row.

```tsx
<TxRow>
  <Time>{formatTime(tx.timestamp)}</Time>
  <Counterparty>{tx.from === self ? `→ ${tx.to}` : `← ${tx.from}`}</Counterparty>
  <Amount>{tx.amount ?? <Skeleton />}</Amount>
</TxRow>
```

For amounts the user is not allowed to decrypt, show "Hidden" — never "Failed".

### §6.7 — Mobile

Mobile wallet UX is the dominant failure mode for crypto apps. Specific to FHEVM:

- **MUST** test EIP-712 signature flow on a real mobile wallet (MetaMask Mobile, Rainbow, Coinbase). The deep-link round-trip can take 10–30s and the user may bounce away.
- **MUST** persist in-progress operation state across app backgrounds. Use `sessionStorage` for the operation's logical state (not for keys).
- **SHOULD** prefer WalletConnect over injected providers on mobile. Most users browse FHEVM dApps in their wallet's in-app browser.
- **SHOULD** size touch targets at ≥44×44 px (iOS HIG / WCAG 2.5.5).

### §6.8 — Accessibility

General web3, applied here:

- **MUST** provide text alternatives for the lock icon: `aria-label="Encrypted on-chain"`.
- **MUST** announce status changes via a live region (`aria-live="polite"`). Spinners alone are invisible to screen readers.
- **MUST** maintain visible focus on the active step in multi-step flows.
- **SHOULD** offer reduced-motion fallbacks for skeleton loaders and progress animations.

```tsx
<div role="status" aria-live="polite" aria-atomic="true">
  {status === "decrypting" && "Decrypting your balance"}
  {status === "done" && "Balance updated"}
</div>
```

---

## §7 — UI patterns by app shape

### §7.1 — Confidential payroll dashboard

Layout: three vertical sections.

1. **Header** — connected wallet, network badge, role indicator (Admin / Manager / Employee).
2. **Main content** — role-conditional:
   - **Employee:** their decrypted salary, decrypt button (if signature not yet given), payment history.
   - **Manager:** team table with names + decrypted salaries (where allowed) + edit buttons.
   - **Admin:** aggregate metrics via public-decryption flow + role management.
3. **Action panel** — sticky bottom on mobile, sidebar on desktop.

Table pattern for the manager view:
```tsx
<Table>
  <Row><Cell>Name</Cell><Cell>Salary</Cell><Cell>Action</Cell></Row>
  {employees.map(e => (
    <Row key={e.address}>
      <Cell>{e.name}</Cell>
      <Cell>
        <EncryptedAmount handle={e.salaryHandle} viewerCanDecrypt={e.allowedToView}/>
      </Cell>
      <Cell><Button onClick={() => editSalary(e)}>Edit</Button></Cell>
    </Row>
  ))}
</Table>
```

### §7.2 — Private voting

- **Phase indicator at top** — "Voting open" / "Tallying" / "Revealed" — drives which UI is shown.
- **Voting phase:** binary or N-choice selector, encrypts on submit, shows "Vote sealed" confirmation. **NEVER** echo the user's choice back after submit — it defeats the privacy guarantee at the UX layer.
- **Tallying phase:** countdown to reveal. Disable voting controls.
- **Revealed phase:** result + decryption proof verification status.

```tsx
<VoteCard>
  <PhaseHeader phase={phase} deadline={deadline} />
  {phase === "open" && <BallotForm onSubmit={encryptAndCast} />}
  {phase === "tallying" && <TallyingState />}
  {phase === "revealed" && <Results yes={yes} no={no} />}
</VoteCard>
```

### §7.3 — Sealed auction

- **Bidder view:** current state (open/closed), your bid (encrypted), bid input (encrypted on submit). After close, "winner is X" if revealed, else "awaiting reveal".
- **Auctioneer view:** countdown to close, list of bidders (count only), trigger-reveal button after close.
- **MUST NOT** show your own bid amount during the auction window in a way that competitors can shoulder-surf — store decrypted bids only in memory, never persist or broadcast.

### §7.4 — Confidential vault

Standard vault layout:
- **Top:** total deposited (your share, decrypted) + total vault TVL (public).
- **Middle:** deposit / withdraw forms with encrypted amount inputs.
- **Bottom:** transaction history with decrypted amounts.

### §7.5 — Admin panel patterns

- **MUST** confirm destructive actions with a typed confirmation ("type DELETE to confirm").
- **SHOULD** group operations by frequency: high-frequency (set salary, cast vote) on the main panel; low-frequency (rotate key, change role) behind a "Settings" tab.
- **SHOULD** show an audit log derived from on-chain events with handles. Even when amounts are hidden, the *fact* that an action occurred is auditable.

---

## §8 — Responsive components

### §8.1 — Cards

Cards reflow stack on mobile, grid on desktop:
```tsx
<div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
  {items.map(i => <Card key={i.id} {...i} />)}
</div>
```

### §8.2 — Tables

Tables become stacked cards on mobile (<640px). Don't shrink — readability collapses.

```tsx
<table className="hidden md:table">{/* full table */}</table>
<div className="md:hidden">{/* stacked card list */}</div>
```

### §8.3 — Forms

- Single column always, even on desktop. Multi-column forms are misread.
- Action button width matches input width on mobile, fixed on desktop.
- Encryption status appears between input and button, not as a toast.

### §8.4 — Skeleton loaders

Shape-matched skeletons reduce layout shift. Use these dimensions:

```tsx
<Skeleton className="h-8 w-32" />          {/* a number */}
<Skeleton className="h-4 w-48" />          {/* a label */}
<Skeleton className="h-12 w-full" />       {/* an input */}
<Skeleton className="h-24 w-full" />       {/* a card body */}
```

For decryption specifically, prefer "Decrypting…" text with a small spinner over a generic skeleton — it gives the user a model of what's happening.

---

## §9 — IF YOU SEE THIS ERROR

| Error / symptom | Go to |
|---|---|
| `__wbindgen_malloc` / `instance.createEncryptedInput is undefined` | §1.3 |
| `HTTP 401` on relayer | Mainnet API key missing — §2.2 |
| `"FHE: invalid proof"` | Frontend encrypted with wrong contract or user address — `CORE_RULES.md` §2 |
| `userDecrypt` throws "not allowed" | Contract didn't call `FHE.allow(handle, user)` — `CORE_RULES.md` §4.1 |
| Decryption hangs >2min | Mainnet latency, or wrong relayer URL. Show retry option — §5.4 |
| `chainChanged` then everything breaks | Re-init instance + invalidate handle cache — §3.2 |
| Tx succeeds but read shows zero | Reading wrong contract, wrong network, or stale config — §2.3 |

---

## PRE-SHIP CHECKLIST (frontend)

- [ ] Network badge visible in header at all times.
- [ ] Mainnet API key not in client bundle (`grep -r 'VITE_RELAYER_KEY' dist/` returns nothing).
- [ ] All states from §6.1 represented in UI (no implicit "loading").
- [ ] User rejection (code 4001) does not show error toast.
- [ ] EIP-712 signature cached for session, not re-prompted per read.
- [ ] Cache keyed on handle, invalidates automatically on state change.
- [ ] `chainChanged` and `accountsChanged` re-initialize instance + clear caches.
- [ ] Mobile tested on real iOS Safari + Android Chrome (not just emulators).
- [ ] Empty / uninitialized handle case has explicit UI (§6.4).
- [ ] Decryption phases distinguished (sign / relayer / render).
- [ ] Public decryption shows progress for the full 30–120s on mainnet.
- [ ] Live region announces status changes for screen readers.
- [ ] Touch targets ≥44 px on mobile.
- [ ] Skeleton loaders match final layout (no layout shift).
