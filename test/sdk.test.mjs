import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { OpenSES, OpenSESError, verifyWebhook } from "../dist/index.js";

/** A stand-in API that records what it was asked and answers from a script. */
async function api(answer) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : undefined });
      const { status = 200, json } = answer(req) ?? {};
      res.writeHead(status, { "content-type": "application/json" });
      res.end(json === undefined ? "" : JSON.stringify(json));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { seen, baseUrl: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

test("send posts the email with the key and the idempotency key", async () => {
  const a = await api(() => ({ status: 201, json: { id: "em_1", status: "sent" } }));
  try {
    const openses = new OpenSES({ apiKey: "os_test_abc", baseUrl: a.baseUrl + "/" });
    const email = await openses.emails.send({ from: "Acme <hi@acme.com>", to: ["jane@example.com"], subject: "Hello", html: "<p>Hi</p>" }, { idempotencyKey: "order-42" });
    assert.equal(email.id, "em_1");
    const [req] = a.seen;
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/v1/emails");
    assert.equal(req.headers.authorization, "Bearer os_test_abc");
    assert.equal(req.headers["idempotency-key"], "order-42");
    assert.deepEqual(req.body, { from: "Acme <hi@acme.com>", to: ["jane@example.com"], subject: "Hello", html: "<p>Hi</p>" });
  } finally { a.close(); }
});

test("lists pass filters as a query and leave out what is unset", async () => {
  const a = await api(() => ({ json: { data: [], total: 0, page: 2, limit: 10 } }));
  try {
    const openses = new OpenSES({ apiKey: "k", baseUrl: a.baseUrl });
    await openses.emails.list({ status: "bounced", limit: 10, page: 2, tag: undefined });
    await openses.contacts.list({ subscribed: false, topic: "Product news" });
    assert.equal(a.seen[0].url, "/v1/emails?status=bounced&limit=10&page=2");
    assert.equal(a.seen[1].url, "/v1/contacts?subscribed=false&topic=Product+news");
  } finally { a.close(); }
});

test("ids and addresses in paths are escaped; 204 answers resolve to undefined", async () => {
  const a = await api(() => ({ status: 204 }));
  try {
    const openses = new OpenSES({ apiKey: "k", baseUrl: a.baseUrl });
    assert.equal(await openses.suppressions.remove("a+b@example.com"), undefined);
    await openses.contacts.delete("con/../x");
    assert.equal(a.seen[0].url, "/v1/suppressions/a%2Bb%40example.com");
    assert.equal(a.seen[1].url, "/v1/contacts/con%2F..%2Fx");
  } finally { a.close(); }
});

test("every resource reaches the route the API serves", async () => {
  const a = await api(() => ({ json: {} }));
  try {
    const o = new OpenSES({ apiKey: "k", baseUrl: a.baseUrl });
    await o.emails.get("em_1"); await o.emails.cancel("em_1");
    await o.contacts.upsert({ email: "a@example.com" }); await o.contacts.get("c1"); await o.contacts.unsubscribe("c1");
    await o.domains.list(); await o.topics.list({ domain: "acme.com" });
    await o.templates.list(); await o.templates.get("t1"); await o.templates.upsert({ name: "Welcome", subject: "Hi" });
    await o.sequences.list(); await o.sequences.upsert({ name: "Onboarding", senders: ["hi@acme.com"], steps: [{ delay: 0, delay_unit: "hours", template: "Welcome" }] });
    await o.sequences.enroll("s1", { email: "a@example.com" }); await o.sequences.stop("s1", { contact_id: "c1" });
    await o.suppressions.list({ reason: "bounce" }); await o.suppressions.add("a@example.com", "asked");
    await o.inboxes.list(); await o.threads.list({ unread: true }); await o.threads.get("th1");
    await o.threads.reply("th1", { text: "Thanks" }); await o.threads.update("th1", { archived: true });
    await o.webhooks.list(); await o.webhooks.create({ url: "https://example.com/hook", events: ["email.delivered"] }); await o.webhooks.delete("wh1");
    assert.deepEqual(a.seen.map((r) => `${r.method} ${r.url}`), [
      "GET /v1/emails/em_1", "POST /v1/emails/em_1/cancel",
      "POST /v1/contacts", "GET /v1/contacts/c1", "POST /v1/contacts/c1/unsubscribe",
      "GET /v1/domains", "GET /v1/topics?domain=acme.com",
      "GET /v1/templates", "GET /v1/templates/t1", "PUT /v1/templates",
      "GET /v1/sequences", "PUT /v1/sequences", "POST /v1/sequences/s1/enroll", "POST /v1/sequences/s1/stop",
      "GET /v1/suppressions?reason=bounce", "POST /v1/suppressions",
      "GET /v1/inboxes", "GET /v1/threads?unread=true", "GET /v1/threads/th1", "POST /v1/threads/th1/reply", "PATCH /v1/threads/th1",
      "GET /v1/webhooks", "POST /v1/webhooks", "DELETE /v1/webhooks/wh1",
    ]);
    assert.deepEqual(a.seen[15].body, { email: "a@example.com", note: "asked" });
  } finally { a.close(); }
});

test("an API error becomes an OpenSESError with its code and details", async () => {
  const a = await api(() => ({ status: 400, json: { error: { code: "suppressed", message: "jane@example.com is on the suppression list", details: { suppressed: ["jane@example.com"] } } } }));
  try {
    const openses = new OpenSES({ apiKey: "k", baseUrl: a.baseUrl });
    await assert.rejects(openses.emails.send({ from: "a@acme.com", to: "jane@example.com" }), (err) => {
      assert.ok(err instanceof OpenSESError);
      assert.equal(err.status, 400);
      assert.equal(err.code, "suppressed");
      assert.deepEqual(err.details, { suppressed: ["jane@example.com"] });
      return true;
    });
  } finally { a.close(); }
});

test("a host that cannot be reached is a network_error, a missing key is refused up front", async () => {
  const openses = new OpenSES({ apiKey: "k", baseUrl: "http://127.0.0.1:1" });
  await assert.rejects(openses.domains.list(), (err) => err instanceof OpenSESError && err.status === 0 && err.code === "network_error");
  const saved = process.env.OPENSES_API_KEY;
  delete process.env.OPENSES_API_KEY;
  try { assert.throws(() => new OpenSES(), (err) => err instanceof OpenSESError && err.code === "missing_api_key"); } finally { if (saved) process.env.OPENSES_API_KEY = saved; }
});

test("the key and the API address fall back to the environment", () => {
  const saved = { ...process.env };
  process.env.OPENSES_API_KEY = "os_test_env";
  process.env.OPENSES_API_URL = "https://api.example.com/";
  try { assert.equal(new OpenSES().baseUrl, "https://api.example.com"); } finally { process.env = saved; }
});

test("verifyWebhook accepts a good signature and refuses a wrong, stale or missing one", () => {
  const secret = "whsec_test";
  const payload = JSON.stringify({ id: "evt_1", type: "email.delivered", created_at: "2026-01-01T00:00:00Z", data: { email_id: "em_1" } });
  const sign = (t, body = payload, key = secret) => `t=${t},v1=${createHmac("sha256", key).update(`${t}.${body}`).digest("hex")}`;
  const now = Math.floor(Date.now() / 1000);
  assert.equal(verifyWebhook({ payload, signature: sign(now), secret }).data.email_id, "em_1");
  const refused = (signature, body = payload) => assert.throws(() => verifyWebhook({ payload: body, signature, secret }), (err) => err instanceof OpenSESError && err.code === "invalid_signature");
  refused(sign(now, payload, "other secret"));
  refused(sign(now), payload.replace("em_1", "em_2"));
  refused(sign(now - 3600));
  refused(undefined);
  refused("t=abc,v1=zz");
});
