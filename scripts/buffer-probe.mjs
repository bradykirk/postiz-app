#!/usr/bin/env node
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
const needsChannel = ['draft', 'thread', 'publish'];
if (needsChannel.includes(cmd) && !channelId) {
  console.error(`Usage: node buffer-probe.mjs ${cmd} <channelId>   (get it from \`channels\`)`);
  process.exit(1);
}
const run = { channels, draft, thread, publish }[cmd];
if (!run) {
  console.error('Usage: node buffer-probe.mjs <channels|draft|thread|publish>');
  process.exit(1);
}
run(channelId).catch((e) => {
  console.error(e);
  process.exit(1);
});
