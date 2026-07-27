# Buffer-relayed X Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Postiz social provider that publishes to X through the Buffer GraphQL API instead of `api.x.com`, eliminating X's $0.20-per-link-post charge.

**Architecture:** A thin, dependency-free GraphQL client wraps `https://api.buffer.com`. A new `BufferProvider` implements Postiz's `SocialProvider` interface on top of it, using the existing API-key connect pattern (`customFields()` + base64-JSON `authenticate()`) rather than OAuth. Postiz's Temporal workflow remains the scheduler — Buffer is called with `mode: 'shareNow'` at publish time and never holds a queue.

**Tech Stack:** TypeScript, NestJS, Nx monorepo, pnpm. No new dependencies — Node 24 built-in `fetch` only.

## Global Constraints

- **pnpm only.** Never npm or yarn.
- **No new npm dependencies.** Buffer is plain GraphQL over `fetch`.
- **Three-layer rule** (Controller → Service → Repository) does not apply here; providers live in `libraries/nestjs-libraries/src/integrations/social/` and are consumed by existing services.
- **Verification is the checked-in probe script against the live Buffer API.** The repo has zero test files and `getJestProjects()` resolves to zero projects, so `pnpm test` runs nothing. Do not add jest infrastructure.
- **`ImageMetadataInput.altText` is a required `String!`. Omitting the `metadata` object causes Buffer to silently discard the image** (post succeeds with `assets: []`). Every image asset must carry a non-empty `altText`.
- **This is a production instance.** `x.provider.ts` must remain untouched and functional as a fallback.
- **Scope: single-owner self-hosted only.** Buffer's personal API key covers "your own Buffer data"; it does not license multi-tenant use.
- Buffer endpoint: `https://api.buffer.com`, header `Authorization: Bearer <key>`.
- Verified enums — `ShareMode: addToQueue | customScheduled | shareNext | shareNow`; `SchedulingType: automatic | notification`; `PostStatus: draft | error | needs_approval | scheduled | sending | sent`.
- Verified quotas — 100 req/15min, 500 req/day, 15,000 req/30days, 50 posts/day/channel.

## Prerequisite

`node_modules` is absent. Typechecking requires `pnpm install` at the repo root once before starting. If that is not possible locally, every "verify it compiles" step must be done by pushing to CI instead.

## File Structure

| File | Responsibility |
| --- | --- |
| `libraries/nestjs-libraries/src/integrations/social/buffer.client.ts` | **Create.** Dependency-free Buffer GraphQL client. Knows nothing about Postiz. |
| `libraries/nestjs-libraries/src/integrations/social/buffer.provider.ts` | **Create.** `SocialProvider` implementation. Maps Postiz types ↔ Buffer types. |
| `libraries/nestjs-libraries/src/dtos/posts/providers-settings/buffer.dto.ts` | **Create.** Per-post settings DTO. |
| `libraries/nestjs-libraries/src/dtos/posts/providers-settings/all.providers.settings.ts` | **Modify.** Register the DTO. |
| `libraries/nestjs-libraries/src/integrations/integration.manager.ts` | **Modify.** Register the provider instance. |
| `apps/frontend/src/components/new-launch/providers/buffer/buffer.provider.tsx` | **Create.** Settings UI component. |
| `apps/frontend/src/components/new-launch/providers/show.all.providers.tsx` | **Modify.** Map identifier → component. |
| `apps/frontend/public/icons/platforms/buffer.png` | **Create.** Channel icon. |
| `scripts/buffer-probe.mjs` | **Create.** Checked-in verification script (from session scratchpad). |

Splitting client from provider matters: the client is the part that gets exercised directly by the probe script, and keeping it free of Postiz imports is what makes that possible.

---

### Task 1: Buffer GraphQL client

