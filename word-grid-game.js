import {
  isValidWord,
  detectNewWords,
  findWordsInGrid,
} from "./word-dictionary.js";
import { distributePrizes } from "./blockchain-rewards.js";

class WordGridRoom {
  constructor(roomId, betAmount = 1) {
    this.id = roomId;
    this.players = [];
    this.grid = Array(64).fill({
      letter: "",
      playerId: null,
      isNewWord: false,
    });
    this.currentPlayer = null;
    this.gamePhase = "waiting"; // waiting, playing, finished
    this.wordsFound = [];
    this.gameTimer = null;
    this.betAmount = betAmount;
    this.totalPrizePool = betAmount;
    this.startTime = null;
    this.maxPlayers = 2;
    this.gameTimeLimit = 300; // 5 minutes total game time
    this.playerTimeLimit = 150; // 2.5 minutes per player
  }

  async addPlayer(playerId, socketId, wallet, betAmount = null) {
    if (this.players.length >= this.maxPlayers) {
      throw new Error("Room is full");
    }

    if (this.gamePhase !== "waiting") {
      throw new Error("Game already in progress");
    }

    const actualBetAmount = betAmount || this.betAmount;

    const player = {
      id: playerId,
      socketId: socketId,
      wallet: wallet,
      timeRemaining: this.playerTimeLimit,
      score: 0,
      isActive: false,
      betAmount: actualBetAmount,
      paymentConfirmed: false,
    };

    this.players.push(player);
    this.totalPrizePool = this.players.reduce((sum, p) => sum + p.betAmount, 0);

    console.log(
      `🔤 Player ${wallet} joined Word Grid room ${this.id}, bet: ${actualBetAmount} GOR`
    );

    return this.getGameState();
  }

  confirmPayment(playerId) {
    const player = this.players.find((p) => p.id === playerId);
    if (player) {
      player.paymentConfirmed = true;
      console.log(`✅ Payment confirmed for player ${player.wallet}`);
    }
  }

  removePlayer(playerId) {
    const playerIndex = this.players.findIndex((p) => p.id === playerId);
    if (playerIndex !== -1) {
      const removedPlayer = this.players.splice(playerIndex, 1)[0];
      this.totalPrizePool -= removedPlayer.betAmount;

      console.log(
        `❌ Player ${removedPlayer.wallet} left Word Grid room ${this.id}`
      );

      // If game was in progress, end it
      if (this.gamePhase === "playing") {
        this.finishGame("player_disconnect");
      }

      // If no players left, mark for cleanup
      return this.players.length === 0;
    }
    return false;
  }

  startGame() {
    if (this.players.length !== this.maxPlayers) {
      throw new Error("Need exactly 2 players to start");
    }

    // Check if all players have confirmed payment
    const unpaidPlayers = this.players.filter((p) => !p.paymentConfirmed);
    if (unpaidPlayers.length > 0) {
      throw new Error("Not all players have confirmed payment");
    }

    this.gamePhase = "playing";
    this.currentPlayer = this.players[0].id;
    this.players[0].isActive = true;
    this.startTime = Date.now();

    console.log(`🚀 Word Grid game started in room ${this.id}`);

    // Set up player turn timer
    this.gameTimer = setInterval(() => {
      this.updateTimers();
    }, 1000);

    return this.getGameState();
  }

  updateTimers() {
    const activePlayer = this.players.find((p) => p.id === this.currentPlayer);
    if (activePlayer && activePlayer.timeRemaining > 0) {
      activePlayer.timeRemaining -= 1;

      // Check if time ran out
      if (activePlayer.timeRemaining <= 0) {
        this.finishGame("timeout");
      }
    }
  }

  switchTurn() {
    const currentIndex = this.players.findIndex(
      (p) => p.id === this.currentPlayer
    );
    const nextIndex = (currentIndex + 1) % this.players.length;

    // Deactivate current player
    this.players[currentIndex].isActive = false;

    // Activate next player
    this.currentPlayer = this.players[nextIndex].id;
    this.players[nextIndex].isActive = true;
  }

  placeLetter(playerId, cellIndex, letter) {
    // Validate move
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
      throw new Error("Cell is already occupied");
    }

    if (!/^[A-Z]$/i.test(letter)) {
      throw new Error("Invalid letter");
    }

    // Place the letter
    const newGrid = [...this.grid];
    newGrid[cellIndex] = {
      letter: letter.toUpperCase(),
      playerId: playerId,
      isNewWord: false,
    };
    this.grid = newGrid;

