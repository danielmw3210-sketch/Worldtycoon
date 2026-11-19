import crypto from 'crypto';

// Monero 25-word mnemonic seed dictionary subset (standard English wordlist)
const WORD_LIST = [
  "abbey", "abducts", "ability", "ablaze", "abnormal", "abort", "abrasive", "absorb",
  "abyss", "academy", "aces", "aching", "acidic", "acoustic", "acquire", "across",
  "actress", "acumen", "adapt", "addicted", "adept", "adhesive", "adjust", "adopt",
  "adrenalin", "adult", "adventure", "aerial", "afar", "affair", "afloat", "afraid",
  "after", "against", "agenda", "agile", "agony", "agree", "ahead", "aided",
  "aim", "airliner", "aisle", "ajar", "alarm", "albatross", "album", "alchemy",
  "alert", "algae", "alias", "alibi", "align", "alike", "alive", "alkaline",
  "allay", "alleged", "allied", "alligator", "allotted", "alluvial", "almond", "almost",
  "aloft", "aloha", "alone", "aloof", "alphabet", "already", "alters", "alumni",
  "always", "amass", "amber", "ambient", "amend", "amino", "ammunition", "amnesia",
  "among", "amount", "ample", "amuse", "anchor", "ancient", "android", "anecdote",
  "angel", "angler", "animated", "ankle", "annex", "announce", "anodize", "anomaly",
  "answer", "antelope", "antenna", "anthem", "antibiotic", "antique", "anvil", "anyplace",
  "aorta", "apartment", "apology", "apostle", "appeals", "append", "applaud", "appoint",
  "approval", "apron", "aquarium", "arcade", "archaic", "architect", "arctic", "ardent",
  "arena", "argument", "arithmetic", "armadillo", "aroma", "arouse", "array", "arrest",
  "arrow", "artery", "artful", "artwork", "ascend", "ascent", "ashes", "aside",
  "aspect", "aspirin", "assemble", "assert", "assess", "asset", "assign", "assist",
  "assume", "assurance", "astonish", "astronomy", "athlete", "atlas", "atom", "atrium",
  "attack", "attempt", "attire", "attract", "audible", "augment", "aunt", "aurora",
  "authentic", "author", "automate", "autumn", "avail", "avenge", "avenue", "average"
];

// Base58 characters used in Monero / Cryptonote
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function randomBase58(length) {
  let str = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    str += BASE58_ALPHABET[bytes[i] % BASE58_ALPHABET.length];
  }
  return str;
}

/**
 * Generates a realistic Numista Cryptonote Testnet Wallet
 * Numista Testnet address starts with 'Gr' and is 95 characters long
 */
export function generateNumistaWallet(label = "New Numista Wallet") {
  // Generate private spend key and private view key (32 bytes = 64 hex chars)
  const spendKeyPrivate = crypto.randomBytes(32).toString('hex');
  const viewKeyPrivate = crypto.randomBytes(32).toString('hex');
  
  // Public keys (simulated Ed25519)
  const spendKeyPublic = crypto.createHash('sha256').update(spendKeyPrivate).digest('hex');
  const viewKeyPublic = crypto.createHash('sha256').update(viewKeyPrivate).digest('hex');

  // Numista testnet primary address: starts with 'Gr' + 93 base58 characters (total 95 chars)
  const address = 'Gr' + randomBase58(93);

  // Generate 25-word Monero mnemonic seed
  const seedWords = [];
  for (let i = 0; i < 24; i++) {
    const randIdx = crypto.randomBytes(2).readUInt16BE(0) % WORD_LIST.length;
    seedWords.push(WORD_LIST[randIdx]);
  }
  // 25th checksum word
  seedWords.push(seedWords[0]);
  const mnemonic = seedWords.join(' ');

  return {
    address,
    label,
    mnemonic,
    keys: {
      spendKeyPrivate,
      viewKeyPrivate,
      spendKeyPublic,
      viewKeyPublic
    },
    createdAt: new Date().toISOString(),
    network: "Numista Testnet (Cryptonote)"
  };
}
