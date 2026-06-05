/**
 * The store: the only layer that knows about git. It reads/writes the
 * .git/cairn/ journal, the refs/notes/cairn namespace, and Lore commit trailers.
 */
export * from "./git.js";
export * from "./journal.js";
export * from "./trailers.js";
export * from "./notes.js";
export * from "./staleness.js";
export * from "./reverts.js";