    // Detect new words
    const newWords = detectNewWords(this.grid, cellIndex, this.wordsFound);

    // Award points for new words
    const player = this.players.find((p) => p.id === playerId);
    if (player && newWords.length > 0) {
      for (const wordObj of newWords) {
        player.score += wordObj.word.length;
        this.wordsFound.push({
          ...wordObj,
          playerId: playerId,
          isNew: true,
          timestamp: Date.now(),
        });

        console.log(
          `📝 Word found: "${wordObj.word}" (${wordObj.word.length} pts) by ${player.wallet}`
        );

        // Mark cells as part of new word temporarily
        wordObj.coordinates.forEach((coord) => {
          if (this.grid[coord]) {
            this.grid[coord].isNewWord = true;
          }
        });
      }
    }

    // Switch turns
    this.switchTurn();

    // Check if game should end
    const isBoardFull = this.grid.every((cell) => cell.letter !== "");
    const allPlayersOutOfTime = this.players.every((p) => p.timeRemaining <= 0);

    if (isBoardFull || allPlayersOutOfTime) {
      this.finishGame(isBoardFull ? "board_full" : "time_up");
    }

    return {
      grid: this.grid,
      newWords: newWords,
      players: this.players,
      nextPlayer: this.currentPlayer,
    };
  }

  async finishGame(reason = "completed") {
    this.gamePhase = "finished";

    if (this.gameTimer) {
      clearInterval(this.gameTimer);
      this.gameTimer = null;
    }

    // Calculate final standings
    const sortedPlayers = [...this.players].sort((a, b) => b.score - a.score);
    const winner = sortedPlayers[0];
    const loser = sortedPlayers[1];

    // Determine prize distribution
    let finalStandings;

    if (winner.score > loser.score) {
      // Clear winner
      finalStandings = [
        {
          wallet: winner.wallet,
          score: winner.score,
          position: 1,
          prize: this.totalPrizePool * 1.8, // Winner gets 90% of doubled pool
          wordsFound: this.wordsFound.filter((w) => w.playerId === winner.id)
            .length,
        },
        {
          wallet: loser.wallet,
          score: loser.score,
          position: 2,
          prize: this.totalPrizePool * 0.2, // Loser gets 10% of doubled pool
          wordsFound: this.wordsFound.filter((w) => w.playerId === loser.id)
            .length,
        },
      ];
    } else {
      // Tie - split the prize pool
      const tieAmount = this.totalPrizePool; // Each gets their entry fee back
      finalStandings = [
        {
          wallet: winner.wallet,
          score: winner.score,
          position: 1,
          prize: tieAmount,
          wordsFound: this.wordsFound.filter((w) => w.playerId === winner.id)
            .length,
        },
        {
          wallet: loser.wallet,
          score: loser.score,
          position: 1,
          prize: tieAmount,
          wordsFound: this.wordsFound.filter((w) => w.playerId === loser.id)
            .length,
        },
      ];
    }

    console.log(`🏁 Word Grid game ${this.id} finished:`, {
      reason,
      standings: finalStandings,
      totalWordsFound: this.wordsFound.length,
      gameTime: Date.now() - this.startTime,
    });

    // Distribute prizes
    try {
      await distributePrizes(finalStandings, "wordGrid");
      console.log("✅ Word Grid prizes distributed successfully");
    } catch (error) {
      console.error("❌ Error distributing Word Grid prizes:", error);
    }

    return {
      reason,
      finalStandings,
      totalWordsFound: this.wordsFound.length,
      gameTime: this.startTime ? Date.now() - this.startTime : 0,
      allWords: this.wordsFound,
    };
  }

  getGameState() {
    return {
      roomId: this.id,
      players: this.players.map((p) => ({
        id: p.id,
        wallet: p.wallet,
        timeRemaining: p.timeRemaining,
        score: p.score,
        isActive: p.isActive,
        paymentConfirmed: p.paymentConfirmed,
      })),
      grid: this.grid,
      currentPlayer: this.currentPlayer,
      gamePhase: this.gamePhase,
      wordHighlights: this.wordsFound.slice(-10), // Show last 10 words
      totalPrizePool: this.totalPrizePool,
      maxPlayers: this.maxPlayers,
      wordsFoundCount: this.wordsFound.length,
    };
  }

  cleanup() {
    if (this.gameTimer) {
      clearInterval(this.gameTimer);
      this.gameTimer = null;
    }
  }
}

export { WordGridRoom };
