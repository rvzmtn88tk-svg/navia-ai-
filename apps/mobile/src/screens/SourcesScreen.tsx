// One place for data attribution and disclaimers, instead of small print on
// every screen.
import React from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { useT, type StringKey } from "../i18n";
import { Card, Text, useColors } from "../components/ui";
import { Icon, type IconName } from "../components/Icon";
import { iconSize, space } from "../theme/tokens";

const ITEMS: { icon: IconName; key: StringKey }[] = [
  { icon: "layers", key: "sources.map" },
  { icon: "shelter", key: "sources.places" },
  { icon: "alert", key: "sources.alerts" },
  { icon: "route", key: "sources.routing" },
];

export function SourcesScreen(): JSX.Element {
  const c = useColors();
  const { t } = useT();
  return (
    <ScrollView style={{ backgroundColor: c.background }} contentContainerStyle={styles.content}>
      <Card style={styles.card}>
        {ITEMS.map((item) => (
          <View key={item.key} style={styles.row}>
            <Icon name={item.icon} size={iconSize.md} color={c.accent} />
            <Text variant="callout" color="secondary" style={styles.text}>{t(item.key)}</Text>
          </View>
        ))}
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.md },
  card: { gap: space.md },
  row: { flexDirection: "row", gap: space.sm, alignItems: "flex-start" },
  text: { flex: 1 },
});
