"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Address } from "viem";
import { api, type ServiceInfo } from "./api";

export type Role = "seller" | "buyer";

interface PersonaCtx {
  role: Role;
  setRole: (r: Role) => void;
  address?: Address;
  info?: ServiceInfo;
  error?: string;
  refreshInfo: () => void;
}

const Ctx = createContext<PersonaCtx>({ role: "buyer", setRole: () => {}, refreshInfo: () => {} });

export function PersonaProvider({ children }: { children: ReactNode }) {
  const [role, setRoleState] = useState<Role>("buyer");
  const [info, setInfo] = useState<ServiceInfo>();
  const [error, setError] = useState<string>();
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

  return (
    <Ctx.Provider
      value={{ role, setRole, info, error, address: info?.personas[role].address, refreshInfo: () => setTick((t) => t + 1) }}
    >
      {children}
    </Ctx.Provider>
  );
}

export const usePersona = () => useContext(Ctx);
