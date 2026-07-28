// libraries/nestjs-libraries/src/integrations/social/buffer.client.ts

/**
 * `retryable` distinguishes transient failures (network error, 429, 5xx) — which the
 * Temporal retry loop should keep retrying — from terminal ones, which buffer.provider.ts
 * converts into non-retryable ApplicationFailure subclasses. `status` carries the HTTP
 * status so the provider can map 401/403 to a re-authentication failure specifically.
 */
export class BufferApiError extends Error {
  constructor(
    message: string,
    public readonly retryable = false,
    public readonly status?: number
  ) {
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

export type BufferPostAsset = {
  id: string;
  type: string;
  mimeType: string | null;
  source: string | null;
};

export type BufferPost = {
  id: string;
  text: string;
  status: 'draft' | 'error' | 'needs_approval' | 'scheduled' | 'sending' | 'sent';
  externalLink: string | null;
  sentAt: string | null;
  error: { __typename: string } | null;
  // Buffer silently drops an image whose metadata.altText is missing, returning
  // assets: []. Selecting the field makes that observable at runtime instead of
  // invisible. Deliberately NOT asserted on in post(): a throw there would be
  // retried by the workflow and could publish the post repeatedly.
  assets: BufferPostAsset[] | null;
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
  assets { id type mimeType source }
`;

export class BufferClient {
  private readonly endpoint = 'https://api.buffer.com';

  constructor(private readonly apiKey: string) {}

  private async gql<T>(query: string, variables: Record<string, any> = {}): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (err: any) {
      throw new BufferApiError(
        `Buffer request failed: ${err?.message ?? String(err)}`,
        true
      );
    }

    if (res.status === 429) {
      throw new BufferApiError('Buffer rate limit exceeded', true);
    }

    const json = (await res.json().catch(() => null)) as any;
    if (!json) {
      throw new BufferApiError(
        `Buffer returned HTTP ${res.status} with an unreadable body`,
        res.status >= 500,
        res.status
      );
    }
    if (json.errors?.length) {
      // An auth failure can surface as errors[] with a 200/401 status alike, so keep
      // the status attached for the provider's 401/403 mapping.
      throw new BufferApiError(
        json.errors.map((e: any) => e.message).join('; '),
        res.status >= 500,
        res.status
      );
    }
    if (!res.ok) {
      const bodyText = json.message ?? JSON.stringify(json);
      throw new BufferApiError(
        `Buffer returned HTTP ${res.status}: ${bodyText}`,
        res.status >= 500,
        res.status
      );
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
