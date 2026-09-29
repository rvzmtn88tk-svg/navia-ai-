// @navia/core's KeyValueStore on the device: SQLite-backed key-value storage
// from expo-sqlite (already a dependency). Holds the active-trip cache and
// the driver's long-term preferences. Nothing secret goes here.
import { SQLiteStorage } from "expo-sqlite/kv-store";
import type { KeyValueStore } from "@navia/core";

export class DeviceKeyValueStore implements KeyValueStore {
  private storage = new SQLiteStorage("navia-kv");
  getItem(key: string): Promise<string | null> { return this.storage.getItemAsync(key); }
  setItem(key: string, value: string): Promise<void> { return this.storage.setItemAsync(key, value); }
  async removeItem(key: string): Promise<void> { await this.storage.removeItemAsync(key); }
}
