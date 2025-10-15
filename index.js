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
 
 const usdtERCProvider = { 
   name: "Ethplorer (ERC20)", 
   url: (address) => 
     `https://api.ethplorer.io/getAddressInfo/${address}?apiKey=freekey`, 
  parse: async (res) => { 
    // Defensive parsing - Ethplorer responses can vary and tokenInfo may be missing
    const data = await res.json(); 
    const tokens = data.tokens || [];
    const token = tokens.find((t) => {
      const ti = t.tokenInfo || {};
      const symbol = (ti.symbol || t.symbol || "").toString().toUpperCase();
      const addr = (ti.address || "").toString().toLowerCase();
      return (
        symbol === "USDT" ||
        addr === "0xdac17f958d2ee523a2206206994597c13d831ec7"
      );
    });

    if (!token) return 0;

    // Prefer token.balance if present; fall back to token.tokenInfo.balance
    const rawBalance = token.balance ?? token.tokenInfo?.balance ?? 0;
    const decimals = Number(token.tokenInfo?.decimals ?? token.decimals ?? 6) || 6;
    const numeric = parseFloat(rawBalance);
    if (isNaN(numeric)) return 0;
    return numeric / Math.pow(10, decimals);
  }, 
 }; 
 
 const usdtTRCProvider = { 
   name: "TronScan (TRC20)", 
   url: (address) => 
     `https://apilist.tronscan.org/api/account?address=${address}`, 
  parse: async (res) => { 
    const data = await res.json(); 
    const tokens = data.trc20 || [];
    const token = tokens.find((t) => {
      const symbol = (t.symbol || "").toString().toUpperCase();
      const tokenId = (t.tokenId || "").toString();
      return (
        symbol === "USDT" ||
        tokenId === "TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj"
      );
    });

    if (!token) return 0;

    const rawBalance = token.balance ?? 0;
    // Tron TRC20 balances are often in smallest unit; default to 6 decimals for USDT
    const decimals = Number(token.decimals ?? 6) || 6;
    const numeric = parseFloat(rawBalance);
    if (isNaN(numeric)) return 0;
    return numeric / Math.pow(10, decimals);
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
       const balance = await p.parse(res, address); 
       if (balance !== null && !isNaN(balance)) { 
         console.log(`✅ Success from ${p.name}`); 
         return { balance, source: p.name }; 
       } 
     } catch (e) { 
       console.log(`❌ Failed from ${p.name}`); 
     } 
   } 
   return { balance: null, source: "All providers failed" }; 
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
   const result = await tryProviders([usdtTRCProvider], req.params.address); 
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