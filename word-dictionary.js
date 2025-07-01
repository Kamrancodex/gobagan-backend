// Word Dictionary for Word Grid Game
// Contains common English words for validation

// Common English words (subset for demo - in production use full dictionary)
const VALID_WORDS = new Set([
  // 3 letter words
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
  "OUT",
  "DAY",
  "GET",
  "HAS",
  "HIM",
  "HIS",
  "HOW",
  "ITS",
  "NEW",
  "NOW",
  "OLD",
  "SEE",
  "TWO",
  "WHO",
  "BOY",
  "DID",
  "END",
  "FEW",
  "GOT",
  "LET",
  "MAN",
  "OWN",
  "PUT",
  "SAY",
  "SHE",
  "TOO",
  "USE",

  // 4 letter words
  "THAT",
  "WITH",
  "HAVE",
  "THIS",
  "WILL",
  "YOUR",
  "FROM",
  "THEY",
  "KNOW",
  "WANT",
  "BEEN",
  "GOOD",
  "MUCH",
  "SOME",
  "TIME",
  "VERY",
  "WHEN",
  "COME",
  "HERE",
  "JUST",
  "LIKE",
  "LONG",
  "MAKE",
  "MANY",
  "OVER",
  "SUCH",
  "TAKE",
  "THAN",
  "THEM",
  "WELL",
  "WERE",
  "WHAT",
  "YEAR",
  "WORK",
  "BACK",
  "CALL",
  "CAME",
  "EACH",
  "EVEN",
  "FIND",
  "GIVE",
  "HAND",
  "HIGH",
  "KEEP",
  "LAST",
  "LEFT",
  "LIFE",
  "LIVE",
  "LOOK",
  "MADE",
  "MOST",
  "MOVE",
  "MUST",
  "NAME",
  "NEED",
  "NEXT",
  "OPEN",
  "PART",
  "PLAY",
  "SAID",
  "SAME",
  "SEEM",
  "SHOW",
  "SIDE",
  "TELL",
  "TURN",
  "USED",
  "WANT",
  "WAYS",
  "WEEK",
  "WENT",
  "WORD",
  "WORK",
  "YEAR",

  // 5 letter words
  "ABOUT",
  "AFTER",
  "AGAIN",
  "BEING",
  "COULD",
  "FIRST",
  "FOUND",
  "GREAT",
  "GROUP",
  "HOUSE",
  "LARGE",
  "LIGHT",
  "MIGHT",
  "NEVER",
  "OTHER",
  "PLACE",
  "RIGHT",
  "SHALL",
  "SMALL",
  "SOUND",
  "STILL",
  "THINK",
  "THREE",
  "UNDER",
  "WATER",
  "WHERE",
  "WHICH",
  "WHILE",
  "WORLD",
  "WOULD",
  "WRITE",
  "YOUNG",
  "ABOVE",
  "AMONG",
  "BEGAN",
  "BLACK",
  "CARRY",
  "CLOSE",
  "EVERY",
  "HEARD",
  "LATER",
  "LEARN",
  "LEAVE",
  "MUSIC",
  "OFTEN",
  "ORDER",
  "POINT",
  "ROUND",
  "SOUND",
  "STAND",
  "START",
  "STATE",
  "STUDY",
  "TABLE",
  "UNTIL",
  "VOICE",
  "WHITE",
  "WHOLE",

  // 6 letter words
  "BEFORE",
  "CHANGE",
  "COURSE",
  "DURING",
  "FAMILY",
  "FOLLOW",
  "FRIEND",
  "GROUND",
  "HAPPEN",
  "HAVING",
  "LETTER",
  "LIVING",
  "MAKING",
  "MOTHER",
  "MOVING",
  "MYSELF",
  "NEVER",
  "NUMBER",
  "ORANGE",
  "PERSON",
  "PLEASE",
  "PRETTY",
  "PUBLIC",
  "RATHER",
  "SCHOOL",
  "SECOND",
  "SHOULD",
  "SIMPLE",
  "SISTER",
  "STREET",
  "STRONG",
  "THINGS",
  "THOUGH",
  "TRYING",
  "TURNED",
  "UNITED",
  "WANTED",
  "WINDOW",
  "WINTER",
  "WITHIN",
  "WONDER",
  "WORKED",
  "YELLOW",

  // 7 letter words
  "AGAINST",
  "ALREADY",
  "ANOTHER",
  "BECAUSE",
  "BETWEEN",
  "BROUGHT",
  "CERTAIN",
  "COMPANY",
  "COUNTRY",
  "EDUCATION",
  "EVENING",
  "EXAMPLE",
  "GENERAL",
  "GETTING",
  "GREATER",
  "GROWING",
  "HIMSELF",
  "HUSBAND",
  "INSTEAD",
  "KITCHEN",
  "LOOKING",
  "MACHINE",
  "MORNING",
  "NOTHING",
  "PARENTS",
  "PERHAPS",
  "PICTURE",
  "PROBLEM",
  "PROGRAM",
  "PROTECT",
  "RECEIVE",
  "RUNNING",
  "SCIENCE",
  "SEVERAL",
  "SOMEONE",
  "SPECIAL",
  "STATION",
  "STUDENT",
  "SURFACE",
  "SYSTEMS",
  "TEACHER",
  "THROUGH",
  "TONIGHT",
  "TROUBLE",
  "USUALLY",
  "VERSION",
  "WALKING",
  "WEATHER",
  "WELCOME",
  "WESTERN",
  "WITHOUT",
  "WORKING",
  "WRITING",

  // 8 letter words
  "ALTHOUGH",
  "BUSINESS",
  "CHILDREN",
  "COMPUTER",
  "CONTINUE",
  "DECISION",
  "EVERYONE",
  "FUNCTION",
  "HOWEVER",
  "INCREASE",
  "LANGUAGE",
  "LEARNING",
  "MATERIAL",
  "NATIONAL",
  "OFFICIAL",
  "PERSONAL",
  "PHYSICAL",
  "POSITION",
  "POSSIBLE",
  "REMEMBER",
  "RESEARCH",
  "RESPONSE",
  "SECURITY",
  "SERVICES",
  "SHOULDER",
  "SOLDIERS",
  "SPEAKING",
  "STANDING",
  "STANDARD",
  "STARTING",
  "STUDENTS",
  "TEACHING",
  "TOGETHER",
  "TRAINING",
  "TRAVELED",
  "WATCHING",

  // Common short words for gameplay
  "CAT",
  "DOG",
  "SUN",
  "SKY",
  "EAR",
  "EYE",
  "ARM",
  "LEG",
  "RUN",
  "WIN",
  "YES",
  "RED",
  "BIG",
  "BAD",
  "HOT",
  "TOP",
  "CUP",
  "BAG",
  "MAP",
  "PEN",
  "BED",
  "CAR",
  "ART",
  "EAT",
  "FUN",
  "JOB",
  "KEY",
  "LAW",
  "LOT",
  "MAY",
  "MOM",
  "NET",
  "OIL",
  "PAY",
  "POP",
  "RUN",
  "SIT",
  "SIX",
  "TAX",
  "TRY",
  "WAR",
  "WAY",
  "WIN",
  "YET",
  "ZOO",

  // Game words
  "GAME",
  "PLAY",
  "WORD",
  "GRID",
  "TIMER",
  "SCORE",
  "POINT",
  "CHESS",
  "BOARD",
  "MATCH",
  "RULES",
  "TURNS",
  "MOVES",
  "COINS",
  "PRIZE",
  "MONEY",
]);

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
  if (!word || typeof word !== "string") return false;

  const cleanWord = word.toUpperCase().trim();
  if (cleanWord.length < 3) return false; // Minimum 3 letters

  return VALID_WORDS.has(cleanWord);
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

