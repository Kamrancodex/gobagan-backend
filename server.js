import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";

// Load environment variables for REAL transactions
dotenv.config();
import { Connection, PublicKey } from "@solana/web3.js";
import {
  connectDB,
  User,
  GameMatch,
  getOrCreateUser,
  updateUserStats,
  getLeaderboard,
  getRecentMatches,
} from "./models.js";
import {
  distributePrizes,
  distributeSinglePrize,
  checkPlatformBalance,
} from "./blockchain-rewards.js";
import {
  distributeSmartContractRewards,
  initializeGame as initSmartContractGame,
  getGameState as getSmartContractGameState,
  validateEntryFeePayment,
  collectEntryFeeToEscrow,
  collectValidatedEntryFee,
  ensurePlatformBalance,
} from "./smart-contract-integration.js";
// WordGridRoom with blockchain integration
class WordGridRoom {
  constructor(roomId, betAmount = 1, password = null, creatorWallet = null) {
    this.roomId = roomId;
    this.betAmount = betAmount;
    this.password = password;
    this.creatorWallet = creatorWallet;
    this.maxPlayers = 2;
    this.players = [];
    this.gamePhase = "waiting"; // waiting, betting, countdown, playing, finished
    this.currentPlayer = null;
    this.gameStartTime = null;
    this.totalGameTime = 150; // 150 seconds (2.5 minutes) TOTAL per player for entire game

    // 8x8 word grid
    this.grid = Array(64)
      .fill(null)
      .map(() => ({
        letter: "",
        playerId: null,
        isNewWord: false,
      }));

    this.wordHistory = [];
    this.moveHistory = [];
    this.foundWords = new Set();
    this.totalEscrowed = 0;
    this.validatedTransactions = [];

    console.log(
      `🔤 Created Word Grid room: ${roomId} with bet ${betAmount} GOR`
    );
  }

  verifyPassword(inputPassword) {
    if (!this.password) return true;
    return this.password === inputPassword;
  }

  async addPlayer(playerId, socketId, wallet, betAmount = null) {
    if (this.players.length >= this.maxPlayers) {
      throw new Error("Room is full");
    }

    if (!wallet || typeof wallet !== "string" || wallet.trim() === "") {
      throw new Error("Valid wallet address is required");
    }

    const existingPlayer = this.players.find((p) => p.wallet === wallet);
    if (existingPlayer) {
      throw new Error("Player already in room");
    }

    const finalBetAmount = betAmount || this.betAmount;
    const nickname = wallet.length >= 8 ? `${wallet.slice(0, 8)}...` : wallet;

    const player = {
      id: playerId,
      socketId: socketId,
      wallet: wallet,
      nickname: nickname,
      betAmount: finalBetAmount,
      score: 0,
      timeRemaining: this.totalGameTime,
      isActive: false,
      hasPaid: false,
      paymentConfirmed: false,
      txSignature: null,
      actualPaidAmount: 0,
      wordsFound: [],
      totalLettersPlaced: 0,
      longestWord: 0,
      isCreator: wallet === this.creatorWallet,
    };

    this.players.push(player);

    console.log(
      `🔤 Player ${wallet.slice(0, 8)}... joined Word Grid room ${
        this.roomId
      } (${this.players.length}/${this.maxPlayers})`
    );

    // If room is full, enter betting phase
    if (this.players.length === this.maxPlayers) {
      this.gamePhase = "betting";
      console.log(`💰 Word Grid room ${this.roomId} entering betting phase`);
    }

    return this.getGameState();
  }

  async confirmPayment(playerId, txSignature) {
    const player = this.players.find((p) => p.id === playerId);
    if (!player) {
      throw new Error("Player not found");
    }

    try {
      console.log(
        `🔍 [WordGrid] Verifying payment for player ${player.wallet.slice(
          0,
          8
        )}...`
      );
      console.log(`   Transaction: ${txSignature}`);
      console.log(`   Expected amount: ${player.betAmount} GOR`);

      // Verify the blockchain transaction
      const verification =
        await smartContractIntegration.validateEntryFeePayment(
          player.wallet,
          this.roomId,
          txSignature
        );

      if (verification.success) {
        console.log(
          `✅ [WordGrid] Payment verified! Amount: ${verification.actualAmount} GOR`
        );

        // Collect the validated entry fee
        const escrowResult =
          await smartContractIntegration.collectValidatedEntryFee(
            player.wallet,
            verification.actualAmount,
            this.roomId,
            txSignature
          );

        if (escrowResult.success) {
          // Mark payment as confirmed
          player.hasPaid = true;
          player.paymentConfirmed = true;
          player.txSignature = txSignature;
          player.actualPaidAmount = verification.actualAmount;

          console.log(
            `🏦 [WordGrid] Escrow updated: ${escrowResult.escrowBalance} GOR in room ${this.roomId}`
          );

          // Check if all players have paid
          if (this.players.every((p) => p.hasPaid)) {
            console.log(`🚀 All Word Grid players paid - starting countdown`);
            this.gamePhase = "countdown";
            this.startCountdown();
          }

          return { success: true, verified: true };
        } else {
          throw new Error("Failed to collect entry fee to escrow");
        }
      } else {
        throw new Error(
          verification.error || "Transaction verification failed"
        );
      }
    } catch (error) {
      console.error(`❌ [WordGrid] Payment confirmation error:`, error);
      throw error;
    }
  }

  startCountdown() {
    let countdown = 10;
    console.log(`⏱️ Word Grid countdown started: ${countdown} seconds`);

    const countdownInterval = setInterval(() => {
      countdown--;
      console.log(`⏱️ Word Grid countdown: ${countdown} seconds remaining`);

      if (countdown <= 0) {
        clearInterval(countdownInterval);
        this.startGame();
      }
    }, 1000);
  }

  startGame() {
    this.gamePhase = "playing";
    this.gameStartTime = Date.now();
    this.currentPlayer = this.players[0].id; // Player 1 starts

    // Generate the word grid
    this.generateGrid();

    console.log(`🎮 Word Grid game started in room ${this.roomId}`);
    console.log(`🎯 Current player: ${this.currentPlayer}`);
  }

  generateGrid() {
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

    // Use common letters more frequently
    const weightedLetters = "AEIOURSTLNBCDFGHJKMPQVWXYZ";

    for (let i = 0; i < 64; i++) {
      this.grid[i] = {
        letter:
          weightedLetters[Math.floor(Math.random() * weightedLetters.length)],
        playerId: null,
        isNewWord: false,
      };
    }
  }

  placeLetter(playerId, cellIndex, letter) {
    if (this.gamePhase !== "playing") {
      throw new Error("Game is not in playing state");
    }

    if (this.currentPlayer !== playerId) {
      throw new Error("Not your turn");
    }

    if (cellIndex < 0 || cellIndex >= 64) {
      throw new Error("Invalid cell index");
    }

    const player = this.players.find((p) => p.id === playerId);
    if (!player) {
      throw new Error("Player not found");
    }

    if (player.timeRemaining <= 0) {
      throw new Error("No time remaining");
    }

    // Place the letter
    this.grid[cellIndex] = {
      letter: letter.toUpperCase(),
      playerId: playerId,
      isNewWord: false,
    };

    player.totalLettersPlaced++;

    // Check for new words formed
    const newWords = this.findWordsFromPosition(cellIndex);

    if (newWords.length > 0) {
      newWords.forEach((wordInfo) => {
        if (!this.foundWords.has(wordInfo.word)) {
          this.foundWords.add(wordInfo.word);
          player.wordsFound.push(wordInfo.word);
          player.score += wordInfo.word.length;

          if (wordInfo.word.length > player.longestWord) {
            player.longestWord = wordInfo.word.length;
          }

          console.log(
            `✅ New word found by ${player.wallet.slice(0, 8)}: ${
              wordInfo.word
            } (+${wordInfo.word.length} points)`
          );
        }
      });
    }

    // Switch turns (time-based)
    this.switchTurn();
  }

  findWordsFromPosition(cellIndex) {
    // Simplified word detection - in production, use a dictionary
    const words = [];
    const gridSize = 8;
    const row = Math.floor(cellIndex / gridSize);
    const col = cellIndex % gridSize;

    // Check horizontal and vertical words of length 3-8
    const directions = [
      [0, 1], // horizontal
      [1, 0], // vertical
      [1, 1], // diagonal down-right
      [1, -1], // diagonal down-left
    ];

    directions.forEach(([dRow, dCol]) => {
      for (let len = 3; len <= 8; len++) {
        let word = "";
        let valid = true;

        for (let i = 0; i < len; i++) {
          const checkRow = row + dRow * i;
          const checkCol = col + dCol * i;

          if (
            checkRow < 0 ||
            checkRow >= gridSize ||
            checkCol < 0 ||
            checkCol >= gridSize
          ) {
            valid = false;
            break;
          }

          const checkIndex = checkRow * gridSize + checkCol;
          const cell = this.grid[checkIndex];

          if (!cell.letter) {
            valid = false;
            break;
          }

          word += cell.letter;
        }

        if (valid && word.length >= 3) {
          // Simple word validation (in production, use a real dictionary)
          const commonWords = [
            "THE",
            "AND",
            "FOR",
            "ARE",
            "BUT",
            "NOT",
            "YOU",
            "ALL",
            "CAN",
            "HER",
            "WAS",
            "ONE",
            "OUR",
            "HAD",
            "DAY",
            "GET",
            "USE",
            "MAN",
            "NEW",
            "NOW",
            "WAY",
            "MAY",
            "SAY",
          ];
          if (commonWords.includes(word) && word.length >= 3) {
            words.push({
              word,
              cells: Array.from(
                { length: len },
                (_, i) => (row + dRow * i) * gridSize + (col + dCol * i)
              ),
            });
          }
        }
      }
    });

    return words;
  }

  switchTurn() {
    const currentIndex = this.players.findIndex(
      (p) => p.id === this.currentPlayer
    );
    const nextIndex = (currentIndex + 1) % this.players.length;
    this.currentPlayer = this.players[nextIndex].id;

    console.log(`🔄 Word Grid turn switched to player ${this.currentPlayer}`);
  }

  async finishGame(reason = "normal") {
    console.log(
      `🏁 Word Grid game finishing in room ${this.roomId}, reason: ${reason}`
    );

    this.gamePhase = "finished";

    // Calculate final scores
    const sortedPlayers = [...this.players].sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.longestWord !== a.longestWord) return b.longestWord - a.longestWord;
      return b.totalLettersPlaced - a.totalLettersPlaced;
    });

    const winner = sortedPlayers[0];
    const loser = sortedPlayers[1];
    const totalBets = this.players.reduce(
      (sum, player) => sum + player.actualPaidAmount,
      0
    );
    const platformFee = totalBets * 0.1;
    const prizePool = totalBets - platformFee;

    const gameStats = {
      winner: winner,
      loser: loser,
      reason: reason,
      finalStandings: sortedPlayers.map((player, index) => ({
        wallet: player.wallet,
        rank: index + 1,
        score: player.score,
        wordsFound: player.wordsFound.length,
        longestWord: player.longestWord,
        totalLettersPlaced: player.totalLettersPlaced,
        timeRemaining: player.timeRemaining,
        betAmount: player.actualPaidAmount,
        prize: index === 0 ? prizePool : 0,
      })),
      betPool: {
        totalAmount: totalBets,
        platformFee: platformFee,
        prizePool: prizePool,
      },
      roomId: this.roomId,
    };

    console.log(
      `🏆 Word Grid Winner: ${winner.wallet.slice(0, 8)}... with ${
        winner.score
      } points`
    );
    console.log(
      `💰 Prize: ${prizePool} GOR to winner, Platform fee: ${platformFee} GOR`
    );

    // Distribute prizes using the smart contract integration
    try {
      await smartContractIntegration.distributeSmartContractRewards(
        this.roomId,
        [
          {
            walletAddress: winner.wallet,
            prizeAmount: prizePool,
            gameType: "wordGrid",
          },
        ]
      );
    } catch (error) {
      console.error(`❌ Failed to distribute Word Grid prizes:`, error);
    }

    return gameStats;
  }

  getGameState() {
    return {
      roomId: this.roomId,
      gamePhase: this.gamePhase,
      players: this.players.map((player) => ({
        id: player.id,
        wallet: player.wallet,
        nickname: player.nickname,
        score: player.score,
        timeRemaining: player.timeRemaining,
        isActive: player.id === this.currentPlayer,
        paymentConfirmed: player.paymentConfirmed,
        wordsFound: player.wordsFound,
        totalLettersPlaced: player.totalLettersPlaced,
        longestWord: player.longestWord,
        isCreator: player.isCreator,
      })),
      grid: this.grid,
      currentPlayer: this.currentPlayer,
      betAmount: this.betAmount,
      maxPlayers: this.maxPlayers,
      hasPassword: !!this.password,
      gameStartTime: this.gameStartTime,
      totalGameTime: this.totalGameTime,
    };
  }
}
import { setupDemoRoutes } from "./demo-server.js";
import { setupRealWalletRoutes } from "./real-wallet-server.js";

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: [
      process.env.FRONTEND_URL || "http://localhost:3000",
      process.env.PRODUCTION_FRONTEND_URL ||
        "https://gorbagana-taupe.vercel.app",
      "https://gorbagana-taupe.vercel.app",
      "https://gorbagana.xyz",
      "https://gorbagana-frontend.vercel.app",
    ],
    methods: ["GET", "POST"],
    credentials: true,
  },
});

