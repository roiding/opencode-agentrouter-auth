import assert from "node:assert/strict";
import test from "node:test";
import { accountCapabilities, assertSameUser, beijingDay, protocolBase, readAccount, saveAccount } from "../lib/accounts.mjs";

const account = (extra = {}) => ({
  schema: 2, provider: "agentrouter", mode: "password", site: "air",
  siteURL: "https://ps.air-outer.com", apiBase: "", key: "inference-secret",
  userId: "123", username: "alice", password: "one-time-password",
  session: "session=site-secret", accessToken: "", headers: "", checkinEnabled: false,
  ...extra
});

test("passwords are persisted only with explicit password-mode check-in consent", () => {
  for (const mode of ["password", "github", "linuxdo", "access-token"]) {
    const auth = saveAccount(account({ mode }));
    assert.doesNotMatch(JSON.stringify(auth), /one-time-password/);
    assert.equal(readAccount(auth).checkinEnabled, false);
    assert.equal(readAccount(auth).key, "inference-secret");
  }
  const auth = saveAccount(account({ checkinEnabled: true }));
  assert.equal(readAccount(auth).password, "one-time-password");
  assert.equal(accountCapabilities(readAccount(auth)).checkin, true);
  assert.equal(auth.uid, "agentrouter:123");
  assert.equal(auth.expires, 0);
});

test("API-key-only credentials cannot acquire account capabilities from stray fields", () => {
  const auth = saveAccount(account({ mode: "api-key", accessToken: "site-token", checkinEnabled: true }));
  assert.doesNotMatch(JSON.stringify(auth), /one-time-password|site-secret|site-token/);
  assert.deepEqual(accountCapabilities(readAccount(auth)), { inference: true, usage: false, checkin: false });
});

test("legacy API and mixed credentials migrate without opting into check-in", () => {
  const pure = readAccount({ type: "api", key: "key", metadata: { site: "air" } });
  assert.equal(pure.siteURL, "https://ps.air-outer.com");
  assert.equal(pure.apiBase, "");
  assert.deepEqual(accountCapabilities(pure), { inference: true, usage: false, checkin: false });
  const mixed = readAccount({ type: "api", key: "key", metadata: {
    username: "alice", password: "legacy-password", cookie: "session=legacy", userId: 123,
    endpoint: "https://legacy.example/v1", siteURL: "https://site.example", site: "air"
  } });
  assert.equal(mixed.apiBase, "https://legacy.example/v1");
  assert.equal(mixed.siteURL, "https://site.example");
  assert.equal(mixed.checkinEnabled, false);
  assert.equal(accountCapabilities(mixed).usage, true);
  assert.doesNotMatch(saveAccount(mixed).refresh, /legacy-password/);
});

test("corrupt versioned credentials and unsafe endpoint formats fail visibly", () => {
  assert.throws(() => readAccount({ type: "oauth", refresh: "broken", access: "key" }), /无法识别/);
  for (const url of ["sk-not-a-url", "file:///tmp/key", "https://user:secret@site.example", "https://site.example?key=secret"]) {
    assert.throws(() => readAccount({ type: "api", key: "key", metadata: { endpoint: url } }));
  }
  assert.throws(() => readAccount({ type: "api", key: "key", metadata: { site: "untrusted" } }), /只能选择/);
  assert.throws(() => saveAccount(account({ key: "" })), /推理 key/);
  assert.throws(() => saveAccount(account({ userId: "" })), /账号 ID/);
});

test("protocol base paths do not accumulate versions", () => {
  assert.equal(protocolBase("https://ps.air-outer.com/"), "https://ps.air-outer.com/v1");
  assert.equal(protocolBase("https://ps.air-outer.com/v1", "gemini"), "https://ps.air-outer.com/v1beta");
  assert.equal(protocolBase("https://ps.air-outer.com/v1beta", "anthropic"), "https://ps.air-outer.com/v1");
});

test("UID validation prevents cross-account session replacement", () => {
  assert.equal(assertSameUser(account(), { id: 123 }), "123");
  assert.throws(() => assertSameUser(account(), { id: 124 }), /不一致/);
  assert.throws(() => assertSameUser(account(), {}), /缺失/);
  assert.equal(saveAccount(account({ site: "org" })).uid, saveAccount(account({ site: "air" })).uid);
});

test("Beijing-day boundaries are independent of the runtime timezone", () => {
  assert.equal(beijingDay(Date.parse("2026-10-28T15:59:59Z")), "2026-10-28");
  assert.equal(beijingDay(Date.parse("2026-10-28T16:00:00Z")), "2026-10-29");
});
