import React from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { AppText as Text } from "./AppText";
import { useAppSettings } from "../settings/AppSettings";

type BoundaryState = { error: Error | null };

export class AppErrorBoundary extends React.Component<React.PropsWithChildren, BoundaryState> {
  override state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  override render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    return <ErrorFallback error={this.state.error} onRetry={() => this.setState({ error: null })} />;
  }
}

function ErrorFallback({ error, onRetry }: { error: Error; onRetry: () => void }): JSX.Element {
  const { palette: p, language } = useAppSettings();
  const en = language === "en";
  return (
    <View style={[styles.screen, { backgroundColor: p.background }]}>
      <Text style={[styles.brand, { color: p.accent }]}>NAVIA</Text>
      <Text style={[styles.title, { color: p.text }]}>{en ? "NAVIA could not open this screen" : "Не вдалося відкрити цей екран"}</Text>
      <Text style={[styles.body, { color: p.muted }]}>{en ? "The app is showing this error instead of a blank screen. Try opening the screen again or restart NAVIA." : "Замість порожнього екрана NAVIA показує помилку. Спробуйте ще раз або перезапустіть застосунок."}</Text>
      {__DEV__ && <Text selectable style={[styles.detail, { color: p.subtle }]}>{error.stack ?? error.message}</Text>}
      <Pressable onPress={onRetry} style={[styles.button, { backgroundColor: p.accent }]}><Text style={[styles.buttonText, { color: p.accentText }]}>{en ? "Try again" : "Спробувати ще раз"}</Text></Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 28, alignItems: "center", justifyContent: "center" },
  brand: { fontSize: 13, fontWeight: "900", letterSpacing: 5, marginBottom: 20 },
  title: { fontSize: 23, lineHeight: 29, fontWeight: "800", textAlign: "center" },
  body: { fontSize: 13, lineHeight: 20, textAlign: "center", marginTop: 10, maxWidth: 330 },
  detail: { fontSize: 9, lineHeight: 14, marginTop: 16, maxWidth: 340 },
  button: { minHeight: 50, minWidth: 190, borderRadius: 15, paddingHorizontal: 18, justifyContent: "center", alignItems: "center", marginTop: 24 },
  buttonText: { fontSize: 13, fontWeight: "800" },
});
