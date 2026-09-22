// Spec section 21: full IDLE -> ROUTING -> ACTIVE -> GNSS_DEGRADED ->
// GNSS_LOST -> POSITION_UNCERTAIN -> GNSS_RECOVERED(RECOVERING) -> ACTIVE
// chain, plus ACTIVE<->OFF_ROUTE and ACTIVE->ARRIVED, all with hysteresis
// ("do not switch state on one noisy sample").
import {test} from "node:test";
import assert from "node:assert/strict";
import {NavigationStateMachine, type StateMachineInput} from "../src/navigation-state-machine";

function baseInput(overrides: Partial<StateMachineInput> = {}): StateMachineInput {
  return {
    gnssIntegrity: "NORMAL",
    confidenceBand: "HIGH",
    offRouteConfirmed: false,
    hasArrived: false,
    routeRequested: false,
    routeReady: false,
    ...overrides,
  };
}

test("state machine: IDLE -> ROUTING -> ACTIVE happy path", () => {
  const sm = new NavigationStateMachine();
  assert.equal(sm.getMode(), "IDLE");
  assert.equal(sm.tick(baseInput({routeRequested: true})), "ROUTING");
  assert.equal(sm.tick(baseInput({routeReady: true})), "ACTIVE");
});

test("state machine: a single degraded sample does NOT drop out of ACTIVE (hysteresis)", () => {
  const sm = new NavigationStateMachine({degradedConfirmSamples: 3});
  sm.tick(baseInput({routeRequested: true}));
  sm.tick(baseInput({routeReady: true}));
  assert.equal(sm.getMode(), "ACTIVE");
  const mode = sm.tick(baseInput({gnssIntegrity: "DEGRADED"}));
  assert.equal(mode, "ACTIVE");
});

test("state machine: sustained degraded samples DO transition to GNSS_DEGRADED", () => {
  const sm = new NavigationStateMachine({degradedConfirmSamples: 3});
  sm.tick(baseInput({routeRequested: true}));
  sm.tick(baseInput({routeReady: true}));
  sm.tick(baseInput({gnssIntegrity: "DEGRADED"}));
  sm.tick(baseInput({gnssIntegrity: "DEGRADED"}));
  const mode = sm.tick(baseInput({gnssIntegrity: "DEGRADED"}));
  assert.equal(mode, "GNSS_DEGRADED");
});

test("state machine: sustained LOST escalates to GNSS_LOST, then to POSITION_UNCERTAIN when confidence collapses", () => {
  const sm = new NavigationStateMachine({lostConfirmSamples: 2});
  sm.tick(baseInput({routeRequested: true}));
  sm.tick(baseInput({routeReady: true}));
  sm.tick(baseInput({gnssIntegrity: "LOST", confidenceBand: "LOW"}));
  let mode = sm.tick(baseInput({gnssIntegrity: "LOST", confidenceBand: "LOW"}));
  assert.equal(mode, "GNSS_LOST");
  mode = sm.tick(baseInput({gnssIntegrity: "LOST", confidenceBand: "UNKNOWN"}));
  assert.equal(mode, "POSITION_UNCERTAIN");
});

test("state machine: recovery requires several consecutive good samples, then returns to ACTIVE", () => {
  const sm = new NavigationStateMachine({lostConfirmSamples: 1, recovery: {confirmSamples: 3}});
  sm.tick(baseInput({routeRequested: true}));
  sm.tick(baseInput({routeReady: true}));
  sm.tick(baseInput({gnssIntegrity: "LOST", confidenceBand: "LOW"}));
  assert.equal(sm.getMode(), "GNSS_LOST");

  // First good sample flips into RECOVERING, not straight back to ACTIVE.
  let mode = sm.tick(baseInput({gnssIntegrity: "NORMAL", confidenceBand: "HIGH"}));
  assert.equal(mode, "RECOVERING");
  // Needs confirmSamples consecutive good samples in total; one more isn't enough yet.
  mode = sm.tick(baseInput({gnssIntegrity: "NORMAL", confidenceBand: "HIGH"}));
  assert.equal(mode, "RECOVERING");
  mode = sm.tick(baseInput({gnssIntegrity: "NORMAL", confidenceBand: "HIGH"}));
  assert.equal(mode, "ACTIVE");
});

test("state machine: a relapse during RECOVERING drops back to a degraded state, not straight to ACTIVE", () => {
  const sm = new NavigationStateMachine({lostConfirmSamples: 1, recovery: {confirmSamples: 3}});
  sm.tick(baseInput({routeRequested: true}));
  sm.tick(baseInput({routeReady: true}));
  sm.tick(baseInput({gnssIntegrity: "LOST", confidenceBand: "LOW"}));
  sm.tick(baseInput({gnssIntegrity: "NORMAL", confidenceBand: "HIGH"})); // -> RECOVERING
  assert.equal(sm.getMode(), "RECOVERING");
  const mode = sm.tick(baseInput({gnssIntegrity: "LOST", confidenceBand: "LOW"}));
  assert.equal(mode, "GNSS_LOST");
});

test("state machine: ACTIVE -> OFF_ROUTE -> ROUTING -> ACTIVE on confirmed off-route + reroute", () => {
  const sm = new NavigationStateMachine();
  sm.tick(baseInput({routeRequested: true}));
  sm.tick(baseInput({routeReady: true}));
  assert.equal(sm.tick(baseInput({offRouteConfirmed: true})), "OFF_ROUTE");
  assert.equal(sm.tick(baseInput({offRouteConfirmed: false})), "ROUTING");
  assert.equal(sm.tick(baseInput({routeReady: true})), "ACTIVE");
});

test("state machine: ACTIVE -> ARRIVED on arrival, and a new request starts a fresh trip", () => {
  const sm = new NavigationStateMachine();
  sm.tick(baseInput({routeRequested: true}));
  sm.tick(baseInput({routeReady: true}));
  assert.equal(sm.tick(baseInput({hasArrived: true})), "ARRIVED");
  assert.equal(sm.tick(baseInput({routeRequested: true})), "ROUTING");
});
