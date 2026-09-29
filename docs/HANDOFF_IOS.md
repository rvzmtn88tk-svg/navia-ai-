# Handoff: bring the AI co-pilot into your local NAVIA and onto the iPhone

Branch: `navia-ai-upgrade` (PR into `main`, not merged). Based on `main` at
`5c2254a`; `main` had not moved when this branch was created.

## What the iOS app is in this repo

`apps/mobile` is an **Expo (SDK 52) / React Native** app. The Xcode project is
*generated* from `apps/mobile/app.json` by `npx expo prebuild` into
`apps/mobile/ios/` (not committed). All new AI code is TypeScript
(`packages/core/src/copilot/…`, `apps/mobile/src/…`) and is compiled into the
app's JS bundle by Metro — there are **no new Swift/ObjC files to add to an
Xcode target**. The only native change is one new Expo module,
`expo-speech-recognition` (already in `apps/mobile/package.json`), linked
automatically by `pod install` through `use_expo_modules!`, plus its
Info.plist permission strings (via the config plugin in `app.json`).

Verified in the cloud sandbox (no Mac available there):
- `npx expo export --platform ios` → Hermes bytecode bundle, 920 modules, the
  co-pilot code and UI strings are inside; no API keys inside.
- `npx expo prebuild --platform ios` (with temporary placeholder icons) →
  Info.plist contains `NSSpeechRecognitionUsageDescription`,
  `NSMicrophoneUsageDescription`, location strings; autolinking for iOS
  resolves `expo-speech-recognition`, `expo-speech`, `expo-location`, …
- NOT verified: `pod install`, Xcode compile, running on an iPhone.

If your iPhone build comes from a different (native Swift) project that is
not in this repository, none of this code will be in it: the co-pilot lives
in the Expo app. Port it by building `apps/mobile`, or tell the local
session which project you install from.

## 1. Get the branch and merge it with your local work

```bash
cd ~/path/to/navia-ai-            # your local clone
git status                        # commit or stash local (design/UX) work first:
git switch -c local-design-work   #   e.g. put it on its own branch
git add -A && git commit -m "WIP: local design/UX changes"

git fetch origin
git switch main && git pull --ff-only origin main
git switch -c integrate-ai origin/navia-ai-upgrade      # the AI branch
git merge local-design-work                              # bring your design work in (merge, no rebase)
```

Files most likely to conflict with design/UX work, and how to resolve:

| File | AI branch changed | Resolve by |
|---|---|---|
| `apps/mobile/src/components/VoicePanel.tsx` | co-pilot calls, Yes/No card, mic/STT, text field | keep the AI branch's logic (`activeCopilot()`, `confirm()`, `onMicPress`, pending card) and take your styles/layout |
| `apps/mobile/src/screens/HomeScreen.tsx` | "Додому" button, AI consent switch | keep both: your layout + the consent `Switch` and home button |
| `apps/mobile/src/screens/NavigationScreen.tsx` | routing through `tripPlanner`, `markStopsVisited`, `<VoicePanel … onRouteChanged>` | keep the AI branch's effect logic; take your visual changes |
| `apps/mobile/src/providers/MapLibreRouteView.tsx` | `styleURL`→`mapStyle`, child in `PointAnnotation` (MapLibre 10.4 types) | keep these two fixes |
| `apps/mobile/app.json` | `expo-speech-recognition` plugin, `NSSpeechRecognitionUsageDescription` | keep both entries plus your changes |
| `package-lock.json` | new `apps/ai-backend` workspace, `@anthropic-ai/sdk` | take either side, then run `npm install` to regenerate |

Then verify:

```bash
npm install                  # repo root (workspaces)
npm run typecheck            # must be 0 errors
npm test                     # 165 tests
(cd apps/mobile && npx tsc --noEmit)
npm run eval:replay          # 26/26 recorded scenarios
```

## 2. Backend (holds the Anthropic key — never in the app or Git)

