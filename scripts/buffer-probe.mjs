#!/usr/bin/env node
/**
 * Verification probe for the Buffer-relayed X provider.
 * The repo has no jest projects; this script is how buffer.provider.ts is verified.
 *
 *   export BUFFER_API_KEY=...
 *   node scripts/buffer-probe.mjs channels
 *   node scripts/buffer-probe.mjs preflight <channelId>  # publishes nothing
 *   node scripts/buffer-probe.mjs draft   <channelId>   # publishes nothing
 *   node scripts/buffer-probe.mjs thread  <channelId>   # publishes nothing
 *   node scripts/buffer-probe.mjs publish <channelId> --i-mean-it   # REAL TWEET
 *
 * `preflight` is the regression guard for buffer.provider.ts: it issues exactly the
 * calls post() makes, in order — channel(input:{id}), dailyPostingLimits, then
 * createPost with an image asset carrying metadata.altText and
 * metadata.twitter.isAiGenerated — asserts each one, and deletes the draft it made.
 * Run it after any change to buffer.client.ts or buffer.provider.ts.
 *
 * Known Buffer behaviour: ImageMetadataInput.altText is a required String!.
 * Omitting the metadata object makes Buffer silently discard the image and
 * return a post with assets: []. Always assert assets.length after creating
 * a post with media.
 *
 * Zero dependencies — Node 24 built-in fetch only. Schema below is verified
 * against the live API, not guessed.
 */

const ENDPOINT = 'https://api.buffer.com';
const KEY = process.env.BUFFER_API_KEY;
if (!KEY) {
  console.error('Set BUFFER_API_KEY (see .buffer-env).');
  process.exit(1);
}

async function gql(query, variables = {}) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json().catch(() => null);
  if (!json) throw new Error(`HTTP ${res.status} — unparseable response`);
  if (json.errors) console.error('GraphQL errors:', JSON.stringify(json.errors, null, 2));
  return json;
}

const h = (s) => console.log(`\n${'='.repeat(70)}\n${s}\n${'='.repeat(70)}`);

// Every field Postiz's PostResponse contract needs, plus diagnostics.
const POST_FIELDS = `
  id
  text
  status
  externalLink
  sentAt
  dueAt
  createdAt
  channelId
  channelService
  sharedNow
  shareMode
  via
  metricsUpdatedAt
  error { __typename }
  assets { id type mimeType source }
`;

const CREATE = `
  mutation Create($input: CreatePostInput!) {
    createPost(input: $input) {
      ... on PostActionSuccess { post { ${POST_FIELDS} } }
      ... on MutationError { message }
    }
  }`;

async function orgId() {
  const j = await gql(`query { account { organizations { id name } } }`);
  const org = j?.data?.account?.organizations?.[0];
  if (!org) throw new Error('No organization found for this key.');
  return org.id;
}

// ------------------------------------------------------------------ channels
async function channels() {
  const id = await orgId();
  h(`Channels for organization ${id}`);
  const j = await gql(
    `query C($id: OrganizationId!) {
       channels(input: { organizationId: $id }) {
         id name service type isDisconnected isLocked externalLink serviceId
       }
     }`,
    { id }
  );
  const list = j?.data?.channels || [];
  if (!list.length) {
    console.log('  (none) — connect X in the Buffer UI first. There is no API path to link a channel.');
    return;
  }
  for (const c of list) {
    const isX = /twitter|^x$/i.test(c.service || '');
    console.log(
      `  ${String(c.service).padEnd(12)} ${String(c.name).padEnd(22)} ${c.id}` +
        `${c.isDisconnected ? ' [DISCONNECTED]' : ''}${c.isLocked ? ' [LOCKED]' : ''}${isX ? '  <-- X' : ''}`
    );
  }
}

// ----------------------------------------------------------------- preflight
const DELETE = `
  mutation Delete($input: DeletePostInput!) {
    deletePost(input: $input) {
      ... on DeletePostSuccess { id }
      ... on VoidMutationError { message }
    }
  }`;