**Files:**
- Create: `libraries/nestjs-libraries/src/integrations/social/buffer.client.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `BufferClient` class with
  `constructor(apiKey: string)`,
  `getOrganizationId(): Promise<string>`,
  `listChannels(organizationId: string): Promise<BufferChannel[]>`,
  `getChannel(channelId: string): Promise<BufferChannel | null>`,
  `getDailyPostingLimit(channelId: string, date: string): Promise<BufferDailyLimit | null>`,
  `createPost(input: BufferCreatePostInput): Promise<BufferPost>`.
  Exported types `BufferChannel`, `BufferPost`, `BufferDailyLimit`, `BufferCreatePostInput`, and error class `BufferApiError`.

- [ ] **Step 1: Create the client**

```typescript
// libraries/nestjs-libraries/src/integrations/social/buffer.client.ts

export class BufferApiError extends Error {
  constructor(message: string, public readonly retryable = false) {
    super(message);
    this.name = 'BufferApiError';
  }
}

export type BufferChannel = {
  id: string;
  name: string;
  service: string;
  serviceId: string;
  displayName: string | null;
  avatar: string | null;
  externalLink: string | null;
  isDisconnected: boolean;
  isLocked: boolean;
};

export type BufferPost = {
  id: string;
  text: string;
  status: 'draft' | 'error' | 'needs_approval' | 'scheduled' | 'sending' | 'sent';
  externalLink: string | null;
  sentAt: string | null;
  error: { __typename: string } | null;
};

export type BufferDailyLimit = {
  channelId: string;
  isAtLimit: boolean;
  limit: number | null;
  scheduled: number;
  sent: number;
};

export type BufferImageAsset = {
  image: {
    url: string;
    thumbnailUrl?: string;
    // altText is REQUIRED by Buffer. Omitting `metadata` makes Buffer silently
    // drop the image and return a post with assets: [].
    metadata: { altText: string };
  };
};

export type BufferCreatePostInput = {
  text: string;
  channelId: string;
  schedulingType: 'automatic' | 'notification';
  mode: 'addToQueue' | 'customScheduled' | 'shareNext' | 'shareNow';
  saveToDraft?: boolean;
  dueAt?: string;
  source?: string;
  assets?: BufferImageAsset[];
  metadata?: {
    twitter?: {
      thread?: { text: string }[];
      isAiGenerated?: boolean;
    };
  };
};

const CHANNEL_FIELDS = `
  id name service serviceId displayName avatar externalLink isDisconnected isLocked
`;

const POST_FIELDS = `
  id text status externalLink sentAt error { __typename }
`;

export class BufferClient {
  private readonly endpoint = 'https://api.buffer.com';

  constructor(private readonly apiKey: string) {}