app.use(
  cors({
    origin: [
      process.env.FRONTEND_URL || "http://localhost:3000",
      process.env.PRODUCTION_FRONTEND_URL ||
        "https://gorbagana-taupe.vercel.app",
      "https://gorbagana-taupe.vercel.app",
      "https://gorbagana.xyz",
      "https://gorbagana-frontend.vercel.app",
    ],
    credentials: true,
  })
);
app.use(express.json());

// Gorbagana network connection
const connection = new Connection(
  process.env.GORBAGANA_RPC_URL ||
    process.env.SOLANA_RPC_URL ||
    "https://rpc.gorbagana.wtf/",
  "confirmed"
);

// Smart contract addresses (DEPLOYED CONTRACT)
const PROGRAM_ID = "GorTokenTakedown11111111111111111111111111";
const GGOR_MINT = "71Jvq4Epe2FCJ7JFSF7jLXdNk1Wy4Bhqd8iL6bEFELvg"; // Real GOR from Jupiter

// Game configuration
const GAME_CONFIG = {
  ENTRY_FEE: 5, // gGOR
  MAX_PLAYERS: 6,
  MIN_PLAYERS: 2,
  GAME_DURATION: 60, // seconds
  MAX_TOKENS: 10,
  ARENA_SIZE: 20,
  FREEZE_DURATION: 3000, // milliseconds
  FREEZE_COST: 1, // gGOR
  PLATFORM_FEE_RATE: 0.1, // 10% platform fee
};

class GameRoom {
  constructor(gameId) {
    this.gameId = gameId;
    this.players = new Map();
    this.tokens = new Map();
    this.gameState = "waiting"; // waiting, playing, finished
    this.timeRemaining = GAME_CONFIG.GAME_DURATION;
    this.gameTimer = null;
    this.tokenSpawnTimer = null;
    this.entryFeeTransactions = new Map(); // Track verified transactions
    this.totalPrizePool = 0;
    this.gameStartTime = null;
    this.winners = [];
  }

  addPlayer(playerId, socketId, walletAddress, entryTxSignature) {
    if (this.players.size >= GAME_CONFIG.MAX_PLAYERS) {
      throw new Error("Game is full");
    }

    if (this.gameState !== "waiting") {
      throw new Error("Game already started");
    }

    // In production, verify the transaction signature here
    // For now, we'll assume it's valid
    this.entryFeeTransactions.set(playerId, {
      signature: entryTxSignature,
      amount: GAME_CONFIG.ENTRY_FEE,
      verified: true, // Mock verification
    });

    this.players.set(playerId, {
      id: playerId,
      socketId,
      wallet: walletAddress,
      position: this.getRandomSpawnPosition(),
      tokens: 0,
      frozen: false,
      freezeEndTime: 0,
      joinedAt: Date.now(),
    });

    this.totalPrizePool += GAME_CONFIG.ENTRY_FEE;
    console.log(
      `Player ${playerId} joined game ${this.gameId}. Prize pool: ${this.totalPrizePool} gGOR`
    );

    // Start game if enough players
    if (
      this.players.size >= GAME_CONFIG.MIN_PLAYERS &&
      this.gameState === "waiting"
    ) {
      this.startGame();
    }

    return this.getGameState();
  }

  removePlayer(playerId) {
    if (this.players.has(playerId)) {
      this.players.delete(playerId);

      // End game if no players left
      if (this.players.size === 0) {
        this.endGame();
      }
    }
  }

  startGame() {
    this.gameState = "playing";
    this.gameStartTime = Date.now();
    this.spawnTokens();
    this.startGameTimer();
    this.startTokenSpawning();

    console.log(
      `🎮 Game ${this.gameId} started with ${this.players.size} players!`
    );
  }

  startGameTimer() {
    this.gameTimer = setInterval(() => {
      this.timeRemaining--;

      if (this.timeRemaining <= 0) {
        this.endGame();
      }
    }, 1000);
  }

  startTokenSpawning() {
    this.tokenSpawnTimer = setInterval(() => {
      if (this.tokens.size < GAME_CONFIG.MAX_TOKENS) {
        this.spawnToken();
      }
    }, 2000);
  }

  spawnTokens() {
    // Spawn initial tokens
    for (let i = 0; i < Math.min(GAME_CONFIG.MAX_TOKENS, 5); i++) {
      this.spawnToken();
    }
  }

  spawnToken() {
    const tokenId = uuidv4();
    const position = this.getRandomPosition();
    const value = Math.floor(Math.random() * 5) + 1; // 1-5 gGOR

    this.tokens.set(tokenId, {
      id: tokenId,
      position,
      value,
      spawnTime: Date.now(),
    });
  }

  getRandomPosition() {
    const margin = 2;
    return [
      (Math.random() - 0.5) * (GAME_CONFIG.ARENA_SIZE - margin * 2),
      0.5,
      (Math.random() - 0.5) * (GAME_CONFIG.ARENA_SIZE - margin * 2),
    ];
  }

  getRandomSpawnPosition() {
    // Spawn players around the edges
    const side = Math.floor(Math.random() * 4);
    const edge = GAME_CONFIG.ARENA_SIZE / 2 - 1;

    switch (side) {
      case 0:
        return [-edge, 0.5, (Math.random() - 0.5) * GAME_CONFIG.ARENA_SIZE];
      case 1:
        return [edge, 0.5, (Math.random() - 0.5) * GAME_CONFIG.ARENA_SIZE];
      case 2:
        return [(Math.random() - 0.5) * GAME_CONFIG.ARENA_SIZE, 0.5, -edge];
      case 3:
        return [(Math.random() - 0.5) * GAME_CONFIG.ARENA_SIZE, 0.5, edge];
      default:
        return [0, 0.5, 0];
    }
  }

  movePlayer(playerId, direction) {
    const player = this.players.get(playerId);
    if (!player || player.frozen || this.gameState !== "playing") return;

    const moveDistance = 0.5;
    const newPosition = [...player.position];

    switch (direction.toLowerCase()) {
      case "w":
      case "arrowup":
        newPosition[2] -= moveDistance;
        break;
      case "s":
      case "arrowdown":
        newPosition[2] += moveDistance;
        break;
      case "a":
      case "arrowleft":
        newPosition[0] -= moveDistance;
        break;
      case "d":
      case "arrowright":
        newPosition[0] += moveDistance;
        break;
    }

    // Boundary checking
    const boundary = GAME_CONFIG.ARENA_SIZE / 2;
    newPosition[0] = Math.max(-boundary, Math.min(boundary, newPosition[0]));
    newPosition[2] = Math.max(-boundary, Math.min(boundary, newPosition[2]));

    player.position = newPosition;

    // Check token collisions
    this.checkTokenCollisions(playerId);
  }

  checkTokenCollisions(playerId) {
    const player = this.players.get(playerId);
    if (!player) return;

    const collectionDistance = 0.8;

    for (const [tokenId, token] of this.tokens) {
      const distance = Math.sqrt(
        Math.pow(player.position[0] - token.position[0], 2) +
          Math.pow(player.position[2] - token.position[2], 2)
      );

      if (distance < collectionDistance) {
        player.tokens += token.value;
        this.tokens.delete(tokenId);
        console.log(`Player ${playerId} collected ${token.value} gGOR token`);
        break;
      }
    }
  }

  async usePowerUp(playerId, powerUpType, txSignature) {
    const player = this.players.get(playerId);
    if (!player || this.gameState !== "playing") return;

    if (powerUpType === "freeze") {
      // Verify the burn transaction (mock verification for now)
      if (player.tokens < GAME_CONFIG.FREEZE_COST) {
        throw new Error("Not enough tokens to use freeze power-up");
      }

      // Find nearest opponent
      let nearestPlayer = null;
      let nearestDistance = Infinity;

      for (const [otherPlayerId, otherPlayer] of this.players) {
        if (otherPlayerId !== playerId && !otherPlayer.frozen) {
          const distance = Math.sqrt(
            Math.pow(player.position[0] - otherPlayer.position[0], 2) +
              Math.pow(player.position[2] - otherPlayer.position[2], 2)
          );

          if (distance < nearestDistance) {
            nearestDistance = distance;
            nearestPlayer = otherPlayer;
          }
        }
      }

      if (nearestPlayer && nearestDistance < 5) {
        // Freeze the nearest player
        nearestPlayer.frozen = true;
        nearestPlayer.freezeEndTime = Date.now() + GAME_CONFIG.FREEZE_DURATION;

        // Deduct tokens from user (this would be handled by smart contract)
        player.tokens = Math.max(0, player.tokens - GAME_CONFIG.FREEZE_COST);

        console.log(
          `Player ${playerId} froze player ${nearestPlayer.id} for ${GAME_CONFIG.FREEZE_DURATION}ms`
        );

        // Unfreeze after duration
        setTimeout(() => {
          if (
            nearestPlayer.frozen &&
            Date.now() >= nearestPlayer.freezeEndTime
          ) {
            nearestPlayer.frozen = false;
            nearestPlayer.freezeEndTime = 0;
          }
        }, GAME_CONFIG.FREEZE_DURATION);

        return { success: true, target: nearestPlayer.id };
      }
    }

    return { success: false, message: "No valid targets for power-up" };
  }

  endGame() {
    this.gameState = "finished";

    if (this.gameTimer) {
      clearInterval(this.gameTimer);
      this.gameTimer = null;
    }

    if (this.tokenSpawnTimer) {
      clearInterval(this.tokenSpawnTimer);
      this.tokenSpawnTimer = null;
    }

    // Calculate winners
    this.winners = Array.from(this.players.values())
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 3)
      .map((player, index) => ({
        rank: index + 1,
        playerId: player.id,
        wallet: player.wallet,
        tokens: player.tokens,
        prize: this.calculatePrize(index),
      }));

    console.log(`🏁 Game ${this.gameId} ended. Winners:`, this.winners);

    // In production, this would trigger the smart contract to distribute rewards
    this.distributeRewards();
  }

  calculatePrize(rank) {
    if (rank === 0) return Math.floor(this.totalPrizePool * 0.5); // 50%
    if (rank === 1) return Math.floor(this.totalPrizePool * 0.3); // 30%
    if (rank === 2) return Math.floor(this.totalPrizePool * 0.2); // 20%
    return 0;
  }

  async distributeRewards() {
    console.log(`🏆 Game ${this.gameId} ended. Winners:`, this.winners);

    // Convert winners to format expected by blockchain rewards system
    const winnersForDistribution = this.winners.map((winner) => ({
      rank: winner.rank,
      wallet: winner.playerId, // Assuming playerId is the wallet address
      prize: winner.prize,
    }));

    // Find actual wallet addresses from players
    const winnersWithWallets = winnersForDistribution.map((winner) => {
      const player = Array.from(this.players.values()).find(
        (p) => p.id === winner.wallet
      );
      return {
        ...winner,
        wallet: player ? player.wallet : winner.wallet,
      };
    });

    console.log("🎯 Reward distribution:");
    winnersWithWallets.forEach((winner) => {
      console.log(
        `  ${winner.rank}. Player ${winner.wallet.slice(0, 8)}...: ${
          winner.prize
        } gGOR`
      );
    });

    try {
      // Real blockchain prize distribution
      const distributionResults = await distributePrizes(winnersWithWallets);

      console.log("📜 Smart contract reward distribution transaction sent");

      // Log successful distributions
      const successful = distributionResults.filter((r) => r.success);
      const failed = distributionResults.filter((r) => !r.success);

      if (successful.length > 0) {
        console.log(
          `✅ Successfully distributed prizes to ${successful.length} winners`
        );
        successful.forEach((result) => {
          console.log(
            `   ${result.wallet.slice(0, 8)}...: ${result.prize} GOR (${
              result.signature
            })`
          );
        });
      }

      if (failed.length > 0) {
        console.log(
          `❌ Failed to distribute prizes to ${failed.length} winners`
        );
        failed.forEach((result) => {
          console.log(`   ${result.wallet.slice(0, 8)}...: ${result.error}`);
        });
      }

      // Store winners for results page
      setTimeout(() => {
        this.cleanup();
      }, 10000); // Clean up after 10 seconds
    } catch (error) {
      console.error("Failed to distribute rewards:", error);
    }
  }

  cleanup() {
    // Clean up game resources
    this.players.clear();
    this.tokens.clear();
    this.entryFeeTransactions.clear();
    console.log(`🧹 Game ${this.gameId} cleaned up`);
  }

  getGameState() {
    return {
      gameId: this.gameId,
      players: Array.from(this.players.values()).map((player) => ({
        id: player.id,
        position: player.position,
        tokens: player.tokens,
        frozen: player.frozen,
        isYou: false, // Will be set by client
      })),
      tokens: Array.from(this.tokens.values()),
      timeRemaining: this.timeRemaining,
      gameStatus: this.gameState,
      prizePool: this.totalPrizePool,
      winners: this.winners,
    };
  }
}

class Lobby {
  constructor() {
    this.players = new Map();
    this.gameStarting = false;
    this.countdown = 0;
    this.countdownTimer = null;
  }

