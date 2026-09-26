# LiveAssist hub protocol (v1)

This is the contract between the WordPress plugin, the visitor widget, and the self-hosted chat hub. The hub must implement everything marked **Hub**.

## 1. Site credentials

The hub creates each site and issues two values:

| Value | Format | Used for |
|---|---|---|
| `site_id` | `[A-Za-z0-9_-]+` | Identifies the site in every request |
| `site_secret` | 32+ random bytes, base64url or hex | HMAC signing and JWT signing, both directions |

The plugin stores the secret encrypted (libsodium, key derived from WordPress salts).

## 2. Signed server-to-server requests

Used for WordPress → hub REST calls and hub → WordPress webhooks.

Headers:

```
X-LAIC-Site:      <site_id>
X-LAIC-Timestamp: <unix seconds>
X-LAIC-Signature: hex( HMAC-SHA256( site_secret, "<timestamp>.<raw body>" ) )
```

Reject if the site is unknown, the timestamp is more than 300 s away from server time, or the signature doesn't match (constant-time compare). For GET requests the body is the empty string.

## 3. WordPress → hub REST API

Base: `{hub_url}/api/v1/sites/{site_id}`. All bodies are JSON. Errors return `{ "error": "message" }` with a non-2xx status.

| Method & path | Body | Response | Purpose |
|---|---|---|---|
| `GET /ping` | – | `{ "ok": true, "site_name": "…" }` | Connection test |
| `PUT /config` | See 3.1 | `{ "ok": true }` | Assistant, routing and privacy settings |
| `POST /knowledge` | See 3.2 | `{ "ok": true }` | Upsert/delete knowledge documents |
| `POST /knowledge/commit` | `{ "sync_id": "uuid" }` | `{ "ok": true, "pruned": n }` | End of full sync: delete docs not seen in this `sync_id` |
| `POST /privacy/erase` | `{ "email": "…" }` | `{ "ok": true }` | Delete all conversations and leads for an email |

### 3.1 Config

```json
{
  "site": { "name": "…", "url": "https://…/", "timezone": "America/New_York", "language": "en-US",
            "webhook": "https://…/wp-json/laic/v1/webhook" },
  "assistant": { "name": "…", "avatar_url": "…", "greeting": "…", "business_intro": "…",
                 "tone": "friendly|professional|concise", "sales_prompt": "…", "tech_prompt": "…",
                 "blocked_topics": "one per line", "model_tier": "economy|balanced|best" },
  "routing": { "allow_human": 1, "handoff_timeout": 90, "notify_email": "…", "offline_notice": "…",
               "hours": { "mon": { "on": 1, "start": "09:00", "end": "17:00" }, "…": {} } },
  "privacy": { "retention_days": 365, "ai_disclosure": "…" },
  "faq": "Q: … A: …",
  "plugin": "0.1.0"
}
```

**Hub:** map `model_tier` to Claude models in hub config (not in the plugin), so models can change without a plugin release.

### 3.2 Knowledge

```json
{
  "upsert": [{
    "id": "wp-123", "type": "page", "track": "general|sales",
    "title": "…", "url": "…", "modified": "ISO-8601",
    "excerpt": "…", "content": "plain text, ≤30k chars",
    "meta": { "terms": ["…"], "product": { "sku": "…", "price": "…", "currency": "USD", "stock_status": "instock" } },
    "hash": "md5"
  }],
  "delete": ["wp-456"],
  "full": true,
  "sync_id": "uuid (full syncs only)"
}
```

Batches are up to 40 documents. Upserts must be idempotent by `id`.

## 4. Visitor tokens

The widget calls `POST /wp-json/laic/v1/session` on the WordPress site and receives:

```json
{ "token": "<JWT>", "ws_url": "wss://hub/ws", "expires_in": 7200 }
```

The token is HS256, signed with `site_secret`. Claims:

| Claim | Meaning |
|---|---|
| `iss` | `site_id` |
| `aud` | `laic-hub` |
| `sub` | `visitor:<uuid>` (stable per browser) |
| `iat`, `nbf`, `exp`, `jti` | Standard |
| `ctx` | `{ page_url, page_title, locale, ip_hash }` |
| `user` | Optional `{ id, name, email }` for logged-in WordPress users |

