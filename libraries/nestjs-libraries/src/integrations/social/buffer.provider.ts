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