  addPlayer(playerId, socketId, walletAddress) {
    if (this.gameStarting) {
      throw new Error("Game is starting, cannot join lobby");
    }

    this.players.set(playerId, {
      id: playerId,
      socketId,
      wallet: walletAddress,
      ready: false,
      joinedAt: Date.now(),
    });

    console.log(
      `Player ${playerId} joined lobby (${this.players.size}/${GAME_CONFIG.MAX_PLAYERS})`
    );

    // Start countdown if enough players
    if (this.players.size >= GAME_CONFIG.MIN_PLAYERS && !this.gameStarting) {
      this.startGameCountdown();
    }

    return this.getLobbyState();
  }

  removePlayer(playerId) {
    if (this.players.has(playerId)) {
      this.players.delete(playerId);

      // Cancel countdown if not enough players
      if (this.players.size < GAME_CONFIG.MIN_PLAYERS && this.gameStarting) {
        this.cancelGameCountdown();
      }
    }
  }

  startGameCountdown() {
    this.gameStarting = true;
    this.countdown = 5;

    console.log("🚀 Starting game countdown...");

    this.countdownTimer = setInterval(() => {
      this.countdown--;

      // Emit countdown update to all clients
      if (globalIo) {
        globalIo.emit("lobbyState", this.getLobbyState());
      }

      console.log(`⏰ Countdown: ${this.countdown}`);

      if (this.countdown <= 0) {
        this.startGame();
      }
    }, 1000);
  }

  cancelGameCountdown() {
    this.gameStarting = false;
    this.countdown = 0;

    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }

    console.log("❌ Game countdown cancelled");
  }

  startGame() {
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }

    console.log("🎯 Starting game from lobby");

    // Create new game room
    const gameId = uuidv4();
    const gameRoom = new GameRoom(gameId);

    // Add all lobby players to the game room
    for (const [playerId, playerData] of this.players) {
      gameRoom.addPlayer(
        playerId,
        playerData.socketId,
        playerData.wallet,
        "mock-entry-tx" // Mock transaction for lobby players
      );
    }

    // Start the game immediately
    gameRoom.startGame();

    // Add to global game rooms
    if (typeof gameRooms !== "undefined") {
      gameRooms.set(gameId, gameRoom);
      console.log(
        `🎮 Game ${gameId} created with ${gameRoom.players.size} players`
      );
    }

    // Notify all lobby players to transition to game
    if (globalIo) {
      globalIo.emit("gameStarting", {
        gameId,
        message: "Moving to game arena...",
      });

      // After a short delay, send them to the game page
      setTimeout(() => {
        globalIo.emit("redirectToGame", { gameId });

        // Also broadcast initial game state
        const gameState = gameRoom.getGameState();
        globalIo.to(gameId).emit("gameState", gameState);
      }, 2000);
    }

    // Reset lobby state AFTER creating the game
    const lobbyPlayers = Array.from(this.players.values());
    this.gameStarting = false;
    this.countdown = 0;
    this.players.clear();

    return { gameId, players: lobbyPlayers };
  }

  getLobbyState() {
    return {
      players: Array.from(this.players.values()),
      gameStarting: this.gameStarting,
      countdown: this.countdown,
      requiredPlayers: GAME_CONFIG.MIN_PLAYERS,
      maxPlayers: GAME_CONFIG.MAX_PLAYERS,
    };
  }
}

// Tic-Tac-Toe Room Class
class TicTacToeRoom {
  constructor(roomId, betAmount = 1) {
    this.roomId = roomId;
    this.players = [];
    this.spectators = [];
    this.board = Array(9).fill(null);
    this.currentPlayer = "X";
    this.gamePhase = "waiting"; // waiting, betting, toss, playing, finished
    this.winner = null;
    this.coinToss = {
      choosingPlayer: null,
      choice: null,
      result: null,
      isFlipping: false,
    };
    this.scores = { X: 0, O: 0, draws: 0 };
    this.betAmount = betAmount;
    this.betPool = {
      totalAmount: 0,
      platformFee: 0,
      winnerPayout: 0,
    };
    this.dbMatch = null; // MongoDB document reference
    this.createdAt = Date.now();

    // Timeout mechanism for no opponent
    this.waitingTimeout = null;
    this.timeoutDuration = 5 * 60 * 1000; // 5 minutes in milliseconds
    this.isTimedOut = false;
  }

  async addPlayer(playerId, socketId, wallet, betAmount = null) {
    if (this.players.length >= 2) {
      throw new Error("Room is full");
    }

    // Use provided bet amount or room default
    const playerBetAmount = betAmount || this.betAmount;

    // Assign X to first player, O to second
    const symbol = this.players.length === 0 ? "X" : "O";

    this.players.push({
      id: playerId,
      socketId,
      wallet,
      symbol,
      betAmount: playerBetAmount,
      hasPaid: false, // Will be set to true after payment confirmation
      isYou: false, // Will be set correctly when sending state
    });

    // Create/update MongoDB document
    if (!this.dbMatch) {
      try {
        this.dbMatch = await GameMatch.create({
          gameId: this.roomId,
          gameType: "ticTacToe",
          players: [],
          gameState: "waiting",
          betPool: this.betPool,
          gameData: {
            board: this.board,
            moves: [],
          },
        });
      } catch (dbError) {
        if (dbError.code === 11000) {
          // Document already exists, find it instead
          this.dbMatch = await GameMatch.findOne({ gameId: this.roomId });
          console.log(`📋 Found existing game document: ${this.roomId}`);
        } else {
          console.log(`⚠️ Database match creation skipped:`, dbError.message);
        }
      }
    }

    // Add player to database
    try {
      await GameMatch.updateOne(
        { gameId: this.roomId },
        {
          $push: {
            players: {
              walletAddress: wallet,
              symbol: symbol,
              betAmount: playerBetAmount,
              isWinner: false,
            },
          },
        }
      );
    } catch (dbError) {
      console.log(`⚠️ Database player addition skipped:`, dbError.message);
    }

    // Start betting confirmation phase when both players join
    if (this.players.length === 2) {
      this.gamePhase = "betting";
      this.calculateBetPool();
      // Cancel waiting timeout since we found an opponent
      this.cancelWaitingTimeout();
    } else if (this.players.length === 1) {
      // First player joined - start timeout for no opponent
      this.startWaitingTimeout();
    }

    return this.getGameState();
  }

  addSpectator(playerId, socketId, wallet) {
    // Remove if already spectating
    this.spectators = this.spectators.filter((s) => s.id !== playerId);

    this.spectators.push({
      id: playerId,
      socketId,
      wallet,
    });

    // Add to database
    if (this.dbMatch) {
      GameMatch.updateOne(
        { gameId: this.roomId },
        {
          $push: {
            spectators: {
              walletAddress: wallet,
              joinedAt: new Date(),
            },
          },
        }
      ).catch(console.error);
    }

    return this.getGameState();
  }

  async confirmPayment(playerId, txSignature) {
    const player = this.players.find((p) => p.id === playerId);
    if (!player) {
      throw new Error("Player not found");
    }

    try {
      console.log(
        `🔍 [TicTacToe] Verifying payment for player ${player.wallet.slice(
          0,
          8
        )}...`
      );
      console.log(`   Transaction: ${txSignature}`);
      console.log(`   Expected amount: ${player.betAmount} GOR`);

      // Verify the blockchain transaction
      const validationResult = await validateEntryFeePayment(
        player.wallet,
        this.roomId,
        txSignature
      );

      if (validationResult.verified) {
        // Payment verified on blockchain
        player.hasPaid = true;
        player.txSignature = txSignature;
        player.actualPaidAmount = validationResult.amount;

        console.log(
          `✅ [TicTacToe] Payment verified! ${
            validationResult.amount
          } GOR from ${player.wallet.slice(0, 8)}`
        );

        // Collect the validated entry fee to platform escrow
        const escrowResult = await collectValidatedEntryFee(
          player.wallet,
          validationResult.amount,
          this.roomId,
          txSignature
        );

        console.log(`🏦 [TicTacToe] Entry fee collected to escrow`);
        console.log(`   Escrow pool: ${escrowResult.virtualPool} GOR`);

        // If both players have paid, start coin toss
        if (this.players.every((p) => p.hasPaid)) {
          this.gamePhase = "toss";
          // Set the first player as the choosing player for coin toss
          this.coinToss.choosingPlayer = this.players[0].id;
          this.calculateBetPool();
          await this.updateBetPool();

          console.log(
            `🎲 [TicTacToe] Both players paid, starting coin toss phase`
          );
          console.log(`   Total pool: ${this.betPool.totalAmount} GOR`);
          console.log(`   Winner prize: ${this.betPool.winnerPayout} GOR`);
          console.log(`   Platform fee: ${this.betPool.platformFee} GOR`);

          // Check platform balance for prize distribution
          try {
            const balanceCheck = await ensurePlatformBalance(
              this.betPool.winnerPayout
            );
            if (!balanceCheck.sufficient) {
              console.log(`⚠️ [TicTacToe] ${balanceCheck.message}`);
            }
          } catch (error) {
            console.error(
              `❌ [TicTacToe] Failed to check platform balance:`,
              error
            );
          }
        }

        return {
          success: true,
          verified: true,
          amount: validationResult.amount,
        };
      } else {
        console.error(
          `❌ [TicTacToe] Payment verification failed for ${txSignature}`
        );
        return { success: false, error: "Payment verification failed" };
      }
    } catch (error) {
      console.error(`❌ [TicTacToe] Payment confirmation error:`, error);
      return { success: false, error: error.message };
    }
  }

  calculateBetPool() {
    const totalBets = this.players.reduce(
      (sum, player) => sum + player.betAmount,
      0
    );
    const platformFee = totalBets * GAME_CONFIG.PLATFORM_FEE_RATE;

    this.betPool = {
      totalAmount: totalBets,
      platformFee: platformFee,
      winnerPayout: totalBets - platformFee,
    };
  }

  async updateBetPool() {
    if (this.dbMatch) {
      await GameMatch.updateOne(
        { gameId: this.roomId },
        {
          $set: {
            betPool: this.betPool,
            gameState: "playing",
          },
        }
      );
    }
  }

  removePlayer(playerId) {
    this.players = this.players.filter((p) => p.id !== playerId);

    // Reset game if a player leaves
    if (this.players.length < 2) {
      this.resetGame();
    }
  }

  startWaitingTimeout() {
    console.log(`⏰ Starting 5-minute timeout for room ${this.roomId}`);

    this.waitingTimeout = setTimeout(() => {
      this.handleWaitingTimeout();
    }, this.timeoutDuration);
  }

  cancelWaitingTimeout() {
    if (this.waitingTimeout) {
      console.log(
        `✅ Canceling waiting timeout for room ${this.roomId} (opponent found)`
      );
      clearTimeout(this.waitingTimeout);
      this.waitingTimeout = null;
    }
  }

  async handleWaitingTimeout() {
    if (this.isTimedOut || this.players.length !== 1) {
      return; // Already handled or invalid state
    }

    this.isTimedOut = true;
    const player = this.players[0];

    console.log(
      `⏰ Timeout reached for room ${
        this.roomId
      } - refunding player ${player.wallet.slice(0, 8)}...`
    );

    try {
      // Only refund if player has paid
      if (player.hasPaid) {
        console.log(
          `💰 Refunding ${player.betAmount} gGOR to ${player.wallet.slice(
            0,
            8
          )}...`
        );

        // Distribute refund via smart contract system
        const refundWinners = [
          {
            rank: 1,
            wallet: player.wallet,
            prize: player.betAmount, // Full refund (no platform fee for timeout)
            score: 0,
          },
        ];

        const results = await distributeSmartContractRewards(
          this.roomId,
          refundWinners
        );

        const result = results[0];
        if (result && result.success) {
          console.log(`✅ Timeout refund successful! TX: ${result.signature}`);
        } else {
          console.error(
            `❌ Timeout refund failed: ${result?.error || "Unknown error"}`
          );
        }
      }

      // Update database
      if (this.dbMatch) {
        await GameMatch.updateOne(
          { gameId: this.roomId },
          {
            $set: {
              gameState: "timeout",
              "gameData.timeoutReason": "no_opponent",
              finishedAt: new Date(),
            },
          }
        );
      }

      this.gamePhase = "finished";
      this.winner = "timeout";

      console.log(`🏁 Room ${this.roomId} closed due to timeout`);

      // Signal to remove this room from the rooms map
      return { shouldRemoveRoom: true, refundedPlayer: player };
    } catch (error) {
      console.error(
        `❌ Error handling timeout for room ${this.roomId}:`,
        error
      );
    }
  }

  cleanup() {
    // Clean up any pending timeouts
    this.cancelWaitingTimeout();
  }

  handleCoinChoice(playerId, choice) {
    if (
      this.gamePhase !== "toss" ||
      this.coinToss.choosingPlayer !== playerId
    ) {
      return false;
    }

    this.coinToss.choice = choice;
    this.coinToss.isFlipping = true;

    // Simulate coin flip after delay
    setTimeout(() => {
      this.coinToss.result = Math.random() < 0.5 ? "heads" : "tails";
      this.coinToss.isFlipping = false;

      // Assign symbols based on coin toss result
      const choosingPlayer = this.players.find((p) => p.id === playerId);
      const otherPlayer = this.players.find((p) => p.id !== playerId);

      if (this.coinToss.choice === this.coinToss.result) {
        // Choosing player wins, gets X
        choosingPlayer.symbol = "X";
        otherPlayer.symbol = "O";
      } else {
        // Other player wins, gets X
        choosingPlayer.symbol = "O";
        otherPlayer.symbol = "X";
      }

      // Start game after brief delay
      setTimeout(() => {
        this.gamePhase = "playing";
        this.currentPlayer = "X";
        // Broadcasting will be handled by the socket event handler
      }, 3000);
    }, 2000);

    return true;
  }

