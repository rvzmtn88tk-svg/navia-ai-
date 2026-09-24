// Extends app.json with options that depend on the build environment.
// - Sign in with Apple entitlement only for a paid Apple Developer team
//   (EXPO_PUBLIC_NAVIA_APPLE_SIGNIN=1); a free team cannot sign it.
// - Google sign-in redirect scheme (reversed iOS client ID) when configured.
module.exports = ({ config }) => {
  const appleSignIn = process.env.EXPO_PUBLIC_NAVIA_APPLE_SIGNIN === "1";
  const googleClientId = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID;
  const schemes = [config.scheme];
  if (googleClientId) schemes.push(googleClientId.split(".").reverse().join("."));
  return {
    ...config,
    scheme: schemes.length > 1 ? schemes : config.scheme,
    ios: { ...config.ios, usesAppleSignIn: appleSignIn },
  };
};