```bash
export ANTHROPIC_API_KEY='sk-ant-…'       # the key only, not a whole curl command
npm run ai:backend                        # :8787 ; check: curl localhost:8787/healthz
ANTHROPIC_API_KEY=… npm run eval:ai       # live eval on the real models (costs a few cents)
```

The app talks to `POST {backend}/v1/copilot/complete` (protocol
`2026-09-29.1`). If you already run a different server, either deploy
`apps/ai-backend` or make yours implement this contract (see
`apps/ai-backend/src/handler.ts`).

iOS App Transport Security blocks plain `http://` to non-local hosts: give the
phone an **https** URL — deploy the backend, or for testing tunnel it
(`cloudflared tunnel --url http://localhost:8787` or `ngrok http 8787`).

## 3. App configuration (`apps/mobile/.env`, not committed)

```
EXPO_PUBLIC_NAVIA_AI_BACKEND_URL=https://<your backend or tunnel>
EXPO_PUBLIC_NAVIA_AI_CLIENT_TOKEN=            # optional; must equal NAVIA_BACKEND_CLIENT_TOKEN on the backend
EXPO_PUBLIC_NAVIA_OVERPASS_URL=https://overpass-api.de/api/interpreter   # live OSM place search
EXPO_PUBLIC_NAVIA_VALHALLA_URL=https://<valhalla>                        # real routing
EXPO_PUBLIC_NAVIA_MAP_STYLE_URL=https://<maplibre style.json>
EXPO_PUBLIC_NAVIA_GEOCODER_URL=https://nominatim.openstreetmap.org
```

`EXPO_PUBLIC_*` values are compiled into the JS bundle at build time — rebuild
after changing them, and never put secrets there.

## 4. Build and install on the connected iPhone

`app.json` references `./assets/icon.png`, `./assets/splash.png`,
`./assets/adaptive-icon.png`, which are **not in the repository** — prebuild
fails without them. Use your own (design) assets at those paths.

```bash
cd apps/mobile
npx expo prebuild --platform ios          # regenerates ios/ with the new plugin + Info.plist keys
#   (if you keep a hand-edited ios/ folder instead: add NSSpeechRecognitionUsageDescription
#    to Info.plist and run `cd ios && pod install`)
open ios/NAVIA.xcworkspace                # Signing & Capabilities → select your Team once
npx expo run:ios --device --configuration Release   # pick the connected iPhone; JS bundle embedded
#   Debug alternative: npx expo run:ios --device  (phone and Mac on the same Wi-Fi, Metro running)
```

On the phone: allow Location, then on the Home screen switch on
**«Надсилати контекст поїздки ШІ»** (off by default). Tap 🎤 in navigation
and allow Microphone + Speech Recognition. Quick test without driving:
**Demo Mode** → the purple question buttons (fuel ≤5 min, coffee,
McDonald's ≤10 min + add stop, parking at destination, why this route,
traffic).

## 5. Ready-to-paste prompt for the local Claude Code session

> Integrate branch `navia-ai-upgrade` from GitHub (rvzmtn88tk-svg/navia-ai-)
> into my local NAVIA without losing my local design/UX changes. Read
> `docs/HANDOFF_IOS.md`, `docs/AI_COPILOT.md` and `CLAUDE.md` first. Commit
> my current local work to its own branch, create `integrate-ai` from
> `origin/navia-ai-upgrade`, merge my branch into it (merge, no rebase, no
> force-push), and resolve conflicts per the table in HANDOFF_IOS.md: keep
> the AI logic, keep my visual design. Run `npm install`, `npm run
> typecheck`, `npm test`, `(cd apps/mobile && npx tsc --noEmit)` and fix
> anything red. Make sure `apps/mobile/assets/{icon,splash,adaptive-icon}.png`
> exist. Create `apps/mobile/.env` from `.env.example` (ask me for the
> backend URL; never write the Anthropic key into the repo). Run `npx expo
> prebuild --platform ios`, check Info.plist has
> NSSpeechRecognitionUsageDescription and NSMicrophoneUsageDescription, then
> `npx expo run:ios --device --configuration Release` for my connected
> iPhone. Report exactly what built, what was installed, and anything that
> failed.
