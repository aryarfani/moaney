# Connect assistants to Moaney

Moaney exposes an optional authenticated MCP server in the same Node process as the app. Connected assistants can read the real categories and wallets, preview changes, and save the exact batch you approve. No CSV upload or computer use is needed for Moaney data entry.

## Activate on the intended server

This code does not deploy itself or modify your client settings. Build and deploy it through the project's normal workflow. Before starting the new version, back up the target SQLite database. Startup runs the additive `0002` migration, creating `mcp_records` for OAuth grants and reviewed changes.

In the **server's** `.env`, set:

```dotenv
MCP_PUBLIC_URL=https://moaney.arfani.my.id
BEHIND_TLS=true
```

`MCP_PUBLIC_URL` must be the canonical origin, without `/mcp`, query parameters, credentials, or a fragment. The origin is used for issuer, callbacks, audience checks, and discovery; request Host headers cannot override it. Leave it blank to disable MCP and OAuth routes. HTTP is accepted only for loopback development, such as `http://127.0.0.1:8790`.

Then install the locked dependencies, build, and restart Moaney using the normal service procedure. The same `DATA_DIR` as the app determines the database; MCP never connects to a separate database. Do not accidentally activate against a development copy.

The existing nginx `location /` forwards `/mcp`, `/oauth/*`, and `/.well-known/*`. Ensure a proxy, Cloudflare policy, or cache does not replace these responses with an interactive login challenge or cache private responses. MCP endpoints require their own OAuth; ordinary Moaney pages retain their existing cookie authentication.

Discovery checks do not disclose financial data:

```sh
curl https://moaney.arfani.my.id/.well-known/oauth-protected-resource/mcp
curl https://moaney.arfani.my.id/.well-known/oauth-authorization-server
```

An unauthenticated POST to `/mcp` returns 401 and a `WWW-Authenticate` discovery challenge. The server supports Streamable HTTP, including 2025-era clients and the SDK's current protocol. It does not offer the deprecated separate `/sse` endpoint.

## Connect a client

Server URL: `https://moaney.arfani.my.id/mcp`