// Function to find all words in a grid
export function findWordsInGrid(grid, gridSize = 8) {
  const words = [];

  // Helper function to extract word from coordinates
  const extractWord = (coordinates) => {
    return coordinates
      .map((coord) => grid[coord])
      .filter((cell) => cell && cell.letter)
      .map((cell) => cell.letter)
      .join("");
  };

  // Check horizontal words (rows)
  for (let row = 0; row < gridSize; row++) {
    for (let startCol = 0; startCol < gridSize; startCol++) {
      for (let endCol = startCol + 2; endCol < gridSize; endCol++) {
        // Minimum 3 letters
        const coordinates = [];
        for (let col = startCol; col <= endCol; col++) {
          coordinates.push(row * gridSize + col);
        }

        const word = extractWord(coordinates);
        if (word.length >= 3 && isValidWord(word)) {
          words.push({
            word: word,
            coordinates: coordinates,
            direction: "horizontal",
          });
        }
      }
    }
  }

  // Check vertical words (columns)
  for (let col = 0; col < gridSize; col++) {
    for (let startRow = 0; startRow < gridSize; startRow++) {
      for (let endRow = startRow + 2; endRow < gridSize; endRow++) {
        // Minimum 3 letters
        const coordinates = [];
        for (let row = startRow; row <= endRow; row++) {
          coordinates.push(row * gridSize + col);
        }

        const word = extractWord(coordinates);
        if (word.length >= 3 && isValidWord(word)) {
          words.push({
            word: word,
            coordinates: coordinates,
            direction: "vertical",
          });
        }
      }
    }
  }

  // Check diagonal words (top-left to bottom-right)
  for (let startRow = 0; startRow < gridSize; startRow++) {
    for (let startCol = 0; startCol < gridSize; startCol++) {
      for (
        let len = 3;
        len <= Math.min(gridSize - startRow, gridSize - startCol);
        len++
      ) {
        const coordinates = [];
        for (let i = 0; i < len; i++) {
          coordinates.push((startRow + i) * gridSize + (startCol + i));
        }

        const word = extractWord(coordinates);
        if (word.length >= 3 && isValidWord(word)) {
          words.push({
            word: word,
            coordinates: coordinates,
            direction: "diagonal-down",
          });
        }
      }
    }
  }

  // Check diagonal words (top-right to bottom-left)
  for (let startRow = 0; startRow < gridSize; startRow++) {
    for (let startCol = gridSize - 1; startCol >= 0; startCol--) {
      for (
        let len = 3;
        len <= Math.min(gridSize - startRow, startCol + 1);
        len++
      ) {
        const coordinates = [];
        for (let i = 0; i < len; i++) {
          coordinates.push((startRow + i) * gridSize + (startCol - i));
        }

        const word = extractWord(coordinates);
        if (word.length >= 3 && isValidWord(word)) {
          words.push({
            word: word,
            coordinates: coordinates,
            direction: "diagonal-up",
          });
        }
      }
    }
  }

  return words;
}

// Function to detect new words formed after placing a letter
export function detectNewWords(grid, newLetterIndex, existingWords = []) {
  const allWords = findWordsInGrid(grid);
  const existingWordStrings = existingWords.map((w) => w.word);

  // Filter to only new words that include the newly placed letter
  const newWords = allWords.filter((wordObj) => {
    const includesNewLetter = wordObj.coordinates.includes(newLetterIndex);
    const isNew = !existingWordStrings.includes(wordObj.word);
    const notTrivial = !isTrivialExtension(wordObj.word, existingWordStrings);

    return includesNewLetter && isNew && notTrivial;
  });

  return newWords;
}

export default {
  isValidWord,
  isTrivialExtension,
  findWordsInGrid,
  detectNewWords,
};
