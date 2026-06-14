// RegEx patterns for negative filtering (case-insensitive) - targeting actual spam
export const SPAM_PATTERN = new RegExp(
  '\\b(' +
    [
      // Promotional spam
      'discount', 'coupon', 'promo', 'promotion', 'buy now', 'use code', 'limited time', 'shop now',
      'onlyfans', 'patreon', 'giveaway', 'giveaways', 'sweepstakes', 'win a free',
      // Crypto/Web3 spam
      'airdrop', 'memecoin drop', 'free token', 'claim airdrop', 'yield farming', 'doubled my money',
      'presale token', 'whitelist open'
    ].join('|') +
  ')\\b',
  'i'
);

export function isTextClean(text: string): boolean {
  if (!text) return true;
  return !SPAM_PATTERN.test(text);
}

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
  
  if (text.trim().length < 3 && !hasImages) {
    return { shouldInclude: false, isReply };
  }

  // 3. Spam keyword filter
  if (SPAM_PATTERN.test(text)) {
    return { shouldInclude: false, isReply };
  }

  // 4. Hashtag limits: maximum of 4 hashtags (prevents hashtag spamming)
  const hashtags = (text.match(/#[^\s#]+/g) || []);
  if (hashtags.length > 4) {
    return { shouldInclude: false, isReply };
  }

  // 5. Mention limits: maximum of 4 mentions
  const mentions = (text.match(/@[^\s@]+/g) || []);
  if (mentions.length > 4) {
    return { shouldInclude: false, isReply };
  }

  // 6. Max length to keep it clean (Bluesky max length is 300 characters)
  if (text.length > 300) {
    return { shouldInclude: false, isReply };
  }

  return { shouldInclude: true, isReply };
}
