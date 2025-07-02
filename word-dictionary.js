// Word Dictionary for Word Grid Game
// Contains common English words for validation

import englishWords from "word-list-json";

// Comprehensive English word list
const validWords = new Set(englishWords.map((word) => word.toUpperCase()));

// Add common 2-letter words that might be missing
const twoLetterWords = [
  "AM",
  "AN",
  "AS",
  "AT",
  "BE",
  "BY",
  "DO",
  "GO",
  "HE",
  "IF",
  "IN",
  "IS",
  "IT",
  "ME",
  "MY",
  "NO",
  "OF",
  "ON",
  "OR",
  "SO",
  "TO",
  "UP",
  "US",
  "WE",
];

const threeLetterWords = [
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
  "HAS",
  "HIS",
  "HOW",
  "ITS",
  "MAY",
  "NEW",
  "NOW",
  "OLD",
  "SEE",
  "TWO",
  "WHO",
  "BOY",
  "DID",
  "GET",
  "LET",
  "MAN",
  "SAY",
  "SHE",
  "TOO",
  "WAY",
  "CAT",
  "DOG",
  "BAD",
  "BIG",
  "EAT",
  "FAR",
  "FUN",
  "GOT",
  "HOT",
  "JOB",
  "LAW",
  "LOT",
  "OWN",
  "RUN",
  "SIT",
  "TOP",
  "TRY",
  "WIN",
  "YES",
  "YET",
];

// Add these common words to our set
twoLetterWords.forEach((word) => validWords.add(word));
threeLetterWords.forEach((word) => validWords.add(word));

console.log(`📚 Loaded ${validWords.size} valid English words for Word Grid`);

// Common suffixes to detect trivial extensions
const TRIVIAL_SUFFIXES = [
  "S",
  "ES",
  "ED",
  "ING",
  "LY",
  "ER",
  "EST",
  "ION",
  "TION",
  "SION",
  "NESS",
  "MENT",
  "ABLE",
  "IBLE",
  "FUL",
  "LESS",
];

// Function to check if a word is valid
export function isValidWord(word) {
  if (!word || word.length < 2) return false;
  const upperWord = word.toUpperCase().trim();
  return validWords.has(upperWord);
}

// Function to check if a word is a trivial extension of an existing word
export function isTrivialExtension(newWord, existingWords) {
  if (!newWord || !Array.isArray(existingWords)) return false;

  const cleanNewWord = newWord.toUpperCase().trim();

  for (const existingWord of existingWords) {
    const cleanExisting = existingWord.toUpperCase().trim();

    // Check if new word is just existing word + suffix
    if (
      cleanNewWord.startsWith(cleanExisting) &&
      cleanNewWord !== cleanExisting
    ) {
      const suffix = cleanNewWord.substring(cleanExisting.length);

      // Check if it's a trivial suffix
      for (const trivialSuffix of TRIVIAL_SUFFIXES) {
        if (suffix === trivialSuffix) {
          return true;
        }
      }
    }
  }

  return false;
}

// Get all 8 directions from a cell
function getDirections() {
  return [
    { dx: 0, dy: 1 }, // right
    { dx: 1, dy: 0 }, // down
    { dx: 1, dy: 1 }, // diagonal down-right
    { dx: 1, dy: -1 }, // diagonal down-left
    { dx: 0, dy: -1 }, // left
    { dx: -1, dy: 0 }, // up
    { dx: -1, dy: -1 }, // diagonal up-left
    { dx: -1, dy: 1 }, // diagonal up-right
  ];
}

// Convert cell index to row, col
function indexToCoords(index) {
  return { row: Math.floor(index / 8), col: index % 8 };
}

// Convert row, col to cell index
function coordsToIndex(row, col) {
  return row * 8 + col;
}

// Check if coordinates are valid
function isValidCoord(row, col) {
  return row >= 0 && row < 8 && col >= 0 && col < 8;
}

