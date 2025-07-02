import {
  isValidWord,
  detectNewWords,
  findWordsInGrid,
  wordCount,
} from "./word-dictionary.js";
import { distributePrizes } from "./blockchain-rewards.js";
import { v4 as uuidv4 } from "uuid";

console.log(`🔤 Word Grid game loaded with ${wordCount} words for validation`);

class WordGridRoom {
  constructor(
    roomId,
    betAmount = 1,
    password = null,
    creatorWallet = null,
    isMockMode = false
  ) {
    this.id = roomId;
    this.betAmount = betAmount;
    this.password = password;
    this.maxPlayers = 2;
    this.isMockMode = isMockMode;

    // Game state
    this.players = [];
    this.gamePhase = "waiting"; // waiting, playing, finished
    this.currentPlayer = null;
    this.gameStartTime = null;
    this.timePerPlayer = 150; // 2.5 minutes per player

    // 8x8 grid
    this.grid = Array(64)
      .fill(null)
      .map(() => ({
        letter: "",
        playerId: null,
        isNewWord: false,
      }));

    this.wordHistory = []; // All words found throughout the game
    this.moveHistory = []; // All moves made
    this.gameTimer = null;

    console.log(
      `🔤 Created Word Grid room: ${roomId} with bet ${betAmount} GOR ${
        isMockMode ? "(Mock)" : "(Real)"
      }`
    );
  }

  verifyPassword(inputPassword) {
    if (!this.password) return true; // No password set
    return this.password === inputPassword;
  }

  getRoomInfo() {
    return {
      roomId: this.id,
      betAmount: this.betAmount,
      maxPlayers: this.maxPlayers,
      currentPlayers: this.players.length,
      gamePhase: this.gamePhase,
      hasPassword: !!this.password,
      isMockMode: this.isMockMode,
    };
  }

  async addPlayer(playerId, socketId, wallet, betAmount = null) {
    if (this.players.length >= this.maxPlayers) {
      throw new Error("Room is full");
    }

    if (this.gamePhase !== "waiting") {
      throw new Error("Game already in progress");
    }

    // Validate wallet with proper null check
    if (!wallet || typeof wallet !== "string" || wallet.trim() === "") {
      throw new Error("Valid wallet address is required");
    }

    // Check if player already exists
    const existingPlayer = this.players.find((p) => p.wallet === wallet);
    if (existingPlayer) {
      throw new Error("Player already in room");
    }

    const finalBetAmount = betAmount || this.betAmount;

    // Safe wallet slicing with null check
    const safeWallet = wallet || "Unknown";
    const nickname =
      safeWallet.length >= 6 ? `${safeWallet.slice(0, 6)}...` : safeWallet;

    const player = {
      id: playerId,
      socketId: socketId,
      wallet: wallet,
      nickname: nickname,
      betAmount: finalBetAmount,
      score: 0,
      timeRemaining: this.timePerPlayer,
      isActive: false,
      paymentConfirmed: false,
      wordsFound: [],
      totalLettersPlaced: 0,
      longestWord: 0,
    };

    this.players.push(player);

    const safeWalletDisplay =
      wallet && wallet.length >= 8
        ? `${wallet.slice(0, 8)}...`
        : wallet || "Unknown";
    console.log(
      `🔤 Player ${safeWalletDisplay} joined Word Grid room ${this.id} (${this.players.length}/${this.maxPlayers})`
    );

    // If room is full, wait for payment confirmations before starting
    if (this.players.length === this.maxPlayers) {
      console.log(
        `🔤 Word Grid room ${this.id} is full - waiting for payment confirmations`
      );
    }

    return this.getGameState();
  }

