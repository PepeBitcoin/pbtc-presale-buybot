const { JsonRpcProvider, Contract, formatUnits } = require("ethers");
const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const path = require("path");

const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_IDS,
  RPC_URL,
  PRESALE_CONTRACT_ADDRESS,
  START_BLOCK // optional: set to block to recover from
} = process.env;

// Init Telegram bot
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });

// ABI
const presaleAbi = require("./abi/PresaleABI.json");

// Provider + contract
const provider = new JsonRpcProvider(RPC_URL);
const presaleContract = new Contract(PRESALE_CONTRACT_ADDRESS, presaleAbi, provider);

// Image tiers
function getTier(usdt) {
  if (usdt < 50) return { emoji: "🦐", label: "Shrimp", image: "buy.jpg" };
  if (usdt < 200) return { emoji: "🐟", label: "Fish", image: "buy.jpg" };
  if (usdt < 500) return { emoji: "🐬", label: "Dolphin", image: "buy.jpg" };
  return { emoji: "🐋", label: "Whale", image: "buy.jpg" };
}

// Format values
function formatAmount(amount, decimals = 18) {
  return parseFloat(formatUnits(amount, decimals)).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  });
}

// Progress bar
function generateProgressBar(current, max, barLength = 10) {
  const percent = Math.min(current / max, 1);
  const filledLength = Math.round(barLength * percent);
  const emptyLength = barLength - filledLength;
  const bar = "▰".repeat(filledLength) + "▱".repeat(emptyLength);
  const percentText = `${Math.round(percent * 100)}%`;
  return `${bar} ${percentText}`;
}

// Broadcast buy to all chats
async function broadcastBuy({ user, usdt, pbtc, txHash }) {
  const totalRaised = parseFloat(formatUnits(await presaleContract.totalRaised(), 6));
  const hardcap = parseFloat(formatUnits(await presaleContract.hardcap(), 6));
  const progressBar = generateProgressBar(totalRaised, hardcap);
  const shortAddr = `${user.slice(0, 6)}...${user.slice(-4)}`;
  const txLink = `https://basescan.org/tx/${txHash}`;
  const tier = getTier(usdt);
  const message =
    `${tier.emoji} *New ${tier.label} Buy!*\n\n` +
    `👤 [${shortAddr}](https://basescan.org/address/${user})\n` +
    `💵 *$${usdt.toFixed(2)}* USDT\n` +
    `💰 *${pbtc}* PBTC\n\n` +
    `🎯 *${totalRaised.toLocaleString()} / ${hardcap.toLocaleString()}* USDT raised\n` +
    `${progressBar}\n\n` +
    `🔗 [View on BaseScan](${txLink})`;

  const imagePath = path.join(__dirname, "images", tier.image);
  const chatIds = TELEGRAM_CHAT_IDS.split(",");

  for (const chatId of chatIds) {
    await bot.sendPhoto(chatId.trim(), imagePath, {
      caption: message,
      parse_mode: "Markdown"
    });
    await new Promise(r => setTimeout(r, 300)); // avoid spam throttle
  }

  console.log(`[BuyBot] ${tier.label} | $${usdt.toFixed(2)} | ${progressBar}`);
}

// Track last block seen
let lastBlock = START_BLOCK ? parseInt(START_BLOCK) : 0;

async function pollNewBuys() {
  try {
    const currentBlock = await provider.getBlockNumber();

    if (lastBlock === 0) {
      lastBlock = currentBlock - 1;
    }

    const events = await presaleContract.queryFilter("Purchased", lastBlock + 1, currentBlock);
    lastBlock = currentBlock;

    for (const e of events) {
      const { user, usdtAmount, pbtcAmount } = e.args;
      const txHash = e.transactionHash;
      const usdt = parseFloat(formatUnits(usdtAmount, 6));
      const pbtc = formatAmount(pbtcAmount, 18);

      await broadcastBuy({ user, usdt, pbtc, txHash });
    }
  } catch (err) {
    console.error("Polling error:", err.message);
  }
}

// Start polling
setInterval(pollNewBuys, 10000);
console.log("✅ PBTC buy bot is polling for purchases...");
