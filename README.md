# Bluesky "Thoughts & Memes" Feed Generator

A lightweight, high-performance Bluesky custom feed generator that streams and filters posts using **Jetstream** and serves them using **Express** and **SQLite**.

### Feed Concept: The Essence of Microblogging
This feed is designed to filter out the noise of modern social networks:
*   ❌ **No Politics:** No references to election campaigns, politicians, wars, or hot-button debates.
*   ❌ **No Programming / Tech:** No coding, tech stacks, AI tools, framework debates, or developer slop.
*   ❌ **No Promotion:** No newsletter signups, sales, store links, crypto, OnlyFans/Patreon links, or follow-trains.
*   ✅ **Just People:** Everyday personal status updates, jokes, shower thoughts, reflections, and memes (images).

---

## Getting Started

### 1. Installation

Install all required packages:
```bash
npm install
```

### 2. Configuration

Create a `.env` file from the template:
```bash
cp .env.example .env
```

Open `.env` and fill in the required fields:
*   `FEEDGEN_PORT`: Port to run the server on (default: `3000`).
*   `FEEDGEN_HOSTNAME`: The domain where your feed generator will be deployed (e.g. `feed.yourdomain.com`). This domain must support HTTPS.
*   `FEEDGEN_PUBLISHER_DID`: Your Bluesky user account DID (looks like `did:plc:xxxxxxxxxxxx`). You can find yours by entering your handle at [did.directory](https://did.directory/).
*   `BSKY_HANDLE`: Your Bluesky handle (e.g., `yourname.bsky.social`).
*   `BSKY_PASSWORD`: A Bluesky **App Password** (create one at `Settings > App Passwords` inside the Bluesky app).

### 3. Run Locally

To test the filtering engine and server locally:
```bash
npm run dev
```
You will see the feed generator start, connect to Jetstream, and log filtered posts matching the criteria as they are added to the database.

---

## Deployment & Verification

### 1. Deploy the Server
Deploy this node app to a cloud hosting provider (Railway, Render, Fly.io, or your own VPS).
*   Ensure it exposes port `3000` (or your configured port).
*   Ensure it has a public domain (e.g., `https://feed.yourdomain.com`).

### 2. Verify endpoints
Verify the following URLs load correctly:
1.  `https://feed.yourdomain.com/.well-known/did.json` (resolves the DID Document)
2.  `https://feed.yourdomain.com/xrpc/app.bsky.feed.describeFeedGenerator` (describes the feed)

---

## Publishing the Feed to Bluesky

Once your server is live and verified, run the publish script to register it on the Bluesky network:

```bash
npm run publish-feed
```

Once published, you will see a success message with the feed link (e.g., `https://bsky.app/profile/yourname.bsky.social/feed/thoughts-and-memes`). You can click the link to view, save, and pin the feed to your Bluesky home page!
