"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-full-journey-"));
process.env.NEMOCLAW_SESSION_FILE = path.join(temporary, "sessions.json");
process.env.NEMOCLAW_PENDING_FILE = path.join(temporary, "pending.json");
process.env.NEMOCLAW_STATE_FILE = path.join(temporary, "state.json");
process.env.NEMOCLAW_DB_PATH = path.join(temporary, "ads.db");
process.env.NEMOCLAW_IMAGE_DIR = path.join(temporary, "images");
process.env.NEMOCLAW_COMPLEXITY_ROUTING = "manual";
process.env.KA_COOKIES = "csrf-token=journey-test; registered_user=true";

const agent = require("../workspace/agent");
const store = require("../tools/adstore");
const { createSerialExecutor } = require("../workspace/runtime");

test.after(() => {
  store.close();
  fs.rmSync(temporary, { recursive: true, force: true });
});

test("album, publish, relist, and buyer reply form one exact-approval journey", async () => {
  agent.loadKleinanzeigenSession({ required: true });
  process.env.NEMOCLAW_MODE = "live";
  const ka = agent.requireAuthenticatedKa();
  const original = {
    uploadImage: ka.uploadImage,
    createAd: ka.createAd,
    sendMessage: ka.sendMessage,
    search: agent.TOOLS.ka_search_ads.fn,
    bundles: agent.TOOLS.ka_get_ad_bundles.fn,
  };
  const created = [];
  const outbound = [];
  let uploadCount = 0;
  ka.uploadImage = async () => ({
    imageUrl: `https://images.invalid/journey-${++uploadCount}.jpg`,
  });
  ka.createAd = async args => {
    const id = `910000000${created.length + 1}`;
    created.push({ id, args });
    return { id, link: `https://www.kleinanzeigen.de/s-anzeige/${id}` };
  };
  ka.sendMessage = async (conversationId, text) => {
    outbound.push({ conversationId, text });
    return { sent: true };
  };
  agent.TOOLS.ka_search_ads.fn = async () => [
    { id: "market-1", title: "Schwarze Schreibtischlampe", price: 12, categoryId: 82 },
    { id: "market-2", title: "Verstellbare Tischlampe", price: 18, categoryId: 82 },
  ];
  agent.TOOLS.ka_get_ad_bundles.fn = async () => ({
    expired: [{ id: "9100000001", status: "EXPIRED" }],
  });

  const sent = [];
  const gateway = {
    async downloadPhoto(fileId) { return Buffer.from(`synthetic-jpeg-${fileId}`); },
    async send(_chatId, text) { sent.push(text); },
    async sendPhoto() {},
  };
  const albumPaths = [];
  let listingStep = 0;
  const listingLlm = {
    model: "stub",
    async complete(request) {
      listingStep++;
      if (!albumPaths.length) {
        const text = request.messages[1].content[0].text;
        albumPaths.push(...[...text.matchAll(/\[FOTO path:([^\]]+)\]/g)].map(match => match[1]));
      }
      if (listingStep === 1) {
        return {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{
              id: "journey-search",
              type: "function",
              function: {
                name: "ka_search_ads",
                arguments: JSON.stringify({ keyword: "Schreibtischlampe schwarz" }),
              },
            }],
          },
        };
      }
      return {
        message: {
          role: "assistant",
          content: "Ich habe beide Fotos geprüft und den sichtbaren Lackabplatzer ehrlich aufgenommen.",
          tool_calls: [{
            id: "journey-create",
            type: "function",
            function: {
              name: "ka_create_ad",
              arguments: JSON.stringify({
                assetName: "Schwarze Schreibtischlampe",
                title: "Mattschwarze Schreibtischlampe",
                description: "Funktionsfähig mit kleinem sichtbarem Lackabplatzer am Sockel.",
                categoryId: 82,
                price: 12,
                priceType: "NEGOTIABLE",
                zipCode: "80636",
                locationId: "16360",
                contactName: "Jannik",
                imagePaths: albumPaths,
              }),
            },
          }],
        },
      };
    },
  };
  const updates = [
    {
      update_id: 1,
      message: {
        message_id: 11,
        chat: { id: 77 },
        media_group_id: "journey-album",
        caption: "Funktionsfähige Lampe; kleiner Lackabplatzer am Sockel.",
        photo: [{ file_id: "front" }],
      },
    },
    {
      update_id: 2,
      message: {
        message_id: 12,
        chat: { id: 77 },
        media_group_id: "journey-album",
        photo: [{ file_id: "defect" }],
      },
    },
  ];

  try {
    const albumBuffer = new Map();
    const enqueue = createSerialExecutor();
    await agent.processTelegramUpdates(
      [updates[0]],
      new Set(["77"]),
      enqueue,
      listingLlm,
      { gateway, albumBuffer, albumDelayMs: 20 }
    );
    await agent.processTelegramUpdates(
      [updates[1]],
      new Set(["77"]),
      enqueue,
      listingLlm,
      { gateway, albumBuffer, albumDelayMs: 20 }
    );
    await new Promise(resolve => setTimeout(resolve, 100));

    assert.equal(albumPaths.length, 2);
    assert.equal(agent.getPending("77").tool, "ka_create_ad");
    assert.match(sent.at(-1), /Lackabplatzer/);
    assert.match(sent.at(-1), /Fotos: 2/);
    assert.match(sent.at(-1), /sha256:[a-f0-9]{12}/);

    await agent.runAgent("77", "Go", { llmClient: listingLlm, gateway });
    assert.equal(agent.getPending("77"), null);
    assert.equal(created.length, 1);
    assert.equal(uploadCount, 2);
    assert.match(sent.at(-1), /9100000001/);

    const firstBundle = store.getAssetBundleByKaId("9100000001");
    const assetId = firstBundle.asset.id;
    assert.equal(firstBundle.asset.has_active_listing, 1);
    assert.deepEqual(firstBundle.asset.image_paths, albumPaths);
    assert.deepEqual(
      firstBundle.images.map(image => image.image_path),
      albumPaths
    );
    assert.equal(firstBundle.listings.length, 1);

    const firstMiss = await agent.checkListingLifecycle({
      getMyAds: async () => [],
      now: "2026-07-29T10:00:00.000Z",
    });
    assert.equal(firstMiss.events.length, 0);
    const secondMiss = await agent.checkListingLifecycle({
      getMyAds: async () => [],
      now: "2026-07-29T11:00:00.000Z",
    });
    assert.equal(secondMiss.events.length, 1);

    let relistStep = 0;
    const relistPayload = {
      ...firstBundle.asset.last_listing_payload,
      assetId,
    };
    const relistLlm = {
      model: "stub",
      async complete() {
        relistStep++;
        if (relistStep === 1) {
          return {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{
                id: "journey-bundles",
                type: "function",
                function: { name: "ka_get_ad_bundles", arguments: "{}" },
              }],
            },
          };
        }
        return {
          message: {
            role: "assistant",
            content: "Die alte Anzeige ist bestätigt abgelaufen. Hier ist dieselbe Anzeige mit denselben Fotos.",
            tool_calls: [{
              id: "journey-relist",
              type: "function",
              function: {
                name: "ka_create_ad",
                arguments: JSON.stringify(relistPayload),
              },
            }],
          },
        };
      },
    };
    await agent.runAgent(
      "lifecycle-77",
      agent.listingLifecyclePrompt(secondMiss.events[0]),
      { llmClient: relistLlm, gateway, source: "system" }
    );
    const relistPending = agent.getPending("lifecycle-77");
    assert.equal(relistPending.tool, "ka_create_ad");
    assert.equal(relistPending.args.assetId, assetId);
    assert.deepEqual(relistPending.args.imagePaths, albumPaths);
    await agent.runAgent("lifecycle-77", "Go", { llmClient: relistLlm, gateway });

    assert.equal(created.length, 2);
    assert.equal(uploadCount, 4);
    const relistedBundle = store.getAssetBundleByKaId("9100000002");
    assert.equal(relistedBundle.asset.id, assetId);
    assert.equal(relistedBundle.listings.length, 2);
    assert.deepEqual(relistedBundle.asset.image_paths, albumPaths);

    const buyerLlm = {
      model: "stub",
      async complete() {
        return {
          message: {
            role: "assistant",
            content: "Vorschlag: „Ja, die Lampe ist noch verfügbar.“",
            tool_calls: [{
              id: "journey-reply",
              type: "function",
              function: {
                name: "ka_send_message",
                arguments: JSON.stringify({
                  conversationId: "conversation-77",
                  text: "Ja, die Lampe ist noch verfügbar.",
                }),
              },
            }],
          },
        };
      },
    };
    const heartbeatSeen = {};
    const inbox = await agent.notifyUnreadConversations({
      conversations: [{
        id: "conversation-77",
        adId: "9100000002",
        adTitle: "Mattschwarze Schreibtischlampe",
        otherParty: "Alex",
        lastMessage: "Hallo, ist die Lampe noch verfügbar?",
        unread: true,
        updatedAt: "2026-07-29T12:00:00.000Z",
      }],
      heartbeatSeen,
      chatId: "inbox-77",
      enqueue: (_chatId, task) => task(),
      llmClient: buyerLlm,
      gateway,
      getMessages: async () => [{
        id: "message-77",
        text: "Hallo, ist die Lampe noch verfügbar?",
        sentAt: "2026-07-29T12:00:00.000Z",
        isMe: false,
      }],
    });
    assert.deepEqual(inbox, { changed: 1, notified: 1 });
    assert.match(sent.at(-1), /Originalnachricht: „Hallo, ist die Lampe noch verfügbar\?“/);
    assert.equal(agent.getPending("inbox-77").tool, "ka_send_message");

    await agent.runAgent("inbox-77", "Go", { llmClient: buyerLlm, gateway });
    assert.deepEqual(outbound, [{
      conversationId: "conversation-77",
      text: "Ja, die Lampe ist noch verfügbar.",
    }]);
    assert.equal(agent.getPending("inbox-77"), null);
  } finally {
    agent.clearPending("77");
    agent.clearPending("lifecycle-77");
    agent.clearPending("inbox-77");
    ka.uploadImage = original.uploadImage;
    ka.createAd = original.createAd;
    ka.sendMessage = original.sendMessage;
    agent.TOOLS.ka_search_ads.fn = original.search;
    agent.TOOLS.ka_get_ad_bundles.fn = original.bundles;
  }
});
