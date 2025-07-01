import express from "express";
import { Server } from "socket.io";
import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction,
  Keypair,
} from "@solana/web3.js";
import {
  createTransferInstruction,
  getOrCreateAssociatedTokenAccount,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import bs58 from "bs58";

// Real Gorbagana Network Configuration
const GORBAGANA_RPC =
  process.env.GORBAGANA_RPC_URL || "https://rpc.gorbagana.wtf/";
const connection = new Connection(GORBAGANA_RPC, "confirmed");

// GOR Token Configuration (Real Gorbagana GOR)
const GOR_MINT = new PublicKey("71Jvq4Epe2FCJ7JFSF7jLXdNk1Wy4Bhqd8iL6bEFELvg");
const GOR_DECIMALS = 9; // Real GOR decimals

// Platform Escrow Wallet
const PLATFORM_PRIVATE_KEY = process.env.PLATFORM_PRIVATE_KEY;
let platformWallet = null;

if (PLATFORM_PRIVATE_KEY) {
  try {
    let secretKey;

    // Try JSON format first (array of numbers)
    if (PLATFORM_PRIVATE_KEY.startsWith("[")) {
      const privateKeyBytes = JSON.parse(PLATFORM_PRIVATE_KEY);
      secretKey = new Uint8Array(privateKeyBytes);
    } else {
      // Try base58 format
      secretKey = bs58.decode(PLATFORM_PRIVATE_KEY);
    }

    platformWallet = Keypair.fromSecretKey(secretKey);
    console.log(
      `🔑 Platform escrow wallet: ${platformWallet.publicKey.toBase58()}`
    );
  } catch (error) {
    console.error("❌ Failed to load platform wallet:", error);
    console.error(
      "   Make sure PLATFORM_PRIVATE_KEY is in correct format (JSON array or base58)"
    );
  }
}

// Real wallet game classes with blockchain integration
class RealWalletTicTacToeRoom {
  constructor(roomId, betAmount = 1) {
    this.roomId = roomId;
    this.players = [];
    this.spectators = [];
    this.board = Array(9).fill(null);
    this.currentPlayer = "X";
    this.gamePhase = "waiting"; // waiting, paying, toss, playing, finished
    this.winner = null;
    this.betAmount = betAmount;
    this.escrowAccount = null; // Holds the GOR during game
    this.totalEscrowed = 0;
    this.paymentStatus = new Map(); // Track payment confirmations
  }

  async addPlayer(playerId, socketId, wallet, betAmount = null) {
    if (this.players.length >= 2) {
      throw new Error("Room is full");
    }

    if (this.gamePhase !== "waiting") {
      throw new Error("Game already in progress");
    }

    const actualBetAmount = betAmount || this.betAmount;
    const symbol = this.players.length === 0 ? "X" : "O";

    const player = {
      id: playerId,
      socketId: socketId,
      wallet: wallet,
      symbol: symbol,
      betAmount: actualBetAmount,
      paymentConfirmed: false,
      escrowTxSignature: null,
    };

    this.players.push(player);
    console.log(
      `🎮 Real wallet player ${wallet} joined tic-tac-toe room ${this.roomId}`
    );

    // Move to payment phase when 2 players join
    if (this.players.length === 2) {
      this.gamePhase = "paying";
      await this.initializeEscrow();
    }

    return this.getGameState();
  }

  async initializeEscrow() {
    if (!platformWallet) {
      throw new Error("Platform wallet required for escrow");
    }

    try {
      // Create escrow account for this game
      this.escrowAccount = platformWallet.publicKey; // Use platform wallet as escrow
      console.log(`💰 Escrow initialized for game ${this.roomId}`);
      console.log(`   Escrow account: ${this.escrowAccount.toBase58()}`);
      console.log(`   Total required: ${this.betAmount * 2} GOR`);
    } catch (error) {
      console.error("❌ Failed to initialize escrow:", error);
      throw error;
    }
  }

  async confirmPayment(playerId, txSignature) {
    const player = this.players.find((p) => p.id === playerId);
    if (!player) {
      throw new Error("Player not found");
    }

    try {
      // Verify the transaction on blockchain
      const verified = await this.verifyPaymentTransaction(
        player.wallet,
        txSignature,
        player.betAmount
      );

      if (verified) {
        player.paymentConfirmed = true;
        player.escrowTxSignature = txSignature;
        this.totalEscrowed += player.betAmount;

        console.log(
          `💰 Payment confirmed: ${player.betAmount} GOR from ${player.wallet}`
        );
        console.log(`   Transaction: ${txSignature}`);
        console.log(`   Total escrowed: ${this.totalEscrowed} GOR`);

        // Check if all players have paid
        const allPaid = this.players.every((p) => p.paymentConfirmed);
        if (allPaid) {
          this.gamePhase = "toss";
          console.log(`🎲 All payments confirmed, starting coin toss phase`);
        }

        return { success: true, verified: true };
      } else {
        return { success: false, error: "Payment verification failed" };
      }
    } catch (error) {
      console.error("❌ Payment confirmation error:", error);
      return { success: false, error: error.message };
    }
  }

  async verifyPaymentTransaction(playerWallet, txSignature, expectedAmount) {
    try {
      console.log(`🔍 Verifying payment transaction: ${txSignature}`);

      const transaction = await connection.getTransaction(txSignature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });

      if (!transaction) {
        console.log("❌ Transaction not found on blockchain");
        return false;
      }

      if (transaction.meta?.err) {
        console.log("❌ Transaction failed:", transaction.meta.err);
        return false;
      }

      // For GOR (native SOL-like token on Gorbagana), check balance changes
      const preBalances = transaction.meta.preBalances;
      const postBalances = transaction.meta.postBalances;

      // Find the player's account index
      const accountKeys = transaction.transaction.message.accountKeys.map(
        (key) => key.toBase58()
      );
      const playerIndex = accountKeys.indexOf(playerWallet);
      const platformIndex = accountKeys.indexOf(
        platformWallet.publicKey.toBase58()
      );

      if (playerIndex === -1) {
        console.log("❌ Player wallet not found in transaction");
        return false;
      }

      // Calculate the amount transferred (in lamports)
      const playerBalanceChange =
        preBalances[playerIndex] - postBalances[playerIndex];
      const expectedLamports = expectedAmount * Math.pow(10, GOR_DECIMALS);

      // Allow for transaction fees (small tolerance)
      const tolerance = 0.01 * Math.pow(10, GOR_DECIMALS); // 0.01 GOR tolerance for fees

      if (Math.abs(playerBalanceChange - expectedLamports) <= tolerance) {
        console.log(`✅ Payment verified: ${expectedAmount} GOR transferred`);
        return true;
      } else {
        console.log(
          `❌ Payment amount mismatch: expected ${expectedAmount} GOR, got ${
            playerBalanceChange / Math.pow(10, GOR_DECIMALS)
          } GOR`
        );
        return false;
      }
    } catch (error) {
      console.error("❌ Transaction verification error:", error);
      return false;
    }
  }

  makeMove(playerId, cellIndex) {
    if (this.gamePhase !== "playing") return null;
    if (this.board[cellIndex] !== null) return null;

    const player = this.players.find((p) => p.id === playerId);
    if (!player || player.symbol !== this.currentPlayer) return null;

    this.board[cellIndex] = this.currentPlayer;

    const winner = this.checkWinner();
    if (winner) {
      this.winner = winner;
      this.gamePhase = "finished";
      this.distributePrizes();
    } else {
      this.currentPlayer = this.currentPlayer === "X" ? "O" : "X";
    }

    return this.getGameState();
  }

  checkWinner() {
    const lines = [
      [0, 1, 2],
      [3, 4, 5],
      [6, 7, 8], // rows
      [0, 3, 6],
      [1, 4, 7],
      [2, 5, 8], // columns
      [0, 4, 8],
      [2, 4, 6], // diagonals
    ];

    for (const [a, b, c] of lines) {
      if (
        this.board[a] &&
        this.board[a] === this.board[b] &&
        this.board[a] === this.board[c]
      ) {
        return this.board[a];
      }
    }

    if (this.board.every((cell) => cell !== null)) {
      return "draw";
    }

    return null;
  }

  async distributePrizes() {
    if (!platformWallet) {
      console.error("❌ Platform wallet required for prize distribution");
      return;
    }

    try {
      const prizePool = this.totalEscrowed;
      const platformFee = prizePool * 0.1; // 10% platform fee
      const winnerPrize = prizePool - platformFee;

      console.log(`🏆 Distributing prizes for game ${this.roomId}`);
      console.log(`   Total pool: ${prizePool} GOR`);
      console.log(`   Platform fee: ${platformFee} GOR`);
      console.log(`   Winner prize: ${winnerPrize} GOR`);

      if (this.winner === "draw") {
        // Split the prize between both players
        const splitPrize = winnerPrize / 2;
        for (const player of this.players) {
          await this.sendPrizeToPlayer(player.wallet, splitPrize);
        }
        console.log(`🤝 Draw! Each player receives ${splitPrize} GOR`);
      } else {
        // Find the winning player
        const winningPlayer = this.players.find(
          (p) => p.symbol === this.winner
        );
        if (winningPlayer) {
          await this.sendPrizeToPlayer(winningPlayer.wallet, winnerPrize);
          console.log(
            `🎉 Winner ${winningPlayer.wallet} receives ${winnerPrize} GOR`
          );
        }
      }
    } catch (error) {
      console.error("❌ Prize distribution error:", error);
    }
  }

  async sendPrizeToPlayer(playerWallet, amount) {
    try {
      const transaction = new Transaction();

      // Create transfer instruction from escrow (platform wallet) to player
      const transferInstruction = SystemProgram.transfer({
        fromPubkey: platformWallet.publicKey,
        toPubkey: new PublicKey(playerWallet),
        lamports: amount * Math.pow(10, GOR_DECIMALS),
      });

      transaction.add(transferInstruction);

      // Send the transaction
      const signature = await sendAndConfirmTransaction(
        connection,
        transaction,
        [platformWallet],
        {
          commitment: "confirmed",
          preflightCommitment: "confirmed",
        }
      );

      console.log(`✅ Prize sent: ${amount} GOR → ${playerWallet}`);
      console.log(`   Transaction: ${signature}`);

      return { success: true, signature };
    } catch (error) {
      console.error(`❌ Failed to send prize to ${playerWallet}:`, error);
      return { success: false, error: error.message };
    }
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
      betAmount: this.betAmount,
      totalEscrowed: this.totalEscrowed,
      escrowAccount: this.escrowAccount?.toBase58(),
    };
  }
}

