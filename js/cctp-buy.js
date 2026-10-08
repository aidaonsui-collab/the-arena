// Buy-side CCTP V2: burn native USDC on an EVM chain, then the page mints it on Sui.
// Addresses and the depositForBurn argument order match Circle's mainnet docs.
// Standard transfer only: minFinalityThreshold 2000, maxFee 0. No hook data.
(function(global){
  var MESSENGER = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d";
  var DEPOSIT_SELECTOR = "8e0250ee";
  var APPROVE_SELECTOR = "095ea7b3";
  var ALLOWANCE_SELECTOR = "dd62ed3e";
  var BALANCE_SELECTOR = "70a08231";
  var IRIS = "https://iris-api.circle.com/v2/messages/";
  var CHAINS = {
    base: {
      key: "base",
      label: "Base",
      domain: 6,
      chainId: 8453,
      hex: "0x2105",
      usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      rpc: "https://mainnet.base.org",
      explorer: "https://basescan.org",
      currency: { name: "Ether", symbol: "ETH", decimals: 18 }
    },
    ethereum: {
      key: "ethereum",
      label: "Ethereum",
      domain: 0,
      chainId: 1,
      hex: "0x1",
      usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      rpc: "https://ethereum.publicnode.com",
      explorer: "https://etherscan.io",
      currency: { name: "Ether", symbol: "ETH", decimals: 18 }
    },
    arbitrum: {
      key: "arbitrum",
      label: "Arbitrum",
      domain: 3,
      chainId: 42161,
      hex: "0xa4b1",
      usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
      rpc: "https://arb1.arbitrum.io/rpc",
      explorer: "https://arbiscan.io",
      currency: { name: "Ether", symbol: "ETH", decimals: 18 }
    },
    // Arc mainnet: CCTP domain 26, chain 5042. Native gas is USDC (18 decimals).
    // The burn uses the 6-decimal ERC-20 precompile, same balance as gas.
    arc: {
      key: "arc",
      label: "Arc",
      domain: 26,
      chainId: 5042,
      hex: "0x13b2",
      usdc: "0x3600000000000000000000000000000000000000",
      rpc: "https://rpc.mainnet.arc.io",
      explorer: "https://explorer.arc.io",
      currency: { name: "USDC", symbol: "USDC", decimals: 18 },
      gasReserve: "50000"
    }
  };
  // Mainnet Sui CCTP V2. The receive PTB calls these in Circle's published order.
  var SUI = {
    domain: 8,
    mtPackage: "0x16bcfcfc465f96281663a344641c017de84529370e11aa3879d0dce43ad6db87",
    mtState: "0x0c067f7d325e5b60e3179712e7783534ba1556cbb3d359d8161497e37689230c",
    tmmPackage: "0xeb14978abfe93a37c5d5bf86a0623b923553a5f0e794daac7724f1e2fdbfb830",
    tmmState: "0x06fb166941cd7bc095edc019d054a753ec3f1e4c25f28f2ecc4a6cfa0a9b1167",
    handlerPackage: "0x185ed207c4d64fc594882ab927f9f3c6ff957aad03df8a731ba64378faeeb2bf",
    handlerState: "0xa32de8a6dd0178fb05f662929d55cddb69a25c26bde4b83f89e36d17ead94c41",
    treasury: "0x57d6725e7a8b49a7b2a612f6bd66ab5f39fc95332ca48be421c3229d514a6de7",
    denyList: "0x403",
    clock: "0x6"
  };

  function hexBody(v){
    return String(v || "").trim().replace(/^0x/i, "").toLowerCase();
  }
  function pad32(v){
    var h = hexBody(v);
    if (!/^[0-9a-f]*$/.test(h) || h.length > 64) throw new Error("Bad 32-byte value");
    return h.padStart(64, "0");
  }
  function u256(n){
    var v = typeof n === "bigint" ? n : BigInt(String(n == null ? "0" : n));
    if (v < 0n) v = 0n;
    var h = v.toString(16);
    if (h.length > 64) throw new Error("Value does not fit in 32 bytes");
    return h.padStart(64, "0");
  }
  function encodeDeposit(amount, domain, mintRecipient, burnToken){
    return "0x" + DEPOSIT_SELECTOR
      + u256(amount)
      + u256(domain)
      + pad32(mintRecipient)
      + pad32(burnToken)
      + pad32("0x0")
      + u256(0)
      + u256(2000);
  }
  function hexToBytes(hex){
    var h = hexBody(hex);
    if (!h) return new Uint8Array(0);
    if (h.length % 2) h = "0" + h;
    if (!/^[0-9a-f]+$/.test(h)) throw new Error("Attestation is not hex");
    var out = new Uint8Array(h.length / 2);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
    return out;
  }
  function suiToBytes32(addr){
    var h = hexBody(addr);
    if (!/^[0-9a-f]{1,64}$/.test(h)) throw new Error("Connect a Sui wallet first");
    return "0x" + h.padStart(64, "0");
  }
  function sleep(ms){ return new Promise(function(ok){ setTimeout(ok, ms); }); }
  function rejected(e){
    var code = e && e.code;
    var msg = String((e && e.message) || e || "");
    return code === 4001 || /reject|denied|cancel/i.test(msg);
  }

  async function switchChain(request, chain){
    var id = await request("eth_chainId");
    if ((parseInt(id, 16) || 0) === chain.chainId) return;
    try {
      await request("wallet_switchEthereumChain", [{ chainId: chain.hex }]);
    } catch (e) {
      var code = e && e.code;
      var msg = String((e && e.message) || "");
      if (code === 4902 || /unrecognized|not added|unknown chain/i.test(msg)){
        await request("wallet_addEthereumChain", [{
          chainId: chain.hex,
          chainName: chain.label,
          nativeCurrency: chain.currency,
          rpcUrls: [chain.rpc],
          blockExplorerUrls: [chain.explorer]
        }]);
      } else if (rejected(e)) {
        throw new Error("Wallet rejected the " + chain.label + " switch.");
      } else {
        throw e;
      }
    }
    var after = await request("eth_chainId");
    if ((parseInt(after, 16) || 0) !== chain.chainId){
      throw new Error("Switch the wallet to " + chain.label + ".");
    }
  }
  async function account(request){
    var accs = await request("eth_requestAccounts");
    var addr = accs && accs[0];
    if (!addr) throw new Error("EVM wallet returned no account");
    return addr;
  }
  async function ethCall(request, to, data){
    var raw = await request("eth_call", [{ to: to, data: data }, "latest"]);
    if (!raw || raw === "0x") return 0n;
    return BigInt(raw);
  }
  function revertText(err){
    var data = "";
    var msg = String((err && err.message) || err || "");
    var bag = err && (err.data || (err.error && err.error.data) || "");
    if (bag && typeof bag === "object") bag = bag.data || bag.message || "";
    data = String(bag || "");
    var hex = data.indexOf("08c379a0") >= 0 ? data.slice(data.indexOf("08c379a0") + 8) : "";
    if (hex.length >= 128){
      try {
        var len = parseInt(hex.slice(64, 128), 16);
        if (len > 0 && len < 200){
          var chars = hex.slice(128, 128 + len * 2);
          var text = "";
          for (var i = 0; i < chars.length; i += 2) text += String.fromCharCode(parseInt(chars.substr(i, 2), 16));
          if (text) return text;
        }
      } catch (e) {}
    }
    var known = msg.match(/execution reverted:?\s*(.+)/i);
    if (known && known[1]) return known[1].replace(/^"|"$/g, "").slice(0, 180);
    return "";
  }
  async function preflight(request, from, to, data){
    try {
      await request("eth_call", [{ from: from, to: to, data: data }, "latest"]);
      return "";
    } catch (e) {
      return revertText(e) || "This burn would revert.";
    }
  }
  async function sendAndWait(request, tx){
    var hash = await request("eth_sendTransaction", [tx]);
    if (!hash) throw new Error("Wallet did not return a transaction");
    var start = Date.now();
    while (Date.now() - start < 180000){
      var rec = null;
      try { rec = await request("eth_getTransactionReceipt", [hash]); } catch (e) { rec = null; }
      if (rec && rec.blockNumber){
        var status = String(rec.status || "");
        if (status === "0x0" || status === "0x00") throw new Error("The chain reverted this transaction. " + hash);
        return hash;
      }
      await sleep(1500);
    }
    throw new Error("Transaction still pending: " + hash);
  }
  async function ensureAllowance(request, chain, owner, amount, onStatus){
    var data = "0x" + ALLOWANCE_SELECTOR + pad32(owner) + pad32(MESSENGER);
    var current = await ethCall(request, chain.usdc, data);
    if (current >= amount) return;
    if (current > 0n){
      if (onStatus) onStatus("Resetting the USDC approval on " + chain.label + ".");
      await sendAndWait(request, {
        from: owner,
        to: chain.usdc,
        data: "0x" + APPROVE_SELECTOR + pad32(MESSENGER) + u256(0),
        value: "0x0"
      });
    }
    if (onStatus) onStatus("Approving USDC on " + chain.label + ". Confirm in the wallet.");
    await sendAndWait(request, {
      from: owner,
      to: chain.usdc,
      data: "0x" + APPROVE_SELECTOR + pad32(MESSENGER) + u256(amount),
      value: "0x0"
    });
  }

  async function burn(opts){
    var request = opts && opts.request;
    if (!request) throw new Error("No EVM wallet found. Install MetaMask, Rabby, or Coinbase Wallet.");
    var chain = CHAINS[opts.chainKey];
    if (!chain) throw new Error("Pick a USDC network");
    var amount = typeof opts.amount === "bigint" ? opts.amount : BigInt(String(opts.amount || "0"));
    if (!(amount > 0n)) throw new Error("Enter a USDC amount");
    var recipient = suiToBytes32(opts.suiAddress);
    if (opts.onStatus) opts.onStatus("Switching to " + chain.label + ".");
    await switchChain(request, chain);
    var owner = await account(request);
    var bal = await ethCall(request, chain.usdc, "0x" + BALANCE_SELECTOR + pad32(owner));
    if (bal < amount) throw new Error("Not enough USDC on " + chain.label + ".");
    if (chain.gasReserve){
      var reserve = BigInt(chain.gasReserve);
      if (bal < amount + reserve) throw new Error("Leave a little USDC on " + chain.label + " for gas.");
    }
    await ensureAllowance(request, chain, owner, amount, opts.onStatus);
    // Destination is Sui (domain 8). chain.domain is only the source, for Iris.
    var burnData = encodeDeposit(amount, SUI.domain, recipient, chain.usdc);
    var why = await preflight(request, owner, MESSENGER, burnData);
    if (/allowance/i.test(why)){
      if (opts.onStatus) opts.onStatus("Approving USDC on " + chain.label + " again.");
      await sendAndWait(request, {
        from: owner,
        to: chain.usdc,
        data: "0x" + APPROVE_SELECTOR + pad32(MESSENGER) + u256(amount),
        value: "0x0"
      });
      why = await preflight(request, owner, MESSENGER, burnData);
    }
    if (why){
      if (/allowance/i.test(why)) throw new Error("USDC approval did not cover this burn.");
      if (/balance/i.test(why)) throw new Error("Not enough USDC on " + chain.label + ".");
      if (/max fee/i.test(why)) throw new Error("Circle's fee is higher than this amount.");
      throw new Error(why);
    }
    var gas = null;
    try {
      var est = await request("eth_estimateGas", [{ from: owner, to: MESSENGER, data: burnData, value: "0x0" }]);
      if (est) gas = "0x" + ((BigInt(est) * 12n) / 10n).toString(16);
    } catch (e) {}
    if (opts.onStatus) opts.onStatus("Burning USDC on " + chain.label + ". Confirm in the wallet.");
    var tx = { from: owner, to: MESSENGER, data: burnData, value: "0x0" };
    if (gas) tx.gas = gas;
    var hash = await sendAndWait(request, tx);
    return { hash: hash, owner: owner, chainId: chain.chainId };
  }

  async function waitAttestation(opts){
    var chain = CHAINS[opts.chainKey];
    if (!chain) throw new Error("Pick a USDC network");
    var hash = String(opts.txHash || "");
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("Burn hash is not an EVM transaction");
    var url = IRIS + chain.domain + "?transactionHash=" + hash;
    var start = Date.now();
    var limit = opts.timeoutMs || (25 * 60 * 1000);
    while (Date.now() - start < limit){
      if (opts.onStatus){
        var mins = Math.floor((Date.now() - start) / 60000);
        var hint = chain.key === "ethereum"
          ? "Ethereum often takes about 15 minutes."
          : "This waits for Circle finality.";
        opts.onStatus("Waiting for Circle" + (mins ? " · " + mins + "m" : "") + ". " + hint + " Leave this tab open, or come back and tap Finish.");
      }
      try {
        var res = await fetch(url);
        if (res.status === 429){
          await sleep(30000);
          continue;
        }
        if (res.ok){
          var data = await res.json();
          var msg = data && data.messages && data.messages[0];
          if (msg && msg.message && msg.message !== "0x" && msg.attestation && msg.attestation !== "PENDING"){
            return { message: msg.message, attestation: msg.attestation };
          }
        }
      } catch (e) {}
      await sleep(8000);
    }
    var err = new Error("Circle has not attested yet. This burn is saved. Tap Finish to keep waiting.");
    err.cctpPending = true;
    throw err;
  }

  async function balanceOf(request, chainKey, owner){
    var chain = CHAINS[chainKey];
    if (!request || !chain || !owner) return 0n;
    return ethCall(request, chain.usdc, "0x" + BALANCE_SELECTOR + pad32(owner));
  }

  global.ViceCctp = {
    messenger: MESSENGER,
    chains: CHAINS,
    sui: SUI,
    chain: function(key){ return CHAINS[key] || null; },
    burn: burn,
    waitAttestation: waitAttestation,
    balanceOf: balanceOf,
    hexToBytes: hexToBytes,
    suiToBytes32: suiToBytes32,
    encodeDeposit: encodeDeposit
  };
})(typeof window !== "undefined" ? window : globalThis);
