# openses

TypeScript SDK for [OpenSES](https://openses.email), the open-source email platform on your own Amazon SES. Send email, manage contacts and sequences, answer the inbox and verify webhooks.

No dependencies. Works on Node 18 and later, and on any runtime with `fetch`.

## Install

```bash
npm install openses
```

## Send an email

```ts
import { OpenSES } from "openses";

const openses = new OpenSES({ apiKey: process.env.OPENSES_API_KEY });

const email = await openses.emails.send({
  from: "Acme <billing@acme.com>",
  to: "jane@example.com",
  subject: "Your invoice #1042",
  html: "<p>Thanks for your order.</p>",
});

console.log(email.id, email.status);
```

Create the key in the dashboard under **API & MCP**. A `send` key can send; `read` and `full` keys can do more.

### Self-hosted

Point the SDK at your own API:

```ts
const openses = new OpenSES({ apiKey: "os_live_…", baseUrl: "https://api.example.com" });
```

Without `baseUrl` the SDK uses the `OPENSES_API_URL` environment variable, then OpenSES Cloud. Without `apiKey` it uses `OPENSES_API_KEY`.

## What you can call

| Area | Methods |
|---|---|
| `emails` | `send`, `list`, `get`, `cancel` |
| `contacts` | `upsert`, `list`, `get`, `unsubscribe`, `delete` |
| `templates` | `list`, `get`, `upsert` |
| `sequences` | `list`, `upsert`, `enroll`, `stop` |
| `suppressions` | `list`, `add`, `remove` |
| `threads` (inbox) | `list`, `get`, `reply`, `update` |
| `webhooks` | `list`, `create`, `delete` |
| `domains`, `topics`, `inboxes` | `list` |

Field names are the API's own (`reply_to`, `scheduled_at`), so the [API reference](https://openses.email/docs) applies as written. For a call the SDK has no method for yet: `openses.request("GET", "/emails", { query: { limit: 5 } })`.

```ts
// A template, variables and a time to send at
await openses.emails.send(
  { from: "hi@acme.com", to: "jane@example.com", template: "welcome", variables: { first_name: "Jane" }, scheduled_at: "2027-01-05T09:00:00Z" },
  { idempotencyKey: "welcome-jane" }, // the same key never sends twice
);

// Add someone to a topic, then start a sequence for them
await openses.contacts.upsert({ email: "jane@example.com", name: "Jane", topics: ["Product news"] });
await openses.sequences.enroll("seq_…", { email: "jane@example.com" });

// Answer the newest unread conversation
const { data } = await openses.threads.list({ unread: true, limit: 1 });
if (data[0]) await openses.threads.reply(data[0].id, { text: "Thanks, we are on it." });
```

## Errors

Every failed call throws an `OpenSESError` with the HTTP `status`, the API's `code` and a readable `message`.

```ts
import { OpenSESError } from "openses";

try {
  await openses.emails.send({ from: "hi@acme.com", to: "jane@example.com", subject: "Hi", text: "Hello" });
} catch (err) {
  if (err instanceof OpenSESError && err.code === "suppressed") {
    // the address bounced or complained before; do not retry
  } else throw err;
}
```

`status` is `0` when no answer arrived (`network_error`, `timeout`).

## Webhooks

`verifyWebhook` checks the signature and returns the payload. Give it the raw request body, not parsed JSON.

```ts
import { verifyWebhook } from "openses";

export async function POST(request: Request) {
  const event = verifyWebhook({
    payload: await request.text(),
    signature: request.headers.get("x-openses-signature"),
    secret: process.env.OPENSES_WEBHOOK_SECRET!,
  });
  if (event.type === "email.bounced") { /* … */ }
  return new Response(null, { status: 204 });
}
```

It throws when the signature does not match or is older than five minutes. `verifyWebhook` uses `node:crypto`, so it needs Node or a runtime that provides it.

## License

MIT
