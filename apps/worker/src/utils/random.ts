/**
 * Returns a random integer between `min` and `max` (inclusive).
 * Used to introduce human-like variance in automation timing.
 */
export function random(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
