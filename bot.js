// PBTC Uniswap-V3 Buy-Bot   (buyer-address fix + mcap)
// ---------------------------------------------------
// ENV: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_IDS, RPC_URL, START_BLOCK,
//      PBTC_TOKEN_ADDRESS, STAKING_CONTRACT_ADDRESS

const { JsonRpcProvider, Contract, Interface, formatUnits, id, getAddress } = require("ethers");
const TelegramBot = require("node-telegram-bot-api");
const path = require("path");

const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_IDS,
  RPC_URL,
  START_BLOCK,
  PBTC_TOKEN_ADDRESS,
  STAKING_CONTRACT_ADDRESS,
} = process.env;

/* ─────────── Telegram ─────────── */
const bot     = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const chatIds = TELEGRAM_CHAT_IDS.split(",").map((c) => c.trim());

/* ─────────── Pool & token setup ─────────── */
const POOL_ADDRESS   = "0xc3fd337dfc5700565a5444e3b0723920802a426d"; // PBTC / USDT
const USDT_DECIMALS  = 6;
const PBTC_DECIMALS  = 18;
const MIN_USDT       = 10;
const FACTORY_ADDRESS  = "0x33128a8fC17869897dcE68Ed026d694621f6FDfD"; // Uniswap V3 Factory on Base
const TRANSFER_TOPIC = id("Transfer(address,address,uint256)");      // keccak256 event sig

/* ─────────── RPC / contracts ─────────── */
const provider = new JsonRpcProvider(RPC_URL);


// Uniswap V3 Factory ABI (only PoolCreated needed)
const factoryAbi = [
  "event PoolCreated(address indexed token0, address indexed token1, uint24 fee, int24 tickSpacing, address pool)"
];
const factory = new Contract(FACTORY_ADDRESS, factoryAbi, provider);


// Map of poolAddress → Contract instance
const poolContracts = {};

// ABI to read Swap events from any V3 pool
const uniV3PoolAbi = [
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)"
];

const pbtcAbi = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
];
const stakingAbi = require("./abi/StakingContractABI.json");

const pbtc    = new Contract(PBTC_TOKEN_ADDRESS, pbtcAbi, provider);
const staking = new Contract(STAKING_CONTRACT_ADDRESS, stakingAbi, provider);

const iface = new Interface(pbtcAbi);   // for decoding Transfer logs

/* ─────────── Globals ─────────── */
let TOTAL_SUPPLY = 100_000_000; // fallback
(async () => {
  try {
    const raw = await pbtc.totalSupply();
    TOTAL_SUPPLY = parseFloat(formatUnits(raw, PBTC_DECIMALS));
    console.log(`[Init] totalSupply = ${TOTAL_SUPPLY.toLocaleString()}`);
  } catch {
    console.warn(`[Init] using fallback totalSupply 100 M`);
  }
})();

let lastFactoryBlock  = START_BLOCK ? Number(START_BLOCK) : 0;
let lastSwapBlock     = START_BLOCK ? Number(START_BLOCK) : 0;

/* ─────────── Helper fns ─────────── */
function tier(usdt) {
  if (usdt < 50)  return { emoji: "🦐", label: "Shrimp", img: "buy.jpg" };
  if (usdt < 200) return { emoji: "🐟", label: "Fish",   img: "buy.jpg" };
  if (usdt < 500) return { emoji: "🐬", label: "Dolphin",img: "buy.jpg" };
  return             { emoji: "🐋", label: "Whale",  img: "buy.jpg" };
}
function fmt(num, dec = 2) {
  return num.toLocaleString(undefined, {
    minimumFractionDigits: dec,
    maximumFractionDigits: dec,
  });
}
async function isEOA(address) {
  return (await provider.getCode(address)) === "0x";
}

/*────────────────────── Update Pools ──────────────────────*/
/**
 * Queries the Uniswap V3 Factory for any new PoolCreated events since `lastFactoryBlock`.
 * For each event where token0===PBTC or token1===PBTC, adds a new Contract to `poolContracts`.
 */
