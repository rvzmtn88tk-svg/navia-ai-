// The live Snapshot (layer 1) for screens: engine state + the co-pilot's
// world view (places, alert, trip words) + network. One source for the
// assistant screen and the proactive layer during navigation.
import { useMemo } from "react";
import { useNaviaStore } from "../../engine/naviaController";
import { isSimulatedOffline } from "../../offline/network";
import { useCopilotWorld } from "../useCopilotWorld";
import { buildSnapshot, type Snapshot } from "./snapshot";

export function useNavigatorSnapshot(): Snapshot {
  const state = useNaviaStore((s) => s.state);
  const world = useCopilotWorld();
  return useMemo(() => buildSnapshot({ state, world, online: !isSimulatedOffline() }), [state, world]);
}
