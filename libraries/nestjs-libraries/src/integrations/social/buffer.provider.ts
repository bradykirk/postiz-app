// libraries/nestjs-libraries/src/integrations/social/buffer.provider.ts
import { Integration } from '@prisma/client';
import dayjs from 'dayjs';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';
import { BadBody, RefreshToken, SocialAbstract } from '../social.abstract';
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

  /**
   * Integration.internalId is stored as `buffer:<x user id>` so that the row cannot collide
   * with a native X integration on the `organizationId_internalId` upsert key — see the
   * comment in authenticate(). These two helpers are the only places that know about it.
   */
  protected static namespaceId(serviceId: string): string {
    return `buffer:${serviceId}`;
  }

  protected static denamespaceId(internalId: string): string {
    return (internalId || '').replace(/^buffer:/, '');
  }

  /**
   * Terminal Buffer failures must never be retried. The postSocial activity retries 3x
   * (post.workflow.v1.0.5.ts) and the surrounding iterate loop makes 5 passes, so a plain
   * Error can produce up to 15 createPost calls — up to 15 identical tweets once, say, an
   * approver clears a `needs_approval` queue. The workflow only understands the
   * ApplicationFailure subclasses from social.abstract: `bad_body` surfaces the
   * "Error posting on …" notification to the user, `refresh_token` marks the channel for
   * re-authentication. Genuinely transient failures (network error, 429, 5xx — carried on
   * BufferApiError.retryable) are rethrown untouched, because retrying those is correct.
   */
  protected failTerminal(e: unknown): never {
    if (e instanceof BufferApiError && !e.retryable) {
      if (e.status === 401 || e.status === 403) {
        throw new RefreshToken(this.identifier, '{}', '{}', e.message);
      }
      throw new BadBody(this.identifier, '{}', '{}', e.message);
    }
    throw e;
  }

  /** Splits the composite token stored on the integration. */
  protected splitToken(accessToken: string): { apiKey: string; channelId: string } {
    const separator = accessToken.lastIndexOf(':');
    if (separator === -1) {
      throw new BadBody(
        this.identifier,
        '{}',
        '{}',
        'Malformed Buffer token — expected "<apiKey>:<channelId>". Reconnect the channel.'
      );
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
        // Required, not optional: add.provider.component.tsx builds the yup schema with
        // `.matches(regex).required()` for every custom field, and yup rejects ''. A field
        // labelled optional would therefore fail validation when left blank. Always
        // supplying the handle is also defence-in-depth against binding the integration to
        // the wrong X account when several are connected to the same Buffer organization.
        key: 'handle',
        label: 'X Handle',
        validation: `/^@?[A-Za-z0-9_]{1,15}$/`,
        type: 'text' as const,
        hint: 'The handle of the X channel connected to your Buffer account, e.g. @postiz.',
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
    // Buffer's `service` value is matched case-insensitively (and accepts the newer "x"
    // spelling) so a casing change on Buffer's side cannot make every channel vanish.
    const xChannels = channels.filter((c) => /^(twitter|x)$/i.test(c.service || ''));
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
        // DO NOT "simplify" this to a bare serviceId. integration.repository.ts upserts on
        // the compound key `organizationId_internalId` — providerIdentifier is NOT part of
        // that key — and its update branch overwrites providerIdentifier and token.
        // resolved.serviceId is the native X user id, i.e. exactly what x.provider.ts
        // stores as its own internalId, so returning it bare would convert an existing
        // native X integration in place: the provider would flip x -> buffer and the OAuth1
        // token would be destroyed, leaving no fallback channel. Namespacing the id gives
        // Buffer its own integration row so both channels coexist.
        id: BufferProvider.namespaceId(resolved.serviceId),
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

  // Postiz truncates a multi-part post to a single PostDetails before post() is ever
  // called, unless the provider implements comment() (see post.workflow.v1.0.5.ts /
  // post.activity.ts's isCommentable check). Buffer's CreatePostInput has no reply-to-
  // tweet field, so implementing comment() cannot make threads work either. Reject at
  // compose time so the failure is visible instead of silently publishing only part 1.
  override async checkValidity(
    posts: Array<{ path: string; thumbnail?: string }[]>
  ): Promise<string | true> {
    if (posts.length > 1) {
      return 'Threads are not supported on X (via Buffer). Remove the additional post part to continue, or use the native X channel to post a thread.';
    }

    // posts.service.ts hardcodes `type: 'image'` on every media item, so buildAssets'
    // type filter can never see a video and an .mp4 would be handed to Buffer as
    // `{ image: { url: '…mp4' } }`. Reject on the file extension at compose time so the
    // capability gap is visible rather than producing a broken tweet.
    for (const post of posts) {
      for (const media of post || []) {
        const path = (media?.path || '').split('?')[0];
        if (/\.(mp4|mov|m4v|webm|avi)$/i.test(path)) {
          return 'Video is not supported on X (via Buffer). Remove the video attachment, or use the native X channel to post video.';
        }
      }
    }

    return true;
  }

  /** Buffer requires altText; without it the image is silently discarded. */
  protected buildAssets(media: PostDetails['media']) {
    return (media || [])
      // A no-op in practice: posts.service.ts hardcodes `type: 'image'` on every media
      // item, so nothing is ever filtered out here. Video is rejected up front in
      // checkValidity(); this stays as a second line of defence for any caller that does
      // populate `type` honestly.
      .filter((m) => m.type === 'image')
      .map((m) => ({
        image: {
          // `path` on MediaContent is the filesystem path on local-storage installs
          // (posts.service.ts sets UPLOAD_DIRECTORY + name there); the public,
          // server-fetchable URL lives on the runtime-only `url` field instead
          // (not declared on MediaContent). Buffer fetches assets itself, so passing
          // the filesystem path silently produces a text-only tweet. Prefer `url`,
          // falling back to `path` for any caller that only populated that field.
          url: (m as { url?: string; path: string }).url || m.path,
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

  async post(
    id: string,
    accessToken: string,
    postDetails: PostDetails<BufferDto>[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const { apiKey, channelId } = this.splitToken(accessToken);
    const client = new BufferClient(apiKey);
    const [firstPost] = postDetails;

    // Guard against the channel now pointing at a different X account.
    const channel = await client
      .getChannel(channelId)
      .catch((e) => this.failTerminal(e));
    if (!channel) {
      throw new BadBody(
        this.identifier,
        '{}',
        '{}',
        `Buffer channel ${channelId} no longer exists. Reconnect the X (via Buffer) channel.`
      );
    }
    if (channel.isDisconnected || channel.isLocked) {
      throw new RefreshToken(
        this.identifier,
        '{}',
        '{}',
        `Buffer channel @${channel.name} is ${
          channel.isDisconnected ? 'disconnected' : 'locked'
        }. Fix it in Buffer, then reconnect the channel in Postiz.`
      );
    }
    // internalId is namespaced (`buffer:<x user id>`) — see authenticate(). Strip the
    // prefix before comparing; the guard itself is unchanged, a mismatch still refuses.
    const boundServiceId = BufferProvider.denamespaceId(integration.internalId);
    if (channel.serviceId !== boundServiceId) {
      throw new BadBody(
        this.identifier,
        '{}',
        '{}',
        `Buffer channel @${channel.name} resolves to X account ${channel.serviceId}, ` +
          `but this Postiz integration is bound to ${boundServiceId}. Refusing to post.`
      );
    }

    // Fail fast rather than mid-publish when the 50/day cap is reached.
    const limit = await client
      .getDailyPostingLimit(channelId, new Date().toISOString())
      .catch((e) => this.failTerminal(e));
    if (limit?.isAtLimit) {
      throw new BadBody(
        this.identifier,
        '{}',
        '{}',
        `Daily posting limit reached for @${channel.name} (${limit.sent}/${limit.limit}). ` +
          `Reschedule this post for tomorrow.`
      );
    }

    // No thread support here: Postiz already truncated postDetails to a single entry
    // before post() was called (see the checkValidity() comment above), and Buffer's
    // CreatePostInput has no reply-to-tweet field to chain further tweets onto even if
    // it hadn't. Do not repopulate metadata.twitter.thread from postDetails — it is
    // unreachable and was previously dead code.
    // Only send metadata when there is something to put in it — an empty
    // `{ twitter: {} }` is noise on every request.
    const twitterMetadata = firstPost.settings?.made_with_ai
      ? { isAiGenerated: true }
      : undefined;

    const post = await client
      .createPost({
        text: firstPost.message,
        channelId,
        schedulingType: 'automatic',
        mode: 'shareNow',
        source: 'postiz',
        assets: this.buildAssets(firstPost.media),
        ...(twitterMetadata ? { metadata: { twitter: twitterMetadata } } : {}),
      })
      .catch((e) => this.failTerminal(e));

    // Allowlist rather than denylist: BufferPost.status also includes 'draft' and
    // 'needs_approval' (e.g. Buffer org has post approval enabled). Reporting those as
    // posted would tell Postiz — and the user — that a tweet went out when it didn't.
    // Terminal on purpose: retrying a `needs_approval` result would queue another copy of
    // the same tweet on every attempt (up to 15), all of which an approver could then
    // release at once.
    if (post.status !== 'sent' && post.status !== 'sending') {
      throw new BadBody(
        this.identifier,
        '{}',
        '{}',
        `Buffer did not publish post ${post.id}: status is "${post.status}"` +
          (post.error?.__typename ? ` (${post.error.__typename})` : '')
      );
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
}
