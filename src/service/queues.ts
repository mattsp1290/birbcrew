import type { Engine } from "./domain.ts";

export const memberTaskQueue = "birbcrew-ts-members-v1";
export function activityQueue(engine: Engine, profile: string) {
  return `${memberTaskQueue}/${engine}/${profile}`;
}