  setChoosingPlayer(requestingPlayerId, targetPlayer) {
    if (this.gamePhase !== "toss") return false;

    if (targetPlayer === "me") {
      this.coinToss.choosingPlayer = requestingPlayerId;
    } else {
      const otherPlayer = this.players.find((p) => p.id !== requestingPlayerId);
      this.coinToss.choosingPlayer = otherPlayer?.id || null;
    }

    return true;
  }

  letOtherChoose(playerId) {
    if (this.coinToss.choosingPlayer !== playerId) return false;

    const otherPlayer = this.players.find((p) => p.id !== playerId);
    this.coinToss.choosingPlayer = otherPlayer?.id || null;

    return true;
  }

  async makeMove(playerId, cellIndex) {
    const player = this.players.find((p) => p.id === playerId);

    if (
      !player ||
      this.gamePhase !== "playing" ||
      this.board[cellIndex] !== null ||
      this.winner ||
      player.symbol !== this.currentPlayer
    ) {
      return false;
    }

    // Make the move
    this.board[cellIndex] = this.currentPlayer;

    // Check for winner
    this.winner = this.checkWinner();

    if (this.winner) {
      await this.finishGame(this.winner);
    } else {
      // Switch turns
      this.currentPlayer = this.currentPlayer === "X" ? "O" : "X";
    }

    return true;
  }

  checkWinner() {
    const winPatterns = [
      [0, 1, 2],
      [3, 4, 5],
      [6, 7, 8], // Rows
      [0, 3, 6],
      [1, 4, 7],
      [2, 5, 8], // Columns
      [0, 4, 8],
      [2, 4, 6], // Diagonals
    ];

    for (const pattern of winPatterns) {
      const [a, b, c] = pattern;
      if (
        this.board[a] &&
        this.board[a] === this.board[b] &&
        this.board[a] === this.board[c]
      ) {
        return this.board[a];
      }
    }

    // Check for draw
    if (this.board.every((cell) => cell !== null)) {
      return "draw";
    }

    return null;
  }

  updateScores() {
    if (this.winner === "draw") {
      this.scores.draws++;
    } else if (this.winner) {
      this.scores[this.winner]++;
    }
  }

  resetGame() {
    this.board = Array(9).fill(null);
    this.currentPlayer = "X";
    this.gamePhase = "toss";
    this.winner = null;
    this.coinToss = {
      choosingPlayer: null,
      choice: null,
      result: null,
      isFlipping: false,
    };
  }

  getGameState(requestingPlayerId = null) {
    return {
      players: this.players.map((p) => ({
        ...p,
        isYou: p.id === requestingPlayerId,
      })),
      spectators: this.spectators.length,
      board: this.board,
      currentPlayer: this.currentPlayer,
      gamePhase: this.gamePhase,
      winner: this.winner,
      coinToss: this.coinToss,
      scores: this.scores,
      betPool: this.betPool,
      betAmount: this.betAmount,
    };
  }

  async finishGame(winner) {
    this.winner = winner;
    this.gamePhase = "finished";
    this.updateScores();

    // Update database
    if (this.dbMatch) {
      const winnerPlayer = this.players.find((p) => p.symbol === winner);
      const loserPlayer = this.players.find(
        (p) => p.symbol !== winner && p.symbol
      );

      await GameMatch.updateOne(
        { gameId: this.roomId },
        {
          $set: {
            gameState: "finished",
            "gameData.winner": winner,
            "gameData.gameResult": winner === "draw" ? "draw" : "win",
            "gameData.board": this.board,
            finishedAt: new Date(),
          },
        }
      );

      // Handle prize distribution
      console.log(`🏆 Game finished! Winner: ${winner}`);
      console.log(`💰 Prize pool: ${this.betPool.totalAmount} gGOR`);
      console.log(`💸 Platform fee: ${this.betPool.platformFee} gGOR`);

      if (winner !== "draw") {
        // Winner gets the payout
        if (winnerPlayer) {
          console.log(
            `🎉 ${winnerPlayer.wallet.slice(0, 8)}... wins ${
              this.betPool.winnerPayout
            } gGOR!`
          );

          // Distribute prize via SMART CONTRACT
          try {
            const winners = [
              {
                rank: 1,
                wallet: winnerPlayer.wallet,
                prize: this.betPool.winnerPayout,
                score: 1,
              },
            ];
            const results = await distributeSmartContractRewards(
              this.roomId,
              winners
            );

            const result = results[0]; // First (and only) winner
            if (result && result.success) {
              console.log(
                `✅ Prize distributed successfully! TX: ${result.signature}`
              );
            } else {
              console.error(
                `❌ Prize distribution failed: ${
                  result?.error || "Unknown error"
                }`
              );
            }
          } catch (error) {
            console.error("❌ Error distributing tic-tac-toe prize:", error);
          }

          await updateUserStats(
            winnerPlayer.wallet,
            "ticTacToe",
            true,
            this.betPool.winnerPayout
          );
        }
        // Loser gets no payout but stats updated
        if (loserPlayer) {
          console.log(`😔 ${loserPlayer.wallet.slice(0, 8)}... loses bet`);
          await updateUserStats(loserPlayer.wallet, "ticTacToe", false, 0);
        }
      } else {
        // Draw - split the pot (minus platform fee)
        const drawPayout = this.betPool.winnerPayout / 2;
        console.log(`🤝 Draw! Each player gets ${drawPayout} gGOR`);

        // Distribute to both players via SMART CONTRACT
        const drawWinners = this.players.map((player, index) => ({
          rank: index + 1,
          wallet: player.wallet,
          prize: drawPayout,
          score: 0,
        }));

        try {
          const results = await distributeSmartContractRewards(
            this.roomId,
            drawWinners
          );

          results.forEach((result, index) => {
            const player = this.players[index];
            if (result.success) {
              console.log(
                `✅ Draw payout distributed to ${player.wallet.slice(
                  0,
                  8
                )}...: ${drawPayout} GOR (${result.signature})`
              );
            } else {
              console.error(
                `❌ Draw payout failed for ${player.wallet.slice(0, 8)}...: ${
                  result.error
                }`
              );
            }
          });

          // Update stats for both players
          for (const player of this.players) {
            await updateUserStats(
              player.wallet,
              "ticTacToe",
              false,
              drawPayout
            );
          }
        } catch (error) {
          console.error("❌ Error distributing draw payouts:", error);
        }
      }

      // Log transaction signatures for audit
      this.players.forEach((player) => {
        if (player.txSignature) {
          console.log(
            `📝 Player ${player.wallet.slice(0, 8)}... TX: ${
              player.txSignature
            }`
          );
        }
      });
    }
  }
}

// Orb Collector 3D Game Room
class OrbCollectorRoom {
  constructor(roomId, betAmount = 1) {
    this.roomId = roomId;
    this.players = new Map();
    this.orbs = new Map();
    this.status = "waiting"; // waiting, countdown, playing, finished
    this.betAmount = betAmount;
    this.timeRemaining = 60; // 60 seconds
    this.countdownTime = 0;
    this.gameTimer = null;
    this.orbSpawner = null;
    this.countdownTimer = null;
    this.maxPlayers = 6;
    this.minPlayers = 2;
    this.arenaSize = 20; // 20x20 arena

    console.log(
      `🔮 Created Orb Collector room ${roomId} with bet ${betAmount} gGOR`
    );
  }

  async addPlayer(playerId, socketId, wallet, betAmount = null) {
    if (this.players.size >= this.maxPlayers) {
      throw new Error("Room is full");
    }

    if (this.status !== "waiting") {
      throw new Error("Game already in progress");
    }

    const finalBetAmount = betAmount || this.betAmount;

    // Generate random spawn position
    const spawnPosition = this.getRandomSpawnPosition();
    const playerColors = [
      "#4F46E5",
      "#9333EA",
      "#F59E0B",
      "#10B981",
      "#EF4444",
      "#8B5CF6",
    ];

    const player = {
      id: playerId,
      socketId: socketId,
      walletAddress: wallet,
      nickname: `${wallet.slice(0, 6)}...`,
      position: spawnPosition,
      score: 0,
      color: playerColors[this.players.size % playerColors.length],
      betAmount: finalBetAmount,
      paymentConfirmed: false, // Will be set to true after real blockchain verification
      joinedAt: new Date(),
    };

    this.players.set(playerId, player);
    console.log(
      `🔮 Player ${wallet.slice(0, 8)}... joined orb collector room ${
        this.roomId
      } - Payment validation required`
    );

    return this.getGameState();
  }

  removePlayer(playerId) {
    if (this.players.has(playerId)) {
      const player = this.players.get(playerId);
      this.players.delete(playerId);
      console.log(
        `🔮 Player ${player.walletAddress.slice(
          0,
          8
        )}... left orb collector room`
      );

      // Cancel countdown if not enough players
      if (this.players.size < this.minPlayers && this.status === "countdown") {
        this.cancelCountdown();
      }
    }
  }

  startCountdown() {
    if (this.status !== "waiting") return;

    // Check if all players have confirmed payment
    const allPaid = Array.from(this.players.values()).every(
      (p) => p.paymentConfirmed
    );
    if (!allPaid) {
      console.log(
        `🔮 Cannot start countdown - not all players have confirmed payment`
      );
      return;
    }

    this.status = "countdown";
    this.countdownTime = 5;

    console.log(`🔮 Starting countdown for orb collector room ${this.roomId}`);

    this.countdownTimer = setInterval(() => {
      this.countdownTime--;

      // Broadcast live countdown updates to all players
      if (globalIo) {
        const gameState = this.getGameState();
        globalIo.to(this.roomId).emit("orbGameState", gameState);
        console.log(`🔮 Countdown: ${this.countdownTime} seconds remaining`);
      }

      if (this.countdownTime <= 0) {
        this.startGame();
      }
    }, 1000);
  }

  cancelCountdown() {
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
    this.status = "waiting";
    this.countdownTime = 0;
    console.log(`🔮 Cancelled countdown for orb collector room ${this.roomId}`);
  }

  startGame() {
    if (this.status !== "countdown") return;

    this.cancelCountdown();
    this.status = "playing";
    this.timeRemaining = 60;

    console.log(
      `🔮 Starting orb collector game ${this.roomId} with ${this.players.size} players`
    );

    // Spawn initial orbs
    this.spawnInitialOrbs();

    // Broadcast initial game state when game starts
    if (globalIo) {
      const gameState = this.getGameState();
      globalIo.to(this.roomId).emit("orbGameState", gameState);
      console.log(
        `🔮 Game started! Broadcasting initial state to ${this.players.size} players`
      );
    }

    // Start game timer
    this.gameTimer = setInterval(() => {
      this.timeRemaining--;

      // Broadcast timer updates every 3 seconds to keep clients synced
      if (this.timeRemaining % 3 === 0 && globalIo) {
        const gameState = this.getGameState();
        globalIo.to(this.roomId).emit("orbGameState", gameState);
        console.log(`🕐 Game timer: ${this.timeRemaining} seconds remaining`);
      }

      // Final countdown - broadcast every second in last 10 seconds
      if (this.timeRemaining <= 10 && globalIo) {
        const gameState = this.getGameState();
        globalIo.to(this.roomId).emit("orbGameState", gameState);
        console.log(`⏰ FINAL COUNTDOWN: ${this.timeRemaining} seconds!`);
      }

      if (this.timeRemaining <= 0) {
        console.log(`🏁 Game time over! Ending game ${this.roomId}`);
        this.endGame();
      }
    }, 1000);

    // Start orb maintenance - ensures minimum orbs always present
    this.orbSpawner = setInterval(() => {
      const orbsSpawned = this.spawnOrb();

      if (orbsSpawned > 0) {
        console.log(
          `🔮 Maintenance spawned ${orbsSpawned} new orb(s). Total orbs: ${this.orbs.size}`
        );

        // Broadcast updated state when new orbs spawn
        if (globalIo) {
          const gameState = this.getGameState();
          globalIo.to(this.roomId).emit("orbGameState", gameState);
        }
      }
    }, 2000); // Check every 2 seconds to maintain orb count
  }

  spawnInitialOrbs() {
    // Spawn 15 initial orbs for immediate gameplay
    for (let i = 0; i < 15; i++) {
      this.createSingleOrb();
    }
    console.log(`🔮 Spawned ${this.orbs.size} initial orbs`);
  }

  spawnOrb() {
    const maxOrbs = 20; // Max 20 orbs at once for better gameplay
    const minOrbs = 12; // Always maintain at least 12 orbs

    let orbsSpawned = 0;

    // Spawn multiple orbs if we're below minimum
    if (this.orbs.size < minOrbs) {
      const orbsToSpawn = minOrbs - this.orbs.size;
      for (let i = 0; i < orbsToSpawn && this.orbs.size < maxOrbs; i++) {
        this.createSingleOrb();
        orbsSpawned++;
      }
    } else if (this.orbs.size < maxOrbs) {
      // Spawn single orb if below max
      this.createSingleOrb();
      orbsSpawned = 1;
    }

    return orbsSpawned;
  }

