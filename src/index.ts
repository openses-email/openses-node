import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * OpenSES SDK. One class, one method per API call, the API's own field names.
 *
 *   const openses = new OpenSES({ apiKey: "os_live_…" });
 *   await openses.emails.send({ from: "Acme <hi@acme.com>", to: "jane@example.com", subject: "Hello", html: "<p>Hi</p>" });
 *
 * `baseUrl` is your own API (https://api.example.com) when you self-host; it defaults to the
 * OPENSES_API_URL environment variable, then to OpenSES Cloud.
 */

export const DEFAULT_BASE_URL = "https://api.openses.email";

export interface OpenSESOptions {
  /** An API key from the dashboard (API & MCP). Defaults to the OPENSES_API_KEY environment variable. */
  apiKey?: string;
  /** Origin of the OpenSES API. Defaults to OPENSES_API_URL, then OpenSES Cloud. */
  baseUrl?: string;
  /** Milliseconds before a request is abandoned. Default 30,000. */
  timeout?: number;
  /** A fetch implementation, for runtimes without a global one or for tests. */
  fetch?: typeof fetch;
}

/** Any response the API answered with an error status, or a request that never got an answer. */
export class OpenSESError extends Error {
  constructor(
    /** HTTP status, or 0 when no response arrived (network error, timeout). */
    readonly status: number,
    /** The API's error code, e.g. `suppressed`, `domain_not_verified`, `validation_error`. */
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "OpenSESError";
  }
}

type Query = Record<string, string | number | boolean | undefined>;
export interface Page<T> { data: T[]; total: number; page: number; limit: number }
export interface List<T> { data: T[] }

// ----- emails -----
export interface SendEmail {
  /** `"Acme <billing@acme.com>"` or a bare address on a verified domain. */
  from: string;
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  reply_to?: string | string[];
  subject?: string;
  html?: string;
  text?: string;
  /** A template id or name, used instead of html and text. */
  template?: string;
  variables?: Record<string, string>;
  headers?: Record<string, string>;
  /** `content` is base64. Up to 20 files, 10 MB in total. */
  attachments?: { filename: string; content: string; content_type?: string }[];
  tags?: Record<string, string>;
  /** ISO 8601 time to send at; the email can be cancelled until then. */
  scheduled_at?: string;
}
export type EmailStatus = "scheduled" | "sent" | "delivered" | "opened" | "clicked" | "bounced" | "complained" | "rejected" | "delayed" | "failed" | "canceled";
export interface Email {
  id: string;
  status: EmailStatus;
  from: string;
  to: string[];
  subject: string;
  message_id: string | null;
  created_at: string;
  scheduled_at: string | null;
  tags: Record<string, string>;
  events: { type: string; at: string; detail: unknown }[];
}
export interface ListEmails { domain?: string; status?: EmailStatus; tag?: string; q?: string; days?: number; limit?: number; page?: number }

// ----- contacts -----
export interface UpsertContact { email: string; domain?: string; name?: string; company?: string; properties?: Record<string, string>; topics?: string[] }
export interface Contact {
  id: string; domain: string; email: string; name: string; company: string | null; properties: Record<string, string>; topics: string[];
  subscribed: boolean; unsubscribed_at: string | null; source: string; created_at: string; last_email_at: string | null; sequences: string[];
}
export interface ListContacts { domain?: string; q?: string; topic?: string; subscribed?: boolean; limit?: number; page?: number }

// ----- everything else -----
export interface Domain { id: string; name: string; status: string; region: string; alias_of: string | null; aliases: string[]; receiving: boolean; created_at: string }
export interface Topic { id: string; name: string; slug: string; description: string | null; default: boolean; subscribers: number; domain: string }
export interface Template { id: string; name: string; subject: string; variables: string[]; domain: string; updated_at: string }
export interface TemplateDetail extends Template { html: string; text: string }
export interface UpsertTemplate { name: string; subject: string; html?: string; text?: string; domain?: string }
export interface Sequence { id: string; domain: string; name: string; status: string; mode: string; trigger: string; steps: number; enrolled: number; active: number; completed: number; replied: number; created_at: string }
export interface UpsertSequence {
  name: string; senders: string[]; domain?: string; mode?: "sales" | "marketing"; status?: "draft" | "active" | "paused";
  stop_on_reply?: boolean; stop_on_unsubscribe?: boolean; skip_weekends?: boolean;
  /** Each step names its template by id or name. */
  steps: { delay: number; delay_unit: "minutes" | "hours" | "days"; template: string }[];
}
/** Who to enroll or stop: an existing contact by id, or an address (created on enroll if new). */
export type ContactRef = { contact_id: string; email?: never } | { email: string; contact_id?: never };
export interface Suppression { id: string; email: string; reason: "bounce" | "complaint" | "manual"; region: string | null; detail: string | null; email_id: string | null; created_at: string }
export interface ListSuppressions { q?: string; reason?: "bounce" | "complaint" | "manual"; limit?: number; page?: number }
export interface Inbox { id: string; address: string; name: string; domain: string; unread: number }
export interface Thread { id: string; subject: string; with: string; with_name: string | null; inbox_id: string; inbox: string | null; snippet: string; unread: boolean; archived: boolean; label: string | null; updated_at: string }
export interface ThreadMessage {
  id: string; direction: "in" | "out"; from: string; from_name: string | null; to: string; cc: string | null; at: string; text: string; html: string | null;
  attachments: { index: number; filename: string; size: number; content_type: string; url: string | null }[];
  email_id: string | null; delivery: { status: string; detail: unknown } | null;
}
export interface ThreadDetail extends Thread { messages: ThreadMessage[] }
export interface ListThreads { domain?: string; inbox?: string; q?: string; unread?: boolean; archived?: boolean; limit?: number; offset?: number }
export type WebhookEvent =
  | "email.sent" | "email.delivered" | "email.bounced" | "email.complained" | "email.rejected" | "email.delayed" | "email.failed"
  | "email.opened" | "email.clicked" | "email.subscription" | "email.received";
export interface Webhook { id: string; url: string; description: string | null; events: WebhookEvent[]; active: boolean; created_at: string }
/** What an endpoint receives. `data` depends on `type`. */
export interface WebhookPayload<T = Record<string, unknown>> { id: string; type: WebhookEvent; created_at: string; data: T }

export class OpenSES {
  readonly baseUrl: string;
  readonly #apiKey: string;
  readonly #timeout: number;
  readonly #fetch: typeof fetch;

  constructor(options: OpenSESOptions | string = {}) {
    const o = typeof options === "string" ? { apiKey: options } : options;
    const env = typeof process !== "undefined" ? process.env : {};
    const apiKey = o.apiKey ?? env.OPENSES_API_KEY;
    if (!apiKey) throw new OpenSESError(0, "missing_api_key", "Pass an apiKey, or set OPENSES_API_KEY.");
    this.#apiKey = apiKey;
    this.baseUrl = (o.baseUrl ?? env.OPENSES_API_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.#timeout = o.timeout ?? 30_000;
    const f = o.fetch ?? globalThis.fetch;
    if (!f) throw new OpenSESError(0, "no_fetch", "This runtime has no fetch; pass one in the options.");
    this.#fetch = f.bind(globalThis);
  }

  /** Any API call: `openses.request("GET", "/emails", { query: { limit: 5 } })`. Paths are relative to `/v1`. */
  async request<T>(method: string, path: string, init: { query?: Query; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}/v1${path}`);
    for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    let res: Response;
    try {
      res = await this.#fetch(url, {
        method,
        headers: { authorization: `Bearer ${this.#apiKey}`, accept: "application/json", ...(init.body !== undefined ? { "content-type": "application/json" } : {}), ...init.headers },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(this.#timeout),
      });
    } catch (err) {
      const timedOut = err instanceof Error && err.name === "TimeoutError";
      throw new OpenSESError(0, timedOut ? "timeout" : "network_error", timedOut ? `No answer from ${url.host} within ${this.#timeout} ms.` : `Could not reach ${url.host}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let data: unknown;
    try { data = text ? JSON.parse(text) : undefined; } catch { data = undefined; }
    if (!res.ok) {
      const e = (data as { error?: { code?: string; message?: string; details?: unknown } } | undefined)?.error;
      throw new OpenSESError(res.status, e?.code ?? "http_error", e?.message ?? (text.slice(0, 200) || res.statusText), e?.details);
    }
    return data as T;
  }

  readonly emails = {
    /** Sends now, or at `scheduled_at`. The same `idempotencyKey` never sends twice. */
    send: (email: SendEmail, options: { idempotencyKey?: string } = {}) =>
      this.request<Email>("POST", "/emails", { body: email, headers: options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : undefined }),
    list: (filter: ListEmails = {}) => this.request<Page<Email>>("GET", "/emails", { query: { ...filter } }),
    get: (id: string) => this.request<Email>("GET", `/emails/${encodeURIComponent(id)}`),
    /** Cancels an email that is still scheduled. */
    cancel: (id: string) => this.request<Email>("POST", `/emails/${encodeURIComponent(id)}/cancel`),
  };

  readonly contacts = {
    /** Creates the contact, or updates the one with that address on the domain. */
    upsert: (contact: UpsertContact) => this.request<{ contact: Contact; created: boolean }>("POST", "/contacts", { body: contact }),
    list: (filter: ListContacts = {}) => this.request<Page<Contact>>("GET", "/contacts", { query: { ...filter } }),
    get: (id: string) => this.request<Contact>("GET", `/contacts/${encodeURIComponent(id)}`),
    /** Unsubscribes the contact from every topic. */
    unsubscribe: (id: string) => this.request<Contact>("POST", `/contacts/${encodeURIComponent(id)}/unsubscribe`),
    delete: (id: string) => this.request<void>("DELETE", `/contacts/${encodeURIComponent(id)}`),
  };

  readonly domains = {
    list: () => this.request<List<Domain>>("GET", "/domains"),
  };

  readonly topics = {
    list: (filter: { domain?: string } = {}) => this.request<List<Topic>>("GET", "/topics", { query: filter }),
  };

  readonly templates = {
    list: (filter: { domain?: string } = {}) => this.request<List<Template>>("GET", "/templates", { query: filter }),
    get: (id: string) => this.request<TemplateDetail>("GET", `/templates/${encodeURIComponent(id)}`),
    /** Creates the template, or updates the one with that name on the domain. */
    upsert: (template: UpsertTemplate) => this.request<{ created: boolean; template: Template }>("PUT", "/templates", { body: template }),
  };

  readonly sequences = {
    list: (filter: { domain?: string } = {}) => this.request<List<Sequence>>("GET", "/sequences", { query: filter }),
    /** Creates the sequence with its steps, or updates the one with that name on the domain. */
    upsert: (sequence: UpsertSequence) => this.request<{ created: boolean; sequence: Pick<Sequence, "id" | "domain" | "name" | "status" | "mode" | "steps"> }>("PUT", "/sequences", { body: sequence }),
    /** `restart: true` starts a contact who is or was in the sequence again from the first step. */
    enroll: (id: string, who: ContactRef & { name?: string; properties?: Record<string, string>; restart?: boolean }) =>
      this.request<{ enrolled: boolean; contact_id: string; sequence_id: string }>("POST", `/sequences/${encodeURIComponent(id)}/enroll`, { body: who }),
    stop: (id: string, who: ContactRef) => this.request<{ stopped: boolean; contact_id: string | null; sequence_id: string }>("POST", `/sequences/${encodeURIComponent(id)}/stop`, { body: who }),
  };

  readonly suppressions = {
    list: (filter: ListSuppressions = {}) => this.request<Page<Suppression> & { counts: Record<string, number> }>("GET", "/suppressions", { query: { ...filter } }),
    add: (email: string, note?: string) => this.request<Suppression>("POST", "/suppressions", { body: { email, note } }),
    remove: (email: string) => this.request<void>("DELETE", `/suppressions/${encodeURIComponent(email)}`),
  };

  readonly inboxes = {
    list: (filter: { domain?: string } = {}) => this.request<List<Inbox>>("GET", "/inboxes", { query: filter }),
  };

  readonly threads = {
    list: (filter: ListThreads = {}) => this.request<{ data: Thread[]; next_offset: number | null }>("GET", "/threads", { query: { ...filter } }),
    /** The conversation with its messages, oldest first. Reading it here does not mark it read. */
    get: (id: string) => this.request<ThreadDetail>("GET", `/threads/${encodeURIComponent(id)}`),
    /** Sends a real email to the other party, from the inbox's address. */
    reply: (id: string, message: { text: string; html?: string }) => this.request<ThreadDetail>("POST", `/threads/${encodeURIComponent(id)}/reply`, { body: message }),
    update: (id: string, patch: { unread?: boolean; archived?: boolean; label?: string | null }) => this.request<Thread>("PATCH", `/threads/${encodeURIComponent(id)}`, { body: patch }),
  };

  readonly webhooks = {
    list: () => this.request<List<Webhook>>("GET", "/webhooks"),
    /** The `secret` in the answer signs every delivery and is shown only here. */
    create: (webhook: { url: string; events: WebhookEvent[]; description?: string }) => this.request<Webhook & { secret: string }>("POST", "/webhooks", { body: webhook }),
    delete: (id: string) => this.request<void>("DELETE", `/webhooks/${encodeURIComponent(id)}`),
  };
}

/**
 * Checks a webhook delivery and returns its payload. Pass the raw request body (not the parsed
 * JSON) and the `X-OpenSES-Signature` header. Throws `OpenSESError` when the signature is wrong
 * or older than `toleranceSeconds` (default five minutes).
 */
export function verifyWebhook<T = Record<string, unknown>>(input: { payload: string; signature: string | null | undefined; secret: string; toleranceSeconds?: number }): WebhookPayload<T> {
  const bad = (message: string) => new OpenSESError(400, "invalid_signature", message);
  const parts = new Map((input.signature ?? "").split(",").map((p) => { const i = p.indexOf("="); return [p.slice(0, i).trim(), p.slice(i + 1).trim()] as const; }));
  const t = parts.get("t");
  const v1 = parts.get("v1");
  if (!t || !/^\d+$/.test(t) || !v1 || !/^[a-f0-9]{64}$/.test(v1)) throw bad("The signature header is missing or malformed.");
  const expected = createHmac("sha256", input.secret).update(`${t}.${input.payload}`).digest();
  if (!timingSafeEqual(expected, Buffer.from(v1, "hex"))) throw bad("The signature does not match this payload and secret.");
  if (Math.abs(Date.now() / 1000 - Number(t)) > (input.toleranceSeconds ?? 300)) throw bad("The signature is too old.");
  return JSON.parse(input.payload) as WebhookPayload<T>;
}

export default OpenSES;
