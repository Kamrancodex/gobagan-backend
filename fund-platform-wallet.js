import dotenv from "dotenv";
import {
  Connection,
  PublicKey,
  Keypair,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import bs58 from "bs58";

// Load environment variables
dotenv.config();

// Gorbagana Testnet configuration
const RPC_URL =
  process.env.NEXT_PUBLIC_RPC_URL ||
  process.env.GORBAGANA_RPC_URL ||
  "https://rpc.gorbagana.wtf/";
const connection = new Connection(RPC_URL, "confirmed");

console.log(`🔗 Using RPC: ${RPC_URL}`);

function initializePlatformWallet() {
  const privateKeyString = process.env.PLATFORM_PRIVATE_KEY;
  if (!privateKeyString) {
    console.error("❌ PLATFORM_PRIVATE_KEY not found in environment variables");
    return null;
  }

  try {
    let secretKey;

    // Try JSON format first (array of numbers)
    if (privateKeyString.startsWith("[")) {
      const privateKeyBytes = JSON.parse(privateKeyString);
      secretKey = new Uint8Array(privateKeyBytes);
    } else {
      // Try base58 format
      secretKey = bs58.decode(privateKeyString);
    }

    const platformWallet = Keypair.fromSecretKey(secretKey);
    console.log(
      `✅ Platform wallet loaded: ${platformWallet.publicKey.toBase58()}`
    );
    return platformWallet;
  } catch (error) {
    console.error("❌ Failed to parse platform private key:", error);
    console.error(
      "   Make sure PLATFORM_PRIVATE_KEY is in correct format (JSON array or base58)"
    );
    return null;
  }
}

async function checkPlatformBalance() {
  const platformWallet = initializePlatformWallet();
  if (!platformWallet) {
    return null;
  }

  try {
    const balance = await connection.getBalance(platformWallet.publicKey);
    const balanceGOR = balance / Math.pow(10, 9);

    console.log("\n🏦 PLATFORM WALLET STATUS");
    console.log("========================");
    console.log(`Address: ${platformWallet.publicKey.toBase58()}`);
    console.log(`Balance: ${balanceGOR.toFixed(6)} GOR`);

    return {
      address: platformWallet.publicKey.toBase58(),
      balance: balanceGOR,
      wallet: platformWallet,
    };
  } catch (error) {
    console.error("❌ Failed to check platform balance:", error);
    return null;
  }
}

async function fundPlatformWallet(sourcePrivateKey, amount) {
  console.log(`\n💰 FUNDING PLATFORM WALLET WITH ${amount} GOR`);
  console.log("================================================");

  const platformWallet = initializePlatformWallet();
  if (!platformWallet) {
    return false;
  }

  try {
    // Parse source wallet private key (handle both JSON and base58 formats)
    let sourceSecretKey;
    if (sourcePrivateKey.startsWith("[")) {
      // JSON array format
      const sourceKeyBytes = JSON.parse(sourcePrivateKey);
      sourceSecretKey = new Uint8Array(sourceKeyBytes);
    } else {
      // Base58 format
      sourceSecretKey = bs58.decode(sourcePrivateKey);
    }
    const sourceWallet = Keypair.fromSecretKey(sourceSecretKey);

    console.log(`Source wallet: ${sourceWallet.publicKey.toBase58()}`);
    console.log(`Target wallet: ${platformWallet.publicKey.toBase58()}`);

    // Check source wallet balance
    const sourceBalance = await connection.getBalance(sourceWallet.publicKey);
    const sourceBalanceGOR = sourceBalance / Math.pow(10, 9);
    console.log(`Source balance: ${sourceBalanceGOR.toFixed(6)} GOR`);

    if (sourceBalanceGOR < amount) {
      console.error(
        `❌ Insufficient source balance! Need ${amount} GOR, have ${sourceBalanceGOR.toFixed(
          6
        )} GOR`
      );
      return false;
    }

    // Create transfer transaction
    const transaction = new Transaction();
    const transferAmount = amount * Math.pow(10, 9); // Convert GOR to lamports

    const transferInstruction = SystemProgram.transfer({
      fromPubkey: sourceWallet.publicKey,
      toPubkey: platformWallet.publicKey,
      lamports: transferAmount,
    });

    transaction.add(transferInstruction);

    // Get recent blockhash
    const { blockhash } = await connection.getLatestBlockhash("processed");
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = sourceWallet.publicKey;

    // Sign and send transaction
    transaction.sign(sourceWallet);
    const signature = await connection.sendRawTransaction(
      transaction.serialize(),
      {
        skipPreflight: false,
        preflightCommitment: "processed",
      }
    );

    console.log(`📝 Transaction sent: ${signature}`);

    // Confirm transaction
    console.log("⏳ Confirming transaction...");
    const confirmation = await connection.confirmTransaction(
      signature,
      "processed"
    );

    if (confirmation.value.err) {
      console.error("❌ Transaction failed:", confirmation.value.err);
      return false;
    }

    console.log("✅ Transfer successful!");

    // Check new balance
    await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait 2 seconds
    const newBalance = await connection.getBalance(platformWallet.publicKey);
    const newBalanceGOR = newBalance / Math.pow(10, 9);
    console.log(`💰 New platform balance: ${newBalanceGOR.toFixed(6)} GOR`);

    return true;
  } catch (error) {
    console.error("❌ Failed to fund platform wallet:", error);
    return false;
  }
}

// Command line interface
const args = process.argv.slice(2);
const command = args[0];

if (command === "balance") {
  checkPlatformBalance();
} else if (command === "fund") {
  const sourcePrivateKey = args[1];
  const amount = parseFloat(args[2]);

  if (!sourcePrivateKey || !amount) {
    console.log(
      "Usage: node fund-platform-wallet.js fund <source_private_key_json> <amount_gor>"
    );
    console.log("Example: node fund-platform-wallet.js fund '[1,2,3,...]' 5.0");
  } else {
    fundPlatformWallet(sourcePrivateKey, amount);
  }
} else {
  console.log("\n🏦 PLATFORM WALLET FUNDING TOOL");
  console.log("================================");
  console.log("Commands:");
  console.log("  node fund-platform-wallet.js balance");
  console.log(
    "  node fund-platform-wallet.js fund <source_private_key> <amount>"
  );
  console.log("\nExample:");
  console.log("  node fund-platform-wallet.js fund '[1,2,3,...]' 5.0");
  console.log("");

  // Show current balance
  await checkPlatformBalance();
}