async function updatePools() {
  const currentBlock = await provider.getBlockNumber();

  // Fetch all PoolCreated events from lastFactoryBlock+1 → currentBlock
  const events = await factory.queryFilter(
    "PoolCreated",
    lastFactoryBlock + 1,
    currentBlock
  );

  for (const ev of events) {
    const { token0, token1, pool: poolAddr } = ev.args;
    if (
      token0.toLowerCase() === PBTC_TOKEN_ADDRESS.toLowerCase() ||
      token1.toLowerCase() === PBTC_TOKEN_ADDRESS.toLowerCase()
    ) {
      const normalized = poolAddr.toLowerCase();
      if (!poolContracts[normalized]) {
        // Create a new Contract instance for this pool
        poolContracts[normalized] = new Contract(poolAddr, uniV3PoolAbi, provider);
        console.log(`[Pools] Added PBTC pool: ${poolAddr}`);
      }
    }
  }

  lastFactoryBlock = currentBlock;
}

/*────────────────────── Resolve Buyer Address ──────────────────────*/
/**
 * For a given Swap event `ev`, finds the exact EOA that ultimately received the
 * swapped PBTC. Logic:
 *   1. Compute `swappedPBTC = |-amount0|`.
 *   2. Scan receipt.logs for Transfer(from=POOL_ADDRESS, payload=swappedPBTC) → initialRecipient.
 *   3. If that initialRecipient is an EOA (code === "0x"), return it.
 *   4. Otherwise, “chase” the exact‐value PBTC transfers out of that contract until we hit an EOA.
 *   5. Fallback: return tx.from.
 */
async function resolveBuyer(ev) {
  const txHash  = ev.transactionHash;
  const receipt = await provider.getTransactionReceipt(txHash);

  // How many PBTC moved in that Swap? (always amount0 < 0 for buys on PBTC=token0 pools)
  const swappedPBTC = ev.args.amount0 < 0n ? -ev.args.amount0 : ev.args.amount0;

  // 1. Find the log where the pool address sent exactly `swappedPBTC` to someone
  let initialRecipient = null;
  for (const lg of receipt.logs) {
    // Only consider logs from this pool
    if (
      lg.address.toLowerCase() === ev.address.toLowerCase() && 
      lg.topics[0] === TRANSFER_TOPIC
    ) {
      const { from, to, value } = iface.decodeEventLog("Transfer", lg.data, lg.topics);
      if (
        from.toLowerCase() === ev.address.toLowerCase() &&
        value === swappedPBTC
      ) {
        initialRecipient = to;
        break;
      }
    }
  }

  if (!initialRecipient) {
    // If we couldn’t find a “pool→someone exact” log, fallback to tx.from or recipient
    const tx = await provider.getTransaction(txHash);
    if ((await provider.getCode(tx.from)) === "0x") return getAddress(tx.from);
    if ((await provider.getCode(ev.args.recipient)) === "0x")
      return getAddress(ev.args.recipient);
    return getAddress(tx.from);
  }

  let currentHolder = initialRecipient;

  // 2. If that first recipient is an EOA, return it:
  if ((await provider.getCode(currentHolder)) === "0x") {
    return getAddress(currentHolder);
  }

  // 3. Otherwise, chase down the chain: look for "currentHolder → next" PBTC transfer of exact `swappedPBTC`
  while (true) {
    let nextRecipient = null;
    for (const lg of receipt.logs) {
      if (
        lg.address.toLowerCase() === PBTC_TOKEN_ADDRESS.toLowerCase() &&
        lg.topics[0] === TRANSFER_TOPIC
      ) {
        const { from, to, value } = iface.decodeEventLog("Transfer", lg.data, lg.topics);
        if (
          from.toLowerCase() === currentHolder.toLowerCase() &&
          value === swappedPBTC
        ) {
          nextRecipient = to;
          break;
        }
      }
    }

    if (!nextRecipient) break;
    if ((await provider.getCode(nextRecipient)) === "0x") {
      return getAddress(nextRecipient);
    }
    currentHolder = nextRecipient;
  }

  // 4. Last‐ditch fallback:
  const tx = await provider.getTransaction(txHash);
  return getAddress(tx.from);
}