  confirmPayment(playerId) {
    const player = this.players.find((p) => p.id === playerId);
    if (!player) {
      console.log(`⚠️ Player ${playerId} not found in room ${this.id}`);
      return this.getGameState();
    }

    if (player.paymentConfirmed) {
      console.log(`⚠️ Player ${player.wallet} payment already confirmed`);
      return this.getGameState();
    }

    player.paymentConfirmed = true;
    console.log(`✅ Word Grid payment confirmed for player ${player.wallet}`);

    // Check if all players have paid AND we have enough players
    const allPaid = this.players.every((p) => p.paymentConfirmed);
    const enoughPlayers = this.players.length === this.maxPlayers;

    console.log(
      `📊 Room ${this.id} status: ${this.players.length}/${
        this.maxPlayers
      } players, ${this.players.filter((p) => p.paymentConfirmed).length} paid`
    );

    if (allPaid && enoughPlayers) {
      console.log(
        `🚀 All Word Grid players paid and room full - starting game automatically`
      );
      try {
        return this.startGame();
      } catch (error) {
        console.error(`❌ Failed to start Word Grid game:`, error);
        return this.getGameState();
      }
    } else if (allPaid && !enoughPlayers) {
      console.log(
        `⏳ All current players paid (${this.players.length}/${this.maxPlayers}) - waiting for more players`
      );
    } else {
      console.log(
        `⏳ Waiting for more payments: ${
          this.players.filter((p) => p.paymentConfirmed).length
        }/${this.players.length} paid`
      );
    }

    return this.getGameState();
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

  removePlayer(playerId) {
    const playerIndex = this.players.findIndex((p) => p.id === playerId);
    if (playerIndex === -1) return false;

    this.players.splice(playerIndex, 1);
    console.log(`🔤 Player removed from Word Grid room ${this.id}`);

    // If game was in progress and a player left, end the game
    if (this.gamePhase === "playing") {
      this.finishGame("player_left");
    }

    return this.players.length === 0; // Return true if room is now empty
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

    // Room creator goes first (first player in the array)
    const firstPlayer = this.players[0]; // Creator is always first
    this.currentPlayer = firstPlayer.id;
    firstPlayer.isActive = true;

    // Make sure all other players are inactive
    this.players.forEach((player, index) => {
      player.isActive = index === 0; // Only first player (creator) is active
    });

    console.log(`🚀 Word Grid game started in room ${this.id}`);
    console.log(
      `🎯 Room creator goes first: ${firstPlayer.wallet.slice(0, 8)}...`
    );
    console.log(`🕐 Starting ${firstPlayer.wallet.slice(0, 8)}'s timer`);

    return this.getGameState();
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

    // Store previous words for comparison
    const previousWords = [...this.wordHistory];

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

    // Detect new words formed
    const newWords = detectNewWords(this.grid, cellIndex, previousWords);

    console.log(
      `📝 Letter '${upperLetter}' placed at cell ${cellIndex} by ${currentPlayerObj.wallet.slice(
        0,
        8
      )}...`
    );

    if (newWords.length > 0) {
      console.log(
        `🎉 New words formed:`,
        newWords.map((w) => `${w.word} (${w.points}pts)`)
      );

      // Mark cells that are part of new words
      newWords.forEach((wordObj) => {
        wordObj.coordinates.forEach((cellIdx) => {
          if (this.grid[cellIdx]) {
            this.grid[cellIdx].isNewWord = true;
          }
        });
      });

      // Add to word history
      this.wordHistory.push(...newWords);

      // Award points to the current player
      const pointsEarned = newWords.reduce((sum, w) => sum + w.points, 0);
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
        )}... earned ${pointsEarned} points! Total: ${currentPlayerObj.score}`
      );
    }

    // Switch to next player
    this.switchTurn();

    // Check if game should end (grid full or time up)
    const emptySpots = this.grid.filter((cell) => cell.letter === "").length;
    if (emptySpots === 0) {
      console.log(`🏁 Word Grid game ending - grid is full`);
      setTimeout(() => this.finishGame("grid_full"), 1000);
    }

    return {
      grid: this.grid,
      newWords: newWords,
      players: this.players,
      nextPlayer: this.currentPlayer,
      moveNumber: this.moveHistory.length,
      emptySpots: emptySpots,
    };
  }

  switchTurn() {
    // Set current player as inactive
    const currentPlayerObj = this.players.find(
      (p) => p.id === this.currentPlayer
    );
    if (currentPlayerObj) {
      currentPlayerObj.isActive = false;
    }

    // Find next player
    const currentIndex = this.players.findIndex(
      (p) => p.id === this.currentPlayer
    );
    const nextIndex = (currentIndex + 1) % this.players.length;
    const nextPlayer = this.players[nextIndex];

    this.currentPlayer = nextPlayer.id;
    nextPlayer.isActive = true;

    console.log(`🔄 Turn switched to ${nextPlayer.wallet.slice(0, 8)}...`);
  }

  async finishGame(reason = "normal") {
    console.log(
      `🏁 Word Grid game finishing in room ${this.id}, reason: ${reason}`
    );

    this.gamePhase = "finished";

    // Stop any running timers
    if (this.gameTimer) {
      clearInterval(this.gameTimer);
      this.gameTimer = null;
    }

    // Calculate final scores and rankings
    const sortedPlayers = [...this.players].sort((a, b) => {
      // Primary: score
      if (b.score !== a.score) return b.score - a.score;
      // Secondary: longest word
      if (b.longestWord !== a.longestWord) return b.longestWord - a.longestWord;
      // Tertiary: total letters placed
      return b.totalLettersPlaced - a.totalLettersPlaced;
    });

    // Assign final rankings
    sortedPlayers.forEach((player, index) => {
      player.finalRank = index + 1;
    });

    const winner = sortedPlayers[0];
    const gameStats = {
      winner: winner,
      finalStandings: sortedPlayers.map((player) => ({
        wallet: player.wallet,
        rank: player.finalRank,
        score: player.score,
        wordsFound: player.wordsFound.length,
        longestWord: player.longestWord,
        totalLettersPlaced: player.totalLettersPlaced,
        betAmount: player.betAmount,
        prize: player.finalRank === 1 ? this.calculateBetPool().prizePool : 0,
      })),
      gameStats: {
        totalWords: this.wordHistory.length,
        totalMoves: this.moveHistory.length,
        gameLength: Date.now() - this.gameStartTime,
        gridFilled: this.grid.filter((cell) => cell.letter !== "").length,
        reason: reason,
      },
      betPool: this.calculateBetPool(),
      roomId: this.id,
    };

    console.log(
      `🏆 Word Grid Winner: ${winner.wallet.slice(0, 8)}... with ${
        winner.score
      } points`
    );
    console.log(`📊 Game Stats:`, gameStats.gameStats);

    // Distribute prizes if not in mock mode
    if (!this.isMockMode) {
      try {
        await this.distributePrizes(gameStats);
      } catch (error) {
        console.error(`❌ Failed to distribute Word Grid prizes:`, error);
      }
    } else {
      console.log(`🎭 Mock mode - no real prize distribution`);
    }

    return gameStats;
  }

  async distributePrizes(gameStats) {
    const { distributeSmartContractRewards } = await import(
      "./blockchain-rewards.js"
    );

    try {
      console.log(`💰 Distributing Word Grid prizes for game ${this.id}`);
      const result = await distributeSmartContractRewards(this.id, [
        gameStats.winner,
      ]);
      console.log(`✅ Word Grid prizes distributed successfully:`, result);
      return result;
    } catch (error) {
      console.error(`❌ Failed to distribute Word Grid prizes:`, error);
      throw error;
    }
  }

  cleanup() {
    if (this.gameTimer) {
      clearInterval(this.gameTimer);
      this.gameTimer = null;
    }
    console.log(`🧹 Word Grid room ${this.id} cleaned up`);
  }

  getGameState() {
    return {
      roomId: this.id,
      gamePhase: this.gamePhase,
      players: this.players,
      grid: this.grid,
      currentPlayer: this.currentPlayer,
      maxPlayers: this.maxPlayers,
      betAmount: this.betAmount,
      wordHighlights: this.wordHistory.slice(-5), // Show last 5 words
      gameStats: {
        totalWords: this.wordHistory.length,
        totalMoves: this.moveHistory.length,
        emptySpots: this.grid.filter((cell) => cell.letter === "").length,
        gameStartTime: this.gameStartTime,
      },
    };
  }
}

export { WordGridRoom };
