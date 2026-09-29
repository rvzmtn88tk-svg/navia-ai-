// Minimal key-value persistence the core needs (active-trip cache, driver
// preferences). The app provides a device-backed implementation
// (apps/mobile: expo-sqlite/kv-store); tests and Node use the in-memory one.

export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export class MemoryKeyValueStore implements KeyValueStore {
  private m = new Map<string, string>();
  async getItem(key: string): Promise<string | null> { return this.m.get(key) ?? null; }
  async setItem(key: string, value: string): Promise<void> { this.m.set(key, value); }
  async removeItem(key: string): Promise<void> { this.m.delete(key); }
}
