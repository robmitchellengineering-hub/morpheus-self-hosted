// Wrapping around the playfield — the ship leaves one edge and comes back on the other.
//
// Rob, 2026-10-03: *"So in asteroids when you fly off the screen you should apear on the othe side and same
// for tope and bottom you know like the original"*
//
// IT WAS ALREADY SUPPOSED TO DO THIS, AND ONLY EVER WORKED FOR THE ASTEROIDS. The game had a `wrap()` that
// tested `o.x < -o.r` — and the ship is `{ x, y, angle, vx, vy, alive, invUntil }` with no `r` at all, as
// are the bullets. `-undefined` is `NaN`, every comparison against `NaN` is false, so the ship and the
// bullets sailed off the screen and were never seen again while the asteroids bounced correctly around.
//
// It lived inside the component, which is why nothing caught it: there was no way to test it. It is a pure
// function of (position, extent, radius) now, so `scripts/verify-deck-play.mjs` covers every edge of it in
// CI's no-install job — the bug was not a hard one, it was an untestable one.
//
// WHY THE RADIUS MATTERS. An object should leave the screen completely before it reappears, not pop the
// instant its centre crosses the boundary — otherwise it vanishes half-drawn and reappears half-drawn.
// So the wrap covers a span of `extent + 2r`: from `-r` (just fully off the left) to `extent + r` (just
// fully off the right). With `r = 0` that collapses to a plain centre wrap, which is the right behaviour
// for a point.

/**
 * Wrap one axis. Returns the position unchanged while the object is on screen, and its equivalent
 * position on the far side once it is fully past an edge.
 *
 * Modulo rather than `+= extent`, deliberately: a long frame (a backgrounded tab, a slow phone) can move
 * an object more than a whole screen in one step, and adding the extent once would leave it still
 * off-screen — a worse bug than the one being fixed, because it would happen rarely and look random.
 * The double modulo keeps the result positive for negative inputs, which JavaScript's `%` does not.
 *
 * @param {number} v current position on this axis
 * @param {number} extent the playfield's size on this axis (0 before the canvas is measured)
 * @param {number} [r] the object's radius — how far it must travel to be fully off screen
 * @returns {number}
 */
export function wrapAxis(v, extent, r = 0) {
  const value = Number(v);
  const span = Number(extent);
  const radius = Number.isFinite(r) && r > 0 ? r : 0;
  // Nothing to wrap against yet: the canvas has not been measured. Returning the value unchanged is
  // deliberate — the old code added `extent` (0) and moved nothing, so this is the same behaviour, and
  // it must never divide by zero or hand back NaN.
  if (!Number.isFinite(value) || !Number.isFinite(span) || span <= 0) return value;
  const full = span + 2 * radius;
  if (value >= -radius && value <= span + radius) return value;
  return ((((value + radius) % full) + full) % full) - radius;
}

/**
 * Wrap an object with `x`, `y` and an optional `r`.
 *
 * `r` is OPTIONAL BUT SHOULD BE GIVEN for anything drawn with a size: without it the object wraps on its
 * centre. The ship and the bullets both carry one now — the missing radius is what broke this.
 *
 * @param {{x: number, y: number, r?: number}} o mutated in place, like the rest of the game loop
 * @param {{w: number, h: number}} size
 */
export function wrapObject(o, { w, h } = {}) {
  if (!o || typeof o !== 'object') return o;
  o.x = wrapAxis(o.x, w, o.r);
  o.y = wrapAxis(o.y, h, o.r);
  return o;
}