  private async gql<T>(query: string, variables: Record<string, any> = {}): Promise<T> {
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });

    if (res.status === 429) {
      throw new BufferApiError('Buffer rate limit exceeded', true);
    }

    const json = (await res.json().catch(() => null)) as any;
    if (!json) {
      throw new BufferApiError(`Buffer returned HTTP ${res.status} with an unreadable body`);
    }
    if (json.errors?.length) {
      throw new BufferApiError(json.errors.map((e: any) => e.message).join('; '));
    }
    return json.data as T;
  }

  async getOrganizationId(): Promise<string> {
    const data = await this.gql<{ account: { organizations: { id: string }[] } }>(
      `query { account { organizations { id name } } }`
    );
    const id = data?.account?.organizations?.[0]?.id;
    if (!id) {
      throw new BufferApiError('No Buffer organization found for this API key');
    }
    return id;
  }

  async listChannels(organizationId: string): Promise<BufferChannel[]> {
    const data = await this.gql<{ channels: BufferChannel[] }>(
      `query C($id: OrganizationId!) {
         channels(input: { organizationId: $id }) { ${CHANNEL_FIELDS} }
       }`,
      { id: organizationId }
    );
    return data?.channels ?? [];
  }

  async getChannel(channelId: string): Promise<BufferChannel | null> {
    const data = await this.gql<{ channel: BufferChannel | null }>(
      `query G($id: ChannelId!) { channel(input: { id: $id }) { ${CHANNEL_FIELDS} } }`,
      { id: channelId }
    );
    return data?.channel ?? null;
  }

  async getDailyPostingLimit(channelId: string, date: string): Promise<BufferDailyLimit | null> {
    const data = await this.gql<{ dailyPostingLimits: BufferDailyLimit[] }>(
      `query D($input: DailyPostingLimitsInput!) {
         dailyPostingLimits(input: $input) { channelId isAtLimit limit scheduled sent }
       }`,
      { input: { channelIds: [channelId], date } }
    );
    return data?.dailyPostingLimits?.[0] ?? null;
  }

  async createPost(input: BufferCreatePostInput): Promise<BufferPost> {
    const data = await this.gql<{
      createPost: { post?: BufferPost; message?: string };
    }>(
      `mutation C($input: CreatePostInput!) {
         createPost(input: $input) {
           ... on PostActionSuccess { post { ${POST_FIELDS} } }
           ... on MutationError { message }
         }
       }`,
      { input }
    );

    const result = data?.createPost;
    if (result?.message) {
      throw new BufferApiError(result.message);
    }
    if (!result?.post) {
      throw new BufferApiError('Buffer returned no post and no error message');
    }
    return result.post;
  }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm run build:backend`
Expected: build succeeds with no TypeScript errors referencing `buffer.client.ts`.

- [ ] **Step 3: Commit**

```bash
git add libraries/nestjs-libraries/src/integrations/social/buffer.client.ts
git commit -m "feat(buffer): add dependency-free Buffer GraphQL client"
```

---

### Task 2: Per-post settings DTO and registration

**Files:**
- Create: `libraries/nestjs-libraries/src/dtos/posts/providers-settings/buffer.dto.ts`
- Modify: `libraries/nestjs-libraries/src/dtos/posts/providers-settings/all.providers.settings.ts:18-19,48-49,85-87`

**Interfaces:**
- Consumes: nothing.
- Produces: `BufferDto` class, referenced as `dto = BufferDto` in Task 3.

- [ ] **Step 1: Create the DTO**

Buffer exposes only `isAiGenerated` as an X-specific toggle. Threads are derived from Postiz's existing multi-post structure, not a user setting.

```typescript
// libraries/nestjs-libraries/src/dtos/posts/providers-settings/buffer.dto.ts
import { IsBoolean, IsOptional } from 'class-validator';
import { JSONSchema } from 'class-validator-jsonschema';

