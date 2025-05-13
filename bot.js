const { WebSocketProvider, Contract, formatUnits } = require("ethers");
const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const path = require("path");

const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_IDS,
  RPC_URL,
  PRESALE_CONTRACT_ADDRESS,
} = process.env;

// Init Telegram bot
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });

// ABI fragment (minimal for event listening)
const presaleAbi = [
  "event Purchased(address indexed user, uint256 usdtAmount, uint256 pbtcAmount)",
];

// Create provider and contract
const provider = new WebSocketProvider(RPC_URL);
const presaleContract = new Contract(PRESALE_CONTRACT_ADDRESS, presaleAbi, provider);

// Helper: format value
function formatAmount(amount, decimals = 18) {
  return parseFloat(formatUnits(amount, decimals)).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  });
}

// Helper: get tier
function getTier(usdt) {
  if (usdt < 50) return { emoji: "🦐", label: "Shrimp", image: "buy.jpg" };
  if (usdt < 200) return { emoji: "🐟", label: "Fish", image: "buy.jpg" };
  if (usdt < 500) return { emoji: "🐬", label: "Dolphin", image: "buy.jpg" };
  return { emoji: "🐋", label: "Whale", image: "buy.jpg" };
}

// Main event listener
presaleContract.on("Purchased", async (user, usdtAmount, pbtcAmount, event) => {
  try {
    const txHash = event.transactionHash;

    const usdt = parseFloat(formatUnits(usdtAmount, 6));
    const pbtc = formatAmount(pbtcAmount, 18);
    const shortAddr = `${user.slice(0, 6)}...${user.slice(-4)}`;
    const txLink = `https://basescan.org/tx/${txHash}`;

    const totalRaised = parseFloat(formatUnits(await presaleContract.totalRaised(), 6));
    const hardcap = parseFloat(formatUnits(await presaleContract.hardcap(), 6));
    const progressBar = generateProgressBar(totalRaised, hardcap);

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
    }

    console.log(`[BuyBot] ${tier.label} | $${usdt.toFixed(2)} | ${progressBar}`);
  } catch (err) {
    console.error("Error posting buy:", err.message);
  }
});

console.log("✅ Buy bot is listening for PBTC purchases...");
