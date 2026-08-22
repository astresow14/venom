/**
 * Client-side gate for canon teach intent.
 *
 * This is a cost guard, not an authority: it only decides whether a super
 * admin's message is worth a proposal round-trip. The server re-verifies the
 * role and re-runs its own (authoritative) gate on every call, and regular
 * users never reach this code path at all — their sends go straight to chat.
 *
 * Recall-oriented on purpose: a false positive costs one propose call that
 * comes back `teachIntent: false` and falls through to normal chat; a false
 * negative silently drops a teaching. Mirror the server's verb/noun pairing.
 */
const TEACH_VERB =
  /\b(?:store|save|keep|remember|absorb|learn|canoni[sz]e|adopt|internali[sz]e|teach|add|commit|codify|enshrine|treat|file)\b/i;
const TEACH_NOUN =
  /\b(?:principles?|teachings?|doctrines?|canon(?:ical)?|rules?|guidelines?|foundations?|fundamentals?|skills?|lessons?|maxims?|tenets?|precepts?)\b/i;
const TEACH_PHRASE =
  /\bcanon\b|\bteach\s+(?:yourself|venom)\b|\b(?:your|our|the)\s+core\s+\w+(?:\s+\w+)?\s+principles\b/i;

export function canonTeachGate(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 24_000) return false;
  if (TEACH_PHRASE.test(trimmed)) return true;
  return TEACH_VERB.test(trimmed) && TEACH_NOUN.test(trimmed);
}
