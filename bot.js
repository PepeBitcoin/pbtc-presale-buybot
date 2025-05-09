const { ethers } = require("ethers");
const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const path = require("path");

const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  RPC_URL,
  PRESALE_CONTRACT_ADDRESS,
} = process.env;

// Init Telegram bot
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });

// ABI fragment
const presaleAbi = [
  "event Purchased(address indexed user, uint256 usdtAmount, uint256 pbtcAmount)",
];

// Ethers provider
const provider = new ethers.JsonRpcProvider(RPC_URL);
const presaleContract = new ethers.Contract(
  PRESALE_CONTRACT_ADDRESS,
  presaleAbi,
  provider
);

// Helper: format value
function formatAmount(amount, decimals = 18) {
  return parseFloat(ethers.formatUnits(amount, decimals)).toLocaleString(
    undefined,
    {
      minimumFractionDigits: 2,
      maximumFractionDigits: 6,
    }
  );
}

// Helper: get tier
function getTier(usdt) {
  if (usdt < 50) return { emoji: "🐟", label: "Shrimp", image: "buy.jpg" };
  if (usdt < 200) return { emoji: "🐠", label: "Fish", image: "buy.jpg" };
  if (usdt < 500) return { emoji: "🐬", label: "Dolphin", image: "buy.jpg" };
  return { emoji: "🐋", label: "Whale", image: "buy.jpg" };
}

// Event listener
presaleContract.on("Purchased", async (user, usdtAmount, pbtcAmount, event) => {
  try {
    const usdt = parseFloat(ethers.formatUnits(usdtAmount, 6));
    const pbtc = formatAmount(pbtcAmount, 18);
    const shortAddr = `${user.slice(0, 6)}...${user.slice(-4)}`;
    const txLink = `https://basescan.org/tx/${event.transactionHash}`;

    const tier = getTier(usdt);
    const message = `${tier.emoji} *New ${tier.label} Buy!*\n\n` +
      `👤 [${shortAddr}](https://basescan.org/address/${user})\n` +
      `💵 *$${usdt.toFixed(2)}* USDT\n` +
      `🪙 *${pbtc}* PBTC\n\n` +
      `🔗 [View on BaseScan](${txLink})`;

    const imagePath = path.join(__dirname, "images", tier.image);

    await bot.sendPhoto(TELEGRAM_CHAT_ID, imagePath, {
      caption: message,
      parse_mode: "Markdown",
    });

    console.log(`[BuyBot] Posted ${tier.label} buy: $${usdt.toFixed(2)}`);
  } catch (err) {
    console.error("Error posting buy:", err.message);
  }
});

console.log("✅ Buy bot is listening for PBTC purchases...");
