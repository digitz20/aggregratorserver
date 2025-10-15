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
 const port = process.env.PORT || 3000; 
 
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
   (addr) => ({ 
     url: `https://blockstream.info/api/address/${addr}`, 
     parser: (data) => 
       data.chain_stats 
         ? (data.chain_stats.funded_txo_sum - data.chain_stats.spent_txo_sum) / 
           1e8 
         : null, 
   }), 
   (addr) => ({ 
     url: `https://sochain.com/api/v2/get_address_balance/BTC/${addr}`, 
     parser: (data) => 
       data.data && data.data.confirmed_balance 
         ? parseFloat(data.data.confirmed_balance) 
         : null, 
   }), 
 ]; 
 
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
       if (balance !== null) return balance; 
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
 
 // -------- Health Check -------- 
 app.get("/", (req, res) => { 
   res.send("✅ Bitcoin Aggregator API is running."); 
 }); 
 
 // -------- Start Server -------- 
 app.listen(port, () => { 
   console.log(`🚀 BTC Aggregator running on port ${port}`); 
 });