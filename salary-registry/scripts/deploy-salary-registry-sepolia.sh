#!/usr/bin/env bash
# Deploy SalaryRegistry to Sepolia and regenerate frontend TS ABIs.
#
# Required env vars (from .env.local or shell):
#   SEPOLIA_RPC_URL       - Sepolia JSON-RPC endpoint
#   DEPLOYER_PRIVATE_KEY  - 0x-prefixed private key of the deployer
#
# Optional:
#   ETHERSCAN_API_KEY     - if set, verifies the contract on Etherscan
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FOUNDRY_DIR="$REPO_ROOT/packages/foundry"

if [[ -f "$REPO_ROOT/.env.local" ]]; then
  set -a; source "$REPO_ROOT/.env.local"; set +a
fi

: "${SEPOLIA_RPC_URL:?SEPOLIA_RPC_URL is required}"
: "${DEPLOYER_PRIVATE_KEY:?DEPLOYER_PRIVATE_KEY is required}"

FORGE_ARGS=(
  script/DeploySalaryRegistry.s.sol:DeploySalaryRegistry
  --rpc-url "$SEPOLIA_RPC_URL"
  --private-key "$DEPLOYER_PRIVATE_KEY"
  --broadcast
)

if [[ -n "${ETHERSCAN_API_KEY:-}" ]]; then
  FORGE_ARGS+=(--verify --etherscan-api-key "$ETHERSCAN_API_KEY")
fi

cd "$FOUNDRY_DIR"
~/.foundry/bin/forge script "${FORGE_ARGS[@]}"

echo
echo "▸ Regenerating frontend ABIs + addresses"
cd "$REPO_ROOT"
pnpm generate

echo
echo "✅  Sepolia deploy complete."
