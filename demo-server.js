import express from "express";
import { Server } from "socket.io";
import cors from "cors";
import {
  getMockBalanceForWallet,
  updateMockBalanceForWallet,
} from "./smart-contract-integration.js";

// Demo-only game classes
class DemoTicTacToeRoom {
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
    this.betPool = { totalAmount: 0, platformFee: 0, winnerPayout: 0 };
    this.betAmount = betAmount;
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
      hasPaid: false,
      isYou: false,
    };

    this.players.push(player);
    this.calculateBetPool();

    console.log(
      `🎭 Demo player ${wallet} joined tic-tac-toe room ${this.roomId}`
    );

    // Auto-transition to betting phase when 2 players join
    if (this.players.length === 2) {
      this.gamePhase = "betting";
      // Cancel waiting timeout since we found an opponent
      this.cancelWaitingTimeout();
    } else if (this.players.length === 1) {
      // First player joined - start timeout for no opponent
      this.startWaitingTimeout();
    }

    return this.getGameState();
  }

  calculateBetPool() {
    const totalBets = this.players.reduce((sum, p) => sum + p.betAmount, 0);
    const platformFee = totalBets * 0.1; // 10% fee

    this.betPool = {
      totalAmount: totalBets,
      platformFee: platformFee,
      winnerPayout: totalBets - platformFee,
    };
  }

  confirmPayment(playerId) {
    const player = this.players.find((p) => p.id === playerId);
    if (player) {
      player.hasPaid = true;
      console.log(`💰 Demo payment confirmed for ${player.wallet}`);

      // Check if all players have paid
      const allPaid = this.players.every((p) => p.hasPaid);
      if (allPaid && this.gamePhase === "betting") {
        this.gamePhase = "toss";
        this.coinToss.choosingPlayer = this.players[0].id;
        console.log(
          `🪙 Demo coin toss phase started, ${this.players[0].wallet} chooses`
        );
      }
    }
  }

  handleCoinChoice(playerId, choice) {
    if (
      this.gamePhase !== "toss" ||
      this.coinToss.choosingPlayer !== playerId
    ) {
      return;
    }

    this.coinToss.choice = choice;
    this.coinToss.isFlipping = true;

    console.log(`🪙 Demo coin choice: ${choice} by ${playerId}`);

    // Simulate coin flip after 2 seconds
    setTimeout(() => {
      this.coinToss.result = Math.random() < 0.5 ? "heads" : "tails";
      this.coinToss.isFlipping = false;

      console.log(`🪙 Demo coin result: ${this.coinToss.result}`);

      // Determine who goes first (winner becomes X)
      const chooserWins = this.coinToss.choice === this.coinToss.result;
      const chooser = this.players.find(
        (p) => p.id === this.coinToss.choosingPlayer
      );
      const otherPlayer = this.players.find(
        (p) => p.id !== this.coinToss.choosingPlayer
      );

      if (chooserWins) {
        chooser.symbol = "X";
        otherPlayer.symbol = "O";
      } else {
        chooser.symbol = "O";
        otherPlayer.symbol = "X";
      }

      console.log(
        `🎯 Demo ${chooser.wallet} is ${chooser.symbol}, ${otherPlayer.wallet} is ${otherPlayer.symbol}`
      );

      // Start the game after 3 more seconds
      setTimeout(() => {
        this.gamePhase = "playing";
        this.currentPlayer = "X";
        console.log(`🎮 Demo game started! X goes first`);

        // Emit updated state to all players
        // Note: This will be handled by the socket event loop
      }, 3000);
    }, 2000);
  }

  letOtherChoose(playerId) {
    if (
      this.gamePhase !== "toss" ||
      this.coinToss.choosingPlayer !== playerId
    ) {
      return;
    }

    // Switch chooser to the other player
    const otherPlayer = this.players.find((p) => p.id !== playerId);
    if (otherPlayer) {
      this.coinToss.choosingPlayer = otherPlayer.id;
      console.log(`🔄 Demo coin toss chooser changed to ${otherPlayer.wallet}`);
    }
  }

  async makeMove(playerId, cellIndex) {
    if (this.gamePhase !== "playing") return null;
    if (this.board[cellIndex] !== null) return null;

    const player = this.players.find((p) => p.id === playerId);
    if (!player || player.symbol !== this.currentPlayer) return null;

    this.board[cellIndex] = this.currentPlayer;

    const winner = this.checkWinner();
    if (winner) {
      this.winner = winner;
      this.gamePhase = "finished";
      this.updateScores();
      await this.distributePrizes();
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

  updateScores() {
    if (this.winner === "draw") {
      this.scores.draws++;
    } else if (this.winner) {
      this.scores[this.winner]++;
    }
  }

  startWaitingTimeout() {
    console.log(`⏰ Starting 5-minute timeout for demo room ${this.roomId}`);

    this.waitingTimeout = setTimeout(() => {
      this.handleWaitingTimeout();
    }, this.timeoutDuration);
  }

  cancelWaitingTimeout() {
    if (this.waitingTimeout) {
      console.log(
        `✅ Canceling waiting timeout for demo room ${this.roomId} (opponent found)`
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
      `⏰ Demo timeout reached for room ${
        this.roomId
      } - refunding player ${player.wallet.slice(0, 8)}...`
    );

    try {
      // Only refund if player has paid
      if (player.hasPaid) {
        console.log(
          `💰 Demo refunding ${player.betAmount} GOR to ${player.wallet.slice(
            0,
            8
          )}...`
        );

        // Refund to mock wallet
        await updateMockBalanceForWallet(player.wallet, player.betAmount);
        console.log(
          `✅ Demo timeout refund successful for ${player.wallet.slice(0, 8)}`
        );
      }

      this.gamePhase = "finished";
      this.winner = "timeout";

      console.log(`🏁 Demo room ${this.roomId} closed due to timeout`);

      // Signal to remove this room from the rooms map
      return { shouldRemoveRoom: true, refundedPlayer: player };
    } catch (error) {
      console.error(
        `❌ Error handling demo timeout for room ${this.roomId}:`,
        error
      );
    }
  }

  cleanup() {
    // Clean up any pending timeouts
    this.cancelWaitingTimeout();
  }

  async distributePrizes() {
    console.log(
      `🏆 Demo tic-tac-toe distributing prizes for winner: ${this.winner}`
    );

    if (this.winner === "draw") {
      // Split the pot between both players
      const refundAmount = this.betPool.winnerPayout / 2;
      for (const player of this.players) {
        try {
          await updateMockBalanceForWallet(player.wallet, refundAmount);
          console.log(
            `💰 Demo refund: ${refundAmount} GOR to ${player.wallet} (draw)`
          );
        } catch (error) {
          console.error(`❌ Demo refund failed for ${player.wallet}:`, error);
        }
      }
    } else if (this.winner) {
      // Find the winning player and give them the prize
      const winningPlayer = this.players.find((p) => p.symbol === this.winner);
      if (winningPlayer) {
        try {
          await updateMockBalanceForWallet(
            winningPlayer.wallet,
            this.betPool.winnerPayout
          );
          console.log(
            `🎉 Demo prize: ${this.betPool.winnerPayout} GOR to ${winningPlayer.wallet} (winner)`
          );
        } catch (error) {
          console.error(
            `❌ Demo prize distribution failed for ${winningPlayer.wallet}:`,
            error
          );
        }
      }
    }
  }

  resetGame() {
    this.board = Array(9).fill(null);
    this.currentPlayer = "X";
    this.gamePhase = "betting";
    this.winner = null;
    this.coinToss = {
      choosingPlayer: this.players[0].id,
      choice: null,
      result: null,
      isFlipping: false,
    };

    // Reset payment status
    this.players.forEach((p) => (p.hasPaid = false));
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
}

// Demo game storage
const demoTicTacToeRooms = new Map();
const demoPlayerSockets = new Map();

// Setup demo routes
export function setupDemoRoutes(app, io) {
  console.log("🎭 Setting up DEMO routes...");

  // Demo socket handling
  io.on("connection", (socket) => {
    console.log(`🎭 Demo client connected: ${socket.id}`);

    // Demo Tic-Tac-Toe Events
    socket.on("joinTicTacToe", async (data) => {
      try {
        const { wallet, betAmount } = data;

        // Check if this is a demo request (look for demo wallet format)
        if (!wallet.startsWith("demo_")) {
          return; // Not a demo request, ignore
        }

        console.log(`🎭 Demo tic-tac-toe join:`, { wallet, betAmount });

        // Find or create a demo room
        let room = Array.from(demoTicTacToeRooms.values()).find(
          (r) => r.players.length < 2 && r.gamePhase === "waiting"
        );

        if (!room) {
          const roomId = `demo_ttt_${Date.now()}`;
          room = new DemoTicTacToeRoom(roomId, betAmount);
          demoTicTacToeRooms.set(roomId, room);
        }

        await room.addPlayer(socket.id, socket.id, wallet, betAmount);
        socket.join(room.roomId);

        demoPlayerSockets.set(socket.id, {
          playerId: socket.id,
          wallet: wallet,
          currentRoom: room.roomId,
          roomType: "demoTicTacToe",
        });

        // Emit state to all players with their individual perspective
        room.players.forEach((player) => {
          io.to(player.socketId).emit(
            "ticTacToeState",
            room.getGameState(player.id)
          );
        });
      } catch (error) {
        console.error("❌ Demo tic-tac-toe join error:", error);
        socket.emit("error", { message: error.message });
      }
    });

    socket.on("confirmPayment", async (data) => {
      try {
        const playerInfo = demoPlayerSockets.get(socket.id);
        if (!playerInfo || !playerInfo.wallet.startsWith("demo_")) return;

        const { txSignature, gameId, amount } = data;
        console.log(`💰 Demo payment confirmation:`, {
          txSignature,
          gameId,
          amount,
        });

        // Update demo balance
        await updateMockBalanceForWallet(playerInfo.wallet, -amount);

        // Confirm payment in appropriate room
        if (playerInfo.roomType === "demoTicTacToe") {
          const room = demoTicTacToeRooms.get(playerInfo.currentRoom);
          if (room) {
            room.confirmPayment(socket.id);
            // Emit state to all players with their individual perspective
            room.players.forEach((player) => {
              io.to(player.socketId).emit(
                "ticTacToeState",
                room.getGameState(player.id)
              );
            });
          }
        }
      } catch (error) {
        console.error("❌ Demo payment confirmation error:", error);
      }
    });

    // Demo Tic-Tac-Toe coin toss events
    socket.on("ticTacToeCoinChoice", (data) => {
      try {
        const playerInfo = demoPlayerSockets.get(socket.id);
        if (!playerInfo || playerInfo.roomType !== "demoTicTacToe") return;

        const room = demoTicTacToeRooms.get(playerInfo.currentRoom);
        if (room) {
          room.handleCoinChoice(socket.id, data.choice);
          // Emit state to all players with their individual perspective
          room.players.forEach((player) => {
            io.to(player.socketId).emit(
              "ticTacToeState",
              room.getGameState(player.id)
            );
          });
        }
      } catch (error) {
        console.error("❌ Demo coin choice error:", error);
      }
    });

    socket.on("ticTacToeLetOtherChoose", () => {
      try {
        const playerInfo = demoPlayerSockets.get(socket.id);
        if (!playerInfo || playerInfo.roomType !== "demoTicTacToe") return;

        const room = demoTicTacToeRooms.get(playerInfo.currentRoom);
        if (room) {
          room.letOtherChoose(socket.id);
          // Emit state to all players with their individual perspective
          room.players.forEach((player) => {
            io.to(player.socketId).emit(
              "ticTacToeState",
              room.getGameState(player.id)
            );
          });
        }
      } catch (error) {
        console.error("❌ Demo let other choose error:", error);
      }
    });

    // Demo Tic-Tac-Toe game moves
    socket.on("ticTacToeMove", async (data) => {
      try {
        const playerInfo = demoPlayerSockets.get(socket.id);
        if (!playerInfo || playerInfo.roomType !== "demoTicTacToe") return;

        const room = demoTicTacToeRooms.get(playerInfo.currentRoom);
        if (room) {
          const gameState = await room.makeMove(socket.id, data.cellIndex);
          if (gameState) {
            // Emit state to all players with their individual perspective
            room.players.forEach((player) => {
              io.to(player.socketId).emit(
                "ticTacToeState",
                room.getGameState(player.id)
              );
            });
          }
        }
      } catch (error) {
        console.error("❌ Demo tic-tac-toe move error:", error);
      }
    });

    socket.on("ticTacToeReset", () => {
      try {
        const playerInfo = demoPlayerSockets.get(socket.id);
        if (!playerInfo || playerInfo.roomType !== "demoTicTacToe") return;

        const room = demoTicTacToeRooms.get(playerInfo.currentRoom);
        if (room) {
          room.resetGame();
          // Emit state to all players with their individual perspective
          room.players.forEach((player) => {
            io.to(player.socketId).emit(
              "ticTacToeState",
              room.getGameState(player.id)
            );
          });
        }
      } catch (error) {
        console.error("❌ Demo tic-tac-toe reset error:", error);
      }
    });

    // Cleanup on disconnect
    socket.on("disconnect", () => {
      console.log(`🎭 Demo client disconnected: ${socket.id}`);

      const playerInfo = demoPlayerSockets.get(socket.id);
      if (playerInfo) {
        // Clean up from appropriate demo room
        // For demo, we'll keep rooms alive for reconnection
        demoPlayerSockets.delete(socket.id);
      }
    });
  });

  console.log("✅ Demo routes setup complete!");

  // Start demo timeout management
  startDemoTimeoutManagement(io);
}

// Timeout management for demo tic-tac-toe rooms
function checkForDemoTimeouts(io) {
  const now = Date.now();
  const roomsToRemove = [];

  for (const [roomId, room] of demoTicTacToeRooms) {
    // Only check rooms with exactly one player waiting for an opponent
    if (room.players.length === 1 && room.gamePhase === "waiting") {
      const waitingTime = now - room.createdAt;

      // Check if room has been waiting for more than 5 minutes
      if (waitingTime > room.timeoutDuration) {
        console.log(
          `⏰ Found timed out demo room: ${roomId} (waiting ${Math.floor(
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
                    redirectTo: "/demo", // Redirect back to demo games
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
              `❌ Error handling demo timeout for room ${roomId}:`,
              error
            );
          });
      }
    }
  }

  // Remove timed out rooms
  roomsToRemove.forEach((roomId) => {
    console.log(`🗑️ Removing timed out demo room: ${roomId}`);
    const room = demoTicTacToeRooms.get(roomId);
    if (room) {
      room.cleanup(); // Clean up any remaining timeouts
      demoTicTacToeRooms.delete(roomId);
    }
  });
}

function startDemoTimeoutManagement(io) {
  // Run demo timeout check every 30 seconds
  setInterval(() => checkForDemoTimeouts(io), 30000);
  console.log("✅ Demo timeout management started");
}
