// =============================== 
 // Bitcoin Balance Aggregator API 
 // =============================== 
 // Features: 
 // - Rotates across multiple free APIs (blockchain.info, blockstream.info, sochain) 
 // - Adds caching (1 minute) 
 // - Handles retries and random delays 
 // - Designed for up to 10+ servers concurrently 
 // =============================== 
 
 import express from "express"; 
 import fetch from "node-fetch"; 
 
 const app = express(); 
 const port = process.env.PORT || 4844; 
 
 // -------- Helper Functions -------- 
 const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); 
 
 async function safeFetch(url, retries = 3) { 
   for (let i = 0; i < retries; i++) { 
     try { 
       const res = await fetch(url, { timeout: 5000 }); 
       if (res.ok) return await res.json(); 
       console.log(`Failed [${res.status}] on ${url}`); 
     } catch (e) { 
       console.log(`Error on ${url}:`, e.message); 
     } 
     await sleep(1000 * (i + 1)); // Backoff delay 
   } 
   throw new Error("All retries failed"); 
 } 
 
 // -------- API Providers -------- 
 const providers = [ 
   (addr) => ({ 
     url: `https://blockchain.info/balance?active=${addr}`, 
     parser: (data) => (data[addr] ? data[addr].final_balance / 1e8 : null), 
   }), 

 ]; 
 
 
const usdtTRCProvider = {
  name: "Tron (TronScan/TronGrid)",
  url: (address) => `https://apilist.tronscan.org/api/account?address=${address}`,
  parse: async (res) => {
    // Tronscan / TronGrid responses vary. Try to support multiple shapes so USDT is found.
    const knownTokenIds = new Set([
      "TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj", // TRON USDT main id
      "1002000", // some APIs return numeric ids or keys
    ]);
    try {
      const data = await res.json();

      // payload may be wrapped in data.data or be top-level
      const payload = data.data || data || {};

      // Many possible fields: trc20, tokens, tokenBalances, assetV2
      const candidates =
        payload.trc20 || payload.tokens || payload.tokenBalances || payload.trc20Tokens || payload.assetV2 || [];

      // Normalize assetV2 entries (TronGrid style) into objects with key/value
      const tokens = (candidates || []).map((t) => {
        // assetV2 entries sometimes look like {key: 'USDT', value: '1230000'}
        if (t && typeof t === "object") return t;
        return null;
      }).filter(Boolean);

      const token = tokens.find((t) => {
        const symbol = (t.symbol || t.tokenName || t.key || t.name || "").toString().toUpperCase();
        const tokenId = (t.tokenId || t.contract || t.key || t.token_id || "").toString();
        // match by symbol or by known token id
        return symbol === "USDT" || knownTokenIds.has(tokenId) || tokenId === "TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj";
      });

      if (!token) {
        return { balance: 0, status: "failed", reason: "USDT token not found" };
      }

      // Balance field variations: balance, value, amount, balanceStr, value_str
      const rawBalance = token.balance ?? token.value ?? token.amount ?? token.balanceStr ?? token.value_str ?? token.valueString ?? 0;
      const decimals = Number(token.decimals ?? token.tokenDecimal ?? token.decimals_str ?? 6) || 6;
      const numeric = Number(rawBalance);
      if (isNaN(numeric)) {
        // Some Tron APIs return integer strings that need to be parsed as BigInt; attempt fallback
        const asString = String(rawBalance || "0").replace(/[^0-9]/g, "");
        if (!asString) return { balance: 0, status: "failed", reason: "Invalid balance format" };
        try {
          // parse possibly very large integer
          const big = BigInt(asString);
          const scaled = Number(big) / Math.pow(10, decimals);
          if (isFinite(scaled)) return { balance: scaled, status: "success" };
        } catch (e) {
          return { balance: 0, status: "failed", reason: "Invalid balance format" };
        }
      }
      return { balance: numeric / Math.pow(10, decimals), status: "success" };
    } catch (e) {
      return { balance: 0, status: "failed", reason: e.message };
    }
  },
};

