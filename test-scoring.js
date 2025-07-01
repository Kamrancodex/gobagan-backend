// Test script to verify scoring and prize distribution
// Run with: node test-scoring.js

import {
  distributeSmartContractRewards,
  getMockBalanceForWallet,
  updateMockBalanceForWallet,
} from "./smart-contract-integration.js";

console.log("🧪 TESTING SCORING AND PRIZE DISTRIBUTION");
console.log("==========================================");

// Test data: simulate an orb collector game with 4 players
const testGameId = "test-game-123";
const testPlayers = [
  { wallet: "Player1Wallet111111111111111111111111", score: 150, betAmount: 2 },
  { wallet: "Player2Wallet222222222222222222222222", score: 120, betAmount: 2 },
  { wallet: "Player3Wallet333333333333333333333333", score: 90, betAmount: 2 },
  { wallet: "Player4Wallet444444444444444444444444", score: 150, betAmount: 2 }, // Tie for first!
];

// Calculate prize distribution
const totalBetPool = testPlayers.reduce((sum, p) => sum + p.betAmount, 0);
const platformFee = totalBetPool * 0.05;
const prizePool = totalBetPool - platformFee;

console.log(`💰 Total bet pool: ${totalBetPool} GOR`);
console.log(`💸 Platform fee (5%): ${platformFee} GOR`);
console.log(`🏆 Prize pool: ${prizePool} GOR`);

// Sort players by score (highest first)
const sortedPlayers = testPlayers.sort((a, b) => b.score - a.score);
console.log("\n📊 Players sorted by score:");
sortedPlayers.forEach((player, index) => {
  console.log(
    `  ${index + 1}. ${player.wallet.slice(0, 8)}... - ${player.score} points`
  );
});

// Determine winners
const maxScore = Math.max(...sortedPlayers.map((p) => p.score));
const topPlayers = sortedPlayers.filter((p) => p.score === maxScore);

console.log(`\n🎯 Max score: ${maxScore} points`);
console.log(`🏆 Number of winners: ${topPlayers.length}`);

let winners = [];

if (maxScore === 0) {
  // No winner scenario - return bets
  winners = testPlayers.map((player, index) => ({
    rank: index + 1,
    wallet: player.wallet,
    prize: player.betAmount,
    reason: "bet_refund",
  }));
  console.log("🤝 NO WINNER SCENARIO - Returning all bets");
} else if (topPlayers.length === 1) {
  // Clear winner
  const winner = topPlayers[0];
  winners = [
    {
      rank: 1,
      wallet: winner.wallet,
      prize: parseFloat(prizePool.toFixed(6)),
      reason: "winner_takes_all",
    },
  ];
  console.log(
    `🏆 CLEAR WINNER: ${winner.wallet.slice(
      0,
      8
    )}... takes all ${prizePool.toFixed(2)} GOR`
  );
} else {
  // Tie scenario - split prize
  const prizePerPlayer = prizePool / topPlayers.length;
  winners = topPlayers.map((player) => ({
    rank: 1,
    wallet: player.wallet,
    prize: parseFloat(prizePerPlayer.toFixed(6)),
    reason: "tie_split",
  }));
  console.log(
    `🤝 TIE SCENARIO: ${topPlayers.length} players split ${prizePool.toFixed(
      2
    )} GOR`
  );
  console.log(`   Each winner gets: ${prizePerPlayer.toFixed(2)} GOR`);
}

// Test mock balance management
console.log("\n💰 Testing mock balance management:");

// Check initial balances
console.log("\n📋 Initial mock balances:");
for (const player of testPlayers) {
  const balance = getMockBalanceForWallet(player.wallet);
  console.log(`   ${player.wallet.slice(0, 8)}...: ${balance.toFixed(2)} GOR`);
}

// Deduct entry fees
console.log("\n💸 Deducting entry fees:");
for (const player of testPlayers) {
  const newBalance = updateMockBalanceForWallet(
    player.wallet,
    -player.betAmount
  );
  console.log(
    `   ${player.wallet.slice(0, 8)}...: -${
      player.betAmount
    } GOR → ${newBalance.toFixed(2)} GOR`
  );
}

// Test prize distribution
async function testPrizeDistribution() {
  try {
    console.log("\n🚀 Testing prize distribution...");

    // Set mock mode
    process.env.NODE_ENV = "development";
    delete process.env.PLATFORM_PRIVATE_KEY; // Force mock mode

    const results = await distributeSmartContractRewards(testGameId, winners);

    console.log("\n✅ Prize distribution results:");
    results.forEach((result) => {
      if (result.success) {
        console.log(
          `   ✅ ${result.wallet.slice(0, 8)}...: +${result.prize} GOR (${
            result.signature
          })`
        );
      } else {
        console.log(
          `   ❌ ${result.wallet.slice(0, 8)}...: FAILED - ${result.error}`
        );
      }
    });

    // Check final balances
    console.log("\n📋 Final mock balances:");
    for (const player of testPlayers) {
      const balance = getMockBalanceForWallet(player.wallet);
      console.log(
        `   ${player.wallet.slice(0, 8)}...: ${balance.toFixed(2)} GOR`
      );
    }

    // Verify the math
    console.log("\n🧮 Verification:");
    const successfulDistributions = results.filter((r) => r.success);
    const totalDistributed = successfulDistributions.reduce(
      (sum, r) => sum + r.prize,
      0
    );
    console.log(`   Total distributed: ${totalDistributed.toFixed(2)} GOR`);
    console.log(`   Expected prize pool: ${prizePool.toFixed(2)} GOR`);
    console.log(
      `   Match: ${
        Math.abs(totalDistributed - prizePool) < 0.01 ? "✅ YES" : "❌ NO"
      }`
    );
  } catch (error) {
    console.error("❌ Test failed:", error);
  }
}

// Run the test
testPrizeDistribution()
  .then(() => {
    console.log("\n🎉 Test completed!");
    process.exit(0);
  })
  .catch((error) => {
    console.error("💥 Test crashed:", error);
    process.exit(1);
  });
