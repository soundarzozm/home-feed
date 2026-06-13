import { BskyAgent } from "@atproto/api";
import dotenv from "dotenv";

dotenv.config();

async function run() {
  const handle = process.env.BSKY_HANDLE;
  const password = process.env.BSKY_PASSWORD;
  const hostname = process.env.FEEDGEN_HOSTNAME;
  const publisherDid = process.env.FEEDGEN_PUBLISHER_DID;

  if (!handle || !password || !hostname || !publisherDid) {
    console.error(
      "Error: Please populate BSKY_HANDLE, BSKY_PASSWORD, FEEDGEN_HOSTNAME, and FEEDGEN_PUBLISHER_DID in your .env file.",
    );
    process.exit(1);
  }

  const agent = new BskyAgent({ service: "https://bsky.social" });

  console.log(`Logging in as ${handle}...`);
  await agent.login({ identifier: handle, password });

  const feedRecordKey = "thoughts-and-memes";
  const feedGenDid = `did:web:${hostname}`;

  console.log(`Publishing feed record for key: ${feedRecordKey}...`);

  // Create or update the feed generator record in user's repo repository
  const response = await agent.api.com.atproto.repo.putRecord({
    repo: agent.session?.did ?? publisherDid,
    collection: "app.bsky.feed.generator",
    rkey: feedRecordKey,
    record: {
      did: feedGenDid,
      displayName: "Thoughts & Memes",
      description:
        "The essence of microblogging: no politics, no tech/programming content, and no promotional slop. Just everyday thoughts, feelings, jokes, and memes.",
      createdAt: new Date().toISOString(),
    },
  });

  console.log("Successfully published feed!");
  console.log(`Record URI: ${response.data.uri}`);
  console.log(
    `Feed URL: https://bsky.app/profile/${handle}/feed/${feedRecordKey}`,
  );
}

run().catch((err) => {
  console.error("Failed to publish feed:", err);
});