/* ─────────── Broadcast ─────────── */
async function sendBuy({ buyer, usdt, pbtcAmt, price, txHash }) {
  const mcap  = price * TOTAL_SUPPLY;
  const t     = tier(usdt);

  const short = `${buyer.slice(0, 6)}...${buyer.slice(-4)}`;
  const link  = `https://basescan.org/tx/${txHash}`;

  const inlineKeyboard = [
    [
      {
        text: "📈 Chart",
        url: "https://dexscreener.com/base/0xc3fd337dfc5700565a5444e3b0723920802a426d"
      },
      {
        text: "💵 Buy",
        url: "https://app.uniswap.org/swap?chain=base&inputCurrency=0xfde4c96c8593536e31f229ea8f37b2ada2699bb2&outputCurrency=0x31705474c1f2de7f738e34233c49522ca1e3c53c"
      }
    ]
  ];
  
  const caption =
    `${t.emoji} *New ${t.label} Buy!*\n\n` +
    `👤 [${short}](https://basescan.org/address/${buyer})\n` +
    `💵 *$${fmt(usdt)}* USDT\n` +
    `💰 *${fmt(pbtcAmt, 6)}* PBTC\n` +
    `🏷️ *Price:* $${fmt(price, 6)}\n` +
    `🏷️ *Mcap:* $${fmt(mcap, 0)}\n\n` +
    `🔗 [View on BaseScan](${link})`;

  const pic = path.join(__dirname, "images", t.img);
  for (const chatId of chatIds) {
    await bot.sendPhoto(chatId, pic, {
      caption,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: inlineKeyboard
      }
    });
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`[BuyBot] ${t.label} | $${fmt(usdt)} | ${short} | Pool: ${poolAddr}`);
}


/*────────────────────── Poll Swaps ──────────────────────*/
/**
 * 1. updatePools() → discovers any newly created PBTC pools.  
 * 2. For each pool in poolContracts, query Swap events from lastSwapBlock → currentBlock.  
 * 3. For each BUY (amount0<0 && amount1>0), resolve the buyer, price, and sendBuy().
 */
async function pollSwaps() {
  try {
    const currentBlock = await provider.getBlockNumber();

    // 1. Discover new pools
    await updatePools();

    if (lastSwapBlock === 0) lastSwapBlock = currentBlock - 1;
    const fromBlock = lastSwapBlock + 1;
    const toBlock   = currentBlock;

    // 2. Iterate each known pool
    for (const [poolAddr, poolContract] of Object.entries(poolContracts)) {
      // Fetch Swap events in [fromBlock, toBlock]
      const events = await poolContract.queryFilter("Swap", fromBlock, toBlock);

      for (const ev of events) {
        const { amount0, amount1 } = ev.args;

        // BUY = PBTC out (amount0<0) & Quote→PBTC (amount1>0)
        if (amount0 < 0n && amount1 > 0n) {
          const usdt    = parseFloat(formatUnits(amount1, USDT_DECIMALS));
          if (usdt < MIN_USDT) continue;

          const pbtcAmt = parseFloat(formatUnits(-amount0, PBTC_DECIMALS));
          const price   = usdt / pbtcAmt;
          const buyer   = await resolveBuyer(ev);

          await sendBuy({
            buyer,
            usdt,
            pbtcAmt,
            price,
            txHash: ev.transactionHash,
            poolAddr
          });
        }
      }
    }

    lastSwapBlock = toBlock;
  } catch (err) {
    console.error("Swap poll error:", err.message);
  }
}
setInterval(pollSwaps, 10_000);
console.log("✅ PBTC buy bot polling swaps…");

/* ─────────── HOLDER COUNTER ─────────── */
let known = new Set();
let lastScan = 29988806;

async function updateKnown() {
  const now = await provider.getBlockNumber();
  for (let f = lastScan + 1; f <= now; f += 500) {
    const t = Math.min(f + 499, now);
    const logs = await pbtc.queryFilter("Transfer", f, t);
    logs.forEach((l) => {
      known.add(l.args.from.toLowerCase());
      known.add(l.args.to.toLowerCase());
    });
  }
  lastScan = now;
  known.delete("0x0000000000000000000000000000000000000000");
}
async function holders(reply = null) {
  try {
    await updateKnown();
    let n = 0;
    for (const a of known) {
      try {
        const [bal, st] = await Promise.all([
          pbtc.balanceOf(a),
          staking.staked(a),
        ]);
        if (bal > 0n || st > 0n) n++;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    const msg = `📊 *Current PBTC Holders:* ${n}`;
    (reply ? [reply] : chatIds).forEach((cid) =>
      bot.sendMessage(cid, msg, { parse_mode: "Markdown" })
    );
    console.log(`[HolderBot] Posted ${n}`);
  } catch (e) {
    console.error("Holder track error:", e.message);
  }
}
bot.onText(/\/holders/, (m) => holders(m.chat.id));
setInterval(holders, 6 * 60 * 60 * 1000);
holders();
