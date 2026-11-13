import { loadLiveProfiles } from "./live-profiles.ts";

/**
 * The live worker's profile module: `cli.ts worker src/service/providers.ts`.
 * Loading it without BIRBCREW_LIVE_PROFILES, or without a configured engine's credential, stops the worker at startup.
 */
export const profiles = await loadLiveProfiles(process.env);
