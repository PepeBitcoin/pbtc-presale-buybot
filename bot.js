// PBTC Uniswap-V3 Buy-Bot + Holder Counter
// ---------------------------------------
// ENV needed: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_IDS (comma-sep),
//             RPC_URL, START_BLOCK, PBTC_TOKEN_ADDRESS, STAKING_CONTRACT_ADDRESS

const { JsonRpcProvider, Contract, formatUnits } = require("ethers");
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

// ────────────────────────  Telegram  ────────────────────────
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const chatIds = TELEGRAM_CHAT_IDS.split(",").map((c) => c.trim());

// ────────────────────────  Constants  ────────────────────────
const POOL_ADDRESS = "0xc3fd337dfc5700565a5444e3b0723920802a426d"; // PBTC / USDT
const USDT_DECIMALS = 6;
const PBTC_DECIMALS = 18;
const MIN_USDT = 10; // USD threshold

// ────────────────────────  Provider  ────────────────────────
const provider = new JsonRpcProvider(RPC_URL);

// ────────────────────────  Pool ABI  ────────────────────────
const uniV3PoolAbi = [
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
];

// Pool contract
const pool = new Contract(POOL_ADDRESS, uniV3PoolAbi, provider);

// ────────────────────────  Tier Helpers  ────────────────────────
function getTier(usdt) {
  if (usdt < 50) return { emoji: "🦐", label: "Shrimp", image: "buy.jpg" };
  if (usdt < 200) return { emoji: "🐟", label: "Fish", image: "buy.jpg" };
  if (usdt < 500) return { emoji: "🐬", label: "Dolphin", image: "buy.jpg" };
  return { emoji: "🐋", label: "Whale", image: "buy.jpg" };
}

function formatAmount(amount, decimals) {
  return parseFloat(formatUnits(amount, decimals)).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  });
}

// ────────────────────────  Broadcast  ────────────────────────
async function broadcastBuy({ user, usdt, pbtc, txHash }) {
  const tier = getTier(usdt);
  const shortAddr = `${user.slice(0, 6)}...${user.slice(-4)}`;
  const txLink = `https://basescan.org/tx/${txHash}`;

  const caption =
    `${tier.emoji} *New ${tier.label} Buy!*\n\n` +
    `👤 [${shortAddr}](https://basescan.org/address/${user})\n` +
    `💵 *$${usdt.toFixed(2)}* USDT\n` +
    `💰 *${pbtc}* PBTC\n\n` +
    `🔗 [View on BaseScan](${txLink})`;

  const photoPath = path.join(__dirname, "images", tier.image);

  for (const chatId of chatIds) {
    await bot.sendPhoto(chatId, photoPath, {
      caption,
      parse_mode: "Markdown",
    });
    await new Promise((r) => setTimeout(r, 300)); // anti-spam
  }

  console.log(`[BuyBot] ${tier.label} | $${usdt.toFixed(2)} | ${shortAddr}`);
}

// ────────────────────────  Swap Poller  ────────────────────────
let lastBlock = START_BLOCK ? parseInt(START_BLOCK) : 0;

async function pollSwaps() {
  try {
    const current = await provider.getBlockNumber();
    if (lastBlock === 0) lastBlock = current - 1;

    const batch = 500;
    for (let from = lastBlock + 1; from <= current; from += batch) {
      const to = Math.min(from + batch - 1, current);

      const events = await pool.queryFilter("Swap", from, to);
      lastBlock = to;

      for (const ev of events) {
        const { recipient, amount0, amount1 } = ev.args;

        // BUY = USDT in (amount1 > 0) & PBTC out (amount0 < 0)
        if (amount0 < 0n && amount1 > 0n) {
          const usdt = parseFloat(formatUnits(amount1, USDT_DECIMALS));
          if (usdt < MIN_USDT) continue; // below threshold

          const pbtc = formatAmount(-amount0, PBTC_DECIMALS);
          await broadcastBuy({
            user: recipient,
            usdt,
            pbtc,
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
console.log("✅ PBTC buy bot is polling Uniswap swaps…");

// ────────────────────────  Holder Counter  ────────────────────────
const stakingAbi = require("./abi/StakingContractABI.json");
const pbtcAbi = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

const pbtc = new Contract(PBTC_TOKEN_ADDRESS, pbtcAbi, provider);
const staking = new Contract(STAKING_CONTRACT_ADDRESS, stakingAbi, provider);

let knownAddresses = new Set();
let lastHolderScanBlock = 29988806; // PBTC deployment block – update if needed

async function updateKnownHolders() {
  const current = await provider.getBlockNumber();
  const step = 500;

  console.log(`[HolderBot] Scanning blocks ${lastHolderScanBlock + 1} → ${current}…`);

  for (let from = lastHolderScanBlock + 1; from <= current; from += step) {
    const to = Math.min(from + step - 1, current);
    const logs = await pbtc.queryFilter("Transfer", from, to);

    for (const lg of logs) {
      knownAddresses.add(lg.args.from.toLowerCase());
      knownAddresses.add(lg.args.to.toLowerCase());
    }
  }

  lastHolderScanBlock = current;
  knownAddresses.delete("0x0000000000000000000000000000000000000000");
}

async function trackHolders(replyChat = null) {
  try {
    await updateKnownHolders();

    let holders = 0;
    for (const addr of knownAddresses) {
      try {
        const [bal, staked] = await Promise.all([
          pbtc.balanceOf(addr),
          staking.staked(addr),
        ]);
        if (bal > 0n || staked > 0n) holders++;
      } catch (_) {}
      await new Promise((r) => setTimeout(r, 100));
    }

    const msg = `📊 *Current PBTC Holders:* ${holders}`;
    const targets = replyChat ? [replyChat] : chatIds;

    for (const cid of targets) {
      await bot.sendMessage(cid, msg, { parse_mode: "Markdown" });
    }

    console.log(`[HolderBot] Posted count: ${holders}`);
  } catch (err) {
    console.error("Holder tracking error:", err.message);
  }
}

bot.onText(/\/holders/, (msg) => trackHolders(msg.chat.id));

setInterval(trackHolders, 6 * 60 * 60 * 1000); // every 6 h
trackHolders(); // run once on start
