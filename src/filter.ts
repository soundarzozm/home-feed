// RegEx patterns for negative filtering (case-insensitive)
const POLITICAL_PATTERN = new RegExp(
  '\\b(' +
    [
      // Figures & Parties
      'trump', 'biden', 'harris', 'kamala', 'walz', 'vance', 'obama', 'clinton', 'putin', 'zelensky', 'netanyahu',
      'democrat', 'democrats', 'democratic', 'republican', 'republicans', 'gop', 'maga', 'tory', 'tories', 'labour',
      // Political Systems & Concepts
      'politics', 'political', 'geopolitics', 'policy', 'government', 'senate', 'congress', 'parliament',
      'election', 'elections', 'vote', 'voting', 'ballot', 'poll', 'polls', 'presidency', 'president', 'governor', 'mayor', 'senator',
      'activism', 'activist', 'protest', 'protester', 'protesters', 'rally', 'campaigning', 'lobbyist',
      'capitalism', 'socialism', 'communism', 'fascism', 'fascist', 'liberal', 'conservative', 'leftist', 'rightwing', 'leftwing',
      // Conflict & Geopolitics
      'gaza', 'israel', 'palestine', 'hamas', 'zionist', 'zionism', 'ukraine', 'russia', 'taiwan', 'nato', 'war', 'genocide',
      // Social/Political Debates
      'immigration', 'border patrol', 'abortion', 'prolife', 'prochoice', 'supreme court', 'scotus'
    ].join('|') +
  ')\\b',
  'i'
);

const TECH_PROGRAMMING_PATTERN = new RegExp(
  '\\b(' +
    [
      // Coding / Engineering terms
      'coding', 'programming', 'programmer', 'software', 'developer', 'webdev', 'fullstack', 'frontend', 'backend',
      'javascript', 'typescript', 'rustlang', 'golang', 'csharp', 'python', 'reactjs', 'nextjs', 'vuejs', 'svelte',
      'compiler', 'refactoring', 'refactor', 'debugging', 'debug', 'codebase', 'codebases', 'git', 'github', 'gitlab',
      'repo', 'repository', 'pull request', 'merge conflict', 'docker', 'kubernetes', 'aws', 'serverless', 'cloudflare',
      'database', 'postgres', 'postgresql', 'sqlite', 'mongodb', 'redis', 'npm', 'pnpm', 'yarn', 'package.json',
      // AI / LLMs (Often tech slop)
      'ai', 'llm', 'llms', 'chatgpt', 'openai', 'claude', 'gemini', 'copilot', 'midjourney', 'generative ai',
      // Protocol terms
      'atproto', 'lexicon', 'lexicons', 'pds', 'feedgen', 'feed generator', 'did:web', 'did:plc'
    ].join('|') +
  ')\\b',
  'i'
);

const PROMO_MARKETING_PATTERN = new RegExp(
  '\\b(' +
    [
      'discount', 'coupon', 'promo', 'promotion', 'buy now', 'shop', 'sale', 'sales', 'limited time',
      'check out my', 'my store', 'subscribers', 'subscribe', 'newsletter', 'substack', 'patreon', 'onlyfans',
      'kickstarter', 'gumroad', 'ko-fi', 'merch', 'hiring', 'job opening', 'freelancer', 'freelance',
      'marketing', 'seo', 'audience', 'follower', 'followers', 'monetize', 'affiliate', 'referral',
      'crypto', 'bitcoin', 'ethereum', 'solana', 'nft', 'nfts', 'web3', 'airdrop', 'token', 'invest', 'investing',
      'passive income', 'make money', 'earn money', 'use code'
    ].join('|') +
  ')\\b',
  'i'
);

// We want to filter out posts containing links
const LINK_PATTERN = /https?:\/\/[^\s]+/i;

export function shouldIncludePost(post: any): { shouldInclude: boolean; isReply: boolean } {
  const isReply = !!post.reply;
  const text = post.text || '';

  // 1. Language filter: If langs are provided, ensure it includes English ('en')
  if (post.langs && post.langs.length > 0) {
    if (!post.langs.includes('en')) {
      return { shouldInclude: false, isReply };
    }
  }

  // 2. Filter out empty or very short posts (unless there's an image/media)
  const hasImages = !!(post.embed && (
    post.embed.$type === 'app.bsky.embed.images' ||
    post.embed.$type === 'app.bsky.embed.recordWithMedia'
  ));
  
  if (text.trim().length < 8 && !hasImages) {
    return { shouldInclude: false, isReply };
  }

  // 3. Filter out posts containing links (very common in promo/news/tech content)
  if (LINK_PATTERN.test(text)) {
    return { shouldInclude: false, isReply };
  }

  // Check facets for links as well
  if (post.facets) {
    for (const facet of post.facets) {
      if (facet.features) {
        for (const feature of facet.features) {
          if (feature.$type === 'app.bsky.richtext.facet#link') {
            return { shouldInclude: false, isReply };
          }
        }
      }
    }
  }

  // 4. Negative keyword filters
  if (POLITICAL_PATTERN.test(text)) {
    return { shouldInclude: false, isReply };
  }
  if (TECH_PROGRAMMING_PATTERN.test(text)) {
    return { shouldInclude: false, isReply };
  }
  if (PROMO_MARKETING_PATTERN.test(text)) {
    return { shouldInclude: false, isReply };
  }

  // 5. Hashtag limits: maximum of 1 hashtag
  const hashtags = (text.match(/#[^\s#]+/g) || []);
  if (hashtags.length > 1) {
    return { shouldInclude: false, isReply };
  }

  // 6. Mention limits: maximum of 1 mention
  const mentions = (text.match(/@[^\s@]+/g) || []);
  if (mentions.length > 1) {
    return { shouldInclude: false, isReply };
  }

  // 7. Max length to keep it brief
  if (text.length > 280) {
    return { shouldInclude: false, isReply };
  }

  return { shouldInclude: true, isReply };
}
