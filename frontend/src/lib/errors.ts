// Plain-language explanations for reverts users can hit, keyed by the decoded custom error name.
export interface Explained {
  title: string;
  body: string;
  /** decoded error, shown as the technical detail */
  detail: string;
  /** the fix is to verify with World ID */
  needsWorldId?: boolean;
}

const EXPLANATIONS: Record<string, Omit<Explained, "detail">> = {
  BuyerNotEligible: {
    title: "Purchase rejected onchain: World ID required",
    body:
      "This Verified Market listing only accepts buyers with a World ID NFC document credential (passport or My Number Card). " +
      "The market contract checked your account at fill time and reverted, so no payment was taken. " +
      "Verify with World ID, then buy again.",
    needsWorldId: true,
  },
  SourceAlreadyTrading: {
    title: "This stake is already being sold",
    body: "The validator is in an open trade. It can be listed again once that trade settles or is refunded.",
  },
  NonceAlreadyUsed: {
    title: "Listing no longer available",
    body: "This listing was already filled or cancelled by the seller.",
  },
  OrderExpired: { title: "Listing expired", body: "The seller's order has passed its expiry." },
  StaleProof: {
    title: "Beacon proof too old",
    body: "The validator proofs come from a beacon state older than the market accepts. Reload to fetch fresh proofs.",
  },
  PriceBelowMinimum: {
    title: "Price below the seller's minimum",
    body: "At the current reference price, this order would pay less than the seller's minimum.",
  },
  TargetNotEligible: {
    title: "Target validator not eligible",
    body: "The receiving validator must be an active, non-exiting 0x02 (compounding) validator.",
  },
  TargetCapacityExceeded: {
    title: "Target validator is too full",
    body: "After the transfer the target would exceed 2048 ETH of effective balance. Choose another validator.",
  },
  InsufficientEth: { title: "Not enough ETH", body: "The ETH sent does not cover the price plus the EIP-7251 fee." },
};

/** `message` is the output of errorMessage(); returns an explanation for known contract errors. */
export function explainError(message: string): Explained | undefined {
  // the node rejects a call whose value exceeds the balance before the contract runs
  if (/exceeds the balance|insufficient funds/i.test(message)) {
    return {
      title: "Not enough ETH in this account",
      body:
        "The price plus the EIP-7251 fee is more than this account's ETH balance, so the transaction was not sent. " +
        "Top up the account (on the local fork: the +100 ETH button in the header), or pay with WETH or USDC.",
      detail: message,
    };
  }
  const name = message.match(/^([A-Za-z0-9_]+)\(|^([A-Za-z0-9_]+)$/);
  const key = name?.[1] ?? name?.[2];
  const e = key ? EXPLANATIONS[key] : undefined;
  return e && { ...e, detail: message };
}
