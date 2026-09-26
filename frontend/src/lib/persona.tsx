"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Address } from "viem";
import { api, type ServiceInfo } from "./api";
import { CHAIN_ID } from "./config";
import { connectWallet, disconnectWallet } from "./wallet";

export type Role = "seller" | "buyer";

interface PersonaCtx {
  role: Role;
  setRole: (r: Role) => void;
  /** acting address: the connected wallet, or the demo persona for `role` */
  address?: Address;
  seller?: Address;
  buyer?: Address;
  wallet?: Address;
  connect: () => Promise<void>;
  disconnect: () => void;
  info?: ServiceInfo;
  error?: string;
  refreshInfo: () => void;
}

const Ctx = createContext<PersonaCtx>({
  role: "buyer",
  setRole: () => {},
  connect: async () => {},
  disconnect: () => {},
  refreshInfo: () => {},
});

export function PersonaProvider({ children }: { children: ReactNode }) {
  const [role, setRoleState] = useState<Role>("buyer");
  const [info, setInfo] = useState<ServiceInfo>();
  const [error, setError] = useState<string>();
  const [wallet, setWallet] = useState<Address>();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("stakeport.role");
      // one-time sync from browser storage after hydration
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (saved === "seller" || saved === "buyer") setRoleState(saved);
    } catch {}
  }, []);

  useEffect(() => {
    api
      .info()
      .then((i) => {
        setInfo(i);
        setError(undefined);
      })
      .catch((e) => setError(`Proof service unavailable: ${e.message}`));
  }, [tick]);

  const setRole = (r: Role) => {
    setRoleState(r);
    try {
      localStorage.setItem("stakeport.role", r);
    } catch {}
  };

  const seller = wallet ?? info?.personas?.seller.address;
  const buyer = wallet ?? info?.personas?.buyer.address;

  return (
    <Ctx.Provider
      value={{
        role,
        setRole,
        info,
        error,
        wallet,
        seller,
        buyer,
        address: role === "seller" ? seller : buyer,
        connect: async () => setWallet(await connectWallet(CHAIN_ID)),
        disconnect: () => {
          disconnectWallet();
          setWallet(undefined);
        },
        refreshInfo: () => setTick((t) => t + 1),
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export const usePersona = () => useContext(Ctx);