let failures = 0;
function assert(ok, label, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

/**
 * Exercises every call buffer.provider.ts#post() makes, with the same shapes.
 * Creates one draft (nothing is published) and deletes it again.
 */
async function preflight(channelId) {
  h('PREFLIGHT — the exact calls post() makes. Publishes nothing.');

  // 1. channel(input: { id }) — the identity/connectivity guard.
  console.log('\n1. channel(input: { id: ChannelId! })');
  const c = await gql(
    `query G($id: ChannelId!) {
       channel(input: { id: $id }) {
         id name service serviceId displayName avatar externalLink isDisconnected isLocked
       }
     }`,
    { id: channelId }
  );
  const channel = c?.data?.channel;
  assert(!!channel, 'channel resolves', channel ? `@${channel.name}` : 'null');
  assert(!!channel?.serviceId, 'serviceId present', channel?.serviceId || '');
  assert(channel?.isDisconnected === false, 'not disconnected');
  assert(channel?.isLocked === false, 'not locked');

  // 2. dailyPostingLimits — the 50/day fail-fast, with a full ISO timestamp.
  console.log('\n2. dailyPostingLimits(input: { channelIds, date })');
  const d = await gql(
    `query D($input: DailyPostingLimitsInput!) {
       dailyPostingLimits(input: $input) { channelId isAtLimit limit scheduled sent }
     }`,
    { input: { channelIds: [channelId], date: new Date().toISOString() } }
  );
  const limit = d?.data?.dailyPostingLimits?.[0];
  assert(!!limit, 'limit row returned', limit ? JSON.stringify(limit) : 'none');
  assert(typeof limit?.isAtLimit === 'boolean', 'isAtLimit is a boolean');
  assert(typeof limit?.limit === 'number', 'limit is a number', String(limit?.limit));

  // 3. createPost with an image asset — altText is REQUIRED; without it Buffer
  //    silently drops the image and returns assets: []. saveToDraft so nothing sends.
  console.log('\n3. createPost(assets + metadata.altText + metadata.twitter.isAiGenerated)');
  const j = await gql(CREATE, {
    input: {
      text: `Buffer preflight ${new Date().toISOString()} https://example.com/probe`,
      channelId,
      schedulingType: 'automatic',
      mode: 'addToQueue',
      saveToDraft: true,
      source: 'postiz-probe',
      assets: [
        {
          image: {
            url: 'https://picsum.photos/800/450',
            thumbnailUrl: 'https://picsum.photos/200/113',
            metadata: { altText: 'Preflight image' },
          },
        },
      ],
      metadata: { twitter: { isAiGenerated: true } },
    },
  });
  const post = j?.data?.createPost?.post;
  assert(!!post, 'createPost returned a post', j?.data?.createPost?.message || '');
  assert(post?.status === 'draft', 'status is draft (nothing published)', post?.status || '');
  assert(
    (post?.assets || []).length === 1,
    'assets.length === 1 (altText accepted, image NOT dropped)',
    `got ${(post?.assets || []).length}`
  );
  assert(
    (post?.text || '').includes('https://example.com/probe'),
    'link survived intact'
  );

  // 4. Clean up — never leave drafts behind in the user's Buffer queue.
  if (post?.id) {
    console.log('\n4. deletePost (cleanup)');
    const del = await gql(DELETE, { input: { id: post.id } });
    assert(
      del?.data?.deletePost?.id === post.id,
      'draft deleted',
      del?.data?.deletePost?.message || post.id
    );
  }

  h(failures === 0 ? 'PREFLIGHT PASSED' : `PREFLIGHT FAILED — ${failures} assertion(s)`);
  if (failures) process.exit(1);
}

// --------------------------------------------------------------------- draft
async function draft(channelId) {
  h('DRAFT with a link — publishes nothing');
  // Links are the whole point: these are the posts X bills at $0.20 each.
  const j = await gql(CREATE, {
    input: {
      text: 'Buffer probe — link handling https://example.com/probe',
      channelId,
      schedulingType: 'automatic',
      mode: 'addToQueue',
      saveToDraft: true,
      source: 'postiz-probe',
    },
  });
  console.log(JSON.stringify(j, null, 2));
  console.log('\n>>> Did the URL survive intact? Is status=draft?');
}

// -------------------------------------------------------------- thread+image
async function thread(channelId) {
  h('DRAFT thread + image asset — publishes nothing');
  // Postiz stores media at URLs already, so ImageAssetInput.url avoids any binary upload step.
  const j = await gql(CREATE, {
    input: {
      text: 'Buffer probe — thread root https://example.com/one',
      channelId,
      schedulingType: 'automatic',
      mode: 'addToQueue',
      saveToDraft: true,
      source: 'postiz-probe',
      assets: [{ image: { url: 'https://picsum.photos/800/450', thumbnailUrl: 'https://picsum.photos/200/113' } }],
      metadata: {
        twitter: {
          thread: [{ text: 'Second tweet in the thread https://example.com/two' }, { text: 'Third tweet.' }],
        },
      },
    },
  });
  console.log(JSON.stringify(j, null, 2));
  console.log('\n>>> Did the thread + image attach? Check the Buffer UI.');
}

// ------------------------------------------------------------------- publish
async function publish(channelId) {
  if (!process.argv.includes('--i-mean-it')) {
    console.error(
      'This PUBLISHES A REAL TWEET to your live X account.\n' +
        'It is the only way to confirm externalLink actually populates after send.\n' +
        'Re-run with --i-mean-it.'
    );
    process.exit(1);
  }
  h('LIVE publish — one real tweet, then poll for externalLink');
  const j = await gql(CREATE, {
    input: {
      text: `Buffer probe ${new Date().toISOString()} https://example.com/probe`,
      channelId,
      schedulingType: 'automatic',
      mode: 'shareNow',
      source: 'postiz-probe',
    },
  });
  console.log(JSON.stringify(j, null, 2));

  const id = j?.data?.createPost?.post?.id;
  if (!id) return console.log('No post id — see errors above.');

  // externalLink is null until Buffer actually sends. Poll until status flips.
  for (let i = 1; i <= 10; i++) {
    await new Promise((r) => setTimeout(r, 6000));
    const p = await gql(`query G($id: PostId!) { post(input: { id: $id }) { ${POST_FIELDS} } }`, { id });
    const post = p?.data?.post;
    console.log(`  [${i * 6}s] status=${post?.status} externalLink=${post?.externalLink ?? 'null'}`);
    if (post?.externalLink || ['sent', 'error'].includes(post?.status)) {
      console.log('\n' + JSON.stringify(post, null, 2));
      console.log(
        post?.externalLink
          ? `\n>>> CONFIRMED: native URL returned. Postiz releaseURL works. Latency to URL: ~${i * 6}s`
          : '\n>>> Post reached terminal status with no externalLink — releaseURL would degrade.'
      );
      return;
    }
  }
  console.log('\n>>> Timed out after 60s. externalLink may populate later — re-query the post id above.');
}

const [, , cmd, channelId] = process.argv;
const needsChannel = ['preflight', 'draft', 'thread', 'publish'];
if (needsChannel.includes(cmd) && !channelId) {
  console.error(`Usage: node buffer-probe.mjs ${cmd} <channelId>   (get it from \`channels\`)`);
  process.exit(1);
}
const run = { channels, preflight, draft, thread, publish }[cmd];
if (!run) {
  console.error('Usage: node buffer-probe.mjs <channels|preflight|draft|thread|publish>');
  process.exit(1);
}
run(channelId).catch((e) => {
  console.error(e);
  process.exit(1);
});