class RealWalletOrbCollectorRoom {
  constructor(roomId, betAmount = 1) {
    this.roomId = roomId;
    this.players = [];
    this.orbs = [];
    this.gameState = "waiting"; // waiting, paying, countdown, playing, finished
    this.timeRemaining = 60;
    this.countdownTime = 0;
    this.betAmount = betAmount;
    this.gameTimer = null;
    this.leaderboard = [];
    this.escrowAccount = null;
    this.totalEscrowed = 0;
  }

  async addPlayer(playerId, socketId, wallet, nickname) {
    if (this.players.length >= 6) {
      throw new Error("Room is full");
    }

    if (this.gameState !== "waiting") {
      throw new Error("Game already in progress");
    }

    const player = {
      id: playerId,
      socketId: socketId,
      walletAddress: wallet,
      position: { x: 0, y: 0.5, z: 0 },
      score: 0,
      color: `hsl(${Math.random() * 360}, 70%, 60%)`,
      nickname: nickname || `Player_${wallet.slice(-4)}`,
      paymentConfirmed: false,
      escrowTxSignature: null,
    };

    this.players.push(player);
    console.log(`🔮 Real wallet player ${wallet} joined orb collector`);

    // Initialize escrow when first player joins
    if (this.players.length === 1) {
      await this.initializeEscrow();
      this.gameState = "paying";
    }

    return this.getGameState();
  }