  createSingleOrb() {
    const orbId = uuidv4();
    const position = this.getRandomOrbPosition();
    const orbTypes = [
      { type: "common", value: 1, weight: 60 },
      { type: "rare", value: 3, weight: 30 },
      { type: "legendary", value: 5, weight: 10 },
    ];

    // Weighted random selection
    const rand = Math.random() * 100;
    let selectedType = orbTypes[0];
    let cumulativeWeight = 0;

    for (const orbType of orbTypes) {
      cumulativeWeight += orbType.weight;
      if (rand <= cumulativeWeight) {
        selectedType = orbType;
        break;
      }
    }

    const orb = {
      id: orbId,
      position: position,
      value: selectedType.value,
      type: selectedType.type,
      glowColor:
        selectedType.type === "common"
          ? "#00d4ff" // Bright cyan
          : selectedType.type === "rare"
          ? "#ff00ff" // Bright magenta
          : "#ffff00", // Bright yellow
      spawnedAt: Date.now(),
    };

    this.orbs.set(orbId, orb);

    console.log(
      `✨ Created new ${
        selectedType.type
      } orb at position (${position.x.toFixed(1)}, ${position.z.toFixed(
        1
      )}) worth ${selectedType.value} points`
    );

    return orb;
  }

  getRandomSpawnPosition() {
    const edge = Math.floor(Math.random() * 4); // 0: top, 1: right, 2: bottom, 3: left
    const arenaHalf = this.arenaSize / 2;

    switch (edge) {
      case 0: // top
        return {
          x: (Math.random() - 0.5) * this.arenaSize,
          y: 0.5,
          z: -arenaHalf + 1,
        };
      case 1: // right
        return {
          x: arenaHalf - 1,
          y: 0.5,
          z: (Math.random() - 0.5) * this.arenaSize,
        };
      case 2: // bottom
        return {
          x: (Math.random() - 0.5) * this.arenaSize,
          y: 0.5,
          z: arenaHalf - 1,
        };
      case 3: // left
        return {
          x: -arenaHalf + 1,
          y: 0.5,
          z: (Math.random() - 0.5) * this.arenaSize,
        };
      default:
        return { x: 0, y: 0.5, z: 0 };
    }
  }

  getRandomOrbPosition() {
    const arenaHalf = this.arenaSize / 2 - 1;
    return {
      x: (Math.random() - 0.5) * (arenaHalf * 2),
      y: 0.5 + Math.random() * 2, // Floating orbs
      z: (Math.random() - 0.5) * (arenaHalf * 2),
    };
  }

  movePlayer(playerId, position) {
    const player = this.players.get(playerId);
    if (!player || this.status !== "playing") return;

    // Update player position with bounds checking
    const arenaHalf = this.arenaSize / 2 - 0.5;
    player.position = {
      x: Math.max(-arenaHalf, Math.min(arenaHalf, position.x)),
      y: 0.5,
      z: Math.max(-arenaHalf, Math.min(arenaHalf, position.z)),
    };

    // Check for orb collisions
    this.checkOrbCollisions(playerId);
  }

  checkOrbCollisions(playerId) {
    const player = this.players.get(playerId);
    if (!player) return;

    for (const [orbId, orb] of this.orbs) {
      const distance = Math.sqrt(
        Math.pow(orb.position.x - player.position.x, 2) +
          Math.pow(orb.position.z - player.position.z, 2)
      );

      if (distance < 1.2) {
        // Collision threshold
        // Player collected the orb
        player.score += orb.value;
        this.orbs.delete(orbId);

        console.log(
          `🔮 Player ${player.walletAddress.slice(0, 8)}... collected ${
            orb.type
          } orb worth ${orb.value} points! New score: ${player.score}`
        );

        // ⭐ IMMEDIATELY SPAWN A NEW ORB TO REPLACE THE COLLECTED ONE
        this.createSingleOrb();
        console.log(
          `🌟 New orb spawned to replace collected orb ${orbId}. Total orbs: ${this.orbs.size}`
        );

        // Broadcast orb collection immediately
        if (globalIo) {
          globalIo.to(this.roomId).emit("orbCollected", {
            orbId: orbId,
            playerId: playerId,
            value: orb.value,
            newScore: player.score,
          });

          // Also broadcast updated game state (includes new orb)
          const gameState = this.getGameState();
          globalIo.to(this.roomId).emit("orbGameState", gameState);
        }

        return { orbId, value: orb.value };
      }
    }

    return null;
  }

  async endGame() {
    if (this.status !== "playing") return;

    this.status = "finished";
    this.timeRemaining = 0;

    // Clear timers
    if (this.gameTimer) {
      clearInterval(this.gameTimer);
      this.gameTimer = null;
    }
    if (this.orbSpawner) {
      clearInterval(this.orbSpawner);
      this.orbSpawner = null;
    }

    // Calculate results
    const sortedPlayers = Array.from(this.players.values()).sort(
      (a, b) => b.score - a.score
    );

    console.log(
      `🔮 Orb collector game ${this.roomId} finished. Final Results:`
    );
    console.log(`🏆 === GAME OVER - FINAL SCORES ===`);
    sortedPlayers.forEach((player, index) => {
      console.log(
        `   ${index + 1}. ${player.walletAddress.slice(0, 8)}... - ${
          player.score
        } points`
      );
    });

    // Broadcast final game state immediately
    if (globalIo) {
      const finalGameState = this.getGameState();
      globalIo.to(this.roomId).emit("orbGameState", finalGameState);
      globalIo.to(this.roomId).emit("gameFinished", {
        results: sortedPlayers,
        finalScores: sortedPlayers.map((p) => ({
          wallet: p.walletAddress,
          score: p.score,
        })),
      });
      console.log(`📡 Broadcasting final game state to all players`);
    }

    // Award prizes to top players
    await this.distributePrizes(sortedPlayers);

    // Clean up after 30 seconds
    setTimeout(() => {
      this.cleanup();
    }, 30000);

    return sortedPlayers;
  }

  async distributePrizes(sortedPlayers) {
    const totalBetPool = Array.from(this.players.values()).reduce(
      (sum, player) => sum + player.betAmount,
      0
    );
    const platformFee = totalBetPool * 0.05; // 5% platform fee
    const prizePool = totalBetPool - platformFee;

    console.log(`💰 Total bet pool: ${totalBetPool} GOR`);
    console.log(`💸 Platform fee (5%): ${platformFee} GOR`);
    console.log(`🏆 Prize pool: ${prizePool} GOR`);

    // Check for no winner scenario (all players have 0 points)
    const maxScore = Math.max(...sortedPlayers.map((p) => p.score));
    const topPlayers = sortedPlayers.filter((p) => p.score === maxScore);

    let winners = [];

    if (maxScore === 0) {
      // NO WINNER SCENARIO - Everyone gets their bet back
      console.log("🤝 NO WINNER - All players scored 0. Returning bets!");

      winners = Array.from(this.players.values()).map((player, index) => ({
        rank: index + 1,
        wallet: player.walletAddress,
        prize: player.betAmount, // Return exact bet amount
        reason: "bet_refund",
      }));

      console.log("💸 REFUNDING ALL BETS:");
      winners.forEach((winner) => {
        console.log(
          `   ${winner.wallet.slice(0, 8)}... → ${winner.prize} GOR (refund)`
        );
      });
    } else if (topPlayers.length === 1) {
      // CLEAR WINNER - Winner takes prize pool
      const winner = topPlayers[0];
      console.log(
        `🏆 CLEAR WINNER: ${winner.walletAddress.slice(0, 8)}... with ${
          winner.score
        } points!`
      );

      winners = [
        {
          rank: 1,
          wallet: winner.walletAddress,
          prize: parseFloat(prizePool.toFixed(6)),
          reason: "winner_takes_all",
        },
      ];
    } else {
      // TIE SCENARIO - Split prize pool among tied players
      console.log(
        `🤝 TIE between ${topPlayers.length} players with ${maxScore} points!`
      );
      const prizePerPlayer = prizePool / topPlayers.length;

      winners = topPlayers.map((player, index) => ({
        rank: 1, // All tied for first
        wallet: player.walletAddress,
        prize: parseFloat(prizePerPlayer.toFixed(6)),
        reason: "tie_split",
      }));

      console.log("🏆 SPLITTING PRIZE POOL:");
      winners.forEach((winner) => {
        console.log(
          `   ${winner.wallet.slice(0, 8)}... → ${winner.prize} GOR (tie share)`
        );
      });
    }

    // ENHANCED PRIZE DISTRIBUTION - BOTH MOCK AND REAL MODES!
    if (winners.length > 0) {
      try {
        console.log(`🚀 DISTRIBUTING ${winners.length} PRIZES...`);

        // Check if we're in real blockchain mode or mock mode
        const isRealMode =
          process.env.PLATFORM_PRIVATE_KEY && !process.env.MOCK_MODE;

        let distributionResults;

        if (isRealMode) {
          console.log("💎 REAL BLOCKCHAIN MODE: Using actual GOR transfers");
          distributionResults = await distributePrizes(winners);
        } else {
          console.log("🎭 MOCK MODE: Simulating prize distribution");
          distributionResults = await distributeSmartContractRewards(
            this.roomId,
            winners
          );
        }

        const successful = distributionResults.filter((r) => r.success);
        const failed = distributionResults.filter((r) => !r.success);

        if (successful.length > 0) {
          console.log(
            `✅ Successfully distributed ${successful.length} prizes:`
          );
          successful.forEach((result) => {
            console.log(
              `   ${result.wallet.slice(0, 8)}... → ${result.prize} GOR (${
                result.signature
              })`
            );
          });
        }

        if (failed.length > 0) {
          console.log(`❌ Failed to distribute ${failed.length} prizes:`);
          failed.forEach((result) => {
            console.log(
              `   ${result.wallet.slice(0, 8)}... → FAILED: ${result.error}`
            );
          });
        }

        // Save match results to database
        try {
          const matchData = {
            gameId: this.roomId,
            gameType: "orbCollector",
            players: Array.from(this.players.values()).map((p) => ({
              walletAddress: p.walletAddress,
              score: p.score,
              betAmount: p.betAmount,
              isWinner: winners.some((w) => w.wallet === p.walletAddress),
            })),
            gameData: {
              scenario:
                maxScore === 0
                  ? "no_winner_refund"
                  : topPlayers.length > 1
                  ? "tie_split"
                  : "clear_winner",
              finalScores: sortedPlayers.map((p) => ({
                wallet: p.walletAddress,
                score: p.score,
              })),
              distributionResults: distributionResults,
            },
            betPool: {
              totalAmount: totalBetPool,
              platformFee: platformFee,
              prizePool: prizePool,
            },
            startedAt: new Date(Date.now() - 60000),
            finishedAt: new Date(),
          };

          const match = new GameMatch(matchData);
          await match.save();
          console.log("📊 Match results saved to database");
        } catch (error) {
          console.error("❌ Error saving match results:", error);
        }

        // Update user stats
        for (const player of Array.from(this.players.values())) {
          try {
            const isWinner = winners.some(
              (w) => w.wallet === player.walletAddress
            );
            const prize =
              winners.find((w) => w.wallet === player.walletAddress)?.prize ||
              0;

            await updateUserStats(
              player.walletAddress,
              "orbCollector",
              isWinner,
              prize
            );
          } catch (error) {
            console.error("❌ Error updating user stats:", error);
          }
        }
      } catch (error) {
        console.error("❌ CRITICAL ERROR distributing prizes:", error);
      }
    }
  }

  cleanup() {
    // Clear any remaining timers
    if (this.gameTimer) clearInterval(this.gameTimer);
    if (this.orbSpawner) clearInterval(this.orbSpawner);
    if (this.countdownTimer) clearInterval(this.countdownTimer);

    // Clear data
    this.players.clear();
    this.orbs.clear();

    console.log(`🔮 Cleaned up orb collector room ${this.roomId}`);
  }

  getGameState() {
    return {
      status: this.status,
      players: Array.from(this.players.values()),
      orbs: Array.from(this.orbs.values()),
      timeRemaining: this.timeRemaining,
      gameId: this.roomId,
      countdownTime: this.countdownTime,
      leaderboard: Array.from(this.players.values()).sort(
        (a, b) => b.score - a.score
      ),
    };
  }

  confirmPayment(playerId) {
    const player = Array.from(this.players.values()).find(
      (p) => p.id === playerId
    );
    if (player) {
      player.paymentConfirmed = true;
      console.log(
        `✅ Payment confirmed for orb collector player ${player.walletAddress}`
      );

      // Check if all players have confirmed payment and start countdown
      const allPaid = Array.from(this.players.values()).every(
        (p) => p.paymentConfirmed
      );
      if (
        allPaid &&
        this.players.size >= this.minPlayers &&
        this.status === "waiting"
      ) {
        this.startCountdown();
      }
    }
  }

  calculateBetPool() {
    const totalBets = Array.from(this.players.values()).reduce(
      (sum, player) => sum + player.betAmount,
      0
    );
    const platformFee = totalBets * 0.1; // 10% platform fee like TicTacToe

    return {
      totalAmount: totalBets,
      platformFee: platformFee,
      prizePool: totalBets - platformFee,
    };
  }
}

// Global game state
const gameRooms = new Map();
const lobby = new Lobby();
const playerSockets = new Map();
const ticTacToeRooms = new Map();
const wordGridRooms = new Map();
const orbCollectorRooms = new Map();
// Note: Word Grid rooms moved to real-wallet-server.js for blockchain integration

// Make io globally accessible for lobby countdown
let globalIo;

// Set global io reference for lobby countdown
globalIo = io;

