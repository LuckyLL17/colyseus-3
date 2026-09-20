import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { LocalPresence } from "../src/presence/LocalPresence.ts";
import { setDevMode } from "../src/utils/DevMode.ts";

const DEVMODE_CACHE_PATH = path.resolve(".devmode.json");

/**
 * Regression: an old expiration timer must never delete a value newer than it.
 * Redis' TTL is a property of the key (not of a write), so any subsequent
 * mutation of that key invalidates a previously scheduled deletion.
 */
describe("LocalPresence: TTL / stale expiration timers", () => {
  let presence: LocalPresence;

  beforeEach(() => {
    vi.useFakeTimers();
    presence = new LocalPresence();
  });

  afterEach(() => {
    presence.shutdown();
    vi.useRealTimers();
  });

  it("plain set() overwriting a short setex() must survive the old TTL", async () => {
    presence.setex("key", "with-ttl", 1);

    // Redis: SET removes any existing TTL on the key
    presence.set("key", "no-ttl");

    vi.advanceTimersByTime(1100);
    expect(presence.get("key")).toBe("no-ttl");

    // and it stays there permanently, no deferred deletion
    vi.advanceTimersByTime(10_000);
    expect(presence.get("key")).toBe("no-ttl");
    expect(await presence.exists("key")).toBe(true);
  });

  it("setex() overwriting a short TTL with a plain set(), then re-expiring, keeps the latest TTL only", () => {
    presence.setex("key", "one-second", 1);
    presence.set("key", "no-ttl");
    presence.expire("key", 10);

    vi.advanceTimersByTime(1100);
    expect(presence.get("key")).toBe("no-ttl");

    vi.advanceTimersByTime(9000);
    expect(presence.get("key")).toBeUndefined();
  });

  it("del() followed by recreate must not be deleted by the old timer (string)", () => {
    presence.setex("key", "old", 1);
    presence.del("key");
    presence.set("key", "recreated");

    vi.advanceTimersByTime(1100);
    expect(presence.get("key")).toBe("recreated");
  });

  it("del() followed by recreate via sadd() must not be deleted by the old timer", async () => {
    presence.setex("key", "old", 1);
    presence.del("key");
    presence.sadd("key", "recreated-member");

    vi.advanceTimersByTime(1100);
    expect(await presence.smembers("key")).toEqual(["recreated-member"]);
  });

  it("del() followed by recreate via hset() must not be deleted by the old timer", async () => {
    presence.setex("key", "old", 1);
    presence.del("key");
    await presence.hset("key", "field", "recreated");

    vi.advanceTimersByTime(1100);
    expect(await presence.hget("key", "field")).toBe("recreated");
  });

  it("setex() then a longer setex(): the short TTL must not fire; only the longer one deletes", () => {
    presence.setex("key", "short", 1);
    presence.setex("key", "long", 10);

    vi.advanceTimersByTime(1100);
    expect(presence.get("key")).toBe("long");

    // repeated renewal: extending again pushes deletion further away
    presence.expire("key", 10);
    vi.advanceTimersByTime(9000);
    expect(presence.get("key")).toBe("long");

    vi.advanceTimersByTime(1100);
    expect(presence.get("key")).toBeUndefined();
  });

  it("expire() on a missing key is a no-op and does not delete a value created afterwards", () => {
    presence.expire("key", 1);
    presence.set("key", "created-after-expire");

    vi.advanceTimersByTime(1100);
    expect(presence.get("key")).toBe("created-after-expire");
  });

  it("expire() on a missing key does not delete a set created afterwards", async () => {
    presence.expire("key", 1);
    presence.sadd("key", "member");

    vi.advanceTimersByTime(1100);
    expect(await presence.smembers("key")).toEqual(["member"]);
  });

  it("expire() on a missing key does not delete a hash created afterwards", async () => {
    presence.expire("key", 1);
    await presence.hset("key", "field", "value");

    vi.advanceTimersByTime(1100);
    expect(await presence.hget("key", "field")).toBe("value");
  });

  it("setex() still expires when left alone", () => {
    presence.setex("key", "value", 1);
    vi.advanceTimersByTime(1100);
    expect(presence.get("key")).toBeUndefined();
  });

  it("hash values survive an unrelated string key expiration", async () => {
    presence.setex("str", "value", 1);
    await presence.hset("h", "field", "value");
    presence.sadd("s", "member");

    vi.advanceTimersByTime(1100);

    expect(presence.get("str")).toBeUndefined();
    expect(await presence.hget("h", "field")).toBe("value");
    expect(await presence.smembers("s")).toEqual(["member"]);
  });

  it("hincrbyex() renewing a hash TTL keeps only the latest expiration", async () => {
    // mirrors how concurrentJoinOrCreateRoomLock() uses hincrbyex twice
    await presence.hincrbyex("h", "field", 1, 1);
    await presence.hincrbyex("h", "field", -1, 10);

    vi.advanceTimersByTime(1100);
    expect(await presence.hget("h", "field")).toBe("0");

    vi.advanceTimersByTime(9000);
    expect(await presence.hget("h", "field")).toBeNull();
  });
});

describe("LocalPresence: devMode cache restore keeps TTL fixes intact", () => {
  let presence: LocalPresence;

  beforeEach(() => {
    setDevMode(true);
    fs.rmSync(DEVMODE_CACHE_PATH, { force: true });
    vi.useFakeTimers();
  });

  afterEach(() => {
    presence?.shutdown();
    setDevMode(false);
    vi.useRealTimers();
    fs.rmSync(DEVMODE_CACHE_PATH, { force: true });
  });

  it("reloaded strings/sets/hashes survive and expire correctly after restore", async () => {
    presence = new LocalPresence();
    presence.set("plain", "kept");
    presence.sadd("set", "member");
    await presence.hset("hash", "field", "value");

    // a key that expires during the "shutdown" is simply absent after restore,
    // but a TTL armed after restore must not leak onto restored siblings
    presence.setex("with-ttl", "expires", 1);

    presence.shutdown(); // writes .devmode.json

    vi.advanceTimersByTime(1100);

    const restored = new LocalPresence();

    // cache restore keeps every data type
    expect(restored.get("plain")).toBe("kept");
    expect(await restored.smembers("set")).toEqual(["member"]);
    expect(await restored.hget("hash", "field")).toBe("value");

    // restored plain keys have no TTL — re-arming an unrelated key must not
    // delete them when it fires
    restored.setex("with-ttl", "new", 1);
    vi.advanceTimersByTime(1100);
    expect(restored.get("with-ttl")).toBeUndefined();
    expect(restored.get("plain")).toBe("kept");
    expect(await restored.hget("hash", "field")).toBe("value");
    expect(await restored.smembers("set")).toEqual(["member"]);

    // overwrite + recreate guarantees hold after restore as well
    restored.setex("with-ttl", "new", 1);
    restored.set("with-ttl", "persistent");
    vi.advanceTimersByTime(1100);
    expect(restored.get("with-ttl")).toBe("persistent");

    restored.shutdown();
  });
});