// Get word in a specific direction from starting position
function getWordInDirection(
  grid,
  startRow,
  startCol,
  direction,
  minLength = 2,
  maxLength = 8
) {
  let word = "";
  let coordinates = [];
  let row = startRow;
  let col = startCol;

  for (let i = 0; i < maxLength && isValidCoord(row, col); i++) {
    const cellIndex = coordsToIndex(row, col);
    const cell = grid[cellIndex];

    if (!cell || !cell.letter) break;

    word += cell.letter;
    coordinates.push(cellIndex);

    // Check if we have a valid word of minimum length
    if (word.length >= minLength && isValidWord(word)) {
      // Return the valid word found
      return {
        word: word,
        coordinates: coordinates.slice(),
        length: word.length,
        startIndex: coordsToIndex(startRow, startCol),
        direction: direction,
      };
    }

    row += direction.dx;
    col += direction.dy;
  }

  return null;
}

// Find all words in the grid
export function findWordsInGrid(grid) {
  const foundWords = [];
  const wordSet = new Set(); // Prevent duplicates

  // Check all starting positions
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const cellIndex = coordsToIndex(row, col);
      const cell = grid[cellIndex];

      if (!cell || !cell.letter) continue;

      // Check all directions from this position
      const directions = getDirections();
      for (const direction of directions) {
        const wordResult = getWordInDirection(grid, row, col, direction);

        if (wordResult) {
          const wordKey = `${wordResult.word}_${wordResult.coordinates.join(
            "-"
          )}`;
          if (!wordSet.has(wordKey)) {
            wordSet.add(wordKey);
            foundWords.push(wordResult);
          }
        }
      }
    }
  }

  return foundWords;
}

// Detect new words formed after placing a letter
export function detectNewWords(grid, lastPlacedIndex, previousWords = []) {
  // Get all current words
  const currentWords = findWordsInGrid(grid);

  // Find words that weren't there before
  const newWords = [];
  const previousWordKeys = new Set(
    previousWords.map((w) => `${w.word}_${w.coordinates.join("-")}`)
  );

  for (const wordResult of currentWords) {
    const wordKey = `${wordResult.word}_${wordResult.coordinates.join("-")}`;

    // Check if this is a new word and if it includes the newly placed letter
    if (
      !previousWordKeys.has(wordKey) &&
      wordResult.coordinates.includes(lastPlacedIndex)
    ) {
      newWords.push({
        word: wordResult.word,
        coordinates: wordResult.coordinates,
        length: wordResult.length,
        startIndex: wordResult.startIndex,
        direction: wordResult.direction,
        points: wordResult.length, // Points equal to word length
        isNew: true,
      });
    }
  }

  console.log(
    `🔍 Detected ${newWords.length} new words:`,
    newWords.map((w) => w.word)
  );
  return newWords;
}

// Get word suggestions for debugging/hints
export function getWordSuggestions(grid, emptyIndices, maxSuggestions = 5) {
  const suggestions = [];

  for (const emptyIndex of emptyIndices.slice(0, 10)) {
    // Check first 10 empty spots
    const { row, col } = indexToCoords(emptyIndex);

    // Try each letter
    for (let charCode = 65; charCode <= 90; charCode++) {
      // A-Z
      const letter = String.fromCharCode(charCode);

      // Simulate placing this letter
      const testGrid = [...grid];
      testGrid[emptyIndex] = { letter, playerId: "test", isNewWord: false };

      // Check if this creates any new words
      const newWords = detectNewWords(testGrid, emptyIndex, []);

      if (newWords.length > 0) {
        suggestions.push({
          cellIndex: emptyIndex,
          letter: letter,
          wordsFormed: newWords.map((w) => w.word),
          totalPoints: newWords.reduce((sum, w) => sum + w.points, 0),
        });

        if (suggestions.length >= maxSuggestions) break;
      }
    }

    if (suggestions.length >= maxSuggestions) break;
  }

  return suggestions.sort((a, b) => b.totalPoints - a.totalPoints);
}

// Export word list size for verification
export const wordCount = validWords.size;

export default {
  isValidWord,
  isTrivialExtension,
  findWordsInGrid,
  detectNewWords,
  getWordSuggestions,
  wordCount,
};