export class BufferDto {
  @IsBoolean()
  @IsOptional()
  @JSONSchema({
    description: 'Discloses that the post contains AI-generated content',
  })
  made_with_ai: boolean;
}
```

- [ ] **Step 2: Register the DTO**

In `all.providers.settings.ts`, add the import beside the existing ones (near line 19):

```typescript
import { BufferDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/buffer.dto';
```

Add to the union type (near line 49):

```typescript
  | ProviderExtension<'buffer', BufferDto>
```

Add to the values array (near line 87):

```typescript
    { value: BufferDto, name: 'buffer' },
```

- [ ] **Step 3: Verify it compiles**

Run: `pnpm run build:backend`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add libraries/nestjs-libraries/src/dtos/posts/providers-settings/
git commit -m "feat(buffer): add BufferDto and register provider settings"
```

---

### Task 3: Buffer provider — connect flow and post flow

> Tasks 3 and 4 were merged before execution. Splitting them would have left a
> `post()` stub that throws in the reviewed state of Task 3, which any reviewer
> would correctly flag as a defect. Implement both halves in one pass and commit
> them separately (Steps 3 and 7).

**Files:**
- Create: `libraries/nestjs-libraries/src/integrations/social/buffer.provider.ts`

**Interfaces:**
- Consumes: `BufferClient`, `BufferChannel`, `BufferApiError` from Task 1; `BufferDto` from Task 2.
- Produces: `BufferProvider` class implementing `SocialProvider`, with `identifier = 'buffer'`, including a working `post()`. Task 5 imports the class.

- [ ] **Step 1: Create the provider with the connect flow**

The access token is a composite `"<apiKey>:<channelId>"`, mirroring how `x.provider.ts:349` packs `accessToken + ':' + accessSecret`. This keeps everything inside the existing `Integration` row with no schema migration.

```typescript
// libraries/nestjs-libraries/src/integrations/social/buffer.provider.ts
import { Integration } from '@prisma/client';
import dayjs from 'dayjs';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';
import { SocialAbstract } from '../social.abstract';
import {
  AuthTokenDetails,
  PostDetails,
  PostResponse,
  SocialProvider,
} from './social.integrations.interface';
import { BufferDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/buffer.dto';
import { BufferApiError, BufferChannel, BufferClient } from './buffer.client';

export class BufferProvider extends SocialAbstract implements SocialProvider {
  identifier = 'buffer';
  name = 'X (via Buffer)';
  isBetweenSteps = false;
  scopes = [] as string[];
  editor = 'normal' as const;
  dto = BufferDto;

  maxLength() {
    return 280;
  }

  /** Splits the composite token stored on the integration. */
  protected splitToken(accessToken: string): { apiKey: string; channelId: string } {
    const separator = accessToken.lastIndexOf(':');
    if (separator === -1) {
      throw new BufferApiError('Malformed Buffer token — expected "<apiKey>:<channelId>"');
    }
    return {
      apiKey: accessToken.slice(0, separator),
      channelId: accessToken.slice(separator + 1),
    };
  }

  async customFields() {
    return [
      {
        key: 'apiKey',
        label: 'Buffer API Key',
        validation: `/^.{10,}$/`,
        type: 'password' as const,
        hint: 'Buffer → Settings → API → create a personal key. Connect your X account inside Buffer first.',
      },
      {
        key: 'handle',
        label: 'X Handle (optional)',
        defaultValue: '',
        validation: `/^@?[A-Za-z0-9_]{0,15}$/`,
        type: 'text' as const,
        hint: 'Only needed if more than one X channel is connected to your Buffer account.',
      },
    ];
  }

  async refreshToken(): Promise<AuthTokenDetails> {
    // Buffer personal API keys do not expire. Mirrors x.provider.ts:281.
    return {
      refreshToken: '',
      expiresIn: 0,
      accessToken: '',
      id: '',
      name: '',
      picture: '',
      username: '',
    };
  }

  async generateAuthUrl() {
    const state = makeId(6);
    return { url: state, codeVerifier: makeId(10), state };
  }

  /** Picks the single X channel, disambiguating on handle when there are several. */
  protected resolveChannel(channels: BufferChannel[], handle?: string): BufferChannel | string {
    const xChannels = channels.filter((c) => c.service === 'twitter');
    if (xChannels.length === 0) {
      return 'No X channel found in this Buffer account. Connect X inside Buffer first.';
    }
    if (xChannels.length === 1) {
      return xChannels[0];
    }

    const wanted = (handle || '').replace(/^@/, '').toLowerCase();
    if (!wanted) {
      return `Multiple X channels found (${xChannels
        .map((c) => c.name)
        .join(', ')}). Re-connect and specify which handle to use.`;
    }

    const match = xChannels.find((c) => c.name.toLowerCase() === wanted);
    if (!match) {
      return `No X channel matching @${wanted}. Available: ${xChannels.map((c) => c.name).join(', ')}`;
    }
    return match;
  }

  async authenticate(params: { code: string; codeVerifier: string; refresh?: string }) {
    const body: { apiKey: string; handle?: string } = JSON.parse(
      Buffer.from(params.code, 'base64').toString()
    );

    try {
      const client = new BufferClient(body.apiKey);
      const organizationId = await client.getOrganizationId();
      const channels = await client.listChannels(organizationId);

      const resolved = this.resolveChannel(channels, body.handle);
      if (typeof resolved === 'string') {
        return resolved;
      }
      if (resolved.isDisconnected) {
        return `Buffer reports the X channel @${resolved.name} as disconnected. Reconnect it in Buffer.`;
      }

      return {
        // serviceId is the native X user id — the same value x.provider.ts:348 stores.
        // Keeping it identical is what makes in-place migration possible.
        id: resolved.serviceId,
        accessToken: `${body.apiKey}:${resolved.id}`,
        refreshToken: '',
        expiresIn: dayjs().add(100, 'years').unix() - dayjs().unix(),
        name: resolved.displayName || resolved.name,
        picture: resolved.avatar || '',
        username: resolved.name,
      };
    } catch (e) {
      return e instanceof BufferApiError ? e.message : 'Invalid Buffer credentials';
    }
  }

  async checkValidity(): Promise<string | true> {
    return true;
  }

  // post() is added in Step 4 below. Do not commit the class without it.
}
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm run build:backend`
Expected: build succeeds.

- [ ] **Step 3: Commit the connect flow**

```bash
git add libraries/nestjs-libraries/src/integrations/social/buffer.provider.ts
git commit -m "feat(buffer): add provider connect flow with channel resolution"
```

- [ ] **Step 4: Add media mapping and the tweet-id parser**

Add these protected methods to `BufferProvider`. Postiz's `MediaContent.alt` is optional, but Buffer silently drops images without `altText`, so a fallback is mandatory rather than cosmetic.

```typescript
  /** Buffer requires altText; without it the image is silently discarded. */
  protected buildAssets(media: PostDetails['media']) {
    return (media || [])
      .filter((m) => m.type === 'image')
      .map((m) => ({
        image: {
          url: m.path,
          ...(m.thumbnail ? { thumbnailUrl: m.thumbnail } : {}),
          metadata: { altText: m.alt?.trim() || 'Image' },
        },
      }));
  }

  /** externalLink looks like https://twitter.com/<handle>/status/<id> */
  protected parseTweetId(externalLink: string | null): string {
    const match = (externalLink || '').match(/status\/(\d+)/);
    return match?.[1] || '';
  }
```

- [ ] **Step 5: Add the `post()` method**

```typescript
  async post(
    id: string,
    accessToken: string,
    postDetails: PostDetails<BufferDto>[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const { apiKey, channelId } = this.splitToken(accessToken);
    const client = new BufferClient(apiKey);
    const [firstPost, ...rest] = postDetails;

    // Guard against the channel now pointing at a different X account.
    const channel = await client.getChannel(channelId);
    if (!channel) {
      throw new BufferApiError(`Buffer channel ${channelId} no longer exists`);
    }
    if (channel.isDisconnected || channel.isLocked) {
      throw new BufferApiError(
        `Buffer channel @${channel.name} is ${channel.isDisconnected ? 'disconnected' : 'locked'}`
      );
    }
    if (channel.serviceId !== integration.internalId) {
      throw new BufferApiError(
        `Buffer channel @${channel.name} resolves to X account ${channel.serviceId}, ` +
          `but this Postiz integration is bound to ${integration.internalId}. Refusing to post.`
      );
    }

    // Fail fast rather than mid-publish when the 50/day cap is reached.
    const limit = await client.getDailyPostingLimit(channelId, new Date().toISOString());
    if (limit?.isAtLimit) {
      throw new BufferApiError(
        `Daily posting limit reached for @${channel.name} (${limit.sent}/${limit.limit})`
      );
    }

    // Postiz models a thread as multiple PostDetails; Buffer takes it in one call.
    const thread = rest.map((p) => ({ text: p.message }));

    const post = await client.createPost({
      text: firstPost.message,
      channelId,
      schedulingType: 'automatic',
      mode: 'shareNow',
      source: 'postiz',
      assets: this.buildAssets(firstPost.media),
      metadata: {
        twitter: {
          ...(thread.length ? { thread } : {}),
          ...(firstPost.settings?.made_with_ai ? { isAiGenerated: true } : {}),
        },
      },
    });

    if (post.status === 'error') {
      throw new BufferApiError(`Buffer failed to publish post ${post.id}`);
    }

    // externalLink is returned synchronously on shareNow (verified), so the fallback is
    // defensive only. Integration.profile is nullable, so prefer the channel's own link
    // over interpolating it into a URL that would read ".../undefined/status/".
    const releaseURL = post.externalLink || channel.externalLink || '';

    // Every PostDetails must be answered, or Postiz will treat the rest as unpublished.
    return postDetails.map((p) => ({
      id: p.id,
      postId: this.parseTweetId(post.externalLink),
      releaseURL,
      status: 'posted',
    }));
  }
```

- [ ] **Step 6: Verify it compiles**

Run: `pnpm run build:backend`
Expected: build succeeds.

- [ ] **Step 7: Commit the post flow**

```bash
git add libraries/nestjs-libraries/src/integrations/social/buffer.provider.ts
git commit -m "feat(buffer): implement post flow with identity assert and thread support"
```

---

### Task 4: Register the provider in the backend

**Files:**
- Modify: `libraries/nestjs-libraries/src/integrations/integration.manager.ts:38,40+`

**Interfaces:**
- Consumes: `BufferProvider` from Task 3.
- Produces: `'buffer'` available in `socialIntegrationList`.

- [ ] **Step 1: Import and register**

Add the import beside the others (after line 38):

```typescript
import { BufferProvider } from '@gitroom/nestjs-libraries/integrations/social/buffer.provider';
```

Add the instance to `socialIntegrationList`, immediately after `new XProvider(),` so the two X paths sit together:

```typescript
  new BufferProvider(),
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm run build:backend`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add libraries/nestjs-libraries/src/integrations/integration.manager.ts
git commit -m "feat(buffer): register Buffer provider in integration manager"
```

---

### Task 5: Frontend settings component and registration

**Files:**
- Create: `apps/frontend/src/components/new-launch/providers/buffer/buffer.provider.tsx`
- Create: `apps/frontend/public/icons/platforms/buffer.png`
- Modify: `apps/frontend/src/components/new-launch/providers/show.all.providers.tsx`

**Interfaces:**
- Consumes: `BufferDto` from Task 2.
- Produces: default-exported `BufferProvider` React component registered under identifier `'buffer'`.

- [ ] **Step 1: Create the component**

Modelled on `x/x.provider.tsx`, reduced to the one setting Buffer supports.

```tsx
'use client';

import {
  PostComment,
  withProvider,
} from '@gitroom/frontend/components/new-launch/providers/high.order.provider';
import { ThreadFinisher } from '@gitroom/frontend/components/new-launch/finisher/thread.finisher';
import { Checkbox } from '@gitroom/react/form/checkbox';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useSettings } from '@gitroom/frontend/components/launches/helpers/use.values';
import { BufferDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/buffer.dto';

const SettingsComponent = () => {
  const t = useT();
  const { register } = useSettings();

  return (
    <>
      <div className="flex flex-col gap-[16px]">
        <Checkbox
          label={t('made_with_ai', 'Disclose AI-generated content')}
          {...register('made_with_ai')}
        />
      </div>

      <ThreadFinisher />
    </>
  );
};

export default withProvider({
  postComment: PostComment.POST,
  minimumCharacters: [],
  SettingsComponent: SettingsComponent,
  CustomPreviewComponent: undefined,
  dto: BufferDto,
  maximumCharacters: 280,
});
```

The `withProvider` signature (`high.order.provider.tsx:40-52`) accepts only
`comments?`, `postComment`, `minimumCharacters`, `SettingsComponent`,
`CustomPreviewComponent?`, `dto?`, and `maximumCharacters?`. Passing anything
else — for example a `checkValidity` key — is a TypeScript excess-property error.

- [ ] **Step 2: Add the icon**

Copy an existing platform icon as a placeholder so the channel renders, then replace with Buffer branding:

```bash
cp apps/frontend/public/icons/platforms/bluesky.png apps/frontend/public/icons/platforms/buffer.png
```

- [ ] **Step 3: Register the component**

In `show.all.providers.tsx`, add the import beside the others:

```typescript
import BufferProvider from '@gitroom/frontend/components/new-launch/providers/buffer/buffer.provider';
```

Add the entry to the array, after the `'x'` entry (near line 49):

```typescript
  {
    identifier: 'buffer',
    component: BufferProvider,
  },
```

- [ ] **Step 4: Verify it compiles**

Run: `pnpm run build:frontend`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/components/new-launch/providers/buffer/ \
        apps/frontend/src/components/new-launch/providers/show.all.providers.tsx \
        apps/frontend/public/icons/platforms/buffer.png
git commit -m "feat(buffer): add frontend settings component and registration"
```

---

### Task 6: Check in the verification probe

**Files:**
- Create: `scripts/buffer-probe.mjs`

**Interfaces:**
- Consumes: nothing (standalone, Node 24 built-in fetch).
- Produces: the repo's verification entry point for this provider.

- [ ] **Step 1: Copy the probe from the session scratchpad**

```bash
cp /private/tmp/claude-501/-Users-brady-postiz-app/d701af04-639e-43fb-9790-ef39d05f40f0/scratchpad/buffer-probe.mjs scripts/buffer-probe.mjs
```

- [ ] **Step 2: Add a header comment documenting usage and the altText trap**

Prepend to `scripts/buffer-probe.mjs`:

```javascript
/**
 * Verification probe for the Buffer-relayed X provider.
 * The repo has no jest projects; this script is how buffer.provider.ts is verified.
 *
 *   export BUFFER_API_KEY=...
 *   node scripts/buffer-probe.mjs channels
 *   node scripts/buffer-probe.mjs draft   <channelId>   # publishes nothing
 *   node scripts/buffer-probe.mjs thread  <channelId>   # publishes nothing
 *   node scripts/buffer-probe.mjs publish <channelId> --i-mean-it   # REAL TWEET
 *
 * Known Buffer behaviour: ImageMetadataInput.altText is a required String!.
 * Omitting the metadata object makes Buffer silently discard the image and
 * return a post with assets: []. Always assert assets.length after creating
 * a post with media.
 */
```

- [ ] **Step 3: Confirm it runs against the live API**

Run: `BUFFER_API_KEY=<key> node scripts/buffer-probe.mjs channels`
Expected: the X channel is listed with its id and `isDisconnected: false`.

- [ ] **Step 4: Commit**

```bash
git add scripts/buffer-probe.mjs
git commit -m "chore(buffer): check in verification probe script"
```

---

### Task 7: End-to-end verification through Postiz

**Files:** none — this task is verification only.

**Interfaces:**
- Consumes: everything from Tasks 1–6.

- [ ] **Step 1: Start the stack**

Run: `pnpm run dev`
Expected: backend, frontend, and orchestrator start.

- [ ] **Step 2: Connect the channel**

In the UI, add a channel, choose **X (via Buffer)**, paste the Buffer API key, leave the handle blank.
Expected: the channel appears with the X handle as its name and the X avatar as its picture.

- [ ] **Step 3: Verify the identity binding**

Query the integration row and confirm `internalId` equals the X user id (`325272494` for `@BradyKirkT`) — the same value the native X provider would have stored.

- [ ] **Step 4: Schedule a text-plus-link post**

Schedule a post containing a URL a few minutes out, and let the orchestrator publish it.
Expected: post state becomes published, and the calendar's release link opens the real tweet at `https://twitter.com/<handle>/status/<id>`.

- [ ] **Step 5: Schedule a post with an image**

Schedule a post with one image attached.
Expected: the published tweet shows the image. **If the image is missing, `altText` was dropped somewhere in `buildAssets` — that is the silent-failure mode this provider is built to avoid.**

- [ ] **Step 6: Schedule a thread**

Schedule a post with two continuation posts.
Expected: X shows a three-tweet thread.

- [ ] **Step 7: Verify the identity guard**

Temporarily edit the integration's `internalId` to a wrong value and attempt a post.
Expected: publishing fails with "Refusing to post" and nothing reaches X. Restore the correct value afterwards.

- [ ] **Step 8: Commit any fixes**

```bash
git add -A
git commit -m "fix(buffer): address issues found in end-to-end verification"
```

---

## Deferred

- **Analytics.** `Post.metrics` and `metricsUpdatedAt` exist and may support `postAnalytics`, but X analytics is being disabled via `DISABLE_X_ANALYTICS` anyway.
- **Migrating the existing X integration in place.** Possible because `internalId` matches under both providers, but connecting fresh is lower-risk for a first cut.
- **Video assets.** `buildAssets` filters to images. `VideoAssetInput` exists and can be added once image posting is proven in production.
- **Buffer ToS confirmation.** Must be resolved before this ships, and it is not an engineering task.
