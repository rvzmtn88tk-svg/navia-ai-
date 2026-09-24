# NAVIA iPhone build

The app currently running from Metro is a development build. It requires the
computer running `npm start`; it is not the version to keep on the phone.

## Install a version that runs without Metro

From the repository root, run:

```bash
cd apps/mobile
npx expo run:ios --device --configuration Release --no-bundler
```

Choose the iPhone in the device picker and let Xcode finish signing and
installing. The Release configuration embeds the JavaScript bundle in the
app, so the phone no longer needs Metro after installation. The iPhone must
be paired with this Mac, and Xcode must have access to the Apple development
team used to sign the app.

An EAS internal build can also be created with:

```bash
cd apps/mobile
eas build --platform ios --profile preview
```

The `preview` profile creates a standalone installable build. Internal iOS
distribution needs an Apple Developer team and a provisioning profile that
includes the iPhone. In this checkout, the EAS account is signed in but has
no Apple team/remote iOS credentials configured yet, so the cloud build stops
at signing setup. Configure the Apple team in EAS before using that route.

## Development build

```bash
cd apps/mobile
npm start
```

Use this only while developing with the phone connected to the same network
as Metro. The development build expects the server to be available.

## Current service setup

- Address search is online and limited to the Kyiv/Kyiv Oblast search area.
- Route calculations use the public FOSSGIS Valhalla demo service by default.
  It is suitable for individual testing under fair use, not for a public
  production launch. Configure `EXPO_PUBLIC_NAVIA_VALHALLA_URL` to use a
  dedicated instance.
- The map uses the public OpenFreeMap Liberty/Dark vector styles backed by
  OpenStreetMap unless a custom style URL is configured. Neither the map nor
  address search currently has offline data.
- Kyiv city alert status comes from the Kyiv Digital current-state endpoint.
  Other regions use NEPTUN's read-only regional alert data, with attribution.
  Both are informational feeds and can be delayed; keep official alerts on.
- Nearby infrastructure is requested from OpenStreetMap. Kyiv shelters and
  resilience points also use the municipal GIS endpoint when it responds.
  Coverage and access details are not guaranteed.
- See [LIMITATIONS.md](LIMITATIONS.md) for the current feature boundaries and
  the exact iPhone install command.
