# Moaney MCP

The owner asked to implement every discussed finance capability and proceed. This document records implementation choices rather than another approval gate.

## Intent
ChatGPT, Claude, and Codex should read and maintain the same Moaney ledger without computer use or CSV uploads. Reproduce the Shopee workflow: read real wallets/categories, preview a batch, accept corrections, save once, retain provenance.

## Scope
Read/search transactions, duplicates and audit history; wallet/category balances and budgets; reports; bills/goals; investment holdings/trades/prices; captured-payment review and categorization rules. Support creating/updating/archiving the corresponding records, recording transfers, voiding transactions and confirming/dismissing captured payments. Investment operations record trades only, never execute orders or move money.

## Approach
Options considered: a local stdio process (does not directly serve cloud clients); a separate proxy service (extra deployment and credential boundary); an authenticated remote MCP endpoint inside Moaney (chosen by implementer to reuse the existing database and domain functions). Use the official TypeScript SDK v2 and stateless Streamable HTTP. Existing REST and browser authentication remain intact.

## Authentication
Opt-in `MCP_PUBLIC_URL` is the canonical origin. HTTPS required except loopback development. OAuth authorization code with S256 PKCE, dynamic registration, exact registered redirect URI matching, resource-bound opaque access tokens, rotating refresh tokens and revocation. The owner links a client through a password-and-consent page; no credentials in tools. Store only hashes of token/code secrets. Separate read/write scopes; no tools for creating credentials or changing authentication. Owner-authenticated REST endpoints list and revoke connections.

## Changes
Every mutation is a typed operation inside `preview_changes`; `commit_changes` accepts only an immutable draft ID and its confirmation digest after explicit user approval. Preview executes the real domain operations inside a rolled-back transaction. Commit revalidates a business-data fingerprint, applies the whole batch atomically, and stores a durable receipt. Repeating the commit returns that receipt. Reject changed/expired drafts, cross-client access, duplicate external IDs and mismatched scope. Give near-duplicate matches for human review, never silently drop purchases.

Money inputs are decimal rupiah strings (no separators); convert to integer minor units exactly. Output declares IDR and exponent 2. All dates are Asia/Jakarta. Require dates on recorded financial events. Maximum 100 operations per batch. New transaction source is `mcp`; audit includes client identity. Reuse existing ledger, capture, reports and investment functions. No arbitrary SQL, URLs, filesystem operations or executable expressions exposed.

## Persistence and limits
One namespaced SQLite MCP-record table stores clients, consent requests, grants, hashed codes/tokens, drafts and receipts. Expiring records are pruned; registration and draft counts bounded. Durable receipts remain available for retry safety. No live database mutation during development or tests: use disposable databases.

## Validation and delivery
Test real HTTP protocol negotiation, OAuth abuse cases, revocation, read/write scopes, exact money conversion, preview rollback, atomic failures, duplicate/stale/expired/cross-client drafts and restart-safe idempotency. Exercise each operation family against real SQLite. Run complete test suite, lint, typecheck and production build. Review the complete patch. Provide setup, client connection and revocation instructions. No push, production deployment, or live client authorization in this task.

## Tradeoffs and remaining limits
The initial authorization server supports dynamic registration, not outbound fetching of client metadata documents. Clients must support DCR or a preregistered client. Any change to business data invalidates an uncommitted draft: conservative and potentially inconvenient, but prevents approving stale balances. Client approval is a host/user interaction; a model-supplied boolean alone cannot prove human consent, so tool descriptions and write annotations require the host approval flow too. Actual account-specific client linking is verified after deployment by the owner.
