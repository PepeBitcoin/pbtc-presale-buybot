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
const TRANSFER_TOPIC = id("Transfer(address,address,uint256)");      // keccak256 event sig

/* ─────────── RPC / contracts ─────────── */
const provider = new JsonRpcProvider(RPC_URL);

const uniV3PoolAbi = [
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
];
const pool = new Contract(POOL_ADDRESS, uniV3PoolAbi, provider);

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

/* ─────────── Helper fns ─────────── */
function tier(usdt) {
  if (usdt < 50)  return { emoji: "🦐", label: "Shrimp", img: "BuybotPBTC.gif" };
  if (usdt < 200) return { emoji: "🐟", label: "Fish",   img: "BuybotPBTC.gif" };
  if (usdt < 500) return { emoji: "🐬", label: "Dolphin",img: "BuybotPBTC.gif" };
  return             { emoji: "🐋", label: "Whale",  img: "BuybotPBTC.gif" };
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

/* ─────────── Resolve buyer address (v3, net-balance algorithm) ─────────── */
async function resolveBuyer(ev) {
  const tx       = await provider.getTransaction(ev.transactionHash);
  const receipt  = await provider.getTransactionReceipt(ev.transactionHash);

  // ── Build net PBTC balance map for every address in this tx ──
  const deltas = new Map();      // address → BigInt balance change
  for (const lg of receipt.logs) {
    if (
      lg.address.toLowerCase() !== PBTC_TOKEN_ADDRESS.toLowerCase() ||
      lg.topics[0] !== TRANSFER_TOPIC
    ) continue;

    const { from, to, value } =
      iface.decodeEventLog("Transfer", lg.data, lg.topics);

    deltas.set(from, (deltas.get(from) || 0n) - value);
    deltas.set(to,   (deltas.get(to)   || 0n) + value);
  }

  // ── Pick EOA with the largest positive PBTC gain ──
  let bestAddr  = null;
  let bestDelta = 0n;

  for (const [addr, delta] of deltas) {
    if (delta <= 0n) continue;                 // must be net receiver
    if ((await provider.getCode(addr)) !== "0x") continue; // skip contracts
    if (delta > bestDelta) {
      bestDelta = delta;
      bestAddr  = addr;
    }
  }

  // ── Fallbacks ──
  if (bestAddr)                         return getAddress(bestAddr); // ✅
  if ((await provider.getCode(tx.from)) === "0x") return getAddress(tx.from);
  if ((await provider.getCode(ev.args.recipient)) === "0x")
                                           return getAddress(ev.args.recipient);
  return getAddress(tx.from);            // last-ditch (contract) fallback
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
        url: "https://www.pepe-bitcoin.com/#/buy"
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

  const animationPath = path.join(__dirname, "images", t.img);
  for (const chatId of chatIds) {
    await bot.sendAnimation(chatId, animationPath, {
      caption,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: inlineKeyboard
      }
    });
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`[BuyBot] ${t.label} | $${fmt(usdt)} | ${short}`);
}


/* ─────────── Swap poller ─────────── */
let lastBlock = START_BLOCK ? Number(START_BLOCK) : 0;

async function pollSwaps() {
  try {
    const current = await provider.getBlockNumber();
    if (lastBlock === 0) lastBlock = current - 1;

    const step = 500;
    for (let from = lastBlock + 1; from <= current; from += step) {
      const to = Math.min(from + step - 1, current);
      const events = await pool.queryFilter("Swap", from, to);
      lastBlock = to;

      for (const ev of events) {
        const { amount0, amount1 } = ev.args;

        // PBTC out (amount0 < 0) & USDT in (amount1 > 0)
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
          });
        }
      }
    }
  } catch (err) {
    console.error("Swap poll error:", err.message);
  }
}
setInterval(pollSwaps, 10_000);
console.log("✅ PBTC buy bot polling swaps…");

/* ─────────── HOLDER COUNTER (unchanged) ─────────── */
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