  async initializeEscrow() {
    if (!platformWallet) {
      throw new Error("Platform wallet required for escrow");
    }

    this.escrowAccount = platformWallet.publicKey;
    console.log(`💰 Orb collector escrow initialized for game ${this.roomId}`);
  }

  async confirmPayment(playerId, txSignature) {
    const player = this.players.find((p) => p.id === playerId);
    if (!player) {
      throw new Error("Player not found");
    }

    try {
      const verified = await this.verifyPaymentTransaction(
        player.walletAddress,
        txSignature,
        this.betAmount
      );

      if (verified) {
        player.paymentConfirmed = true;
        player.escrowTxSignature = txSignature;
        this.totalEscrowed += this.betAmount;

        console.log(
          `💰 Orb game payment confirmed: ${this.betAmount} GOR from ${player.walletAddress}`
        );

        // Start countdown when we have 2+ paid players
        if (this.players.filter((p) => p.paymentConfirmed).length >= 2) {
          this.startCountdown();
        }

        return { success: true, verified: true };
      } else {
        return { success: false, error: "Payment verification failed" };
      }
    } catch (error) {
      console.error("❌ Orb game payment confirmation error:", error);
      return { success: false, error: error.message };
    }
  }

  async verifyPaymentTransaction(playerWallet, txSignature, expectedAmount) {
    // Similar verification logic as TicTacToe
    try {
      const transaction = await connection.getTransaction(txSignature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });

      if (!transaction || transaction.meta?.err) {
        return false;
      }

      const preBalances = transaction.meta.preBalances;
      const postBalances = transaction.meta.postBalances;

      const accountKeys = transaction.transaction.message.accountKeys.map(
        (key) => key.toBase58()
      );
      const playerIndex = accountKeys.indexOf(playerWallet);

      if (playerIndex === -1) {
        return false;
      }

      const playerBalanceChange =
        preBalances[playerIndex] - postBalances[playerIndex];
      const expectedLamports = expectedAmount * Math.pow(10, GOR_DECIMALS);
      const tolerance = 0.01 * Math.pow(10, GOR_DECIMALS);

      return Math.abs(playerBalanceChange - expectedLamports) <= tolerance;
    } catch (error) {
      console.error("❌ Orb payment verification error:", error);
      return false;
    }
  }

  startCountdown() {
    this.gameState = "countdown";
    this.countdownTime = 5;

    const countdown = setInterval(() => {
      this.countdownTime--;
      if (this.countdownTime <= 0) {
        clearInterval(countdown);
        this.startGame();
      }
    }, 1000);
  }

  startGame() {
    this.gameState = "playing";
    this.timeRemaining = 60;
    this.spawnInitialOrbs();

    this.gameTimer = setInterval(() => {
      this.timeRemaining--;
      if (this.timeRemaining <= 0) {
        this.endGame();
      }
    }, 1000);
  }

  spawnInitialOrbs() {
    this.orbs = [];
    for (let i = 0; i < 15; i++) {
      this.createSingleOrb();
    }
  }

  createSingleOrb() {
    const types = [
      { type: "common", value: 1, glowColor: "#4FC3F7", weight: 70 },
      { type: "rare", value: 3, glowColor: "#AB47BC", weight: 25 },
      { type: "legendary", value: 5, glowColor: "#FFB74D", weight: 5 },
    ];

    const random = Math.random() * 100;
    let selectedType = types[0];
    let cumulative = 0;

    for (const type of types) {
      cumulative += type.weight;
      if (random <= cumulative) {
        selectedType = type;
        break;
      }
    }

    const orb = {
      id: `orb_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      position: this.getRandomOrbPosition(),
      value: selectedType.value,
      type: selectedType.type,
      glowColor: selectedType.glowColor,
    };

    this.orbs.push(orb);
  }

  getRandomOrbPosition() {
    return {
      x: (Math.random() - 0.5) * 18,
      y: Math.random() * 3 + 1,
      z: (Math.random() - 0.5) * 18,
    };
  }

  collectOrb(playerId, orbId) {
    const orbIndex = this.orbs.findIndex((o) => o.id === orbId);
    const player = this.players.find((p) => p.id === playerId);

    if (orbIndex !== -1 && player && player.paymentConfirmed) {
      const orb = this.orbs[orbIndex];
      player.score += orb.value;
      this.orbs.splice(orbIndex, 1);

      // Create new orb to maintain count
      this.createSingleOrb();

      console.log(
        `💎 Real wallet orb collected: ${orb.value} points for ${player.walletAddress}`
      );
      return { orbId, playerId, value: orb.value };
    }

    return null;
  }

  async endGame() {
    if (this.gameTimer) {
      clearInterval(this.gameTimer);
      this.gameTimer = null;
    }

    this.gameState = "finished";

    // Create leaderboard with only paid players
    const paidPlayers = this.players.filter((p) => p.paymentConfirmed);
    this.leaderboard = [...paidPlayers]
      .sort((a, b) => b.score - a.score)
      .map((p, index) => ({ ...p, rank: index + 1 }));

    console.log(
      `🏁 Real wallet orb game ended, winner: ${this.leaderboard[0]?.walletAddress}`
    );

    // Distribute prizes
    await this.distributePrizes();
  }

  async distributePrizes() {
    if (!platformWallet || this.leaderboard.length === 0) {
      return;
    }

    try {
      const prizePool = this.totalEscrowed;
      const platformFee = prizePool * 0.1;
      const totalPrizes = prizePool - platformFee;

      console.log(
        `🏆 Distributing orb collector prizes for game ${this.roomId}`
      );
      console.log(`   Total pool: ${prizePool} GOR`);
      console.log(`   Platform fee: ${platformFee} GOR`);
      console.log(`   Prize pool: ${totalPrizes} GOR`);

      // Prize distribution: 50% to winner, 30% to 2nd, 20% to 3rd
      const prizeDistribution = [0.5, 0.3, 0.2];

      for (let i = 0; i < Math.min(this.leaderboard.length, 3); i++) {
        const player = this.leaderboard[i];
        const prize = totalPrizes * prizeDistribution[i];

        if (prize > 0) {
          await this.sendPrizeToPlayer(player.walletAddress, prize);
          console.log(
            `🎉 Rank ${i + 1}: ${player.walletAddress} receives ${prize.toFixed(
              2
            )} GOR`
          );
        }
      }
    } catch (error) {
      console.error("❌ Orb collector prize distribution error:", error);
    }
  }

  async sendPrizeToPlayer(playerWallet, amount) {
    try {
      const transaction = new Transaction();

      const transferInstruction = SystemProgram.transfer({
        fromPubkey: platformWallet.publicKey,
        toPubkey: new PublicKey(playerWallet),
        lamports: amount * Math.pow(10, GOR_DECIMALS),
      });

      transaction.add(transferInstruction);

      const signature = await sendAndConfirmTransaction(
        connection,
        transaction,
        [platformWallet],
        {
          commitment: "confirmed",
          preflightCommitment: "confirmed",
        }
      );

      console.log(`✅ Orb prize sent: ${amount} GOR → ${playerWallet}`);
      return { success: true, signature };
    } catch (error) {
      console.error(`❌ Failed to send orb prize to ${playerWallet}:`, error);
      return { success: false, error: error.message };
    }
  }

  getGameState() {
    return {
      status: this.gameState,
      players: this.players,
      orbs: this.orbs,
      timeRemaining: this.timeRemaining,
      gameId: this.roomId,
      countdownTime: this.countdownTime,
      leaderboard: this.leaderboard,
      totalEscrowed: this.totalEscrowed,
      escrowAccount: this.escrowAccount?.toBase58(),
    };
  }
}

// Real wallet game storage
const realWalletTicTacToeRooms = new Map();
const realWalletOrbCollectorRooms = new Map();
const realWalletPlayerSockets = new Map();

// Setup real wallet routes
export function setupRealWalletRoutes(app, io) {
  console.log("🔗 Setting up REAL WALLET routes...");

  if (!platformWallet) {
    console.warn(
      "⚠️ Platform wallet not configured - real wallet games will be limited"
    );
  }

  // Real wallet balance endpoint
  app.get("/api/real-balance/:wallet", async (req, res) => {
    try {
      const { wallet } = req.params;
      console.log(`💰 Fetching real GOR balance for: ${wallet}`);

      const publicKey = new PublicKey(wallet);
      const balance = await connection.getBalance(publicKey);
      const gorBalance = balance / Math.pow(10, GOR_DECIMALS);

      console.log(`✅ Real balance found: ${gorBalance} GOR`);

      res.json({
        success: true,
        balance: gorBalance,
        raw: balance,
        mint: GOR_MINT.toBase58(),
        network: "Gorbagana",
      });
    } catch (error) {
      console.error("❌ Real balance fetch error:", error);
      res.status(500).json({
        success: false,
        error: error.message,
        balance: 0,
      });
    }
  });

  // Real wallet socket handling
  io.on("connection", (socket) => {
    console.log(`🔗 Real wallet client connected: ${socket.id}`);

    // Real Wallet Tic-Tac-Toe Events
    socket.on("joinRealTicTacToe", async (data) => {
      try {
        const { wallet, betAmount } = data;

        // Only handle real wallet addresses (not demo)
        if (wallet.startsWith("demo_")) {
          return; // Ignore demo requests
        }

        console.log(`🔗 Real tic-tac-toe join:`, { wallet, betAmount });

        // Find or create a real wallet room
        let room = Array.from(realWalletTicTacToeRooms.values()).find(
          (r) => r.players.length < 2 && r.gamePhase === "waiting"
        );

        if (!room) {
          const roomId = `real_ttt_${Date.now()}`;
          room = new RealWalletTicTacToeRoom(roomId, betAmount);
          realWalletTicTacToeRooms.set(roomId, room);
        }

        await room.addPlayer(socket.id, socket.id, wallet, betAmount);
        socket.join(room.roomId);

        realWalletPlayerSockets.set(socket.id, {
          playerId: socket.id,
          wallet: wallet,
          currentRoom: room.roomId,
          roomType: "realTicTacToe",
        });

        io.to(room.roomId).emit(
          "realTicTacToeState",
          room.getGameState(socket.id)
        );
      } catch (error) {
        console.error("❌ Real tic-tac-toe join error:", error);
        socket.emit("error", { message: error.message });
      }
    });

    socket.on("confirmRealPayment", async (data) => {
      try {
        const playerInfo = realWalletPlayerSockets.get(socket.id);
        if (!playerInfo || playerInfo.wallet.startsWith("demo_")) return;

        const { txSignature, gameId } = data;
        console.log(`💰 Real payment confirmation:`, { txSignature, gameId });

        // Confirm payment in appropriate room
        if (playerInfo.roomType === "realTicTacToe") {
          const room = realWalletTicTacToeRooms.get(playerInfo.currentRoom);
          if (room) {
            const result = await room.confirmPayment(socket.id, txSignature);
            if (result.success) {
              io.to(room.roomId).emit(
                "realTicTacToeState",
                room.getGameState(socket.id)
              );
            } else {
              socket.emit("paymentError", result.error);
            }
          }
        } else if (playerInfo.roomType === "realOrbCollector") {
          const room = realWalletOrbCollectorRooms.get(playerInfo.currentRoom);
          if (room) {
            const result = await room.confirmPayment(socket.id, txSignature);
            if (result.success) {
              io.to(room.roomId).emit("realOrbGameState", room.getGameState());
            } else {
              socket.emit("paymentError", result.error);
            }
          }
        }
      } catch (error) {
        console.error("❌ Real payment confirmation error:", error);
        socket.emit("paymentError", error.message);
      }
    });

    // Real Tic-Tac-Toe game moves
    socket.on("realTicTacToeMove", (data) => {
      try {
        const playerInfo = realWalletPlayerSockets.get(socket.id);
        if (!playerInfo || playerInfo.roomType !== "realTicTacToe") return;

        const room = realWalletTicTacToeRooms.get(playerInfo.currentRoom);
        if (room) {
          const gameState = room.makeMove(socket.id, data.cellIndex);
          if (gameState) {
            io.to(room.roomId).emit("realTicTacToeState", gameState);
          }
        }
      } catch (error) {
        console.error("❌ Real tic-tac-toe move error:", error);
      }
    });

    // Real Orb Collector Events
    socket.on("joinRealOrbGame", async (data) => {
      try {
        const { playerId, playerNickname, betAmount } = data;

        if (playerId.startsWith("demo_")) return; // Not a real wallet request

        console.log(`🔮 Real orb collector join:`, { playerId, betAmount });

        // Find or create real orb room
        let room = Array.from(realWalletOrbCollectorRooms.values()).find(
          (r) => r.gameState === "waiting" && r.players.length < 6
        );

        if (!room) {
          const roomId = `real_orb_${Date.now()}`;
          room = new RealWalletOrbCollectorRoom(roomId, betAmount);
          realWalletOrbCollectorRooms.set(roomId, room);
        }

        await room.addPlayer(socket.id, socket.id, playerId, playerNickname);
        socket.join(room.roomId);

        realWalletPlayerSockets.set(socket.id, {
          playerId: socket.id,
          wallet: playerId,
          currentRoom: room.roomId,
          roomType: "realOrbCollector",
        });

        io.to(room.roomId).emit("realOrbGameState", room.getGameState());
      } catch (error) {
        console.error("❌ Real orb collector join error:", error);
      }
    });

    socket.on("collectRealOrb", (data) => {
      try {
        const playerInfo = realWalletPlayerSockets.get(socket.id);
        if (!playerInfo || playerInfo.roomType !== "realOrbCollector") return;

        const room = realWalletOrbCollectorRooms.get(playerInfo.currentRoom);
        if (room) {
          const result = room.collectOrb(socket.id, data.orbId);
          if (result) {
            io.to(room.roomId).emit("realOrbCollected", result);
            io.to(room.roomId).emit("realOrbGameState", room.getGameState());
          }
        }
      } catch (error) {
        console.error("❌ Real orb collect error:", error);
      }
    });

    // Cleanup on disconnect
    socket.on("disconnect", () => {
      console.log(`🔗 Real wallet client disconnected: ${socket.id}`);

      const playerInfo = realWalletPlayerSockets.get(socket.id);
      if (playerInfo) {
        realWalletPlayerSockets.delete(socket.id);
      }
    });
  });

  console.log("✅ Real wallet routes setup complete!");
}