**Hub:** verify signature, `aud`, `exp`/`nbf`, and that `iss` is an active site. Visitors may only access conversations whose `sub` matches.

## 5. Visitor WebSocket (`{hub_url}/ws`)

JSON text frames. The first client frame must be `auth` within 10 s.

### Close codes

| Code | Meaning | Widget behavior |
|---|---|---|
| 4001 | Token missing, invalid or expired | Fetches a new token and reconnects |
| 4003 | Site disabled | Shows the offline form |
| 4029 | Rate limited | Reconnects with backoff |

### Client → hub

| Type | Fields | Notes |
|---|---|---|
| `auth` | `token`, `conversation_id?`, `after?` | Resume a conversation; `after` = last message id seen, replay newer ones |
| `start` | `topic` (`sales`, `technical`, `other`, `auto`), `name?`, `email?`, `consent?`, `page {url,title}`, `referrer?` | Creates a new conversation if none is open |
| `message` | `client_id`, `text` (≤4000 chars) | **Hub:** dedupe by `client_id`; the widget resends unacked messages after reconnecting |
| `typing` | `state` (bool) | Forward to agents only |
| `request_human` | – | Starts handoff |
| `rate` | `message_id`, `value` (`up`/`down`) | |
| `end` | – | Visitor closed the chat |
| `ping` | – | Heartbeat every 25 s; reply `pong` |

### Hub → client

| Type | Fields | Notes |
|---|---|---|
| `ready` | `conversation_id?`, `state?`, `agent?`, `history?` | After `auth`. `history` = array of `message` objects |
| `conversation` | `conversation_id`, `state` | Reply to `start` |
| `ack` | `client_id`, `id` | Visitor message stored |
| `message` | `id`, `role` (`ai`, `agent`, `system`, `visitor`), `text`, `author? {name, avatar}`, `ts` | Don't echo a visitor's message back to the socket that sent it |
| `stream_start` | `id`, `role` | Claude reply begins |
| `stream_delta` | `id`, `text` | Append |
| `stream_end` | `id`, `text?`, `message_id?` | Final text (replaces the accumulated text if present). `message_id` is the permanent id; the stream `id` is temporary |
| `typing` | `role`, `state` | |
| `state` | `state`, `agent? {name, avatar}` | See section 6 |
| `error` | `code`, `message`, `client_id?` | |
| `pong` | – | |

Messages are plain text with light Markdown (`**bold**`, `` `code` ``, `[text](https://…)`, `- lists`). The widget escapes all HTML.

## 6. Conversation states

```
ai_active ──request_human / AI escalates──▶ waiting_human ──agent accepts──▶ human_active
    ▲                                            │                              │
    └──────── timeout: AI collects details ──────┘◀─────── agent returns ───────┘
any state ──visitor ends / agent closes / idle 30 min──▶ closed
```

- `waiting_human`: notify online agents by push. If nobody accepts within `routing.handoff_timeout`, or it's outside `routing.hours`, return to `ai_active` and have Claude post `routing.offline_notice` and collect contact details (`capture_lead` tool).
- `human_active`: Claude stops replying to the visitor. It may draft suggested replies for the agent.

## 7. Claude tools (hub-side)

| Tool | Effect |
|---|---|
| `request_human` | Moves to `waiting_human` |
| `capture_lead` | `{ name?, email?, phone?, interest }` → saves lead, sends `lead.captured` webhook |
| `create_ticket` | `{ email, summary }` → sends `ticket.created` webhook |
| `search_knowledge` | Retrieves documents for the active track |

Claude never sees the site secret, tokens, or other visitors' data.

## 8. Hub → WordPress webhooks

`POST {site.webhook}` with signed headers (section 2). Body: `{ "event": "…", "data": { … } }`.

| Event | Data |
|---|---|
| `ping` | – |
| `lead.captured` | `conversation_id, name, email, phone, topic, interest, summary, page_url` |
| `ticket.created` | Same as `lead.captured` |
| `conversation.closed` | `conversation_id, messages: [{ role, name, text, ts }]` |

WordPress keys leads by `conversation_id`, so repeated `lead.captured` events update one lead. Transcripts attach only to conversations that produced a lead or ticket. Retry failed webhooks with backoff for up to 24 h.
