// Blocked username patterns — lowercase, checked via includes() and exact match
const BLOCKED_WORDS = [
  // Profanity
  'fuck', 'shit', 'ass', 'damn', 'bitch', 'bastard', 'dick', 'cock', 'pussy',
  'cunt', 'whore', 'slut', 'fag', 'faggot', 'nigger', 'nigga', 'retard',
  'twat', 'wanker', 'prick', 'douche', 'jackass', 'asshole', 'motherfucker',
  // Slurs & hate
  'kike', 'chink', 'spic', 'wetback', 'gook', 'raghead', 'towelhead',
  'tranny', 'shemale',
  // Sexual
  'porn', 'xxx', 'sex', 'penis', 'vagina', 'dildo', 'blowjob', 'handjob',
  'cumshot', 'orgasm', 'erection', 'masturbat', 'hentai',
  // Violence
  'kill', 'murder', 'rape', 'molest', 'terrorist', 'bomb', 'shoot',
  // Impersonation
  'admin', 'moderator', 'support', 'staff', 'official', 'rowfantasy',
  'helpdesk', 'system', 'root', 'superuser',
];

// Exact-match blocked usernames
const BLOCKED_EXACT = new Set([
  'god', 'satan', 'devil', 'hitler', 'nazi', 'kkk', 'isis',
  'null', 'undefined', 'anonymous', 'test', 'user', 'unknown',
]);

/**
 * Returns an error message if the username is inappropriate, or null if OK.
 */
export function validateUsernameContent(username: string): string | null {
  const lower = username.toLowerCase().replace(/[_\-\.]/g, '');

  if (BLOCKED_EXACT.has(lower)) {
    return 'This username is not allowed. Please choose another.';
  }

  for (const word of BLOCKED_WORDS) {
    if (lower.includes(word)) {
      return 'This username contains inappropriate language. Please choose another.';
    }
  }

  // Check for l33tspeak common substitutions
  const decoded = lower
    .replace(/0/g, 'o')
    .replace(/1/g, 'i')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/5/g, 's')
    .replace(/7/g, 't')
    .replace(/8/g, 'b')
    .replace(/@/g, 'a');

  if (decoded !== lower) {
    for (const word of BLOCKED_WORDS) {
      if (decoded.includes(word)) {
        return 'This username contains inappropriate language. Please choose another.';
      }
    }
  }

  return null;
}
