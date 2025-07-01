#!/usr/bin/env node

// Platform Wallet Setup Script
// Run this to configure your platform wallet for REAL GOR transactions

import {
  Keypair,
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import bs58 from "bs58";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { writeFileSync } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const GORBAGANA_RPC = "https://rpc.gorbagana.wtf/";
const connection = new Connection(GORBAGANA_RPC, "processed");

console.log("🔧 PLATFORM WALLET SETUP FOR REAL GOR TRANSACTIONS");
console.log("==================================================");

async function main() {
  try {
    // Generate a new wallet
    const newWallet = Keypair.generate();
    const privateKey = bs58.encode(newWallet.secretKey);
    const publicKey = newWallet.publicKey.toBase58();

    console.log(`🔑 Generated new platform wallet:`);
    console.log(`   Public Key:  ${publicKey}`);
    console.log(`   Private Key: ${privateKey}`);
    console.log();

    // Check balance
    console.log("💰 Checking wallet balance...");
    const balance = await connection.getBalance(newWallet.publicKey);
    const gorBalance = balance / Math.pow(10, 9); // 9 decimals like SOL

    console.log(`   Balance: ${gorBalance} GOR`);
    console.log();

    // Create .env file
    const envContent = `# Platform Wallet Configuration
# This wallet will be used to distribute prizes to winners
PLATFORM_PRIVATE_KEY=${privateKey}

# Optional: Set to 'production' to disable mock mode
NODE_ENV=development
`;

    const envPath = join(__dirname, "..", ".env");
    writeFileSync(envPath, envContent);

    console.log("📄 Created .env file with platform wallet configuration");
    console.log(`   File: ${envPath}`);
    console.log();

    if (gorBalance === 0) {
      console.log("⚠️  IMPORTANT NEXT STEPS:");
      console.log("   1. Fund this wallet with GOR tokens");
      console.log(`   2. Send GOR to: ${publicKey}`);
      console.log("   3. Restart your server");
      console.log("   4. Test with real transactions!");
      console.log();
      console.log("💡 You can get GOR tokens from:");
      console.log("   - Gorbagana faucet");
      console.log("   - DEX exchanges");
      console.log("   - Other wallets");
    } else {
      console.log("✅ Wallet already has GOR! Ready for real transactions.");
      console.log(
        "   Restart your server to start using real blockchain transactions."
      );
    }

    console.log();
    console.log("🚀 Setup complete! No more mock transactions!");
  } catch (error) {
    console.error("❌ Setup failed:", error);
    process.exit(1);
  }
}

main();