// Socket.IO connection handling
io.on("connection", (socket) => {
  console.log("🔌 New client connected:", socket.id);

  // Auto-join active game if one exists (for reconnecting clients)
  const activeGame = Array.from(gameRooms.values()).find(
    (room) =>
      room.gameState === "playing" &&
      room.players.size < GAME_CONFIG.MAX_PLAYERS
  );

  console.log(
    "🔍 Active games:",
    gameRooms.size,
    "Total players in socket:",
    playerSockets.size
  );

  if (activeGame) {
    console.log(
      "🎮 Auto-joining client to active game:",
      activeGame.gameId,
      "State:",
      activeGame.gameState
    );

    // Send current game state immediately
    socket.join(activeGame.gameId);
    const gameState = activeGame.getGameState();
    socket.emit("gameState", gameState);
    console.log("📤 Sent game state to new client");
  } else {
    console.log("🔍 No active games found for auto-join");
  }

  socket.on("joinLobby", ({ wallet }) => {
    try {
      const playerId = uuidv4();
      playerSockets.set(socket.id, { playerId, wallet, currentRoom: "lobby" });

      const lobbyState = lobby.addPlayer(playerId, socket.id, wallet);

      // Broadcast updated lobby state to all clients
      io.emit("lobbyState", lobbyState);

      // Send personal info to the joining player
      socket.emit("lobbyJoined", {
        playerId,
        lobbyState,
        yourSocketId: socket.id,
        yourWallet: wallet,
      });
    } catch (error) {
      socket.emit("error", { message: error.message });
    }
  });

  socket.on("joinGame", ({ txSignature }) => {
    try {
      const playerInfo = playerSockets.get(socket.id);
      if (!playerInfo) {
        throw new Error("Player not found");
      }

      // Create or find game room
      let gameRoom = null;
      for (const [roomId, room] of gameRooms) {
        if (
          room.gameState === "waiting" &&
          room.players.size < GAME_CONFIG.MAX_PLAYERS
        ) {
          gameRoom = room;
          break;
        }
      }

      if (!gameRoom) {
        const gameId = uuidv4();
        gameRoom = new GameRoom(gameId);
        gameRooms.set(gameId, gameRoom);
      }

      const gameState = gameRoom.addPlayer(
        playerInfo.playerId,
        socket.id,
        playerInfo.wallet,
        txSignature
      );

      // Update player's current room
      playerInfo.currentRoom = gameRoom.gameId;

      // Join socket room
      socket.join(gameRoom.gameId);

      // Broadcast game state to room
      io.to(gameRoom.gameId).emit("gameState", gameState);

      if (gameRoom.gameState === "playing") {
        io.to(gameRoom.gameId).emit("gameStarted", { gameId: gameRoom.gameId });
      }
    } catch (error) {
      socket.emit("error", { message: error.message });
    }
  });

  socket.on("playerMove", ({ direction }) => {
    try {
      const playerInfo = playerSockets.get(socket.id);
      if (!playerInfo || playerInfo.currentRoom === "lobby") return;

      const gameRoom = gameRooms.get(playerInfo.currentRoom);
      if (!gameRoom) return;

      gameRoom.movePlayer(playerInfo.playerId, direction);

      // Broadcast updated game state
      const gameState = gameRoom.getGameState();
      io.to(gameRoom.gameId).emit("gameState", gameState);
    } catch (error) {
      socket.emit("error", { message: error.message });
    }
  });

  socket.on("usePowerUp", async ({ type, txSignature }) => {
    try {
      const playerInfo = playerSockets.get(socket.id);
      if (!playerInfo || playerInfo.currentRoom === "lobby") return;

      const gameRoom = gameRooms.get(playerInfo.currentRoom);
      if (!gameRoom) return;

      const result = await gameRoom.usePowerUp(
        playerInfo.playerId,
        type,
        txSignature
      );

      if (result.success) {
        // Broadcast power-up effect
        io.to(gameRoom.gameId).emit("powerUpUsed", {
          type,
          user: playerInfo.playerId,
          target: result.target,
        });

        // Broadcast updated game state
        const gameState = gameRoom.getGameState();
        io.to(gameRoom.gameId).emit("gameState", gameState);
      }
    } catch (error) {
      socket.emit("error", { message: error.message });
    }
  });

  socket.on("requestGameState", ({ wallet }) => {
    try {
      console.log("🎮 Game state requested by:", wallet);

      // Find active game and add as spectator/reconnecting player
      const activeGame = Array.from(gameRooms.values()).find(
        (room) => room.gameState === "playing"
      );

      if (activeGame) {
        console.log("🎯 Reconnecting player to game:", activeGame.gameId);

        // Check if player was already in this game
        let existingPlayer = null;
        for (const [pid, player] of activeGame.players) {
          if (player.wallet === wallet) {
            existingPlayer = { playerId: pid, player };
            break;
          }
        }

        if (existingPlayer) {
          // Reconnect existing player
          console.log(
            "🔄 Reconnecting existing player:",
            existingPlayer.playerId
          );
          playerSockets.set(socket.id, {
            playerId: existingPlayer.playerId,
            wallet,
            currentRoom: activeGame.gameId,
          });

          // Update the player's socket ID in the game room
          existingPlayer.player.socketId = socket.id;
        } else {
          // Add as new spectator
          const playerId = uuidv4();
          playerSockets.set(socket.id, {
            playerId,
            wallet,
            currentRoom: activeGame.gameId,
          });
          console.log("👁️ Added as spectator:", playerId);
        }

        // Join socket room
        socket.join(activeGame.gameId);

        // Send current game state with proper "isYou" flags
        const gameState = activeGame.getGameState();
        gameState.players = gameState.players.map((player) => ({
          ...player,
          isYou: player.id === (existingPlayer?.playerId || false),
        }));

        socket.emit("gameState", gameState);

        console.log("✅ Player connected to active game");
      } else {
        console.log("❌ No active game found, redirecting to lobby");
        socket.emit("error", { message: "No active game found" });
      }
    } catch (error) {
      console.error("Failed to handle game state request:", error);
      socket.emit("error", { message: error.message });
    }
  });

  // Tic-Tac-Toe Socket Events
  socket.on("joinTicTacToe", async ({ wallet, betAmount }) => {
    try {
      const actualBetAmount = betAmount || 1; // Default 1 GOR if not specified
      console.log(
        `🎯 Player joining tic-tac-toe: ${wallet} with bet ${actualBetAmount} GOR`
      );

      const playerId = uuidv4();
      playerSockets.set(socket.id, {
        playerId,
        wallet,
        currentRoom: "ticTacToe",
      });

      // Find or create tic-tac-toe room
      let room = null;
      for (const [roomId, ticTacToeRoom] of ticTacToeRooms) {
        if (
          ticTacToeRoom.players.length < 2 &&
          ticTacToeRoom.betAmount === actualBetAmount
        ) {
          room = ticTacToeRoom;
          break;
        }
      }

      if (!room) {
        const roomId = uuidv4();
        room = new TicTacToeRoom(roomId, actualBetAmount);
        ticTacToeRooms.set(roomId, room);
        console.log(
          `🆕 Created new tic-tac-toe room: ${roomId} with bet ${actualBetAmount} GOR`
        );
      }

      const gameState = await room.addPlayer(
        playerId,
        socket.id,
        wallet,
        actualBetAmount
      );

      // Join socket room
      socket.join(room.roomId);

      // Update player's current room
      const playerInfo = playerSockets.get(socket.id);
      if (playerInfo) {
        playerInfo.currentRoom = room.roomId;
      }

      // Ensure user exists in database
      try {
        await getOrCreateUser(wallet);
      } catch (dbError) {
        console.log(
          `⚠️ Database user creation skipped for ${wallet}:`,
          dbError.message
        );
      }

      if (room.players.length === 1) {
        socket.emit("waitingForPlayer");
        console.log("⏳ Waiting for second player in room:", room.roomId);
      } else {
        // Both players joined
        console.log("✅ Both players joined tic-tac-toe room:", room.roomId);
        console.log(`🎲 [TicTacToe] Game entering betting phase`);

        // Send game state to both players with correct "isYou" flags
        room.players.forEach((player) => {
          const playerSocket = io.sockets.sockets.get(player.socketId);
          if (playerSocket) {
            const personalizedState = room.getGameState(player.id);
            playerSocket.emit("ticTacToeJoined", {
              gameState: personalizedState,
            });
            // Also emit state update to ensure frontend gets the betting phase
            playerSocket.emit("ticTacToeState", personalizedState);
          }
        });

        console.log(
          `💰 [TicTacToe] Betting phase active - players can now pay entry fees`
        );
        console.log(`   Required: ${room.betAmount} GOR per player`);
        console.log(`   Pool: ${room.betPool.totalAmount} GOR (when both pay)`);
        console.log(`   Winner gets: ${room.betPool.winnerPayout} GOR`);
        console.log(`   Platform fee: ${room.betPool.platformFee} GOR`);
      }
    } catch (error) {
      console.error("❌ Error joining tic-tac-toe:", error);
      socket.emit("error", { message: error.message });
    }
  });

  socket.on("ticTacToeChooseCoin", ({ player }) => {
    try {
      const playerInfo = playerSockets.get(socket.id);
      if (!playerInfo || !ticTacToeRooms.has(playerInfo.currentRoom)) return;

      const room = ticTacToeRooms.get(playerInfo.currentRoom);
      const success = room.setChoosingPlayer(playerInfo.playerId, player);

      if (success) {
        // Broadcast updated state to both players
        room.players.forEach((player) => {
          const playerSocket = io.sockets.sockets.get(player.socketId);
          if (playerSocket) {
            const personalizedState = room.getGameState(player.id);
            playerSocket.emit("ticTacToeState", personalizedState);
          }
        });
      }
    } catch (error) {
      socket.emit("error", { message: error.message });
    }
  });

  socket.on("ticTacToeCoinChoice", ({ choice }) => {
    try {
      const playerInfo = playerSockets.get(socket.id);
      if (!playerInfo || !ticTacToeRooms.has(playerInfo.currentRoom)) return;

      const room = ticTacToeRooms.get(playerInfo.currentRoom);
      const success = room.handleCoinChoice(playerInfo.playerId, choice);

      if (success) {
        // Broadcast state immediately and set up interval for live updates
        const broadcastState = () => {
          room.players.forEach((player) => {
            const playerSocket = io.sockets.sockets.get(player.socketId);
            if (playerSocket) {
              const personalizedState = room.getGameState(player.id);
              playerSocket.emit("ticTacToeState", personalizedState);
            }
          });
        };

        broadcastState();

        // Broadcast updates during coin flip animation and game start
        const interval = setInterval(() => {
          broadcastState();

          // Stop broadcasting once game is playing and stable
          if (room.gamePhase === "playing") {
            clearInterval(interval);
            // Final broadcast to ensure game board appears
            setTimeout(() => {
              broadcastState();
            }, 100);
          }
        }, 500);

        // Safety broadcast after the coin flip completes
        setTimeout(() => {
          broadcastState();
        }, 6000);
      }
    } catch (error) {
      socket.emit("error", { message: error.message });
    }
  });

  socket.on("ticTacToeLetOtherChoose", () => {
    try {
      const playerInfo = playerSockets.get(socket.id);
      if (!playerInfo || !ticTacToeRooms.has(playerInfo.currentRoom)) return;

      const room = ticTacToeRooms.get(playerInfo.currentRoom);
      const success = room.letOtherChoose(playerInfo.playerId);

      if (success) {
        // Broadcast updated state
        room.players.forEach((player) => {
          const playerSocket = io.sockets.sockets.get(player.socketId);
          if (playerSocket) {
            const personalizedState = room.getGameState(player.id);
            playerSocket.emit("ticTacToeState", personalizedState);
          }
        });
      }
    } catch (error) {
      socket.emit("error", { message: error.message });
    }
  });

  socket.on("confirmPayment", async ({ txSignature, gameId, amount }) => {
    try {
      const playerInfo = playerSockets.get(socket.id);
      if (!playerInfo || !ticTacToeRooms.has(playerInfo.currentRoom)) return;

      const room = ticTacToeRooms.get(playerInfo.currentRoom);

      console.log(`💰 [Socket] Payment confirmation received:`);
      console.log(`   Player: ${playerInfo.playerId}`);
      console.log(`   TX Signature: ${txSignature}`);
      console.log(`   Game ID: ${gameId}`);
      console.log(`   Amount: ${amount} GOR`);

      // Confirm payment with blockchain verification
      const confirmationResult = await room.confirmPayment(
        playerInfo.playerId,
        txSignature
      );

      if (confirmationResult.success) {
        console.log(
          `✅ [Socket] Payment successfully confirmed and verified on blockchain`
        );

        // Broadcast updated state to all players
        room.players.forEach((player) => {
          const playerSocket = io.sockets.sockets.get(player.socketId);
          if (playerSocket) {
            const personalizedState = room.getGameState(player.id);
            playerSocket.emit("ticTacToeState", personalizedState);
          }
        });

        // Send success response to player
        socket.emit("paymentConfirmed", {
          success: true,
          amount: confirmationResult.amount,
          txSignature: txSignature,
        });
      } else {
        console.error(
          `❌ [Socket] Payment confirmation failed: ${confirmationResult.error}`
        );

        // Send error response to player
        socket.emit("paymentConfirmed", {
          success: false,
          error: confirmationResult.error,
        });
      }
    } catch (error) {
      console.error(`❌ [Socket] Payment confirmation error:`, error);
      socket.emit("paymentConfirmed", {
        success: false,
        error: error.message,
      });
    }
  });

  socket.on("ticTacToeMove", async ({ cellIndex }) => {
    try {
      const playerInfo = playerSockets.get(socket.id);
      if (!playerInfo || !ticTacToeRooms.has(playerInfo.currentRoom)) return;

      const room = ticTacToeRooms.get(playerInfo.currentRoom);
      const success = await room.makeMove(playerInfo.playerId, cellIndex);

      if (success) {
        // Broadcast updated state to both players and spectators
        const allSockets = [...room.players, ...room.spectators];
        allSockets.forEach((participant) => {
          const participantSocket = io.sockets.sockets.get(
            participant.socketId
          );
          if (participantSocket) {
            const personalizedState = room.getGameState(participant.id);
            participantSocket.emit("ticTacToeState", personalizedState);
          }
        });
      }
    } catch (error) {
      socket.emit("error", { message: error.message });
    }
  });

  socket.on("ticTacToeReset", () => {
    try {
      const playerInfo = playerSockets.get(socket.id);
      if (!playerInfo || !ticTacToeRooms.has(playerInfo.currentRoom)) return;

      const room = ticTacToeRooms.get(playerInfo.currentRoom);
      room.resetGame();

      // Broadcast reset state to both players
      room.players.forEach((player) => {
        const playerSocket = io.sockets.sockets.get(player.socketId);
        if (playerSocket) {
          const personalizedState = room.getGameState(player.id);
          playerSocket.emit("ticTacToeState", personalizedState);
        }
      });
    } catch (error) {
      socket.emit("error", { message: error.message });
    }
  });

  // Orb Collector Game Events
  socket.on("joinOrbGame", async ({ walletAddress, betAmount, nickname }) => {
    try {
      console.log(
        `🔮 Player ${walletAddress.slice(
          0,
          8
        )}... wants to join orb game with bet ${betAmount}`
      );

      // Find or create orb collector room
      let orbRoom = null;
      for (const [roomId, room] of orbCollectorRooms) {
        if (room.status === "waiting" && room.players.size < room.maxPlayers) {
          orbRoom = room;
          break;
        }
      }

      if (!orbRoom) {
        const roomId = uuidv4();
        orbRoom = new OrbCollectorRoom(roomId, betAmount);
        orbCollectorRooms.set(roomId, orbRoom);
      }

      const playerId = uuidv4();
      const gameState = await orbRoom.addPlayer(
        playerId,
        socket.id,
        walletAddress,
        betAmount
      );

      // Join socket room
      socket.join(orbRoom.roomId);

      // Update player socket mapping
      playerSockets.set(socket.id, {
        playerId,
        wallet: walletAddress,
        currentRoom: orbRoom.roomId,
        roomType: "orbCollector",
      });

      // Broadcast game state to room
      io.to(orbRoom.roomId).emit("orbGameState", gameState);
    } catch (error) {
      console.error("Error joining orb game:", error);
      socket.emit("error", { message: error.message });
    }
  });

  socket.on("playerMove", ({ gameId, playerId, position }) => {
    try {
      const playerInfo = playerSockets.get(socket.id);
      if (!playerInfo || playerInfo.roomType !== "orbCollector") return;

      const orbRoom = orbCollectorRooms.get(playerInfo.currentRoom);
      if (!orbRoom || orbRoom.status !== "playing") return;

      const collectionResult = orbRoom.movePlayer(playerId, position);

      // Always broadcast updated game state for movement and scores
      const gameState = orbRoom.getGameState();
      io.to(orbRoom.roomId).emit("orbGameState", gameState);

      // Log collection for debugging
      if (collectionResult) {
        console.log(`🎯 Collection result:`, collectionResult);
      }
    } catch (error) {
      console.error("Error handling player move:", error);
    }
  });

  socket.on("collectOrb", ({ gameId, playerId, orbId }) => {
    try {
      const playerInfo = playerSockets.get(socket.id);
      if (!playerInfo || playerInfo.roomType !== "orbCollector") return;

      const orbRoom = orbCollectorRooms.get(playerInfo.currentRoom);
      if (!orbRoom || orbRoom.status !== "playing") return;

      // Manual orb collection (for click-to-collect)
      const player = orbRoom.players.get(playerId);
      const orb = orbRoom.orbs.get(orbId);

      if (player && orb) {
        const distance = Math.sqrt(
          Math.pow(orb.position.x - player.position.x, 2) +
            Math.pow(orb.position.z - player.position.z, 2)
        );

        if (distance < 1.5) {
          // Slightly larger threshold for clicks
          player.score += orb.value;
          orbRoom.orbs.delete(orbId);

          console.log(
            `🔮 Player ${player.walletAddress.slice(
              0,
              8
            )}... manually collected ${orb.type} orb`
          );

          // Broadcast collection
          io.to(orbRoom.roomId).emit("orbCollected", {
            orbId: orbId,
            playerId: playerId,
            value: orb.value,
          });

          // Broadcast updated game state
          const gameState = orbRoom.getGameState();
          io.to(orbRoom.roomId).emit("orbGameState", gameState);
        }
      }
    } catch (error) {
      console.error("Error handling orb collection:", error);
    }
  });

  // Word Grid Game Events - MOVED TO real-wallet-server.js for blockchain integration

  socket.on("disconnect", () => {
    console.log("🔌 Client disconnected:", socket.id);

    const playerInfo = playerSockets.get(socket.id);
    if (playerInfo) {
      if (playerInfo.currentRoom === "lobby") {
        lobby.removePlayer(playerInfo.playerId);
        io.emit("lobbyState", lobby.getLobbyState());
      } else if (gameRooms.has(playerInfo.currentRoom)) {
        const gameRoom = gameRooms.get(playerInfo.currentRoom);
        gameRoom.removePlayer(playerInfo.playerId);

        // Broadcast updated game state
        if (gameRoom.players.size > 0) {
          const gameState = gameRoom.getGameState();
          io.to(gameRoom.gameId).emit("gameState", gameState);
        } else {
          // Clean up empty game room
          gameRooms.delete(playerInfo.currentRoom);
        }
      } else if (ticTacToeRooms.has(playerInfo.currentRoom)) {
        // Handle tic-tac-toe room cleanup
        const room = ticTacToeRooms.get(playerInfo.currentRoom);
        room.removePlayer(playerInfo.playerId);

        if (room.players.length === 0) {
          // Clean up empty tic-tac-toe room
          ticTacToeRooms.delete(playerInfo.currentRoom);
          console.log(
            "🧹 Cleaned up empty tic-tac-toe room:",
            playerInfo.currentRoom
          );
        } else {
          // Notify remaining player
          const remainingPlayer = room.players[0];
          const playerSocket = io.sockets.sockets.get(remainingPlayer.socketId);
          if (playerSocket) {
            playerSocket.emit("waitingForPlayer");
            console.log("⏳ Remaining player waiting for new opponent");
          }
        }
      } else if (orbCollectorRooms.has(playerInfo.currentRoom)) {
        // Handle orb collector room cleanup
        const room = orbCollectorRooms.get(playerInfo.currentRoom);
        room.removePlayer(playerInfo.playerId);

        // Broadcast updated game state to remaining players
        if (room.players.size > 0) {
          const gameState = room.getGameState();
          io.to(room.roomId).emit("orbGameState", gameState);
        } else {
          // Clean up empty orb collector room
          room.cleanup();
          orbCollectorRooms.delete(playerInfo.currentRoom);
          console.log(
            "🧹 Cleaned up empty orb collector room:",
            playerInfo.currentRoom
          );
        }
      } else if (playerInfo.roomType === "wordGrid") {
        // Handle word grid room cleanup
        const room = wordGridRooms.get(playerInfo.currentRoom);
        if (room) {
          const remainingPlayers = room.players.filter(
            (p) => p.id !== playerInfo.playerId
          );

          if (remainingPlayers.length === 0) {
            // Clean up empty room
            wordGridRooms.delete(playerInfo.currentRoom);
            console.log(
              "🧹 Cleaned up empty Word Grid room:",
              playerInfo.currentRoom
            );
          } else {
            // Remove the disconnected player and notify remaining players
            room.players = remainingPlayers;
            io.to(room.roomId).emit("wordGridState", room.getGameState());
            console.log(
              "👋 Player left Word Grid room:",
              playerInfo.currentRoom
            );
          }
        }
      }

      playerSockets.delete(socket.id);
    }
  });

  // NEW: Orb Collector Payment Confirmation Handler
  socket.on("confirmOrbPayment", async ({ txSignature, gameId, amount }) => {
    try {
      const playerInfo = playerSockets.get(socket.id);
      if (!playerInfo || playerInfo.roomType !== "orbCollector") return;

      const orbRoom = orbCollectorRooms.get(playerInfo.currentRoom);
      if (!orbRoom) return;

      // Store transaction details
      const player = Array.from(orbRoom.players.values()).find(
        (p) => p.id === playerInfo.playerId
      );
      if (player) {
        player.txSignature = txSignature;
        player.gameId = gameId;
        player.actualPaidAmount = amount;
      }

      orbRoom.confirmPayment(playerInfo.playerId);

      // Broadcast updated state to all players
      const gameState = orbRoom.getGameState();
      io.to(orbRoom.roomId).emit("orbGameState", gameState);

      console.log(
        `💰 Orb game payment confirmed for player: ${playerInfo.playerId}`
      );
      console.log(`📝 TX Signature: ${txSignature}`);
      console.log(`💵 Amount: ${amount} GOR`);

      // Validate and collect entry fee with transaction verification
      try {
        console.log(`🔍 Validating orb game transaction: ${txSignature}`);
        const validationResult = await validateEntryFeePayment(
          playerInfo.wallet,
          orbRoom.roomId,
          txSignature
        );

        if (validationResult.verified) {
          console.log(
            `✅ Orb game transaction validated! Amount detected: ${validationResult.amount} GOR`
          );

          // Collect the validated entry fee
          const escrowResult = await collectValidatedEntryFee(
            playerInfo.wallet,
            validationResult.amount,
            orbRoom.roomId,
            txSignature
          );
          console.log(
            `✅ Orb game validated entry fee collected: ${escrowResult.signature}`
          );
        } else {
          console.error(
            `❌ Orb game transaction validation failed for ${txSignature}`
          );
        }
      } catch (error) {
        console.error(
          `❌ Failed to validate/collect orb game entry fee:`,
          error
        );
      }

      // If all players have paid, check platform balance
      const allPaid = Array.from(orbRoom.players.values()).every(
        (p) => p.paymentConfirmed
      );
      if (allPaid) {
        const betPool = orbRoom.calculateBetPool();
        console.log(`🏦 Creating escrow for orb game: ${orbRoom.roomId}`);
        console.log(`💰 Total pool: ${betPool.totalAmount} GOR`);
        console.log(`💸 Platform fee: ${betPool.platformFee} GOR`);

        try {
          const balanceCheck = await ensurePlatformBalance(betPool.prizePool);
          if (!balanceCheck.sufficient) {
            console.log(`⚠️ ${balanceCheck.message}`);
          }
        } catch (error) {
          console.error(
            `❌ Failed to check platform balance for orb game:`,
            error
          );
        }
      }
    } catch (error) {
      socket.emit("error", { message: error.message });
    }
  });

  // Word Grid Game Events
  socket.on("createWordGridRoom", async (data) => {
    try {
      console.log("🔤 Creating Word Grid room:", data);

      const { roomId, password, betAmount, wallet, txSignature } = data;

      if (!roomId || !wallet) {
        throw new Error("Room ID and wallet are required");
      }

      if (wordGridRooms.has(roomId)) {
        throw new Error("Room ID already exists");
      }

      // Create new Word Grid room
      const room = new WordGridRoom(roomId, betAmount, password, wallet);
      wordGridRooms.set(roomId, room);

      const playerId = uuidv4();
      await room.addPlayer(playerId, socket.id, wallet, betAmount);

      // Join socket room
      socket.join(roomId);

      // Update player socket mapping
      playerSockets.set(socket.id, {
        playerId,
        wallet,
        currentRoom: roomId,
        roomType: "wordGrid",
      });

      console.log(`✅ Word Grid room created: ${roomId}`);

      socket.emit("wordGridRoomCreated", {
        success: true,
        roomId: roomId,
        gameState: room.getGameState(),
      });

      // Confirm payment if transaction signature provided
      if (txSignature) {
        await room.confirmPayment(playerId, txSignature);
        socket.emit("wordGridState", room.getGameState());
      }
    } catch (error) {
      console.error("❌ Word Grid room creation error:", error);
      socket.emit("error", { message: error.message });
    }
  });

  socket.on("joinWordGridRoom", async (data) => {
    try {
      console.log("🔤 Joining Word Grid room:", data);

      const { roomId, password, betAmount, wallet, txSignature } = data;

      if (!roomId || !wallet) {
        throw new Error("Room ID and wallet are required");
      }

      const room = wordGridRooms.get(roomId);
      if (!room) {
        throw new Error("Room not found");
      }

      if (!room.verifyPassword(password)) {
        throw new Error("Invalid password");
      }

      const playerId = uuidv4();
      await room.addPlayer(playerId, socket.id, wallet, betAmount);

      // Join socket room
      socket.join(roomId);

      // Update player socket mapping
      playerSockets.set(socket.id, {
        playerId,
        wallet,
        currentRoom: roomId,
        roomType: "wordGrid",
      });

      console.log(`✅ Player joined Word Grid room: ${roomId}`);

      socket.emit("wordGridRoomJoined", {
        success: true,
        roomId: roomId,
        gameState: room.getGameState(),
      });

      // Broadcast updated state to all players
      io.to(roomId).emit("wordGridState", room.getGameState());

      // Confirm payment if transaction signature provided
      if (txSignature) {
        await room.confirmPayment(playerId, txSignature);
        io.to(roomId).emit("wordGridState", room.getGameState());
      }
    } catch (error) {
      console.error("❌ Word Grid room join error:", error);
      socket.emit("error", { message: error.message });
    }
  });

  socket.on("confirmWordGridPayment", async (data) => {
    try {
      const { txSignature } = data;
      const playerInfo = playerSockets.get(socket.id);

      if (!playerInfo || playerInfo.roomType !== "wordGrid") return;

      const room = wordGridRooms.get(playerInfo.currentRoom);
      if (!room) return;

      await room.confirmPayment(playerInfo.playerId, txSignature);
      io.to(room.roomId).emit("wordGridState", room.getGameState());
    } catch (error) {
      console.error("❌ Word Grid payment confirmation error:", error);
      socket.emit("error", { message: error.message });
    }
  });

  socket.on("placeWordGridLetter", (data) => {
    try {
      const { cellIndex, letter } = data;
      const playerInfo = playerSockets.get(socket.id);

      if (!playerInfo || playerInfo.roomType !== "wordGrid") return;

      const room = wordGridRooms.get(playerInfo.currentRoom);
      if (!room) return;

      room.placeLetter(playerInfo.playerId, cellIndex, letter);

      io.to(room.roomId).emit("wordGridLetterPlaced", {
        cellIndex,
        letter,
        playerId: playerInfo.playerId,
      });

      io.to(room.roomId).emit("wordGridState", room.getGameState());

      // Check if game should end (simplified logic)
      const allPlayersOutOfTime = room.players.every(
        (p) => p.timeRemaining <= 0
      );
      if (allPlayersOutOfTime) {
        const gameStats = room.finishGame("time_up");
        io.to(room.roomId).emit("wordGridGameFinished", gameStats);
      }
    } catch (error) {
      console.error("❌ Word Grid letter placement error:", error);
      socket.emit("error", { message: error.message });
    }
  });

  socket.on("wordGridTimeOut", (data) => {
    try {
      const { roomId } = data;
      const playerInfo = playerSockets.get(socket.id);

      if (!playerInfo || playerInfo.roomType !== "wordGrid") return;

      const room = wordGridRooms.get(roomId);
      if (!room) return;

      const gameStats = room.finishGame("time_up");
      io.to(room.roomId).emit("wordGridGameFinished", gameStats);
    } catch (error) {
      console.error("❌ Word Grid timeout error:", error);
    }
  });
});

