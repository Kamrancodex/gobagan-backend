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
import {
  isValidWord,
  detectNewWords,
  findWordsInGrid,
} from "./word-dictionary.js";

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

// Storage for word grid rooms (other room types declared elsewhere)
const realWalletWordGridRooms = new Map();

// Storage for Pokemon card rooms
const realWalletPokemonRooms = new Map();

// Real wallet game classes with blockchain integration
class RealWalletWordGridRoom {
  constructor(
    roomId,
    betAmount = 1,
    password = null,
    creatorWallet = null,
    io = null
  ) {
    this.roomId = roomId;
    this.betAmount = betAmount;
    this.password = password;
    this.creatorWallet = creatorWallet;
    this.io = io; // 🚨 CRITICAL: Store socket.io instance for broadcasting
    this.maxPlayers = 2;
    this.players = [];
    this.gamePhase = "waiting"; // waiting, countdown, playing, finished
    this.currentPlayer = null;
    this.gameStartTime = null;
    this.totalGameTime = 150; // 150 seconds (2.5 minutes) TOTAL per player for entire game
    this.countdownTimer = null;
    this.turnTimer = null;
    this.gameTimer = null;

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
    this.totalEscrowed = 0;

    console.log(
      `🔤 Created Real Word Grid room: ${roomId} with bet ${betAmount} GOR`
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

    if (this.gamePhase !== "waiting") {
      throw new Error("Game already in progress");
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
      timeRemaining: this.totalGameTime, // Total time for entire game
      turnStartTime: null, // Track when current turn started
      totalTimeUsed: 0, // Track total time used across all turns
      isActive: false,
      paymentConfirmed: false,
      escrowTxSignature: null,
      wordsFound: [],
      totalLettersPlaced: 0,
      longestWord: 0,
      isCreator: wallet === this.creatorWallet, // Track room creator
    };

    this.players.push(player);

    console.log(
      `🔤 Player ${wallet.slice(0, 8)}... joined Word Grid room ${
        this.roomId
      } (${this.players.length}/${this.maxPlayers})`
    );

    return this.getGameState();
  }

  async confirmPayment(playerId, txSignature) {
    const player = this.players.find((p) => p.id === playerId);
    if (!player) {
      throw new Error("Player not found");
    }

    if (player.paymentConfirmed) {
      console.log(`⚠️ Player ${player.wallet} payment already confirmed`);
      return this.getGameState();
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
          `💰 Word Grid payment confirmed: ${player.betAmount} GOR from ${player.wallet}`
        );
        console.log(`   Transaction: ${txSignature}`);
        console.log(`   Total escrowed: ${this.totalEscrowed} GOR`);

        // Check if all players have paid
        const allPaid = this.players.every((p) => p.paymentConfirmed);
        const enoughPlayers = this.players.length === this.maxPlayers;

        if (allPaid && enoughPlayers) {
          console.log(
            `🚀 All Word Grid players paid - starting 10-second countdown`
          );
          this.startCountdown();
        }

        return { success: true, verified: true };
      } else {
        return { success: false, error: "Payment verification failed" };
      }
    } catch (error) {
      console.error("❌ Word Grid payment confirmation error:", error);
      return { success: false, error: error.message };
    }
  }

  async verifyPaymentTransaction(playerWallet, txSignature, expectedAmount) {
    try {
      console.log(`🔍 Verifying Word Grid payment: ${txSignature}`);

      const transaction = await connection.getTransaction(txSignature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });

      if (!transaction) {
        console.log("❌ Transaction not found");
        return false;
      }

      if (transaction.meta?.err) {
        console.log("❌ Transaction failed:", transaction.meta.err);
        return false;
      }

      // Verify payment amount and recipients
      const preBalances = transaction.meta.preBalances;
      const postBalances = transaction.meta.postBalances;
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

      const playerBalanceChange =
        (postBalances[playerIndex] - preBalances[playerIndex]) /
        Math.pow(10, GOR_DECIMALS);

      console.log(`💰 Player balance change: ${playerBalanceChange} GOR`);

      // Player should have lost at least the expected amount (negative change)
      return Math.abs(playerBalanceChange) >= expectedAmount * 0.95; // 5% tolerance for fees
    } catch (error) {
      console.error("❌ Transaction verification error:", error);
      return false;
    }
  }

  startCountdown() {
    if (this.gamePhase !== "waiting") return;

    this.gamePhase = "countdown";
    let countdown = 10;

    console.log(
      `⏱️ Starting 10-second countdown for Word Grid room ${this.roomId}`
    );

    this.countdownTimer = setInterval(() => {
      countdown--;

      if (countdown <= 0) {
        clearInterval(this.countdownTimer);

        // Start the game and broadcast the updated state
        const gameState = this.startGame();
        console.log(`📡 Broadcasting word grid game started event`);

        // This should be handled by the socket handler that manages this room
        // The broadcasting will be done in the main server socket handlers
      }
    }, 1000);
  }

  startGame() {
    if (this.players.length !== this.maxPlayers) {
      throw new Error("Need exactly 2 players to start");
    }

    if (!this.players.every((p) => p.paymentConfirmed)) {
      throw new Error("All players must confirm payment first");
    }

    this.gamePhase = "playing";
    this.gameStartTime = Date.now();

    // Room creator goes first (player with isCreator = true)
    const creator = this.players.find((p) => p.isCreator);
    const firstPlayer = creator || this.players[0]; // Fallback to first player

    this.currentPlayer = firstPlayer.id;
    firstPlayer.isActive = true;
    firstPlayer.turnStartTime = Date.now(); // Start tracking turn time

    // Make sure other players are inactive and have no active timer
    this.players.forEach((player) => {
      if (player.id !== firstPlayer.id) {
        player.isActive = false;
      }
    });

    console.log(`🚀 Word Grid game started in room ${this.roomId}`);
    console.log(`🎯 Creator goes first: ${firstPlayer.wallet.slice(0, 8)}...`);

    this.startTurnTimer();

    // 🚨 CRITICAL: Broadcast game state after starting
    const gameState = this.getGameState();
    console.log(`📡 Broadcasting game started state to all players`);

    // Broadcast to all players in the room
    if (this.io) {
      this.io.to(this.roomId).emit("wordGridGameStarted", gameState);
      this.io.to(this.roomId).emit("wordGridState", gameState);
      console.log(`✅ Game state broadcasted to room ${this.roomId}`);
    } else {
      console.warn(`⚠️ No socket.io instance available for broadcasting`);
    }

    return gameState;
  }

  startTurnTimer() {
    if (this.turnTimer) {
      clearInterval(this.turnTimer);
    }

    this.turnTimer = setInterval(() => {
      const activePlayer = this.players.find(
        (p) => p.id === this.currentPlayer
      );
      if (!activePlayer || !activePlayer.turnStartTime) return;

      // Calculate time used in current turn
      const currentTurnTime = Math.floor(
        (Date.now() - activePlayer.turnStartTime) / 1000
      );
      const totalTimeUsed = activePlayer.totalTimeUsed + currentTurnTime;

      // Update remaining time
      activePlayer.timeRemaining = Math.max(
        0,
        this.totalGameTime - totalTimeUsed
      );

      if (activePlayer.timeRemaining <= 0) {
        console.log(
          `⏰ Player ${activePlayer.wallet.slice(
            0,
            8
          )}... ran out of time! Total used: ${totalTimeUsed}s`
        );
        this.switchTurn();
      }
    }, 1000);
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

    if (this.grid[cellIndex].letter !== "") {
      throw new Error("Cell already occupied");
    }

    if (!/^[A-Z]$/i.test(letter)) {
      throw new Error("Letter must be A-Z");
    }

    const upperLetter = letter.toUpperCase();
    const currentPlayerObj = this.players.find((p) => p.id === playerId);

    // Place the letter
    this.grid[cellIndex] = {
      letter: upperLetter,
      playerId: playerId,
      isNewWord: false,
    };

    // Record the move
    this.moveHistory.push({
      playerId: playerId,
      cellIndex: cellIndex,
      letter: upperLetter,
      timestamp: Date.now(),
      moveNumber: this.moveHistory.length + 1,
    });

    currentPlayerObj.totalLettersPlaced++;

    console.log(
      `📝 Letter '${upperLetter}' placed at cell ${cellIndex} by ${currentPlayerObj.wallet.slice(
        0,
        8
      )}...`
    );

    // 🚨 NEW COMPREHENSIVE WORD DETECTION
    // Check ENTIRE GRID in ALL DIRECTIONS every time
    const allCurrentWords = this.findAllWordsInGrid();

    // Get previously found words (just the word strings)
    const previousWordStrings = this.wordHistory.map((w) =>
      w.word.toUpperCase()
    );

    // Find truly NEW words (not previously counted)
    const newWords = allCurrentWords.filter(
      (wordObj) => !previousWordStrings.includes(wordObj.word.toUpperCase())
    );

    let pointsEarned = 0;
    if (newWords.length > 0) {
      console.log(
        `🎉 NEW words found in entire grid:`,
        newWords.map((w) => `${w.word} (${w.word.length}pts)`)
      );
      console.log(
        `📊 Total words in grid: ${allCurrentWords.length}, Previously found: ${previousWordStrings.length}, New: ${newWords.length}`
      );

      // Mark cells that are part of new words
      newWords.forEach((wordObj) => {
        wordObj.coordinates.forEach((cellIdx) => {
          if (this.grid[cellIdx]) {
            this.grid[cellIdx].isNewWord = true;
          }
        });
      });

      // Add new words to history
      const wordsToAdd = newWords.map((w) => ({
        word: w.word,
        points: w.word.length, // Points = word length
        coordinates: w.coordinates,
        direction: w.direction,
        playerId: playerId, // Player who completed this word gets the points
        timestamp: Date.now(),
      }));

      this.wordHistory.push(...wordsToAdd);

      // Award points to the current player (player who placed the completing letter)
      pointsEarned = newWords.reduce((sum, w) => sum + w.word.length, 0);
      currentPlayerObj.score += pointsEarned;
      currentPlayerObj.wordsFound.push(...newWords.map((w) => w.word));

      // Track longest word
      const longestNewWord = Math.max(...newWords.map((w) => w.word.length));
      if (longestNewWord > currentPlayerObj.longestWord) {
        currentPlayerObj.longestWord = longestNewWord;
      }

      console.log(
        `🏆 Player ${currentPlayerObj.wallet.slice(
          0,
          8
        )}... earned ${pointsEarned} points for ${
          newWords.length
        } new words! Total: ${currentPlayerObj.score}`
      );
    } else {
      console.log(
        `📝 No new words found (grid has ${allCurrentWords.length} total words, all previously counted)`
      );
    }

    // Switch to next player
    this.switchTurn();

    // Check if game should end (grid full)
    const emptySpots = this.grid.filter((cell) => cell.letter === "").length;
    if (emptySpots === 0) {
      console.log(`🏁 Word Grid game ending - grid is full`);
      setTimeout(() => this.finishGame("grid_full"), 1000);
    }

    return {
      grid: this.grid,
      players: this.players,
      nextPlayer: this.currentPlayer,
      moveNumber: this.moveHistory.length,
      emptySpots: emptySpots,
      newWords: newWords || [],
      pointsEarned: pointsEarned,
    };
  }

  switchTurn() {
    // Stop current timer
    if (this.turnTimer) {
      clearInterval(this.turnTimer);
    }

    // Save time used by current player
    const currentPlayerObj = this.players.find(
      (p) => p.id === this.currentPlayer
    );
    if (currentPlayerObj && currentPlayerObj.turnStartTime) {
      const turnTimeUsed = Math.floor(
        (Date.now() - currentPlayerObj.turnStartTime) / 1000
      );
      currentPlayerObj.totalTimeUsed += turnTimeUsed;
      currentPlayerObj.timeRemaining = Math.max(
        0,
        this.totalGameTime - currentPlayerObj.totalTimeUsed
      );
      currentPlayerObj.isActive = false;
      currentPlayerObj.turnStartTime = null;

      console.log(
        `⏱️ Player ${currentPlayerObj.wallet.slice(
          0,
          8
        )}... used ${turnTimeUsed}s this turn, ${
          currentPlayerObj.totalTimeUsed
        }s total, ${currentPlayerObj.timeRemaining}s remaining`
      );
    }

    // Find next player
    const currentIndex = this.players.findIndex(
      (p) => p.id === this.currentPlayer
    );
    const nextIndex = (currentIndex + 1) % this.players.length;
    const nextPlayer = this.players[nextIndex];

    // Check if next player has time left
    if (nextPlayer.timeRemaining <= 0) {
      console.log(
        `⏰ Next player ${nextPlayer.wallet.slice(
          0,
          8
        )}... has no time left! Game ending...`
      );

      // Award time bonus to current player (1 point per second remaining)
      if (currentPlayerObj && currentPlayerObj.timeRemaining > 0) {
        const timeBonus = Math.floor(currentPlayerObj.timeRemaining);
        currentPlayerObj.score += timeBonus;
        console.log(
          `⏱️ Time bonus: +${timeBonus} points to ${currentPlayerObj.wallet.slice(
            0,
            8
          )}... (${currentPlayerObj.timeRemaining}s remaining)`
        );

        // Broadcast the score update
        if (this.io) {
          this.io.to(this.roomId).emit("wordGridState", this.getGameState());
        }
      }

      setTimeout(() => this.finishGame("time_up"), 1000);
      return;
    }

    this.currentPlayer = nextPlayer.id;
    nextPlayer.isActive = true;
    nextPlayer.turnStartTime = Date.now(); // Start tracking new turn

    console.log(
      `🔄 Turn switched to ${nextPlayer.wallet.slice(0, 8)}... (${
        nextPlayer.timeRemaining
      }s remaining)`
    );

    // Start timer for new player
    this.startTurnTimer();

    // 🚨 CRITICAL: Broadcast turn change
    if (this.io) {
      const gameState = this.getGameState();
      this.io.to(this.roomId).emit("wordGridState", gameState);
      console.log(`📡 Turn switch broadcasted to room ${this.roomId}`);
    }
  }

  async finishGame(reason = "normal") {
    console.log(
      `🏁 Word Grid game finishing in room ${this.roomId}, reason: ${reason}`
    );

    this.gamePhase = "finished";

    // Stop all timers
    if (this.gameTimer) clearInterval(this.gameTimer);
    if (this.turnTimer) clearInterval(this.turnTimer);
    if (this.countdownTimer) clearInterval(this.countdownTimer);

    // If game ended due to time, award final time bonuses
    if (reason === "time_up") {
      this.players.forEach((player) => {
        if (player.timeRemaining > 0) {
          const timeBonus = Math.floor(player.timeRemaining);
          player.score += timeBonus;
          console.log(
            `⏱️ Final time bonus: +${timeBonus} points to ${player.wallet.slice(
              0,
              8
            )}... (${player.timeRemaining}s remaining)`
          );
        }
      });
    }

    // Calculate final scores and rankings
    const sortedPlayers = [...this.players].sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.longestWord !== a.longestWord) return b.longestWord - a.longestWord;
      return b.totalLettersPlaced - a.totalLettersPlaced;
    });

    // Assign final rankings
    sortedPlayers.forEach((player, index) => {
      player.finalRank = index + 1;
    });

    const winner = sortedPlayers[0];
    const loser = sortedPlayers[1];
    const betPool = this.calculateBetPool();

    const gameStats = {
      winner: winner,
      loser: loser,
      reason: reason,
      finalStandings: sortedPlayers.map((player) => ({
        wallet: player.wallet,
        rank: player.finalRank,
        score: player.score,
        wordsFound: player.wordsFound.length,
        longestWord: player.longestWord,
        totalLettersPlaced: player.totalLettersPlaced,
        timeRemaining: player.timeRemaining,
        betAmount: player.betAmount,
        prize: player.finalRank === 1 ? betPool.prizePool : 0,
      })),
      betPool: betPool,
      roomId: this.roomId,
    };

    console.log(
      `🏆 Word Grid Winner: ${winner.wallet.slice(0, 8)}... with ${
        winner.score
      } points (${loser.score} vs ${winner.score})`
    );
    console.log(
      `💰 Prize: ${betPool.prizePool} GOR to winner, Platform fee: ${betPool.platformFee} GOR`
    );

    // Broadcast final results
    if (this.io) {
      this.io.to(this.roomId).emit("wordGridGameFinished", gameStats);
    }

    // Distribute prizes
    try {
      await this.distributePrizes(gameStats);
    } catch (error) {
      console.error(`❌ Failed to distribute Word Grid prizes:`, error);
    }

    return gameStats;
  }

  calculateBetPool() {
    const totalBets = this.players.reduce(
      (sum, player) => sum + player.betAmount,
      0
    );
    const platformFee = totalBets * 0.1; // 10% platform fee

    return {
      totalAmount: totalBets,
      platformFee: platformFee,
      prizePool: totalBets - platformFee,
    };
  }

  async distributePrizes(gameStats) {
    if (!platformWallet) {
      console.error("❌ Platform wallet required for prize distribution");
      return;
    }

    try {
      const winner = gameStats.winner;
      const loser = gameStats.loser;
      const prizeAmount = gameStats.betPool.prizePool;
      const platformFee = gameStats.betPool.platformFee;

      console.log(`🎯 WORD GRID PRIZE DISTRIBUTION:`);
      console.log(
        `   Winner: ${winner.wallet.slice(0, 8)}... (${winner.score} points)`
      );
      console.log(
        `   Loser: ${loser.wallet.slice(0, 8)}... (${loser.score} points)`
      );
      console.log(`   Total Pool: ${gameStats.betPool.totalAmount} GOR`);
      console.log(`   Platform Fee (10%): ${platformFee} GOR`);
      console.log(`   Winner Prize (90%): ${prizeAmount} GOR`);

      if (prizeAmount > 0) {
        const txSignature = await this.sendPrizeToPlayer(
          winner.wallet,
          prizeAmount
        );
        console.log(`✅ Word Grid prize sent successfully!`);
        console.log(`   Amount: ${prizeAmount} GOR`);
        console.log(`   To: ${winner.wallet}`);
        console.log(`   TX: ${txSignature}`);

        return {
          success: true,
          winner: winner.wallet,
          amount: prizeAmount,
          txSignature: txSignature,
        };
      } else {
        console.log(`⚠️ No prize to distribute (amount: ${prizeAmount})`);
        return { success: false, reason: "No prize amount" };
      }
    } catch (error) {
      console.error("❌ Word Grid prize distribution error:", error);
      return { success: false, error: error.message };
    }
  }

  async sendPrizeToPlayer(playerWallet, amount) {
    try {
      const playerPublicKey = new PublicKey(playerWallet);
      const amountLamports = Math.floor(amount * Math.pow(10, GOR_DECIMALS));

      console.log(
        `💸 Sending ${amount} GOR (${amountLamports} lamports) to ${playerWallet.slice(
          0,
          8
        )}...`
      );

      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: platformWallet.publicKey,
          toPubkey: playerPublicKey,
          lamports: amountLamports,
        })
      );

      const signature = await sendAndConfirmTransaction(
        connection,
        transaction,
        [platformWallet]
      );

      console.log(
        `✅ Prize sent: ${amount} GOR to ${playerWallet.slice(0, 8)}...`
      );
      console.log(`   Transaction: ${signature}`);
      return signature;
    } catch (error) {
      console.error(`❌ Failed to send prize to ${playerWallet}:`, error);
      throw error;
    }
  }

  // 🚨 COMPREHENSIVE WORD DETECTION - ALL DIRECTIONS & LENGTHS
  findAllWordsInGrid() {
    const words = [];
    const gridSize = 8;

    // Helper to get letter at row/col
    const getLetter = (row, col) => {
      if (row < 0 || row >= gridSize || col < 0 || col >= gridSize) return "";
      return this.grid[row * gridSize + col]?.letter || "";
    };

    // Check for words in all directions and all possible lengths
    const checkAllWordsFromPosition = (startRow, startCol) => {
      if (!getLetter(startRow, startCol)) return;

      // All 8 directions
      const directions = [
        [0, 1], // right
        [1, 0], // down
        [1, 1], // diagonal down-right
        [1, -1], // diagonal down-left
        [0, -1], // left
        [-1, 0], // up
        [-1, -1], // diagonal up-left
        [-1, 1], // diagonal up-right
      ];

      directions.forEach(([dr, dc]) => {
        // Try different word lengths (2 to 8 letters)
        for (let length = 2; length <= 8; length++) {
          let word = "";
          let coordinates = [];
          let valid = true;

          // Build word of specific length in this direction
          for (let i = 0; i < length; i++) {
            const row = startRow + dr * i;
            const col = startCol + dc * i;
            const letter = getLetter(row, col);

            if (!letter) {
              valid = false;
              break;
            }

            word += letter;
            coordinates.push(row * gridSize + col);
          }

          // Check if this word is valid
          if (valid && word.length >= 2 && isValidWord(word)) {
            words.push({
              word: word.toUpperCase(),
              coordinates: coordinates,
              direction: `${dr},${dc}`,
              startPos: `${startRow},${startCol}`,
            });
          }
        }
      });
    };

    // Check from every position in the grid
    for (let row = 0; row < gridSize; row++) {
      for (let col = 0; col < gridSize; col++) {
        checkAllWordsFromPosition(row, col);
      }
    }

    // Remove duplicates - same word in same positions
    const uniqueWords = [];
    const seen = new Set();

    words.forEach((wordObj) => {
      const key = `${wordObj.word}:${wordObj.coordinates
        .sort((a, b) => a - b)
        .join(",")}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueWords.push(wordObj);
      }
    });

    // Sort by word length (longer words first) then alphabetically
    uniqueWords.sort((a, b) => {
      if (a.word.length !== b.word.length) {
        return b.word.length - a.word.length;
      }
      return a.word.localeCompare(b.word);
    });

    console.log(
      `🔍 Found ${uniqueWords.length} unique valid words:`,
      uniqueWords
        .slice(0, 10)
        .map((w) => `${w.word}(${w.word.length})`)
        .join(", ") + (uniqueWords.length > 10 ? "..." : "")
    );

    return uniqueWords;
  }

  cleanup() {
    if (this.gameTimer) clearInterval(this.gameTimer);
    if (this.turnTimer) clearInterval(this.turnTimer);
    if (this.countdownTimer) clearInterval(this.countdownTimer);
    console.log(`🔤 Cleaned up Word Grid room ${this.roomId}`);
  }

  getGameState() {
    const gameState = {
      roomId: this.roomId,
      gamePhase: this.gamePhase,
      players: this.players.map((p) => ({
        id: p.id,
        wallet: p.wallet,
        nickname: p.nickname,
        score: p.score,
        timeRemaining: p.timeRemaining,
        isActive: p.isActive,
        paymentConfirmed: p.paymentConfirmed,
        isCreator: p.isCreator,
        totalLettersPlaced: p.totalLettersPlaced,
        longestWord: p.longestWord,
      })),
      grid: this.grid,
      currentPlayer: this.currentPlayer,
      betAmount: this.betAmount,
      hasPassword: !!this.password,
      wordHistory: this.wordHistory,
      moveHistory: this.moveHistory,
      totalEscrowed: this.totalEscrowed,
    };

    // 🚨 DEBUG LOGGING - Remove after fixing
    console.log("🔍 GAME STATE DEBUG:", {
      roomId: this.roomId,
      gamePhase: this.gamePhase,
      currentPlayer: this.currentPlayer,
      players: this.players.map((p) => ({
        id: p.id,
        wallet: p.wallet.slice(0, 8),
        active: p.isActive,
        time: p.timeRemaining,
        isCreator: p.isCreator,
      })),
    });

    return gameState;
  }
}

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

    if (this.gameState !== "waiting" && this.gameState !== "paying") {
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

    console.log(`🔮 Starting countdown for orb collector room ${this.roomId}`);

    const countdown = setInterval(() => {
      this.countdownTime--;
      console.log(`🔮 Countdown: ${this.countdownTime} seconds remaining`);

      // Broadcast countdown updates
      if (realWalletIo) {
        const gameState = this.getGameState();
        realWalletIo.to(this.roomId).emit("realOrbGameState", gameState);
      }

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

    console.log(
      `🔮 Starting orb collector game ${this.roomId} with ${this.players.length} players`
    );

    // Broadcast initial game state when game starts
    if (realWalletIo) {
      const gameState = this.getGameState();
      realWalletIo.to(this.roomId).emit("realOrbGameState", gameState);
    }

    this.gameTimer = setInterval(() => {
      this.timeRemaining--;

      // Broadcast periodic updates during gameplay
      if (this.timeRemaining % 5 === 0 && realWalletIo) {
        const gameState = this.getGameState();
        realWalletIo.to(this.roomId).emit("realOrbGameState", gameState);
      }

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

    // Broadcast final game state
    if (realWalletIo) {
      const gameState = this.getGameState();
      realWalletIo.to(this.roomId).emit("realOrbGameState", gameState);
      realWalletIo.to(this.roomId).emit("gameEnd", {
        gameId: this.roomId,
        leaderboard: this.leaderboard,
        totalEscrowed: this.totalEscrowed,
      });
    }

    // Distribute prizes
    await this.distributePrizes();
  }

  async distributePrizes() {
    if (!platformWallet || this.leaderboard.length === 0) {
      return;
    }

    try {
      const prizePool = this.totalEscrowed;
      const platformFee = prizePool * 0.1; // 10% platform fee
      const winnerPrize = prizePool - platformFee; // 90% to winner

      console.log(
        `🏆 Distributing orb collector prizes for game ${this.roomId}`
      );
      console.log(`   Total pool: ${prizePool} GOR`);
      console.log(`   Platform fee: ${platformFee} GOR`);
      console.log(`   Winner prize: ${winnerPrize} GOR`);

      // Winner takes all (like tic-tac-toe)
      const winner = this.leaderboard[0];
      if (winner && winnerPrize > 0) {
        await this.sendPrizeToPlayer(winner.walletAddress, winnerPrize);
        console.log(
          `🎉 Winner: ${winner.walletAddress} receives ${winnerPrize.toFixed(
            2
          )} GOR`
        );
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

// Real Pokemon Card Room Class
class RealWalletPokemonRoom {
  constructor(
    roomId,
    betAmount = 1,
    playerCount = 2,
    password = null,
    io = null
  ) {
    this.roomId = roomId;
    this.betAmount = betAmount;
    this.playerCount = playerCount; // 2-6 players
    this.password = password;
    this.io = io;
    this.maxPlayers = playerCount;
    this.players = [];
    this.gamePhase = "waiting"; // waiting, countdown, playing, finished
    this.countdownTimer = null;
    this.gameTimer = null;
    this.totalEscrowed = 0;
    this.gameStartTime = null;
    this.gameDuration = 15 * 60 * 1000; // 15 minutes in milliseconds

    // Pokemon-specific game state
    this.pokemonCards = [];
    this.gameState = {
      currentTurn: null,
      roundNumber: 1,
      maxRounds: 5,
    };

    console.log(
      `🎴 Created Real Pokemon room: ${roomId} with bet ${betAmount} GOR for ${playerCount} players`
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

    if (this.gamePhase !== "waiting") {
      throw new Error("Game already in progress");
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
      ready: false,
      paymentConfirmed: false,
      escrowTxSignature: null,
      pokemonCards: [],
      score: 0,
      hp: 100,
    };

    this.players.push(player);

    console.log(
      `🎴 Player ${wallet.slice(0, 8)}... joined Pokemon room ${this.roomId} (${
        this.players.length
      }/${this.maxPlayers})`
    );

    return this.getGameState();
  }

  async confirmPayment(playerId, txSignature) {
    console.log(`💰 Pokemon confirmPayment called:`, {
      playerId,
      txSignature,
      roomId: this.roomId,
    });

    const player = this.players.find((p) => p.id === playerId);
    if (!player) {
      console.log(`❌ Player not found: ${playerId}`);
      throw new Error("Player not found");
    }

    if (player.paymentConfirmed) {
      console.log(`⚠️ Player ${player.wallet} payment already confirmed`);
      return { success: true, gameState: this.getGameState() };
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
          `💰 Pokemon payment confirmed: ${player.betAmount} GOR from ${player.wallet}`
        );
        console.log(`   Transaction: ${txSignature}`);
        console.log(`   Total escrowed: ${this.totalEscrowed} GOR`);

        // Check if all players have paid
        const allPaid = this.players.every((p) => p.paymentConfirmed);
        const enoughPlayers = this.players.length >= 2; // Minimum 2 players
        const roomFull = this.players.length === this.maxPlayers;

        console.log(`🎴 Pokemon payment status check:`, {
          playersCount: this.players.length,
          allPaid,
          enoughPlayers,
          roomFull,
          playerPayments: this.players.map((p) => ({
            wallet: p.wallet.slice(0, 8) + "...",
            paid: p.paymentConfirmed,
          })),
        });

        if (allPaid && (roomFull || enoughPlayers)) {
          console.log(
            `🚀 All Pokemon players paid - starting 5-second countdown`
          );
          this.startCountdown();
        } else {
          console.log(`⏳ Waiting for more payments or players...`);
        }

        return { success: true, gameState: this.getGameState() };
      } else {
        return { success: false, error: "Payment verification failed" };
      }
    } catch (error) {
      console.error("❌ Pokemon payment verification error:", error);
      return { success: false, error: error.message };
    }
  }

  async verifyPaymentTransaction(playerWallet, txSignature, expectedAmount) {
    try {
      console.log(
        `🔍 Verifying Pokemon payment: ${txSignature} for ${expectedAmount} GOR`
      );
      console.log(`🔍 Player wallet: ${playerWallet}`);
      console.log(`🔍 Expected amount: ${expectedAmount} GOR`);

      const transaction = await connection.getTransaction(txSignature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });

      if (!transaction || transaction.meta?.err) {
        console.log(`❌ Transaction not found or failed: ${txSignature}`);
        return false;
      }

      // Verify amount transferred
      const preBalances = transaction.meta.preBalances;
      const postBalances = transaction.meta.postBalances;
      const accountKeys = transaction.transaction.message.accountKeys;

      const playerIndex = accountKeys.findIndex(
        (key) => key.toBase58() === playerWallet
      );

      if (playerIndex === -1) {
        console.log(`❌ Player wallet not found in transaction`);
        return false;
      }

      const playerBalanceChange =
        preBalances[playerIndex] - postBalances[playerIndex];
      const expectedLamports = expectedAmount * Math.pow(10, GOR_DECIMALS);
      const tolerance = 0.01 * Math.pow(10, GOR_DECIMALS);

      if (Math.abs(playerBalanceChange - expectedLamports) <= tolerance) {
        console.log(
          `✅ Pokemon payment verified: ${
            playerBalanceChange / Math.pow(10, GOR_DECIMALS)
          } GOR`
        );
        return true;
      } else {
        console.log(
          `❌ Payment amount mismatch: expected ${expectedAmount}, got ${
            playerBalanceChange / Math.pow(10, GOR_DECIMALS)
          }`
        );
        return false;
      }
    } catch (error) {
      console.error("❌ Pokemon payment verification error:", error);
      return false;
    }
  }

  startCountdown() {
    if (this.countdownTimer) {
      clearTimeout(this.countdownTimer);
    }

    this.gamePhase = "countdown";
    let countdown = 5; // 5 seconds as requested

    const countdownInterval = setInterval(() => {
      if (this.io) {
        this.io.to(this.roomId).emit("pokemonCountdown", {
          roomId: this.roomId,
          countdown: countdown,
          message: `Pokemon battle starting in ${countdown} seconds...`,
        });
      }

      countdown--;

      if (countdown < 0) {
        clearInterval(countdownInterval);
        this.startGame();
      }
    }, 1000);

    this.countdownTimer = countdownInterval;
  }

  startGame() {
    this.gamePhase = "playing";
    this.gameStartTime = Date.now();
    this.gameState.currentTurn = this.players[0].id; // First player starts
    this.gameState.turnCount = 1;

    // Initialize Pokemon battle system
    this.initializePokemonBattle();

    console.log(`🎴 Pokemon battle started in room ${this.roomId}`);
    console.log(`   Player 1: ${this.players[0].wallet.slice(0, 8)}...`);
    console.log(`   Player 2: ${this.players[1].wallet.slice(0, 8)}...`);

    if (this.io) {
      this.io.to(this.roomId).emit("pokemonGameStarted", {
        roomId: this.roomId,
        gameState: this.getGameState(),
        message: "Pokemon battle begins!",
        battleState: this.getBattleState(),
      });
    }

    // Set game timer (15 minutes)
    this.gameTimer = setTimeout(() => {
      this.endGame("timeout");
    }, this.gameDuration);
  }

  initializePokemonBattle() {
    // Initialize each player with 3 Pokemon cards for simplified gameplay
    this.players.forEach((player, index) => {
      const pokemonTeam = this.generatePokemonTeam(index);

      player.pokemonTeam = pokemonTeam;
      player.activePokemon = pokemonTeam[0]; // First Pokemon is active
      player.benchPokemon = pokemonTeam.slice(1); // Rest are on bench
      player.defeatedPokemon = [];
      player.remainingPokemon = 3;

      console.log(
        `🎴 Player ${index + 1} team:`,
        pokemonTeam.map((p) => p.name)
      );
    });
  }

  generatePokemonTeam(playerIndex) {
    // Generate different teams for each player using Pokemon TCG API data structure
    const teams = [
      // Player 1 Team - Electric/Fire theme
      [
        {
          id: "pikachu-25",
          name: "Pikachu",
          hp: 60,
          maxHp: 60,
          type: "Electric",
          attacks: [
            {
              name: "Thunder Shock",
              damage: 20,
              description: "Electric attack with moderate damage.",
            },
            {
              name: "Agility",
              damage: 10,
              description:
                "Quick attack that may prevent opponent's next move.",
            },
          ],
          imageUrl: "https://images.pokemontcg.io/base1/25_hires.png",
          rarity: "Common",
        },
        {
          id: "charmander-46",
          name: "Charmander",
          hp: 50,
          maxHp: 50,
          type: "Fire",
          attacks: [
            {
              name: "Scratch",
              damage: 10,
              description: "Basic physical attack.",
            },
            { name: "Ember", damage: 30, description: "Powerful fire attack." },
          ],
          imageUrl: "https://images.pokemontcg.io/base1/46_hires.png",
          rarity: "Common",
        },
        {
          id: "magnemite-53",
          name: "Magnemite",
          hp: 40,
          maxHp: 40,
          type: "Electric",
          attacks: [
            {
              name: "Thunder Wave",
              damage: 10,
              description: "May paralyze the opponent.",
            },
            {
              name: "Selfdestruct",
              damage: 40,
              description: "Powerful attack that damages self.",
            },
          ],
          imageUrl: "https://images.pokemontcg.io/base1/53_hires.png",
          rarity: "Common",
        },
      ],
      // Player 2 Team - Water/Grass theme
      [
        {
          id: "squirtle-63",
          name: "Squirtle",
          hp: 40,
          maxHp: 40,
          type: "Water",
          attacks: [
            {
              name: "Bubble",
              damage: 10,
              description: "Water attack that may paralyze.",
            },
            {
              name: "Withdraw",
              damage: 0,
              description: "Defensive move that reduces damage.",
            },
          ],
          imageUrl: "https://images.pokemontcg.io/base1/63_hires.png",
          rarity: "Common",
        },
        {
          id: "bulbasaur-44",
          name: "Bulbasaur",
          hp: 40,
          maxHp: 40,
          type: "Grass",
          attacks: [
            {
              name: "Leech Seed",
              damage: 20,
              description: "Drains opponent's energy.",
            },
            {
              name: "Vine Whip",
              damage: 15,
              description: "Basic grass-type attack.",
            },
          ],
          imageUrl: "https://images.pokemontcg.io/base1/44_hires.png",
          rarity: "Common",
        },
        {
          id: "psyduck-62",
          name: "Psyduck",
          hp: 50,
          maxHp: 50,
          type: "Water",
          attacks: [
            {
              name: "Headache",
              damage: 10,
              description: "Psychic attack that confuses.",
            },
            {
              name: "Fury Swipes",
              damage: 20,
              description: "Multiple quick attacks.",
            },
          ],
          imageUrl: "https://images.pokemontcg.io/base1/62_hires.png",
          rarity: "Common",
        },
      ],
    ];

    return teams[playerIndex] || teams[0];
  }

  // Pokemon Battle Actions
  attackPokemon(attackingPlayerId, attackIndex) {
    const attackingPlayer = this.players.find(
      (p) => p.id === attackingPlayerId
    );
    const defendingPlayer = this.players.find(
      (p) => p.id !== attackingPlayerId
    );

    if (!attackingPlayer || !defendingPlayer) {
      return { success: false, error: "Invalid players" };
    }

    if (this.gameState.currentTurn !== attackingPlayerId) {
      return { success: false, error: "Not your turn" };
    }

    const activePokemon = attackingPlayer.activePokemon;
    const attack = activePokemon.attacks[attackIndex];

    if (!attack) {
      return { success: false, error: "Invalid attack" };
    }

    // Execute attack
    const damage = attack.damage;
    defendingPlayer.activePokemon.hp -= damage;

    const battleLog = `${activePokemon.name} used ${attack.name} for ${damage} damage!`;

    console.log(`⚔️ ${battleLog}`);
    console.log(
      `   ${defendingPlayer.activePokemon.name} HP: ${defendingPlayer.activePokemon.hp}/${defendingPlayer.activePokemon.maxHp}`
    );

    // Check if defending Pokemon is knocked out
    const knockedOut = defendingPlayer.activePokemon.hp <= 0;
    let gameEnded = false;
    let winner = null;

    if (knockedOut) {
      // Move knocked out Pokemon to defeated pile
      defendingPlayer.defeatedPokemon.push(defendingPlayer.activePokemon);
      defendingPlayer.remainingPokemon--;

      console.log(`💀 ${defendingPlayer.activePokemon.name} was knocked out!`);

      // Check if player has no Pokemon left
      if (defendingPlayer.remainingPokemon === 0) {
        gameEnded = true;
        winner = attackingPlayer;
        console.log(
          `🏆 ${attackingPlayer.wallet.slice(0, 8)}... wins the Pokemon battle!`
        );
      } else {
        // Force defending player to choose new active Pokemon
        const nextPokemon = defendingPlayer.benchPokemon.shift();
        if (nextPokemon) {
          defendingPlayer.activePokemon = nextPokemon;
          console.log(
            `🔄 ${defendingPlayer.activePokemon.name} is now active!`
          );
        }
      }
    }

    // Switch turns
    this.gameState.currentTurn = defendingPlayer.id;
    this.gameState.turnCount++;

    const battleResult = {
      success: true,
      attack: attack,
      damage: damage,
      battleLog: battleLog,
      knockedOut: knockedOut,
      gameEnded: gameEnded,
      winner: winner,
      newActivePokemon: knockedOut ? defendingPlayer.activePokemon : null,
    };

    // Broadcast battle update
    if (this.io) {
      this.io.to(this.roomId).emit("pokemonBattleAction", {
        roomId: this.roomId,
        action: "attack",
        result: battleResult,
        gameState: this.getGameState(),
        battleState: this.getBattleState(),
      });
    }

    // End game if someone won
    if (gameEnded) {
      setTimeout(() => {
        this.endGame("victory", winner);
      }, 2000); // 2 second delay to show final result
    }

    return battleResult;
  }

  switchActivePokemon(playerId, benchIndex) {
    const player = this.players.find((p) => p.id === playerId);

    if (!player) {
      return { success: false, error: "Player not found" };
    }

    if (benchIndex >= player.benchPokemon.length) {
      return { success: false, error: "Invalid Pokemon selection" };
    }

    // Switch active Pokemon with bench Pokemon
    const newActive = player.benchPokemon[benchIndex];
    const currentActive = player.activePokemon;

    player.activePokemon = newActive;
    player.benchPokemon[benchIndex] = currentActive;

    console.log(
      `🔄 ${player.wallet.slice(0, 8)}... switched to ${newActive.name}`
    );

    // Broadcast switch
    if (this.io) {
      this.io.to(this.roomId).emit("pokemonBattleAction", {
        roomId: this.roomId,
        action: "switch",
        playerId: playerId,
        newActivePokemon: newActive,
        gameState: this.getGameState(),
        battleState: this.getBattleState(),
      });
    }

    return { success: true, newActivePokemon: newActive };
  }

  getBattleState() {
    return {
      player1: {
        id: this.players[0].id,
        wallet: this.players[0].wallet,
        activePokemon: this.players[0].activePokemon,
        benchPokemon: this.players[0].benchPokemon,
        defeatedPokemon: this.players[0].defeatedPokemon,
        remainingPokemon: this.players[0].remainingPokemon,
      },
      player2: {
        id: this.players[1].id,
        wallet: this.players[1].wallet,
        activePokemon: this.players[1].activePokemon,
        benchPokemon: this.players[1].benchPokemon,
        defeatedPokemon: this.players[1].defeatedPokemon,
        remainingPokemon: this.players[1].remainingPokemon,
      },
      currentTurn: this.gameState.currentTurn,
      turnCount: this.gameState.turnCount,
    };
  }

  async endGame(reason = "normal", winner = null) {
    this.gamePhase = "finished";

    if (this.gameTimer) {
      clearTimeout(this.gameTimer);
    }
    if (this.countdownTimer) {
      clearTimeout(this.countdownTimer);
    }

    // Determine winner if not provided
    if (!winner) {
      if (reason === "timeout") {
        // If timeout, player with most remaining Pokemon wins
        const sortedPlayers = [...this.players].sort(
          (a, b) => b.remainingPokemon - a.remainingPokemon
        );
        winner = sortedPlayers[0];
      } else {
        // Calculate winner (highest score for other cases)
        const sortedPlayers = [...this.players].sort(
          (a, b) => b.score - a.score
        );
        winner = sortedPlayers[0];
      }
    }

    console.log(`🏁 Pokemon battle finished in room ${this.roomId}`);
    console.log(`   Reason: ${reason}`);
    console.log(`   Winner: ${winner.wallet.slice(0, 8)}...`);

    // Distribute prizes - Winner takes all!
    await this.distributePrizes(winner);

    if (this.io) {
      this.io.to(this.roomId).emit("pokemonGameFinished", {
        roomId: this.roomId,
        winner: {
          id: winner.id,
          wallet: winner.wallet,
          nickname: winner.nickname,
          remainingPokemon: winner.remainingPokemon,
        },
        finalState: this.getBattleState(),
        reason: reason,
        prizeAmount: this.totalEscrowed * 0.9, // 90% to winner
        message: `🏆 ${winner.nickname} wins the Pokemon battle and ${(
          this.totalEscrowed * 0.9
        ).toFixed(2)} GOR!`,
      });
    }

    // Clean up room after 30 seconds
    setTimeout(() => {
      this.cleanup();
    }, 30000);
  }

  async distributePrizes(winner) {
    try {
      const totalPrizePool = this.totalEscrowed;
      const platformFee = totalPrizePool * 0.1;
      const winnerPrize = totalPrizePool * 0.9;

      console.log(`💰 Distributing Pokemon prizes:
        Total Pool: ${totalPrizePool} GOR
        Winner Prize: ${winnerPrize} GOR
        Platform Fee: ${platformFee} GOR`);

      // Send prize to winner
      await this.sendPrizeToPlayer(winner.wallet, winnerPrize);

      console.log(`✅ Pokemon prizes distributed successfully`);
    } catch (error) {
      console.error("❌ Pokemon prize distribution error:", error);
    }
  }

  async sendPrizeToPlayer(winnerWallet, amount) {
    try {
      if (!platformWallet) {
        throw new Error("Platform wallet not configured");
      }

      const winnerPublicKey = new PublicKey(winnerWallet);
      const lamports = Math.floor(amount * Math.pow(10, GOR_DECIMALS));

      console.log(`💰 Transferring ${amount} GOR to ${winnerWallet}...`);

      const transferTx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: platformWallet.publicKey,
          toPubkey: winnerPublicKey,
          lamports: lamports,
        })
      );

      const signature = await sendAndConfirmTransaction(
        connection,
        transferTx,
        [platformWallet],
        {
          commitment: "confirmed",
          maxRetries: 3,
        }
      );

      console.log(
        `✅ Pokemon prize transferred successfully! TX: ${signature}`
      );
      return { success: true, signature: signature };
    } catch (error) {
      console.error(`❌ Pokemon prize transfer failed:`, error);
      return { success: false, error: error.message };
    }
  }

  cleanup() {
    if (this.countdownTimer) {
      clearTimeout(this.countdownTimer);
    }
    if (this.gameTimer) {
      clearTimeout(this.gameTimer);
    }

    // Remove room from storage
    realWalletPokemonRooms.delete(this.roomId);
    console.log(`🗑️ Pokemon room ${this.roomId} cleaned up`);
  }

  getGameState() {
    const gameState = {
      roomId: this.roomId,
      gamePhase: this.gamePhase,
      playerCount: this.playerCount,
      betAmount: this.betAmount,
      totalEscrowed: this.totalEscrowed,
      players: this.players.map((p) => ({
        id: p.id,
        wallet: p.wallet,
        nickname: p.nickname,
        ready: p.ready,
        paymentConfirmed: p.paymentConfirmed,
        score: p.score,
        hp: p.hp,
      })),
      gameState: this.gameState,
      maxPlayers: this.maxPlayers,
    };

    // Add battle state if game is playing
    if (this.gamePhase === "playing" && this.players.length >= 2) {
      gameState.battleState = this.getBattleState();
    }

    return gameState;
  }
}

// Store io instance for broadcasting from room classes
let realWalletIo = null;

// Setup real wallet routes
export function setupRealWalletRoutes(app, io) {
  realWalletIo = io; // Store io instance for room classes
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
        const { playerId, playerNickname, betAmount, txSignature } = data;

        if (playerId.startsWith("demo_")) return; // Not a real wallet request

        console.log(`🔮 Real orb collector join:`, { playerId, betAmount });

        // REQUIRE transaction signature for payment verification
        if (!txSignature) {
          socket.emit("error", { message: "Transaction signature required" });
          return;
        }

        // Find or create real orb room (looking for rooms in "waiting" or "paying" state)
        let room = Array.from(realWalletOrbCollectorRooms.values()).find(
          (r) =>
            (r.gameState === "waiting" || r.gameState === "paying") &&
            r.players.length < 6
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

        // VERIFY PAYMENT BEFORE ALLOWING GAMEPLAY
        const paymentResult = await room.confirmPayment(socket.id, txSignature);
        if (paymentResult.success) {
          console.log(
            `✅ Orb collector payment confirmed for ${playerId.slice(0, 8)}...`
          );
          io.to(room.roomId).emit("realOrbGameState", room.getGameState());
        } else {
          console.log(
            `❌ Orb collector payment failed: ${paymentResult.error}`
          );
          socket.emit("paymentError", paymentResult.error);

          // Remove player from room if payment failed
          const playerIndex = room.players.findIndex((p) => p.id === socket.id);
          if (playerIndex !== -1) {
            room.players.splice(playerIndex, 1);
          }
          realWalletPlayerSockets.delete(socket.id);
          return;
        }
      } catch (error) {
        console.error("❌ Real orb collector join error:", error);
        socket.emit("error", { message: error.message });
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

    // Real Word Grid Events
    socket.on("createWordGridRoom", async (data) => {
      try {
        const { roomId, password, betAmount, wallet, txSignature } = data;

        // Only handle real wallet addresses (not demo/mock)
        if (wallet.startsWith("demo_") || wallet.startsWith("mock_")) {
          return;
        }

        console.log(`🔤 Creating Word Grid room:`, {
          roomId,
          betAmount,
          wallet: wallet.slice(0, 8) + "...",
        });

        // Check if room already exists
        if (realWalletWordGridRooms.has(roomId)) {
          socket.emit("error", { message: "Room already exists" });
          return;
        }

        // IMPORTANT: Only create room AFTER successful payment
        if (!txSignature) {
          socket.emit("error", { message: "Transaction signature required" });
          return;
        }

        // First verify payment BEFORE creating room
        console.log(`🔍 Verifying payment before creating room...`);

        // Create temporary room instance to verify payment
        const tempRoom = new RealWalletWordGridRoom(
          roomId,
          betAmount,
          password,
          wallet
        );
        const paymentValid = await tempRoom.verifyPaymentTransaction(
          wallet,
          txSignature,
          betAmount
        );

        if (!paymentValid) {
          console.log(`❌ Payment verification failed for room creation`);
          socket.emit("error", { message: "Payment verification failed" });
          return;
        }

        console.log(`✅ Payment verified, creating room ${roomId}`);

        // NOW create and store the room after successful payment
        const room = new RealWalletWordGridRoom(
          roomId,
          betAmount,
          password,
          wallet,
          io // 🚨 CRITICAL: Pass socket.io instance for broadcasting
        );
        realWalletWordGridRooms.set(roomId, room);

        // Add creator to room
        await room.addPlayer(socket.id, socket.id, wallet, betAmount);
        socket.join(roomId);

        realWalletPlayerSockets.set(socket.id, {
          playerId: socket.id,
          wallet: wallet,
          currentRoom: roomId,
          roomType: "realWordGrid",
        });

        // Confirm payment (already verified)
        const result = await room.confirmPayment(socket.id, txSignature);
        if (result.success) {
          console.log(`✅ Room creator payment confirmed for ${roomId}`);
        } else {
          console.log(`❌ Room creator payment failed: ${result.error}`);
          // Clean up failed room
          realWalletWordGridRooms.delete(roomId);
          realWalletPlayerSockets.delete(socket.id);
          socket.emit("error", { message: result.error });
          return;
        }

        socket.emit("wordGridRoomCreated", {
          success: true,
          roomId: roomId,
          gameState: room.getGameState(),
        });

        console.log(`✅ Word Grid room ${roomId} created successfully`);
      } catch (error) {
        console.error("❌ Word Grid room creation error:", error);
        socket.emit("error", { message: error.message });
      }
    });

    socket.on("joinWordGridRoom", async (data) => {
      try {
        const { roomId, password, wallet, betAmount, txSignature } = data;

        // Only handle real wallet addresses
        if (wallet.startsWith("demo_") || wallet.startsWith("mock_")) {
          return;
        }

        console.log(`🔤 Joining Word Grid room:`, {
          roomId,
          wallet: wallet.slice(0, 8) + "...",
        });

        const room = realWalletWordGridRooms.get(roomId);
        if (!room) {
          socket.emit("error", { message: "Room not found" });
          return;
        }

        // Verify password if required
        if (!room.verifyPassword(password)) {
          socket.emit("error", { message: "Invalid room password" });
          return;
        }

        // Add player to room
        await room.addPlayer(socket.id, socket.id, wallet, betAmount);
        socket.join(roomId);

        realWalletPlayerSockets.set(socket.id, {
          playerId: socket.id,
          wallet: wallet,
          currentRoom: roomId,
          roomType: "realWordGrid",
        });

        // Confirm payment if transaction signature provided
        if (txSignature) {
          const result = await room.confirmPayment(socket.id, txSignature);
          if (result.success) {
            console.log(`✅ Player payment confirmed for room ${roomId}`);
          } else {
            console.log(`❌ Player payment failed: ${result.error}`);
            socket.emit("paymentError", result.error);
            return;
          }
        }

        socket.emit("wordGridRoomJoined", {
          success: true,
          roomId: roomId,
          gameState: room.getGameState(),
        });

        // Broadcast updated game state to all players in room
        io.to(roomId).emit("wordGridState", room.getGameState());

        console.log(`✅ Player joined Word Grid room ${roomId}`);
      } catch (error) {
        console.error("❌ Word Grid room join error:", error);
        socket.emit("error", { message: error.message });
      }
    });

    socket.on("confirmWordGridPayment", async (data) => {
      try {
        const playerInfo = realWalletPlayerSockets.get(socket.id);
        if (!playerInfo || playerInfo.roomType !== "realWordGrid") return;

        const { txSignature } = data;
        console.log(`💰 Word Grid payment confirmation:`, {
          txSignature,
          roomId: playerInfo.currentRoom,
        });

        const room = realWalletWordGridRooms.get(playerInfo.currentRoom);
        if (room) {
          const result = await room.confirmPayment(socket.id, txSignature);
          if (result.success) {
            io.to(room.roomId).emit("wordGridState", room.getGameState());
            console.log(
              `✅ Word Grid payment confirmed for room ${room.roomId}`
            );
          } else {
            socket.emit("paymentError", result.error);
            console.log(`❌ Word Grid payment failed: ${result.error}`);
          }
        }
      } catch (error) {
        console.error("❌ Word Grid payment confirmation error:", error);
        socket.emit("paymentError", error.message);
      }
    });

    socket.on("placeWordGridLetter", (data) => {
      try {
        const playerInfo = realWalletPlayerSockets.get(socket.id);
        if (!playerInfo || playerInfo.roomType !== "realWordGrid") return;

        const { cellIndex, letter } = data;
        console.log(`📝 Word Grid letter placement:`, {
          cellIndex,
          letter,
          player: playerInfo.wallet.slice(0, 8) + "...",
        });

        const room = realWalletWordGridRooms.get(playerInfo.currentRoom);
        if (room) {
          const result = room.placeLetter(socket.id, cellIndex, letter);
          if (result) {
            // Broadcast letter placement to all players
            io.to(room.roomId).emit("wordGridLetterPlaced", {
              cellIndex: cellIndex,
              letter: letter,
              playerId: socket.id,
              result: result,
            });

            // Broadcast updated game state
            io.to(room.roomId).emit("wordGridState", room.getGameState());

            console.log(`✅ Letter '${letter}' placed at cell ${cellIndex}`);
          }
        }
      } catch (error) {
        console.error("❌ Word Grid letter placement error:", error);
        socket.emit("error", { message: error.message });
      }
    });

    socket.on("wordGridTimeOut", (data) => {
      try {
        const playerInfo = realWalletPlayerSockets.get(socket.id);
        if (!playerInfo || playerInfo.roomType !== "realWordGrid") return;

        const { roomId } = data;
        console.log(`⏰ Word Grid timeout for room:`, roomId);

        const room = realWalletWordGridRooms.get(roomId);
        if (room) {
          // Force turn switch on timeout
          room.switchTurn();
          io.to(room.roomId).emit("wordGridState", room.getGameState());
          console.log(`🔄 Turn switched due to timeout in room ${roomId}`);
        }
      } catch (error) {
        console.error("❌ Word Grid timeout error:", error);
      }
    });

    // Real Pokemon Card Events
    socket.on("createPokemonRoom", async (data) => {
      try {
        const {
          roomId,
          password,
          entryAmount,
          maxPlayers,
          playerWallet,
          txSignature,
        } = data;

        const betAmount = entryAmount;
        const playerCount = maxPlayers;
        const wallet = playerWallet;

        // Only handle real wallet addresses (not demo/mock)
        if (
          !wallet ||
          wallet.startsWith("demo_") ||
          wallet.startsWith("mock_")
        ) {
          return;
        }

        console.log(`🎴 Creating Pokemon room:`, {
          roomId,
          betAmount,
          playerCount,
          wallet: wallet.slice(0, 8) + "...",
        });

        // Check if room already exists
        if (realWalletPokemonRooms.has(roomId)) {
          socket.emit("error", { message: "Room already exists" });
          return;
        }

        // IMPORTANT: Only create room AFTER successful payment
        if (!txSignature) {
          socket.emit("error", { message: "Transaction signature required" });
          return;
        }

        // First verify payment BEFORE creating room
        console.log(`🔍 Verifying payment before creating Pokemon room...`);

        // Create temporary room instance to verify payment
        const tempRoom = new RealWalletPokemonRoom(
          roomId,
          betAmount,
          playerCount,
          password,
          io
        );
        const paymentValid = await tempRoom.verifyPaymentTransaction(
          wallet,
          txSignature,
          betAmount
        );

        if (!paymentValid) {
          console.log(
            `❌ Payment verification failed for Pokemon room creation`
          );
          socket.emit("error", { message: "Payment verification failed" });
          return;
        }

        console.log(`✅ Payment verified, creating Pokemon room ${roomId}`);

        // NOW create and store the room after successful payment
        const room = new RealWalletPokemonRoom(
          roomId,
          betAmount,
          playerCount,
          password,
          io // 🚨 CRITICAL: Pass socket.io instance for broadcasting
        );
        realWalletPokemonRooms.set(roomId, room);

        // Add creator to room
        await room.addPlayer(socket.id, socket.id, wallet, betAmount);
        socket.join(roomId);

        realWalletPlayerSockets.set(socket.id, {
          playerId: socket.id,
          wallet: wallet,
          currentRoom: roomId,
          roomType: "realPokemon",
        });

        // Confirm payment (already verified)
        const result = await room.confirmPayment(socket.id, txSignature);
        if (result.success) {
          console.log(
            `✅ Pokemon room creator payment confirmed for ${roomId}`
          );
        } else {
          console.log(
            `❌ Pokemon room creator payment failed: ${result.error}`
          );
          // Clean up failed room
          realWalletPokemonRooms.delete(roomId);
          realWalletPlayerSockets.delete(socket.id);
          socket.emit("error", { message: result.error });
          return;
        }

        socket.emit("pokemonRoomCreated", {
          success: true,
          roomId: roomId,
          gameState: room.getGameState(),
        });

        console.log(`✅ Pokemon room ${roomId} created successfully`);
      } catch (error) {
        console.error("❌ Pokemon room creation error:", error);
        socket.emit("error", { message: error.message });
      }
    });

    socket.on("joinPokemonRoom", async (data) => {
      try {
        const { roomId, password, playerWallet, txSignature } = data;

        const wallet = playerWallet;

        // Only handle real wallet addresses
        if (
          !wallet ||
          wallet.startsWith("demo_") ||
          wallet.startsWith("mock_")
        ) {
          return;
        }

        console.log(`🎴 Joining Pokemon room:`, {
          roomId,
          wallet: wallet.slice(0, 8) + "...",
        });

        const room = realWalletPokemonRooms.get(roomId);
        if (!room) {
          socket.emit("error", { message: "Room not found" });
          return;
        }

        // Verify password if required
        if (!room.verifyPassword(password)) {
          socket.emit("error", { message: "Invalid room password" });
          return;
        }

        // Add player to room
        await room.addPlayer(socket.id, socket.id, wallet, room.betAmount);
        socket.join(roomId);

        realWalletPlayerSockets.set(socket.id, {
          playerId: socket.id,
          wallet: wallet,
          currentRoom: roomId,
          roomType: "realPokemon",
        });

        // Confirm payment if transaction signature provided
        if (txSignature) {
          const result = await room.confirmPayment(socket.id, txSignature);
          if (result.success) {
            console.log(
              `✅ Pokemon player payment confirmed for room ${roomId}`
            );
          } else {
            console.log(`❌ Pokemon player payment failed: ${result.error}`);
            socket.emit("paymentError", result.error);
            return;
          }
        }

        socket.emit("pokemonRoomJoined", {
          success: true,
          roomId: roomId,
          gameState: room.getGameState(),
        });

        // Broadcast updated game state to all players in room
        io.to(roomId).emit("pokemonGameState", room.getGameState());

        console.log(`✅ Player joined Pokemon room ${roomId}`);
      } catch (error) {
        console.error("❌ Pokemon room join error:", error);
        socket.emit("error", { message: error.message });
      }
    });

    socket.on("confirmPokemonPayment", async (data) => {
      try {
        const playerInfo = realWalletPlayerSockets.get(socket.id);
        if (!playerInfo || playerInfo.roomType !== "realPokemon") return;

        const { txSignature } = data;
        console.log(`💰 Pokemon payment confirmation:`, {
          txSignature,
          roomId: playerInfo.currentRoom,
        });

        const room = realWalletPokemonRooms.get(playerInfo.currentRoom);
        if (room) {
          const result = await room.confirmPayment(socket.id, txSignature);
          if (result.success) {
            io.to(room.roomId).emit("pokemonGameState", room.getGameState());
            console.log(`✅ Pokemon payment confirmed for room ${room.roomId}`);
          } else {
            socket.emit("paymentError", result.error);
            console.log(`❌ Pokemon payment failed: ${result.error}`);
          }
        }
      } catch (error) {
        console.error("❌ Pokemon payment confirmation error:", error);
        socket.emit("paymentError", error.message);
      }
    });

    // Pokemon Battle Actions
    socket.on("pokemonAttack", (data) => {
      try {
        const playerInfo = realWalletPlayerSockets.get(socket.id);
        if (!playerInfo || playerInfo.roomType !== "realPokemon") return;

        const { attackIndex } = data;
        console.log(`⚔️ Pokemon attack:`, {
          attackIndex,
          player: playerInfo.wallet.slice(0, 8) + "...",
          roomId: playerInfo.currentRoom,
        });

        const room = realWalletPokemonRooms.get(playerInfo.currentRoom);
        if (room) {
          const result = room.attackPokemon(socket.id, attackIndex);
          if (!result.success) {
            socket.emit("pokemonError", { message: result.error });
          }
          // Battle result is already broadcasted in the attackPokemon method
        }
      } catch (error) {
        console.error("❌ Pokemon attack error:", error);
        socket.emit("pokemonError", { message: error.message });
      }
    });

    socket.on("pokemonSwitch", (data) => {
      try {
        const playerInfo = realWalletPlayerSockets.get(socket.id);
        if (!playerInfo || playerInfo.roomType !== "realPokemon") return;

        const { benchIndex } = data;
        console.log(`🔄 Pokemon switch:`, {
          benchIndex,
          player: playerInfo.wallet.slice(0, 8) + "...",
          roomId: playerInfo.currentRoom,
        });

        const room = realWalletPokemonRooms.get(playerInfo.currentRoom);
        if (room) {
          const result = room.switchActivePokemon(socket.id, benchIndex);
          if (!result.success) {
            socket.emit("pokemonError", { message: result.error });
          }
          // Switch result is already broadcasted in the switchActivePokemon method
        }
      } catch (error) {
        console.error("❌ Pokemon switch error:", error);
        socket.emit("pokemonError", { message: error.message });
      }
    });

    // Cleanup on disconnect
    socket.on("disconnect", () => {
      console.log(`🔗 Real wallet client disconnected: ${socket.id}`);

      const playerInfo = realWalletPlayerSockets.get(socket.id);
      if (playerInfo) {
        // Clean up word grid room if needed
        if (playerInfo.roomType === "realWordGrid") {
          const room = realWalletWordGridRooms.get(playerInfo.currentRoom);
          if (room) {
            console.log(
              `🔤 Cleaning up Word Grid room ${playerInfo.currentRoom} due to disconnect`
            );
            room.cleanup();
            realWalletWordGridRooms.delete(playerInfo.currentRoom);
          }
        }

        // Clean up Pokemon room if needed
        if (playerInfo.roomType === "realPokemon") {
          const room = realWalletPokemonRooms.get(playerInfo.currentRoom);
          if (room) {
            console.log(
              `🎴 Cleaning up Pokemon room ${playerInfo.currentRoom} due to disconnect`
            );
            room.cleanup();
          }
        }

        realWalletPlayerSockets.delete(socket.id);
      }
    });
  });

  console.log("✅ Real wallet routes setup complete!");
}