// Additional TRC20 provider using TronGrid's public API as a fallback
const usdtTRCProviderTronGrid = {
  name: "TronGrid (TRC20)",
  url: (address) => `https://api.trongrid.io/v1/accounts/${address}/tokens`,
  parse: async (res) => {
    try {
      const data = await res.json();
      // TronGrid returns { data: [...] } or an array directly
      const tokens = data.data || data || [];

      const token = (tokens || []).find((t) => {
        const symbol = (t.tokenAbbr || t.tokenName || t.symbol || t.key || "").toString().toUpperCase();
        const tokenId = (t.contract || t.tokenId || t.key || "").toString().toUpperCase();
        return symbol === "USDT" || tokenId === "TXLAQ63XG1NAZCKPWKHVZW7CSEMLMEQCDJ";
      });

      if (!token) return { balance: 0, status: "failed", reason: "USDT token not found" };

      const rawBalance = token.balance ?? token.value ?? token.amount ?? token.quantity ?? 0;
      const decimals = Number(token.tokenDecimal ?? token.decimals ?? token.tokenDecimal ?? 6) || 6;
      const numeric = Number(rawBalance);
      if (isNaN(numeric)) {
        const asString = String(rawBalance || "0").replace(/[^0-9]/g, "");
        if (!asString) return { balance: 0, status: "failed", reason: "Invalid balance format" };
        try {
          const big = BigInt(asString);
          const scaled = Number(big) / Math.pow(10, decimals);
          if (isFinite(scaled)) return { balance: scaled, status: "success" };
        } catch (e) {
          return { balance: 0, status: "failed", reason: "Invalid balance format" };
        }
      }
      return { balance: numeric / Math.pow(10, decimals), status: "success" };
    } catch (e) {
      return { balance: 0, status: "failed", reason: e.message };
    }
  },
};
 
 // -------- Caching -------- 
 const cache = new Map();
 const CACHE_TTL = 60 * 1000; // 1 minute 
 
 // -------- Core Logic -------- 
 async function getBalanceFromProviders(address) { 
   // Randomize provider order each time for better distribution 
   const shuffled = [...providers].sort(() => Math.random() - 0.5); 
 
   for (const provider of shuffled) { 
     const { url, parser } = provider(address); 
     try { 
       const data = await safeFetch(url); 
       const balance = parser(data); 
       if (balance !== null) {
        console.log(`Success from ${url}`);
        return balance;
       }; 
     } catch (err) { 
       console.log(`Provider failed: ${url}`); 
     } 
     await sleep(1000 + Math.random() * 1500); // Small delay before next provider 
   } 
   throw new Error("All providers failed."); 
 } 
 
 // -------- Caching Wrapper -------- 
 async function getBalance(address) { 
   const now = Date.now();
   const cached = cache.get(address);
   if (cached && now - cached.time < CACHE_TTL) { 
     return cached.value;
   } 
 
   const balance = await getBalanceFromProviders(address); 
   cache.set(address, { value: balance, time: now });
   return balance; 
 } 
 
 async function tryProviders(providers, address) { 
  for (const p of providers) {
    try {
      const res = await fetch(p.url(address));
      if (!res.ok) throw new Error("Bad response");
      const result = await p.parse(res, address);
      // If result is an object with status, use it; else fallback to old logic
      if (result && typeof result === "object" && "status" in result) {
        if (result.status === "success") {
          console.log(`✅ Success from ${p.name}`);
          return { balance: result.balance, status: "success", source: p.name };
        } else {
          console.log(`❌ Failed from ${p.name}: ${result.reason || "Unknown"}`);
          return { balance: result.balance, status: "failed", reason: result.reason, source: p.name };
        }
      } else if (result !== null && !isNaN(result)) {
        console.log(`✅ Success from ${p.name}`);
        return { balance: result, status: "success", source: p.name };
      }
    } catch (e) {
      console.log(`❌ Failed from ${p.name}`);
    }
  }
  return { balance: null, status: "failed", source: "All providers failed" };
 } 
 
 // -------- Express Endpoint -------- 
 app.get("/balance/:address", async (req, res) => { 
   const { address } = req.params; 
   try { 
     const balance = await getBalance(address); 
     res.json({ address, balance, cached: false }); 
   } catch (err) { 
     res.status(500).json({ error: err.message }); 
   } 
 }); 
 
 app.get("/balance/usdt/erc/:address", async (req, res) => { 
   const result = await tryProviders([usdtERCProvider], req.params.address); 
   res.json({ chain: "USDT-ERC20", ...result }); 
 }); 
 
app.get("/balance/usdt/trc/:address", async (req, res) => {
  // Try the primary TRC20 provider first, then fallback to TronGrid
  const result = await tryProviders([usdtTRCProvider, usdtTRCProviderTronGrid], req.params.address);
  res.json({ chain: "USDT-TRC20", ...result });
});
 
 // -------- Health Check -------- 
 app.get("/", (req, res) => { 
   res.send("✅ Bitcoin Aggregator API is running."); 
 }); 
 
 // -------- Start Server -------- 
 app.listen(port, () => { 
   console.log(`🚀 BTC Aggregator running on port ${port}`); 
 });