// Real Blockchain Prize Distribution System
// Replaces the fake logging with actual GOR transfers

import dotenv from "dotenv";
dotenv.config(); // 🚨 CRITICAL: Load environment variables first!

import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  Keypair,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import bs58 from "bs58";

// Gorbagana Network Configuration
const GORBAGANA_RPC = "https://rpc.gorbagana.wtf/";
const connection = new Connection(GORBAGANA_RPC, "processed");

// Platform wallet for signing transactions (should be environment variable)
const PLATFORM_PRIVATE_KEY = process.env.PLATFORM_PRIVATE_KEY || ""; // JSON array or base58 encoded private key
let platformWallet = null;

console.log("🔍 [blockchain-rewards] Environment check on import:");
console.log(
  `   PLATFORM_PRIVATE_KEY exists: ${!!process.env.PLATFORM_PRIVATE_KEY}`
);
console.log(
  `   PLATFORM_PRIVATE_KEY length: ${
    process.env.PLATFORM_PRIVATE_KEY?.length || 0
  }`
);

// Initialize platform wallet
function initializePlatformWallet() {
  console.log("🔍 [blockchain-rewards] Checking PLATFORM_PRIVATE_KEY...");
  console.log(
    `   Environment variable exists: ${!!process.env.PLATFORM_PRIVATE_KEY}`
  );
  console.log(
    `   Variable length: ${process.env.PLATFORM_PRIVATE_KEY?.length || 0}`
  );

  if (!PLATFORM_PRIVATE_KEY) {
    console.log(
      "❌ [blockchain-rewards] No PLATFORM_PRIVATE_KEY found in environment"
    );
    console.log("🔑 Platform wallet will be initialized when needed");
    return null;
  }

  try {
    let secretKey;

    // Try JSON format first (array of numbers)
    if (PLATFORM_PRIVATE_KEY.startsWith("[")) {
      console.log(
        "📋 [blockchain-rewards] Parsing JSON array format private key"
      );
      const privateKeyBytes = JSON.parse(PLATFORM_PRIVATE_KEY);
      secretKey = new Uint8Array(privateKeyBytes);
    } else {
      console.log("📋 [blockchain-rewards] Parsing base58 format private key");
      // Try base58 format
      secretKey = bs58.decode(PLATFORM_PRIVATE_KEY);
    }

    platformWallet = Keypair.fromSecretKey(secretKey);
    console.log(
      `✅ [blockchain-rewards] Platform wallet loaded: ${platformWallet.publicKey.toBase58()}`
    );
    return platformWallet;
  } catch (error) {
    console.error(
      "❌ [blockchain-rewards] Failed to load platform wallet:",
      error
    );
    console.error(
      "   Make sure PLATFORM_PRIVATE_KEY is in correct format (JSON array or base58)"
    );
    return null;
  }
}

// Convert GOR to lamports (9 decimal places like SOL)
function gorToLamports(gorAmount) {
  return Math.floor(gorAmount * Math.pow(10, 9));
}

// Create a GOR transfer transaction
async function createGorTransferTransaction(
  fromWallet,
  toWalletAddress,
  gorAmount
) {
  try {
    const toPublicKey = new PublicKey(toWalletAddress);
    const lamports = gorToLamports(gorAmount);

    const transaction = new Transaction();

    // Add transfer instruction
    const transferInstruction = SystemProgram.transfer({
      fromPubkey: fromWallet.publicKey,
      toPubkey: toPublicKey,
      lamports: lamports,
    });

    transaction.add(transferInstruction);

    // Get recent blockhash
    const { blockhash } = await connection.getLatestBlockhash("processed");
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = fromWallet.publicKey;

    return transaction;
  } catch (error) {
    console.error("❌ Error creating transfer transaction:", error);
    throw error;
  }
}

// Send and confirm a transaction with retry logic
async function sendAndConfirmTransaction(transaction, wallet, maxRetries = 5) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(
        `📡 Sending transaction (attempt ${attempt}/${maxRetries})...`
      );

      // Sign the transaction
      transaction.sign(wallet);

      // Send transaction
      const signature = await connection.sendRawTransaction(
        transaction.serialize(),
        {
          skipPreflight: false,
          preflightCommitment: "processed",
          maxRetries: 3,
        }
      );

      console.log(`📡 Transaction sent: ${signature}`);

      // Wait for confirmation
      const confirmation = await connection.confirmTransaction(
        signature,
        "processed"
      );

      if (confirmation.value.err) {
        throw new Error(`Transaction failed: ${confirmation.value.err}`);
      }

      console.log(`✅ Transaction confirmed: ${signature}`);
      return signature;
    } catch (error) {
      console.warn(`⚠️ Transaction attempt ${attempt} failed:`, error);

      if (attempt === maxRetries) {
        throw error;
      }

      // Wait before retry
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
}

