const { JsonRpcProvider, Contract, formatUnits } = require("ethers");
const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const path = require("path");

const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_IDS,
  RPC_URL,
  PRESALE_CONTRACT_ADDRESS,
  START_BLOCK,
  PBTC_TOKEN_ADDRESS,
  STAKING_CONTRACT_ADDRESS
} = process.env;

// Init Telegram bot
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

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

    const maxRange = 500;
    const start = lastBlock + 1;
    const end = currentBlock;

    for (let fromBlock = start; fromBlock <= end; fromBlock += maxRange) {
      const toBlock = Math.min(fromBlock + maxRange - 1, end);

      const events = await presaleContract.queryFilter("Purchased", fromBlock, toBlock);
      lastBlock = toBlock;

      for (const e of events) {
        const { user, usdtAmount, pbtcAmount } = e.args;
        const txHash = e.transactionHash;
        const usdt = parseFloat(formatUnits(usdtAmount, 6));
        const pbtc = formatAmount(pbtcAmount, 18);

        await broadcastBuy({ user, usdt, pbtc, txHash });
      }
    }
  } catch (err) {
    console.error("Polling error:", err.message);
  }
}


// Start polling
setInterval(pollNewBuys, 10000);
console.log("✅ PBTC buy bot is polling for purchases...");


// Holder tracker setup
// Load staking + token contracts
const stakingAbi = require("./abi/StakingContractABI.json");
const pbtcAbi = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function balanceOf(address) view returns (uint256)"
];

const pbtc = new Contract(PBTC_TOKEN_ADDRESS, pbtcAbi, provider);
const staking = new Contract(STAKING_CONTRACT_ADDRESS, stakingAbi, provider);

let knownAddresses = new Set();

let lastHolderScanBlock = 29988806; // set to PBTC creation block

async function updateKnownHolders() {
  const currentBlock = await provider.getBlockNumber();
  const batchSize = 500;

  console.log(`[HolderBot] Scanning Transfer logs from ${lastHolderScanBlock + 1} to ${currentBlock}...`);

  for (let from = lastHolderScanBlock + 1; from <= currentBlock; from += batchSize) {
    const to = Math.min(from + batchSize - 1, currentBlock);
    const logs = await pbtc.queryFilter("Transfer", from, to);
    for (const log of logs) {
      knownAddresses.add(log.args.from.toLowerCase());
      knownAddresses.add(log.args.to.toLowerCase());
    }
    console.log(`[HolderBot] Scanned blocks ${from}-${to} | Total known: ${knownAddresses.size}`);
  }

  lastHolderScanBlock = currentBlock;
  knownAddresses.delete("0x0000000000000000000000000000000000000000");
}

async function trackHolders(replyChatId = null) {
  try {
    await updateKnownHolders();

    let count = 0;
    for (const addr of knownAddresses) {
      try {
        const [bal, staked] = await Promise.all([
          pbtc.balanceOf(addr),
          staking.staked(addr)
        ]);
        if (bal > 0n || staked > 0n) count++;
      } catch (err) {
        console.warn(`⚠️ Skipping ${addr}: ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, 100)); // slow loop for safety
    }

    const message = `📊 *Current PBTC Holders:* ${count}`;
    const targets = replyChatId ? [replyChatId] : TELEGRAM_CHAT_IDS.split(",");

    for (const chatId of targets) {
      await bot.sendMessage(String(chatId).trim(), message, { parse_mode: "Markdown" });
    }

    console.log(`[HolderBot] Posted: ${count} holders`);
  } catch (err) {
    console.error("Holder tracking error:", err.message);
  }
}

bot.onText(/\/holders/, async (msg) => {
  console.log(`[HolderBot] /holders command from ${msg.chat.username || msg.chat.id}`);
  await trackHolders(msg.chat.id);
});

setInterval(trackHolders, 6 * 60 * 60 * 1000); // once per 6 hours
trackHolders(); // run once on startup