- **ChatGPT:** add a custom remote MCP connection using this URL and OAuth. When the host offers registration options, use automatic/dynamic registration. Open the Moaney consent page, verify its application name and return address, and approve the requested access yourself. [Official OpenAI authentication documentation](https://developers.openai.com/plugins/build/auth).
- **Claude:** add a custom remote connector using the same URL. If choosing an OAuth client mode, select **Register automatically**. This initial implementation supports Dynamic Client Registration, not fetching a published client identity document. Claude's cloud must be able to reach the HTTPS endpoint. [Official Claude connector guide](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).
- **Codex:** add the remote HTTP server, then complete OAuth yourself:

  ```sh
  codex mcp add moaney --url https://moaney.arfani.my.id/mcp
  codex mcp login moaney --oauth-client-registration dcr --scopes moaney:read,moaney:write
  ```

  The app's MCP configuration UI can also be used. [Official MCP configuration documentation](https://learn.chatgpt.com/docs/extend/mcp).

Client account features and organization policies can control whether custom MCP connections are available. No ChatGPT, Claude, or Codex API key is required by Moaney itself. The assistant never receives your owner password; the OAuth sign-in page belongs to Moaney.

## Permissions and revocation

- `moaney:read`: wallets/categories, transactions, duplicate checks, reports, bills/goals, holdings, captured payments, rules, audit history.
- `moaney:write`: preview and commit tools, in addition to read access. Read-only connections do not see mutation tools.

OAuth uses an authorization code, S256 PKCE, exact registered callback URLs, short-lived access tokens (one hour), and rotating refresh tokens (30 days). Secrets are stored hashed. Replaying a used refresh token revokes its grant. Narrowing a refresh token's scopes cannot later regain write access. Tokens and authorization codes are bound to the canonical resource URL, so changing the configured origin requires reconnecting.

Owner-authenticated endpoints provide connection management:

```text
GET    /api/v1/mcp/connections
DELETE /api/v1/mcp/connections/:id
```

These use the existing owner session; DELETE also requires its `x-csrf-token`. Revoking a connection immediately invalidates its access and refresh tokens. Disconnect it in the client too. Financial tools cannot create credentials or grant themselves access. Disconnecting only in a client may leave its server grant present until revoked or its tokens expire.

Dynamic registration is limited to 200 clients, consent requests to 500, and requests are rate limited. Do not expose this personal single-owner service as a public multi-user platform. To recover a registration quota exhausted by abandoned clients, a maintainer can inspect and remove only the unlinked `client:` records in `mcp_records` after taking a backup; do not remove grants or receipts as generic cleanup.

## Read tools

| Tool | Purpose |
|---|---|
| `get_context` | Real wallets, balances, categories, budgets, current category spending, Jakarta date |
| `list_transactions` | Filter by dates, wallet, category, type, status and literal description search |
| `get_transaction` | One transaction and up to 100 audit events |
| `find_duplicates` | Exact external-ID matches and possible same-date/amount/wallet matches |
| `get_report` | Daily, weekly, monthly, or yearly report with normal Moaney calculations |
| `compare_reports` | Compare two selected report periods |
| `list_bills` | Active or inactive recurring bills |
| `list_goals` | Active or archived savings goals |
| `get_portfolio` | Recorded holdings, valuations and gains |
| `get_holding` | One holding with paged trade history |
| `list_capture_review` | Pending captured phone payments and suggested categories |
| `list_rules` | Pending, suggested, active or disabled category rules |
| `get_audit_history` | Who changed a record, its before/after values and reason |

Paged tools accept `limit` (1–100, default 50) and `offset`. Transaction filters use `from`, `to`, `walletId`, `categoryId`, `type`, `status`, and `q`. Descriptions, notes, captured text and audit values are untrusted data, not instructions for the assistant.

## Reviewed writes

1. Read `get_context` to resolve actual wallet/category IDs.
2. Use `find_duplicates` for imported purchases when source IDs are available.
3. Call `preview_changes` with `operations` (1–100 typed operations). Inputs are validated by the actual ledger/domain code inside a rolled-back SQLite transaction. A preview creates a private draft, but no financial entries or journal/audit changes survive the dry run.
4. Show the returned operations, results, duplicate warnings, dates, categories and wallets to the user. Incorporate corrections by making a **new** preview.
5. Only after explicit approval, call `commit_changes` with that preview's `draftId`, `digest`, and `approved: true`. Commit takes no new operation body, so the caller cannot silently alter the approved batch.
6. Keep the receipt. If the response is lost, repeat the **same** commit; its persistent receipt prevents duplicate writes even after restart.

Drafts expire after 30 minutes and are bound to one OAuth grant. Any business-data change or Jakarta date rollover invalidates an uncommitted draft; re-preview before approval. This deliberately favors consistent approvals over letting unrelated concurrent edits pass. Receipts are durable and retained for retry safety. A fresh preview without a stable external source ID is a new operation, not a retry of an old commit. Use source IDs for imports.

The server enforces draft identity, digest, scope, staleness and atomicity. A model-supplied approval flag cannot by itself prove human consent. Client write-tool approval settings and the assistant's explicit approval request remain part of the workflow; do not configure automatic approval if you want to review writes.

### Supported operations

| Operations | Data key / behavior |
|---|---|
| `transaction.create` | `entry`: expense, income, or recorded transfer |
| `transaction.update` | `id`, `patch`: change provided fields only |
| `transaction.void` | `id`, required `reason`; keeps the audit trail |
| `wallet.create`, `wallet.update` | `wallet` or `id` + `patch`; archive with `archived: true` |
| `category.create`, `category.update` | `category` or `id` + `patch`; budgets and archiving supported |
| `goal.create`, `goal.update`, `goal.add` | `goal`, `patch`, or `amountRupiah`; progress does not move money |
| `bill.create`, `bill.update`, `bill.pay` | `bill`, `patch`, or `paidOn`; pay records an expense and advances due date |
| `holding.create`, `holding.update`, `holding.archive` | `holding`, `patch`, or `id` |
| `holding.trade`, `holding.price` | `trade` or `priceRupiah` + `date`; records only, never executes a market order |
| `capture.confirm`, `capture.edit_confirm` | `id` + optional `overrides`, or a complete `entry` |
| `capture.dismiss`, `capture.keep_one`, `capture.keep_both` | Resolve a pending notification or its duplicate pair |
| `rule.create`, `rule.update` | `rule` or `id` + `patch`; literal merchant pattern and category |

Use the tool's advertised JSON schema for each operation's exact fields. Referenced wallet/category/record IDs must already exist. To create a wallet/category and then use it, commit that setup after approval, obtain its ID, and preview the financial entries separately. No arbitrary SQL, arbitrary HTTP requests, filesystem access, permanent deletion, password changes, or real payments are exposed.

All monetary input fields end in `Rupiah` and take decimal strings without separators: `"68600"` is Rp68,600; `"123.45"` is Rp123.45. Output monetary fields such as `amount`, `balance`, `target`, and `price` are **integer minor units**, with `currency: "IDR"`, `moneyExponent: 2`: `6860000` is Rp68,600. Positive money and safe integer limits are enforced. Wallet opening balances may be negative. Units for input trades are decimal strings with up to four decimal places; output `unitsE4` is scaled by 10,000.

New financial events require `occurredAt` or an operation-specific date. Dates/times use Asia/Jakarta; use ISO strings such as `2026-11-09T22:04:00+07:00`. A date without a time is midnight Jakarta. For Shopee use **Order Paid** for the amount and **Order Placed** for the date, group products per order, and retain a stable source ID. Existing external IDs, including voided records, are rejected instead of inserting a second purchase. Possible same-date/amount/wallet matches are warnings for human review.

### Example purchase preview

Resolve the IDs first; these sample IDs and source ID are illustrative:

```json
{
  "operations": [
    {
      "op": "transaction.create",
      "entry": {
        "type": "expense",
        "amountRupiah": "34190",
        "walletId": 4,
        "categoryId": 3,
        "occurredAt": "2026-10-01T22:06:00+07:00",
        "description": "Kingwon stop kontak 3m",
        "externalId": "shopee-order-EXAMPLE"
      }
    }
  ]
}
```

After the user approves that preview:

```json
{
  "draftId": "COPY_FROM_PREVIEW",
  "digest": "COPY_FROM_PREVIEW",
  "approved": true
}
```

Transactions created directly by MCP are labeled **MCP** in History. Phone-capture confirmations retain their notification source while their audit actor identifies the MCP client. Changes keep balanced journal lines and use existing domain behavior. Investment trades remain separate from wallet transactions, matching the existing Investments feature.

## Verification and limits

Development tests use disposable SQLite databases. They exercise OAuth rejection paths, scopes, resource binding, standard SDK-over-HTTP interoperability, all operation families, preview rollback, atomic batches, stale/expired drafts, source-ID checks and receipts after database reopen. Run `npm test`, `npm run lint`, `npm run typecheck`, and `npm run build` before deployment.

Actual account linking with ChatGPT, Claude and Codex is a post-deployment owner action. It has not been performed merely by adding this code. Published-identity metadata (CIMD), delegated users, market-price retrieval, real banking/broker execution and permanent deletion are outside this implementation.