// Distribute prizes to multiple winners
export async function distributePrizes(winners) {
  console.log("🏆 STARTING REAL PRIZE DISTRIBUTION");
  console.log("===================================");

  // Initialize platform wallet if not done
  if (!platformWallet) {
    platformWallet = initializePlatformWallet();
    if (!platformWallet) {
      console.log("🚀 Initializing platform wallet for prize distribution");
      platformWallet = initializePlatformWallet();
      if (!platformWallet) {
        return mockDistributePrizes(winners);
      }
    }
  }

  const results = [];

  for (const winner of winners) {
    try {
      console.log(
        `💰 Distributing ${winner.prize} GOR to ${winner.wallet.slice(0, 8)}...`
      );

      // Create transfer transaction
      const transaction = await createGorTransferTransaction(
        platformWallet,
        winner.wallet,
        winner.prize
      );

      // Send and confirm transaction
      const signature = await sendAndConfirmTransaction(
        transaction,
        platformWallet
      );

      const result = {
        rank: winner.rank,
        wallet: winner.wallet,
        prize: winner.prize,
        success: true,
        signature: signature,
        timestamp: new Date().toISOString(),
      };

      results.push(result);
      console.log(
        `✅ Prize distributed: ${winner.prize} GOR → ${winner.wallet.slice(
          0,
          8
        )}... (${signature})`
      );
    } catch (error) {
      console.error(
        `❌ Failed to distribute prize to ${winner.wallet.slice(0, 8)}...:`,
        error
      );

      const result = {
        rank: winner.rank,
        wallet: winner.wallet,
        prize: winner.prize,
        success: false,
        error: error.message,
        timestamp: new Date().toISOString(),
      };

      results.push(result);
    }
  }

  // Summary
  const successful = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  console.log(`📊 DISTRIBUTION SUMMARY:`);
  console.log(`   ✅ Successful: ${successful.length}/${winners.length}`);
  console.log(`   ❌ Failed: ${failed.length}/${winners.length}`);
  console.log(
    `   💰 Total distributed: ${successful.reduce(
      (sum, r) => sum + r.prize,
      0
    )} GOR`
  );

  return results;
}

// Mock distribution for testing (when no platform wallet)
function mockDistributePrizes(winners) {
  console.log("❌ NO PLATFORM WALLET - CANNOT SEND REAL TRANSACTIONS");
  console.log("=======================================================");
  console.log("⚠️  TO ENABLE REAL TRANSACTIONS:");
  console.log("   1. Set PLATFORM_PRIVATE_KEY environment variable");
  console.log("   2. Fund the platform wallet with GOR tokens");
  console.log("   3. Restart the server");
  console.log("=======================================================");

  const results = winners.map((winner) => {
    console.log(
      `💸 WOULD SEND ${winner.prize} GOR to ${winner.wallet.slice(
        0,
        8
      )}... (BUT CAN'T - NO WALLET)`
    );

    return {
      rank: winner.rank,
      wallet: winner.wallet,
      prize: winner.prize,
      success: false,
      error: "No platform wallet configured - set PLATFORM_PRIVATE_KEY",
      signature: null,
      timestamp: new Date().toISOString(),
      mock: true,
    };
  });

  console.log(
    `❌ MOCK FAILURE: ${results.length} prizes NOT distributed - NO PLATFORM WALLET`
  );
  return results;
}

// Single prize distribution (for individual winners)
export async function distributeSinglePrize(
  wallet,
  gorAmount,
  reason = "Game Prize"
) {
  console.log(
    `💰 Distributing single prize: ${gorAmount} GOR to ${wallet.slice(
      0,
      8
    )}... (${reason})`
  );

  const winners = [
    {
      rank: 1,
      wallet: wallet,
      prize: gorAmount,
    },
  ];

  const results = await distributePrizes(winners);
  return results[0];
}

// Check platform wallet balance
export async function checkPlatformBalance() {
  if (!platformWallet) {
    platformWallet = initializePlatformWallet();
    if (!platformWallet) {
      return { success: false, error: "No platform wallet configured" };
    }
  }

  try {
    const balance = await connection.getBalance(platformWallet.publicKey);
    const gorBalance = balance / Math.pow(10, 9);

    console.log(`🏦 Platform wallet balance: ${gorBalance} GOR`);
    return {
      success: true,
      balance: gorBalance,
      lamports: balance,
      wallet: platformWallet.publicKey.toBase58(),
    };
  } catch (error) {
    console.error("❌ Error checking platform balance:", error);
    return { success: false, error: error.message };
  }
}

// Initialize on import
initializePlatformWallet();
