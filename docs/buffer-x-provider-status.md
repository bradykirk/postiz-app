# Buffer-relayed X provider — status and handover

**Last updated:** 2026-07-28
**Status:** Deployed to production. Four end-to-end checks still unverified.
**Branch:** merged to `self-hosted` as `63703a9b`; feature branch `feat/buffer-x-provider` retained.
**ghcr build:** [run 30362859910](https://github.com/bradykirk/postiz-app/actions/runs/30362859910) — success.

Design: [`docs/superpowers/specs/2026-07-27-buffer-x-provider-design.md`](superpowers/specs/2026-07-27-buffer-x-provider-design.md)
Plan: [`docs/superpowers/plans/2026-07-27-buffer-x-provider.md`](superpowers/plans/2026-07-27-buffer-x-provider.md)

---

## Why this exists

X moved to pay-per-use pricing on 2026-02-06 and added a URL surcharge in April 2026:

| Operation | Price |
| --- | --- |
| Create post | $0.015 |
| **Create post containing a URL** | **$0.200** |
| Reads | $0.001–$0.010 per resource returned |

At this instance's volume — 300–500 posts/month, ~80% carrying links — that is **$65–82/month**.
The surcharge attaches to any post X parses a URL from; it cannot be dodged by moving the link
to a reply, using a shortener, or attaching a card.

Buffer holds its own X access. Its GraphQL API is open on all plans including Free, with a
15,000 request/30-day quota against roughly 1,000 needed. **Cost: ~$0/month.**

## What shipped

| File | Role |
| --- | --- |
| `libraries/nestjs-libraries/src/integrations/social/buffer.client.ts` | Dependency-free Buffer GraphQL client. No Postiz imports, so `scripts/buffer-probe.mjs` can exercise the same calls. |
| `libraries/nestjs-libraries/src/integrations/social/buffer.provider.ts` | `SocialProvider` implementation. API-key connect flow, identity guard, post flow. |
| `libraries/nestjs-libraries/src/dtos/posts/providers-settings/buffer.dto.ts` | Per-post settings (`made_with_ai`). |
| `apps/frontend/src/components/new-launch/providers/buffer/buffer.provider.tsx` | Settings UI. |
| `scripts/buffer-probe.mjs` | **The verification mechanism.** This repo has no test framework. |
| `posts.service.ts:829` | Only shared-code change: `['x','buffer'].includes(...)` for weighted length. |

`x.provider.ts` is **byte-for-byte untouched** and remains available as a fallback.

## Verified vs unverified

| Check | Status |
| --- | --- |
| Native tweet URL returned synchronously by `createPost` | ✅ live API |
| `Channel.serviceId` == native X user id | ✅ live API |
| Image ingestion by URL (4 host types, incl. redirect) | ✅ live API |
| 50 posts/day channel cap, 15,000 req/30d quota | ✅ live API |
| `channel()`, `dailyPostingLimits()`, `altText` asset round-trip | ✅ live API (`preflight`) |
| Connect flow + handle disambiguation | ✅ local run |
| `internalId` namespaced as `buffer:<serviceId>` | ✅ confirmed in DB |
| **Link post publishes with real tweet URL** | ❌ **not verified** |
| **Image appears in the published tweet** | ❌ **not verified** |
| **Thread rejected, nothing published** | ❌ **not verified** |
| **Video rejected** | ❌ **not verified** |

The last four must be run on production. Two of them (image, thread) fail *silently* — the
others fail loudly and would be obvious.

## Known limitations — all deliberate

**Threads do not work and are rejected at compose time.**
`post.workflow.v1.0.5.ts:152-158` truncates a multi-part post to `[postsListBefore[0]]` unless
the provider implements `comment()` (`isCommentable` = `!!getIntegration.comment`,
`post.activity.ts:155-161`). Implementing `comment()` does not help: Buffer's `CreatePostInput`
has no reply-to-tweet field. This is an architectural mismatch between Buffer's one-shot thread
API and Postiz's incremental comment model. `checkValidity` returns an error string so the
failure is visible rather than publishing only tweet 1. **Use the native X channel for threads.**

**Video is rejected.** Buffer ingests images by URL only. Note `posts.service.ts:370` hardcodes
`type: 'image'` on every media item, so the provider's `type === 'image'` filter is a no-op —
rejection is by file extension in `checkValidity`.

**Analytics not implemented.** `Post.metrics` exists and may support it later.

**Multi-tenant is out of scope.** Buffer's personal API key licenses "internal use" only.

**Composer gap (parked, pre-existing).** `comments: false` only takes effect once the user opens
the channel's own tab; in the default global composer the "Add post" button still appears, so a
user can compose a second part and be rejected on save. Seven shipped providers (youtube, tiktok,
pinterest, mewe, kick, twitch, instagram) share this gap — fixing it means editing
`high.order.provider.tsx`, used by every provider. The backend guard catches it and fails
visibly with no data loss.

## Open actions

- [ ] **Run the four unverified checks on production.**
- [ ] **Read Buffer's ToS.** The only thing that could invalidate this after the fact. The API
      license is "a limited… **revocable** license to **internally use** the API". In 2019 Buffer
      revoked API access for tools replicating its core scheduling functionality — Postiz is that
      category. Emailing support@buffer.com describing the self-hosted personal use case, and
      keeping the reply, converts an unknown into a written yes or an early no.
- [ ] **Rotate the Buffer API key.** The one used during development was pasted into a chat
      transcript and local dev logs.
- [ ] **Set `DISABLE_X_ANALYTICS=true`** in Coolify (backend + orchestrator). Independent of
      Buffer and saves money regardless — it also disables the auto-repost/auto-plug Plugs, which
      each fire `tweetLikedBy` 3× per published post at T+6h/12h/18h.
- [ ] Replace the placeholder channel icon. `apps/frontend/public/icons/platforms/buffer.png` is
      currently a byte-identical copy of `bluesky.png`.

## How to resume

**Verify the API contract without publishing:**

```bash
export BUFFER_API_KEY=...
node scripts/buffer-probe.mjs channels              # read-only
node scripts/buffer-probe.mjs preflight <channelId> # exactly what post() calls; creates+deletes a draft
node scripts/buffer-probe.mjs draft   <channelId>   # publishes nothing
node scripts/buffer-probe.mjs thread  <channelId>   # publishes nothing
node scripts/buffer-probe.mjs publish <channelId> --i-mean-it   # REAL TWEET
```

**Typechecking gotcha.** `pnpm run build:backend` only typechecks provider files once something
imports them. Before registration in `integration.manager.ts`, use:

```bash
cd libraries/nestjs-libraries && npx tsc -p tsconfig.lib.json --noEmit
```

That reports ~6–9 pre-existing baseline errors in unrelated files (agent.graph.*,
mastodon.custom.provider, track.service, media.repository, empty providers, short-linking).
Zero should mention any buffer file.

**Running locally on this machine.** A native Postgres binds `127.0.0.1:5432` while Docker binds
`*:5432`; the specific binding wins, so `localhost:5432` reaches the native Postgres and Prisma
fails with `P1010`. Change `docker-compose.dev.yaml` to `5433:5432` and set `DATABASE_URL` to
port 5433. Also note the compose file's credentials (`postiz-local` / `postiz-local-pwd`) differ
from `.env.example` (`postiz-user` / `postiz-password`). `apps/extension` fails on port 8081 —
run backend/frontend/orchestrator only. Image upload needs
`NEXT_PUBLIC_UPLOAD_STATIC_DIRECTORY` set (baked in at frontend build time).

## Traps worth not re-introducing

These were each found by review, not by testing, and several would have shipped silently.

**`ImageMetadataInput.altText` is a required `String!`.** Omit the `metadata` object and Buffer
**silently discards the image** — the post succeeds with `assets: []` and no error. `buildAssets`
always sends `m.alt?.trim() || 'Image'`.

**Media must use `m.url`, not `m.path`.** On local-storage installs `posts.service.ts:371` sets
`path` to a filesystem path while the fetchable HTTP URL lives on `url` (line 361). Buffer fetches
assets server-side, so `path` yields a text-only tweet with no error. `MediaContent` does not
declare `url`, hence the narrow cast.

**`FRONTEND_URL` must be publicly reachable** on local-storage installs, for the same reason.
Not applicable here — this instance uses R2.

**Failures must be `ApplicationFailure`, not plain `Error`.** `BufferApiError` extends `Error`,
which Temporal treats as retryable: `maximumAttempts: 3` × a 5-pass `iterate` loop = **up to 15
`createPost` calls**. A Buffer org with post approval enabled would queue 15 identical tweets.
Terminal failures now throw `BadBody`/`RefreshToken` from `social.abstract.ts` — note the
constructor is `(identifier, json, body, message = '')`, message **fourth**. Only `bad_body`
triggers the user-facing error notification.

**`internalId` must stay namespaced.** `integration.repository.ts:243-249` upserts on
`(organizationId, internalId)` **without** `providerIdentifier`. Storing the bare X user id would
convert the existing native X integration in place — flipping its provider and destroying its
OAuth token — and silently truncate any already-scheduled thread. The `buffer:` prefix is what
keeps both channels coexisting.

**Character limits are unchanged from native X.** `posts.service.ts:841` takes
`max(weighted, plain)`, so link-heavy posts still measure by plain length. Parity with `'x'`, but
the weighted-length change only benefits CJK/emoji content.
