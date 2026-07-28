# Buffer-relayed X provider

**Date:** 2026-07-27
**Status:** Design — approved for planning
**Problem owner:** self-hosted Postiz instance (`self-hosted` branch → ghcr → Coolify)

## Problem

X moved to pay-per-use pricing on 2026-02-06 and added a URL surcharge in April 2026:

| Operation | Price |
| --- | --- |
| Create post | $0.015 |
| **Create post containing a URL** | **$0.200** |
| Reads | $0.001–$0.010 per resource returned |

The free tier is closed to new signups and legacy Basic ($200/mo) subscribers are being
migrated to pay-per-use. At this instance's target volume — 300–500 posts/month with
~80% carrying links — direct X API usage costs **$65–82/month**, growing linearly.

The surcharge attaches to any post X parses a URL from. It cannot be avoided by moving the
link to a reply, using a shortener, or attaching a card. Since the posts exist to drive
click-through, stripping links (already supported via `STRIP_LINKS_FROM_X_POSTS`,
`x.provider.ts:38`) is not an acceptable trade.

## Approach

Route X posts through the **Buffer GraphQL API** instead of `api.x.com`. Buffer holds its own
X access; posting through it costs nothing beyond the Buffer plan.

Buffer's API is open on all plans (including Free), authenticated with a personal API key,
and explicitly supports X. Its stated purpose — "Access your own Buffer data to build personal
automations and integrations" — covers a self-hosted instance posting its owner's account.

**Cost: ~$0/month, replacing $65–82/month.**

## Verified findings

All of the following were confirmed against the live API on 2026-07-27, not taken from docs.
Probe script: `buffer-probe.mjs` (session scratchpad).

**Endpoint** `https://api.buffer.com`, `Authorization: Bearer <key>`.

**Native URL is returned synchronously.** `createPost` returns `Post.externalLink` in the
mutation response — no polling:

```
externalLink: "https://twitter.com/BradyKirkT/status/2081859638643790075"
status:       "sent"
```

This is byte-identical in format to what `x.provider.ts:576` constructs today, so the
existing `PostResponse` contract is satisfied exactly rather than degraded.

**Identity join is exact.** `Channel.serviceId` is the native X user ID — the same value
`x.provider.ts:348` stores from `client.v2.me()`.

| `AuthTokenDetails` | Buffer `Channel` | Observed |
| --- | --- | --- |
| `id` | `serviceId` | `325272494` |
| `username` | `name` | `BradyKirkT` |
| `name` | `displayName` | `BradyKirkT` |
| `picture` | `avatar` | `pbs.twimg.com/...` |

**Threads: Buffer supports them, but Postiz cannot reach them.** `metadata.twitter.thread`
accepts an ordered list and reads back as `threadCount: 2` with links intact — the Buffer
side works. It is unusable from Postiz. `post.workflow.v1.0.5.ts:152-158` truncates a
multi-part post to `[postsListBefore[0]]` unless the provider implements `comment()`
(`isCommentable` = `!!getIntegration.comment`, `post.activity.ts:155-161`), so `post()` is
never handed more than one `PostDetails`. Implementing `comment()` does not rescue it:
Buffer's `CreatePostInput` has no reply-to-tweet field, so the incremental comment model
cannot be satisfied either. This is an architectural mismatch between Buffer's one-shot
thread API and Postiz's incremental comment model.

**Consequence:** the provider rejects threads in `checkValidity` so the failure is visible
at compose time rather than silently publishing only the first tweet. Threads remain
available on the native X provider, which implements `comment()` (`x.provider.ts:582`).

**Media is URL-ingested server-side.** `AssetInput.image.url` — Buffer fetches the image
itself. Verified against 4 hosts including a 302 redirect. No binary upload, no chunked
flow, replacing the `uploadMedia` path and the `media_type` handling from `dc702ae4`.

> **`ImageMetadataInput.altText` is a required `String!`. Omitting the `metadata` object
> entirely causes the image to be silently discarded with no error** — the post succeeds
> with `assets: []`. This is the single most dangerous behaviour found and the provider
> must always send `altText`. An unfetchable URL *does* error properly
> (`"Image could not be read from its URL"`).

**Quotas and caps.**

| Limit | Value | Projected use at 500 posts/mo |
| --- | --- | --- |
| Requests / 15 min | 100 | burst-dependent |
| Requests / 24 h | 500 | ~35 |
| Requests / 30 d | 15,000 | ~1,000 |
| Posts / day / channel | 50 (`dailyPostingLimits`) | ~17 |

~2 requests per post (create + identity assert). 15x headroom on the monthly quota,
3x on the daily posting cap.

**Enums.** `ShareMode: addToQueue | customScheduled | shareNext | shareNow`.
`SchedulingType: automatic | notification`.
`PostStatus: draft | error | needs_approval | scheduled | sending | sent`.

**Mutation surface** is only `createPost`, `deletePost`, `editPost`, `movePostInQueue`,
post templates, `createIdea`. There is no upload mutation and no channel-connect mutation.

## Design

### Provider registration

New `libraries/nestjs-libraries/src/integrations/social/buffer.provider.ts`, registered
alongside the existing providers. It is a **separate provider**, not a transport toggle
inside `x.provider.ts` — the X provider's native features (`community_id`, `reply_settings`,
`made_with_ai`, `paid_partnership`) have no Buffer equivalent, and branching one provider
across two transports would make both harder to reason about.

### Connect flow

Follows the existing API-key pattern (`listmonk.provider.ts:29-110`): `customFields()`
declares inputs, `generateAuthUrl()` returns a synthetic state, and `authenticate()`
receives the values base64-JSON-encoded in `params.code`.

