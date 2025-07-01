import mongoose from "mongoose";

// User Schema
const userSchema = new mongoose.Schema({
  walletAddress: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  username: {
    type: String,
    default: null,
  },
  totalGamesPlayed: {
    type: Number,
    default: 0,
  },
  totalWins: {
    type: Number,
    default: 0,
  },
  totalLosses: {
    type: Number,
    default: 0,
  },
  totalEarnings: {
    type: Number,
    default: 0,
  },
  gamesStats: {
    ticTacToe: {
      played: { type: Number, default: 0 },
      wins: { type: Number, default: 0 },
      losses: { type: Number, default: 0 },
      earnings: { type: Number, default: 0 },
    },
    orbCollector: {
      played: { type: Number, default: 0 },
      wins: { type: Number, default: 0 },
      losses: { type: Number, default: 0 },
      earnings: { type: Number, default: 0 },
    },
    tokenTakedown: {
      played: { type: Number, default: 0 },
      wins: { type: Number, default: 0 },
      losses: { type: Number, default: 0 },
      earnings: { type: Number, default: 0 },
    },
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  lastActive: {
    type: Date,
    default: Date.now,
  },
});

// Game Match Schema
const gameMatchSchema = new mongoose.Schema({
  gameId: {
    type: String,
    required: true,
    unique: true,
  },
  gameType: {
    type: String,
    required: true,
    enum: [
      "ticTacToe",
      "connect4",
      "checkers",
      "orbCollector",
      "tokenTakedown",
    ], // Add more games later
  },
  players: [
    {
      walletAddress: String,
      symbol: String, // X or O for tic-tac-toe
      betAmount: Number,
      isWinner: { type: Boolean, default: false },
    },
  ],
  spectators: [
    {
      walletAddress: String,
      joinedAt: { type: Date, default: Date.now },
    },
  ],
  gameState: {
    type: String,
    enum: ["waiting", "playing", "finished"],
    default: "waiting",
  },
  betPool: {
    totalAmount: { type: Number, default: 0 },
    platformFee: { type: Number, default: 0 },
    winnerPayout: { type: Number, default: 0 },
  },
  gameData: {
    board: [String], // For tic-tac-toe
    moves: [
      {
        player: String,
        move: mongoose.Schema.Types.Mixed,
        timestamp: { type: Date, default: Date.now },
      },
    ],
    winner: String,
    gameResult: String, // 'win', 'loss', 'draw'
  },
  startedAt: Date,
  finishedAt: Date,
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Leaderboard Entry Schema
const leaderboardSchema = new mongoose.Schema({
  gameType: {
    type: String,
    required: true,
    enum: [
      "ticTacToe",
      "connect4",
      "checkers",
      "orbCollector",
      "tokenTakedown",
    ],
  },
  period: {
    type: String,
    enum: ["daily", "weekly", "monthly", "allTime"],
    default: "allTime",
  },
  rankings: [
    {
      walletAddress: String,
      wins: Number,
      totalEarnings: Number,
      gamesPlayed: Number,
      winRate: Number,
      rank: Number,
    },
  ],
  lastUpdated: {
    type: Date,
    default: Date.now,
  },
});

// Platform Stats Schema
const platformStatsSchema = new mongoose.Schema({
  totalUsers: { type: Number, default: 0 },
  totalGames: { type: Number, default: 0 },
  totalVolume: { type: Number, default: 0 },
  totalFees: { type: Number, default: 0 },
  gameStats: {
    ticTacToe: {
      totalGames: { type: Number, default: 0 },
      totalVolume: { type: Number, default: 0 },
    },
    orbCollector: {
      totalGames: { type: Number, default: 0 },
      totalVolume: { type: Number, default: 0 },
    },
    tokenTakedown: {
      totalGames: { type: Number, default: 0 },
      totalVolume: { type: Number, default: 0 },
    },
  },
  lastUpdated: {
    type: Date,
    default: Date.now,
  },
});

// Create models
export const User = mongoose.model("User", userSchema);
export const GameMatch = mongoose.model("GameMatch", gameMatchSchema);
export const Leaderboard = mongoose.model("Leaderboard", leaderboardSchema);
export const PlatformStats = mongoose.model(
  "PlatformStats",
  platformStatsSchema
);

// Database connection function
export const connectDB = async () => {
  try {
    const MONGODB_URI =
      "mongodb+srv://kampremiumyt:CfBF6Rsm3FLwwQxy@cluster0.moaux.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";

    await mongoose.connect(MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    console.log("✅ MongoDB connected successfully");

    // Initialize platform stats if not exists
    const stats = await PlatformStats.findOne();
    if (!stats) {
      await PlatformStats.create({});
      console.log("📊 Platform stats initialized");
    }
  } catch (error) {
    console.error("❌ MongoDB connection error:", error);
    process.exit(1);
  }
};

// Helper functions
export const getOrCreateUser = async (walletAddress) => {
  let user = await User.findOne({ walletAddress });

  if (!user) {
    user = await User.create({
      walletAddress,
      lastActive: new Date(),
    });

    // Update platform stats
    await PlatformStats.updateOne({}, { $inc: { totalUsers: 1 } });
  } else {
    // Update last active
    user.lastActive = new Date();
    await user.save();
  }

  return user;
};

export const updateUserStats = async (
  walletAddress,
  gameType,
  isWinner,
  earnings
) => {
  const updateData = {
    $inc: {
      totalGamesPlayed: 1,
      [`gamesStats.${gameType}.played`]: 1,
    },
  };

  if (isWinner) {
    updateData.$inc.totalWins = 1;
    updateData.$inc[`gamesStats.${gameType}.wins`] = 1;
  } else {
    updateData.$inc.totalLosses = 1;
    updateData.$inc[`gamesStats.${gameType}.losses`] = 1;
  }

  if (earnings > 0) {
    updateData.$inc.totalEarnings = earnings;
    updateData.$inc[`gamesStats.${gameType}.earnings`] = earnings;
  }

  await User.updateOne({ walletAddress }, updateData);
};

export const getLeaderboard = async (gameType = "ticTacToe", limit = 10) => {
  const users = await User.find({
    [`gamesStats.${gameType}.played`]: { $gt: 0 },
  })
    .sort({
      [`gamesStats.${gameType}.wins`]: -1,
      [`gamesStats.${gameType}.earnings`]: -1,
    })
    .limit(limit)
    .select("walletAddress gamesStats totalEarnings");

  return users.map((user, index) => ({
    rank: index + 1,
    walletAddress: user.walletAddress,
    wins: user.gamesStats[gameType]?.wins || 0,
    losses: user.gamesStats[gameType]?.losses || 0,
    played: user.gamesStats[gameType]?.played || 0,
    earnings: user.gamesStats[gameType]?.earnings || 0,
    winRate:
      user.gamesStats[gameType]?.played > 0
        ? Math.round(
            (user.gamesStats[gameType]?.wins /
              user.gamesStats[gameType]?.played) *
              100
          )
        : 0,
  }));
};

export const getRecentMatches = async (gameType = "ticTacToe", limit = 20) => {
  return await GameMatch.find({
    gameType,
    gameState: "finished",
  })
    .sort({ finishedAt: -1 })
    .limit(limit)
    .select("players gameData.winner betPool finishedAt");
};
