// When turn-by-turn prompts may be spoken: only during a trip, and never
// while off the route (its turns no longer apply; a reroute brings new ones).
export function turnPromptsAllowed(phase: string, offRoute: boolean): boolean {
  return phase === "navigating" && !offRoute;
}
