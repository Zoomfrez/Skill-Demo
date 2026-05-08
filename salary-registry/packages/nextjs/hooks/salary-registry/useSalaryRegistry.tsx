"use client";

import { useCallback, useMemo, useState } from "react";
import { useAllow, useEncrypt, useIsAllowed, useUserDecrypt } from "@zama-fhe/react-sdk";
import { ZERO_HANDLE } from "@zama-fhe/sdk";
import { bytesToHex, isAddress } from "viem";
import { useAccount, useChainId, useReadContract, useWriteContract } from "wagmi";
import { SalaryRegistry } from "~~/contracts/SalaryRegistry";
import { deploymentFor } from "~~/utils/contract";

// Role enum must match SalaryRegistry.sol
export enum Role {
  None = 0,
  Employee = 1,
  Manager = 2,
  Admin = 3,
}

export const ROLE_LABELS: Record<Role, string> = {
  [Role.None]: "None",
  [Role.Employee]: "Employee",
  [Role.Manager]: "Manager",
  [Role.Admin]: "Admin",
};

export function useSalaryRegistry() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const registry = useMemo(() => deploymentFor(SalaryRegistry, chainId), [chainId]);

  const [message, setMessage] = useState<string>("");
  const [isProcessing, setIsProcessing] = useState(false);

  const hasContract = Boolean(registry?.address && registry?.abi);

  // --- Read: connected user's role ---
  const roleResult = useReadContract({
    address: hasContract ? registry!.address : undefined,
    abi: hasContract ? registry!.abi : undefined,
    functionName: "roles" as const,
    args: address ? [address] : undefined,
    query: { enabled: Boolean(hasContract && isConnected && address), refetchOnWindowFocus: false },
  });
  const myRole = (roleResult.data as Role | undefined) ?? Role.None;

  // --- Read: connected user's encrypted salary handle ---
  const myHandleResult = useReadContract({
    address: hasContract ? registry!.address : undefined,
    abi: hasContract ? registry!.abi : undefined,
    functionName: "getEncryptedSalary" as const,
    args: address ? [address] : undefined,
    query: { enabled: Boolean(hasContract && isConnected && address), refetchOnWindowFocus: false },
  });
  const myHandle = (myHandleResult.data as string | undefined) ?? undefined;
  const hasMySalary = myHandle && myHandle !== ZERO_HANDLE;

  // --- Decrypt: connected user decrypts their own salary ---
  const decryptHandles = useMemo(() => {
    if (!hasMySalary || !registry?.address) return [];
    return [{ handle: myHandle as `0x${string}`, contractAddress: registry.address }];
  }, [hasMySalary, myHandle, registry?.address]);

  const contractAddr = (registry?.address ?? "0x0") as `0x${string}`;
  const { mutate: allow, isPending: isAllowing } = useAllow();
  const { data: isAllowed } = useIsAllowed({ contractAddresses: [contractAddr] });

  const [decryptEnabled, setDecryptEnabled] = useState(false);
  const decrypt = useUserDecrypt({ handles: decryptHandles }, { enabled: decryptEnabled && !!isAllowed });

  const mySalary = useMemo(() => {
    if (!myHandle || !decrypt.data) return undefined;
    return decrypt.data[myHandle as `0x${string}`];
  }, [myHandle, decrypt.data]);

  const isDecrypted = mySalary !== undefined;

  const decryptSalary = useCallback(async () => {
    if (!hasMySalary || !registry?.address) return;
    setDecryptEnabled(true);
    if (!isAllowed) {
      setMessage("Authorizing decryption — please sign the EIP-712 message in your wallet...");
      allow([registry.address]);
      return;
    }
    setMessage("Decrypting salary...");
  }, [hasMySalary, registry?.address, isAllowed, allow]);

  // --- Encrypt + set salary (Manager) ---
  const encrypt = useEncrypt();
  const { writeContractAsync } = useWriteContract();

  const setSalary = useCallback(
    async (employeeAddr: string, salaryAmount: number) => {
      if (!hasContract || !address || !registry?.address) return;
      if (!isAddress(employeeAddr)) {
        setMessage("Invalid employee address");
        return;
      }
      setIsProcessing(true);
      setMessage("Encrypting salary...");
      try {
        const enc = await encrypt.mutateAsync({
          values: [{ value: BigInt(salaryAmount), type: "euint64" }],
          contractAddress: registry.address,
          userAddress: address,
        });
        setMessage("Sending transaction...");
        await writeContractAsync({
          address: registry.address,
          abi: registry.abi,
          functionName: "setSalary",
          args: [employeeAddr as `0x${string}`, bytesToHex(enc.handles[0]!), bytesToHex(enc.inputProof)],
          gas: 15_000_000n,
        });
        setMessage(`Salary set for ${employeeAddr.slice(0, 8)}...`);
      } catch (e) {
        setMessage(`setSalary failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setIsProcessing(false);
      }
    },
    [hasContract, address, registry, encrypt, writeContractAsync],
  );

  // --- Set role (Admin) ---
  const setRole = useCallback(
    async (targetAddr: string, role: Role) => {
      if (!hasContract || !registry?.address) return;
      if (!isAddress(targetAddr)) {
        setMessage("Invalid address");
        return;
      }
      setIsProcessing(true);
      setMessage("Setting role...");
      try {
        await writeContractAsync({
          address: registry.address,
          abi: registry.abi,
          functionName: "setRole",
          args: [targetAddr as `0x${string}`, role],
        });
        setMessage(`Role set to ${ROLE_LABELS[role]} for ${targetAddr.slice(0, 8)}...`);
        roleResult.refetch();
      } catch (e) {
        setMessage(`setRole failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setIsProcessing(false);
      }
    },
    [hasContract, registry, writeContractAsync, roleResult],
  );

  // --- Read role for an arbitrary address (for UI lookups) ---
  const [lookupAddr, setLookupAddr] = useState<string>("");
  const lookupResult = useReadContract({
    address: hasContract ? registry!.address : undefined,
    abi: hasContract ? registry!.abi : undefined,
    functionName: "roles" as const,
    args: isAddress(lookupAddr) ? [lookupAddr as `0x${string}`] : undefined,
    query: { enabled: Boolean(hasContract && isAddress(lookupAddr)), refetchOnWindowFocus: false },
  });
  const lookupRole = (lookupResult.data as Role | undefined) ?? Role.None;

  return {
    contractAddress: registry?.address,
    myRole,
    myHandle,
    hasMySalary,
    mySalary,
    isDecrypted,
    isDecrypting: decrypt.isFetching,
    isAllowing,
    decryptSalary,
    setSalary,
    setRole,
    isProcessing,
    message,
    setMessage,
    isConnected,
    address,
    lookupAddr,
    setLookupAddr,
    lookupRole,
    refreshRole: roleResult.refetch,
    refreshHandle: myHandleResult.refetch,
  };
}
