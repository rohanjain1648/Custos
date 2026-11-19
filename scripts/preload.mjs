// Load CosmJS before anything else. CosmJS 0.39 is CommonJS but require()s ESM-only packages (@scure/base,
// @noble/curves). If an ES module graph reaches those first, Node 22 refuses with ERR_REQUIRE_CYCLE_MODULE.
// Evaluating CosmJS in its own graph first (node --import) loads them through require() once, cleanly.
await import("@cosmjs/stargate");
await import("@cosmjs/cosmwasm-stargate");
