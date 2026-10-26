// Instruments and timeframes supported by SKY AI SIGNALS.
// This is the symbol-mapping layer: our internal key -> provider symbol.

export const SYMBOLS = {
  XAUUSD: { name: "Gold", kind: "metal", providerSymbol: "XAUUSD" },
  EURUSD: { name: "Euro / US Dollar", kind: "forex", providerSymbol: "EURUSD" },
  GBPUSD: { name: "British Pound / US Dollar", kind: "forex", providerSymbol: "GBPUSD" },
  USDJPY: { name: "US Dollar / Japanese Yen", kind: "forex", providerSymbol: "USDJPY" },
  AUDUSD: { name: "Australian Dollar / US Dollar", kind: "forex", providerSymbol: "AUDUSD" },
  USDCAD: { name: "US Dollar / Canadian Dollar", kind: "forex", providerSymbol: "USDCAD" },
  USDCHF: { name: "US Dollar / Swiss Franc", kind: "forex", providerSymbol: "USDCHF" },
  NZDUSD: { name: "New Zealand Dollar / US Dollar", kind: "forex", providerSymbol: "NZDUSD" }
};

// interval = value sent to Biquote. verified = the owner has seen this interval
// work in a browser. Unverified intervals may be rejected by the provider; when
// that happens the API reports the provider error instead of inventing data.
export const TIMEFRAMES = {
  M5: { interval: "5m", ms: 5 * 60000, verified: false },
  M15: { interval: "15m", ms: 15 * 60000, verified: true },
  M30: { interval: "30m", ms: 30 * 60000, verified: false },
  H1: { interval: "1h", ms: 60 * 60000, verified: true },
  H4: { interval: "4h", ms: 4 * 60 * 60000, verified: false },
  D1: { interval: "1d", ms: 24 * 60 * 60000, verified: false }
};