// RPC Proxy endpoints to bypass CORS issues
app.post("/api/rpc-proxy", async (req, res) => {
  try {
    const { method, params } = req.body;

    const rpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: method,
      params: params || [],
    };

    console.log(`🌐 Proxying RPC call: ${method}`);

    const response = await fetch(
      process.env.GORBAGANA_RPC_URL || "https://rpc.gorbagana.wtf/",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(rpcRequest),
      }
    );

    if (!response.ok) {
      throw new Error(`RPC request failed: ${response.status}`);
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error("❌ RPC Proxy Error:", error);
    res.status(500).json({
      error: "RPC proxy failed",
      details: error.message,
    });
  }
});

// Get balance endpoint (server-side)
app.get("/api/balance/:wallet", async (req, res) => {
  try {
    const { wallet } = req.params;
    console.log(`💰 Fetching balance for: ${wallet}`);

    // Try native balance (GOR)
    const balanceRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "getBalance",
      params: [wallet],
    };

    const response = await fetch(
      process.env.GORBAGANA_RPC_URL || "https://rpc.gorbagana.wtf/",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(balanceRequest),
      }
    );

    if (!response.ok) {
      throw new Error(`Balance request failed: ${response.status}`);
    }

    const data = await response.json();

    if (data.result !== undefined) {
      const gorBalance = data.result.value / Math.pow(10, 9); // Convert lamports to GOR
      console.log(`✅ Found balance: ${gorBalance} GOR`);

      res.json({
        success: true,
        balance: gorBalance,
        raw: data.result.value,
        method: "native",
      });
    } else {
      console.log("⚠️ No balance found, returning 0");
      res.json({
        success: true,
        balance: 0,
        error: data.error,
        method: "native",
      });
    }
  } catch (error) {
    console.error("❌ Balance fetch error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
      balance: 0,
    });
  }
});