Fields: **Buffer API key** (password), **X handle** (text, optional).

`authenticate()` then:

1. `account { organizations { id } }` → organization ID.
2. `channels(input: { organizationId })` filtered to `service === 'twitter'`.
3. Resolve to one channel — single match wins; multiple matches disambiguate on `name`
   against the supplied handle; still ambiguous returns an error string (the interface
   allows `authenticate` to return `string` for user-facing failures).
4. Return `AuthTokenDetails` with `id: channel.serviceId`,
   `accessToken: "<apiKey>:<channelId>"` (composite, mirroring how the X provider already
   packs `accessToken + ':' + accessSecret` at `x.provider.ts:349`),
   `username: channel.name`, `picture: channel.avatar`, `expiresIn` far-future
   (Buffer keys do not expire; `refreshToken()` is a no-op as it is for X).

Channels cannot be connected via API, so the UI must tell the user to link X inside Buffer first.

### Post flow

`post()` splits the composite token, then for each post:

1. **Identity assert** — read the channel and require `serviceId === integration.internalId`.
   On mismatch, refuse and mark the integration rather than post to the wrong account.
   Also surfaces `isDisconnected` / `isLocked`, which map onto Postiz's existing
   `refreshNeeded` / `disabled` flags.
2. `createPost` with `mode: 'shareNow'`, `schedulingType: 'automatic'`. Postiz's Temporal
   workflow remains the scheduler; Buffer is a stateless relay and never holds a queue.
3. Map the response to `PostResponse`:
   `postId` = tweet ID parsed from `externalLink`, `releaseURL` = `externalLink`,
   `status: 'posted'`.

Threads are rejected, not translated — see the threads finding above. `checkValidity`
returns an error string when it receives more than one post, and the provider declares
no `comment()` method. The frontend additionally passes `comments: false`, though note
that flag only takes effect once the user opens the channel's own composer tab; the
`checkValidity` rejection is the guard that actually holds.

Media maps onto `assets[].image` with `url` (NOT `path` — on local-storage installs
`posts.service.ts:371` sets `path` to a filesystem path while the fetchable HTTP URL
lives on `url`, and Buffer fetches assets server-side), `thumbnailUrl`, and a **mandatory**
`metadata.altText`.

### Error handling

Three distinct failure surfaces, all mapped to Postiz errors rather than swallowed:

- GraphQL `errors[]` — malformed request; treat as a bug, log loudly.
- `MutationError.message` — rejected content (bad media URL, over limit); user-facing.
- `Post.error` / `status: 'error'` — post accepted then failed downstream.

Pre-flight `dailyPostingLimits` and fail fast with a clear message when `isAtLimit`.
Handle HTTP 429 with backoff against the 100-per-15-minute window.

### Analytics

`Post.metrics` and `metricsUpdatedAt` exist and may support `postAnalytics`. Out of scope
for the first cut — X analytics is being disabled anyway via `DISABLE_X_ANALYTICS`
(`x.provider.ts:776`), which also suppresses the plug-driven `tweetLikedBy` reads.

### Migration

Because `id` is the X user ID under both providers, an existing X integration can be
matched to its Buffer channel on that value and switched in place without a reconnect,
preserving post history and calendar links.

## Out of scope

- Multi-tenant use. Buffer's personal-API-key scope does not cover posting other users'
  accounts; this design is for the self-hosted single-owner instance only.
- Non-X networks through Buffer.
- Buffer-backed analytics.
- Removing or altering the existing `x.provider.ts`; it stays as a fallback.

## Risks

| Risk | Mitigation |
| --- | --- |
| **Buffer ToS position on driving the API from a self-hosted scheduler is unread** | **Unresolved. Read the ToS or email Buffer support before this ships.** The only remaining blocker |
| Silent image drop when `altText` omitted | `buildAssets` always sends `m.alt?.trim() \|\| 'Image'`, covering undefined/null/empty/whitespace |
| Threads silently publishing only tweet 1 | Rejected in `checkValidity`; see the threads finding |
| "Add post" still reachable in the default global composer | Parked. Pre-existing and systemic — 7 shipped providers (youtube, tiktok, pinterest, mewe, kick, twitch, instagram) share it. `checkValidity` catches it and fails visibly with no data loss. Fixing means editing `high.order.provider.tsx`, shared by every provider |
| Buffer becomes a single point of failure for X posting | Keep `x.provider.ts` intact as a fallback path |
| Buffer plan limits on channel count | Verify plan covers the required channels |
| 50 posts/day cap | 3x headroom at target volume; `dailyPostingLimits` pre-flight fails fast |

## Verification

This repo has no test framework — `pnpm test` runs nothing, because no Nx project defines a
jest config. Verification is therefore:

- Compile: `pnpm run build:backend` and `pnpm run build:frontend`. Note that the backend
  build only typechecks provider files once they are imported by `integration.manager.ts`;
  before that, use `cd libraries/nestjs-libraries && npx tsc -p tsconfig.lib.json --noEmit`
  (which reports pre-existing baseline errors in unrelated files).
- `scripts/buffer-probe.mjs` against the live API: `channels`, then `draft` and `thread`
  (neither publishes), then `publish` gated behind `--i-mean-it`.
- Manual end-to-end through the Postiz UI: connect, link post, image post, thread
  rejection, and an identity-mismatch refusal.

**Connecting now requires the X handle.** Two X channels are connected to this Buffer
account (`AdvisorTactical`, `BradyKirkT`), so `resolveChannel` takes its disambiguation
path and rejects a blank handle.
