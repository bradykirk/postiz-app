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

  // Postiz truncates a multi-part post to a single PostDetails before post() is ever
  // called, unless the provider implements comment() (see post.workflow.v1.0.5.ts /
  // post.activity.ts's isCommentable check). Buffer's CreatePostInput has no reply-to-
  // tweet field, so implementing comment() cannot make threads work either. Reject at
  // compose time so the failure is visible instead of silently publishing only part 1.
  override async checkValidity(
    posts: Array<{ path: string; thumbnail?: string }[]>
  ): Promise<string | true> {
    if (posts.length > 1) {
      return 'Threads are not supported on X (via Buffer) — Buffer has no reply-to-tweet API. Use the native X channel to post a thread.';
    }
    return true;
  }

  /** Buffer requires altText; without it the image is silently discarded. */
  protected buildAssets(media: PostDetails['media']) {
    return (media || [])
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

    // No thread support here: Postiz already truncated postDetails to a single entry
    // before post() was called (see the checkValidity() comment above), and Buffer's
    // CreatePostInput has no reply-to-tweet field to chain further tweets onto even if
    // it hadn't. Do not repopulate metadata.twitter.thread from postDetails — it is
    // unreachable and was previously dead code.
    const post = await client.createPost({
      text: firstPost.message,
      channelId,
      schedulingType: 'automatic',
      mode: 'shareNow',
      source: 'postiz',
      assets: this.buildAssets(firstPost.media),
      metadata: {
        twitter: {
          ...(firstPost.settings?.made_with_ai ? { isAiGenerated: true } : {}),
        },
      },
    });

    // Allowlist rather than denylist: BufferPost.status also includes 'draft' and
    // 'needs_approval' (e.g. Buffer org has post approval enabled). Reporting those as
    // posted would tell Postiz — and the user — that a tweet went out when it didn't.
    if (post.status !== 'sent' && post.status !== 'sending') {
      throw new BufferApiError(
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