// Mock balance endpoint for demo mode
app.get("/api/mock-balance/:wallet", async (req, res) => {
  try {
    const { wallet } = req.params;
    const { getMockBalanceForWallet } = await import(
      "./smart-contract-integration.js"
    );

    const balance = getMockBalanceForWallet(wallet);
    res.json({
      wallet,
      balance,
      isMock: true,
      message: "Mock balance - for demo purposes only",
    });
  } catch (error) {
    console.error("Error getting mock balance:", error);
    res.status(500).json({
      error: "Failed to get mock balance",
      message: error.message,
    });
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    activeGames: gameRooms.size,
    ticTacToeRooms: ticTacToeRooms.size,
    orbCollectorRooms: orbCollectorRooms.size,
    wordGridRooms: wordGridRooms.size,
    lobbyPlayers: lobby.players.size,
    connectedSockets: playerSockets.size,
    blockchain: {
      network: "Gorbagana Testnet (Development Mode)",
      programId: PROGRAM_ID,
      ggorMint: GGOR_MINT,
      note: "Smart contracts integrated and ready for blockchain gaming",
    },
  });
});

// Game statistics endpoint
app.get("/stats", (req, res) => {
  const gameStats = Array.from(gameRooms.values()).map((room) => ({
    gameId: room.gameId,
    players: room.players.size,
    status: room.gameState,
    timeRemaining: room.timeRemaining,
    prizePool: room.totalPrizePool,
  }));

  const ticTacToeStats = Array.from(ticTacToeRooms.values()).map((room) => ({
    roomId: room.roomId,
    players: room.players.length,
    spectators: room.spectators.length,
    gamePhase: room.gamePhase,
    betPool: room.betPool,
  }));

  res.json({
    lobby: lobby.getLobbyState(),
    activeGames: gameStats,
    ticTacToeRooms: ticTacToeStats,
    config: GAME_CONFIG,
  });
});

// Leaderboard endpoint
app.get("/leaderboard/:gameType?", async (req, res) => {
  try {
    const gameType = req.params.gameType || "ticTacToe";
    const limit = parseInt(req.query.limit) || 10;

    const leaderboard = await getLeaderboard(gameType, limit);
    res.json({ leaderboard, gameType });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Recent matches endpoint
app.get("/matches/:gameType?", async (req, res) => {
  try {
    const gameType = req.params.gameType || "ticTacToe";
    const limit = parseInt(req.query.limit) || 20;

    const matches = await getRecentMatches(gameType, limit);
    res.json({ matches, gameType });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// User stats endpoint
app.get("/user/:wallet", async (req, res) => {
  try {
    const wallet = req.params.wallet;
    const user = await User.findOne({ walletAddress: wallet });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({ user });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3001;

// Timeout management for tic-tac-toe rooms
function checkForTimeouts() {
  const now = Date.now();
  const roomsToRemove = [];

  for (const [roomId, room] of ticTacToeRooms) {
    // Only check rooms with exactly one player waiting for an opponent
    if (room.players.length === 1 && room.gamePhase === "betting") {
      const waitingTime = now - room.createdAt;

      // Check if room has been waiting for more than 5 minutes
      if (waitingTime > room.timeoutDuration) {
        console.log(
          `⏰ Found timed out room: ${roomId} (waiting ${Math.floor(
            waitingTime / 1000
          )}s)`
        );

        // Trigger timeout handling
        room
          .handleWaitingTimeout()
          .then((result) => {
            if (result && result.shouldRemoveRoom) {
              // Notify the player about the timeout and refund
              const player = result.refundedPlayer;
              if (player && player.socketId) {
                const playerSocket = io.sockets.sockets.get(player.socketId);
                if (playerSocket) {
                  playerSocket.emit("ticTacToeTimeout", {
                    reason: "no_opponent",
                    message:
                      "No opponent found within 5 minutes. You have been refunded.",
                    refundAmount: player.betAmount,
                    redirectTo: "/games", // Redirect back to games list
                  });

                  // Remove player from room
                  playerSocket.leave(roomId);
                }
              }

              // Mark room for removal
              roomsToRemove.push(roomId);
            }
          })
          .catch((error) => {
            console.error(
              `❌ Error handling timeout for room ${roomId}:`,
              error
            );
          });
      }
    }
  }

  // Remove timed out rooms
  roomsToRemove.forEach((roomId) => {
    console.log(`🗑️ Removing timed out room: ${roomId}`);
    const room = ticTacToeRooms.get(roomId);
    if (room) {
      room.cleanup(); // Clean up any remaining timeouts
      ticTacToeRooms.delete(roomId);
    }
  });
}

// Run timeout check every 30 seconds
setInterval(checkForTimeouts, 30000);

// Initialize server with MongoDB connection
const startServer = async () => {
  try {
    // Connect to MongoDB
    await connectDB();

    // Setup demo routes (completely separate from real wallet games)
    setupDemoRoutes(app, io);

    // Setup real wallet routes (blockchain-integrated games)
    setupRealWalletRoutes(app, io);

    // Start the server
    server.listen(PORT, () => {
      console.log(`🚀 Gaming Platform server running on port ${PORT}`);
      console.log(`🗄️  MongoDB connected and ready`);
      console.log(`🔗 Gorbagana testnet integration ready`);
      console.log(`📋 Game Configuration:`, GAME_CONFIG);
      console.log(`🔗 Smart contracts ready for blockchain transactions`);
      console.log(`🎭 Demo routes initialized for mock gameplay`);
    });
  } catch (error) {
    console.error("❌ Failed to start server:", error);
    process.exit(1);
  }
};

startServer();

// Utility function to generate unique room IDs
function generateRoomId(gameType = "room") {
  let attempts = 0;
  const maxAttempts = 10;

  while (attempts < maxAttempts) {
    const timestamp = Date.now().toString(36);
    const randomStr = Math.random().toString(36).substring(2, 8);
    const roomId = `${gameType}_${timestamp}_${randomStr}`.toUpperCase();

    // Import the room storage from real-wallet-server if available
    let roomExists = false;

    // Check different game room types
    if (gameType.toLowerCase().includes("wordgrid")) {
      // Check if word grid room exists (would need to import from real-wallet-server)
      // For now, just use the generated ID since conflicts are very rare
      roomExists = false;
    } else if (gameType.toLowerCase().includes("pokemon")) {
      // Check if Pokemon room exists (would need to import from real-wallet-server)
      // For now, just use the generated ID since conflicts are very rare
      roomExists = false;
    } else if (gameType.toLowerCase().includes("tictactoe")) {
      roomExists = ticTacToeRooms.has(roomId);
    } else if (gameType.toLowerCase().includes("orb")) {
      roomExists = orbCollectorRooms.has(roomId);
    }

    if (!roomExists) {
      return roomId;
    }

    attempts++;
    // Add small delay to ensure different timestamp
    if (attempts < maxAttempts) {
      const start = Date.now();
      while (Date.now() - start < 2) {} // 2ms delay
    }
  }

  // Fallback with extra randomness if all attempts failed
  const timestamp = Date.now().toString(36);
  const extraRandom = Math.random().toString(36).substring(2, 12);
  return `${gameType}_${timestamp}_${extraRandom}`.toUpperCase();
}

// NEW: Generate Room ID endpoint
app.get("/api/generate-room-id/:gameType", (req, res) => {
  try {
    const { gameType } = req.params;
    const roomId = generateRoomId(gameType);

    console.log(`🎲 Generated room ID: ${roomId} for ${gameType}`);

    res.json({
      success: true,
      roomId: roomId,
      gameType: gameType,
    });
  } catch (error) {
    console.error("❌ Error generating room ID:", error);
    res.status(500).json({
      success: false,
      error: "Failed to generate room ID",
    });
  }
});

// Mock balance API endpoints
app.get("/api/mock-balance/:wallet", (req, res) => {
  try {
    const { wallet } = req.params;
    // Return a mock balance for development
    const mockBalance = 5.0; // 5 GOR for testing

    res.json({
      success: true,
      wallet: wallet,
      balance: mockBalance,
      currency: "GOR",
    });
  } catch (error) {
    console.error("❌ Error getting mock balance:", error);
    res.status(500).json({
      success: false,
      error: "Failed to get mock balance",
    });
  }
});

app.post("/api/mock-balance/:wallet", (req, res) => {
  try {
    const { wallet } = req.params;
    const { amount, operation } = req.body; // operation: 'add' or 'subtract'

    // Just return success for mock operations
    res.json({
      success: true,
      wallet: wallet,
      operation: operation,
      amount: amount,
      newBalance: 5.0, // Mock balance
    });
  } catch (error) {
    console.error("❌ Error updating mock balance:", error);
    res.status(500).json({
      success: false,
      error: "Failed to update mock balance",
    });
  }
});
