// The live Snapshot (layer 1) for screens: engine state + the co-pilot's
// world view (places, alert, trip words) + network. One source for the
// assistant screen and the proactive layer during navigation.
import { useMemo } from "react";
import { useNaviaStore } from "../../engine/naviaController";
import { isSimulatedOffline } from "../../offline/network";
import { useCopilotWorld } from "../useCopilotWorld";
import { buildSnapshot, type Snapshot } from "./snapshot";
import { classify, exampleBank } from "./intents";

// Build the example index once, when a screen that talks to the navigator
// mounts — not on the driver's first question.
let warmed = false;
function warm(): void { if (!warmed) { warmed = true; setTimeout(() => { exampleBank(); classify("прогрів штурмана"); }, 0); } }

export function useNavigatorSnapshot(): Snapshot {
  warm();
  const state = useNaviaStore((s) => s.state);
  const world = useCopilotWorld();
  return useMemo(() => buildSnapshot({ state, world, online: !isSimulatedOffline() }), [state, world]);
}
