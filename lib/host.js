/**
 * Host half of dsh-limbs.
 *
 * The plugin is a Client UI plugin: every visible capability lives in the
 * browser half (lib/client.js). This Host half exists only so the Loader has a
 * package entry to mount. It deliberately registers nothing — no tools, no
 * services, no timers, no persistence, no network calls.
 *
 * Keep it that way: a Host-side catalogue or cache here would be a second
 * source of truth beside the Host's own session model catalog.
 */

/** Mount the package. Intentionally empty. */
export function apply() {}
