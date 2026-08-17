#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const CONFIRM_FLAG = "--confirm-external-draft";
const FORBIDDEN_EXTERNAL_MARKERS = /\b(?:canary|e2e|smoke|test|timestamp|zeitstempel)\b/i;
const TITLE_CANDIDATES = Object.freeze([
  "Mattschwarze Schreibtischlampe",
  "Verstellbare schwarze Schreibtischlampe",
  "Schwarze Schreibtischlampe mit Gelenkarm",
  "Schwarze Gelenkarm-Schreibtischlampe",
]);

function requireExplicitConfirmation(argv) {
  if (!argv.includes(CONFIRM_FLAG)) {
    throw new Error(
      `Dieser Test lädt echte Bilder hoch und legt kurzzeitig einen echten Kleinanzeigen-Entwurf an. ` +
      `Erneut mit "${CONFIRM_FLAG}" starten.`
    );
  }
}

function naturalListing(existingDrafts = []) {
  const existingTitles = new Set(
    existingDrafts.map(draft => String(draft.title || "").trim())
  );
  const title = TITLE_CANDIDATES.find(candidate => !existingTitles.has(candidate));
  if (!title) {
    throw new Error(
      "Alle natürlichen Titelvarianten existieren bereits als Entwurf. Vor dem Lauf manuell prüfen; keine markierte Variante erzeugen."
    );
  }
  const listing = {
    assetName: "Schwarze Schreibtischlampe",
    title,
    description: [
      "Verkaufe eine mattschwarze Schreibtischlampe mit verstellbarem Gelenkarm.",
      "Die Lampe ist funktionsfähig. Am vorderen Rand des Sockels befindet sich ein kleiner Lackabplatzer, siehe Detailfoto.",
      "Nur Abholung.",
      "Privatverkauf: Keine Rücknahme oder Garantie.",
    ].join("\n\n"),
    category: "Haus & Garten > Lampen & Licht",
    price: 12,
    priceType: "NEGOTIABLE",
    delivery: "pickup_only",
  };
  assertNaturalExternalContent(listing);
  return listing;
}

function assertNaturalExternalContent(listing) {
  const externalText = [listing.title, listing.description].join("\n");
  if (FORBIDDEN_EXTERNAL_MARKERS.test(externalText)) {
    throw new Error("Der externe Anzeigentext enthält eine technische Testmarkierung.");
  }
  return true;
}

function newDraftsSince(beforeDrafts, afterDrafts) {
  const beforeIds = new Set((beforeDrafts || []).map(draft => String(draft.id)));
  return (afterDrafts || []).filter(draft => !beforeIds.has(String(draft.id)));
}

function verifiedCreatedDraft(beforeDrafts, afterDrafts, expected, remoteId = null) {
  const created = newDraftsSince(beforeDrafts, afterDrafts);
  const matches = created.filter(draft => (
    (!remoteId || String(draft.id) === String(remoteId))
    && String(draft.title || "").trim() === expected.title
    && Number(draft.categoryId) === 82
    && Number(draft.priceAmount) === expected.price
    && String(draft.priceType) === expected.priceType
    && Number(draft.images) === expected.imagePaths.length
  ));
  if (created.length !== 1 || matches.length !== 1) {
    throw new Error(
      `Der Read nach dem Speichern ist nicht eindeutig (neu=${created.length}, exakt=${matches.length}).`
    );
  }
  return matches[0];
}

async function pollDrafts(readDrafts, predicate, { timeoutMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let drafts = [];
  do {
    drafts = await readDrafts();
    if (predicate(drafts)) return drafts;
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  } while (true);
  return drafts;
}

async function runApprovedAction(agent, broker, chatId, toolName, args, gateway) {
  const action = agent.stagePending(chatId, toolName, args);
  await agent.runAgent(chatId, "Go", { llmClient: null, gateway });
  const operation = broker.getOperation(action.id);
  if (operation?.status !== "completed") {
    throw new Error(
      `${toolName} wurde nicht eindeutig abgeschlossen (Status ${operation?.status || "unbekannt"}).`
    );
  }
  return operation;
}

async function main(argv = process.argv.slice(2)) {
  requireExplicitConfirmation(argv);
  const root = path.resolve(__dirname, "..");
  require("dotenv").config({ path: path.join(root, ".env"), override: true });
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-real-draft-e2e-"));
  process.env.NEMOCLAW_DB_PATH = path.join(temporary, "ads.db");
  process.env.NEMOCLAW_SESSION_FILE = path.join(temporary, "sessions.json");
  process.env.NEMOCLAW_STATE_FILE = path.join(temporary, "state.json");
  process.env.NEMOCLAW_READINESS_FILE = path.join(temporary, "readiness.json");
  process.env.NEMOCLAW_KA_CATEGORY_CACHE_FILE = path.join(temporary, "category-contracts.json");

  const agent = require("../workspace/agent");
  const broker = require("../tools/marketplace-broker");
  const store = require("../tools/adstore");
  const { discardPreparedFormSession } = require("../tools/kleinanzeigen-form");
  const chatId = "local-draft-e2e";
  const outbound = [];
  const gateway = {
    async send(_chatId, text) { outbound.push(String(text || "")); },
  };
  let releaseLock;
  let beforeDrafts = [];
  let expectedListing = null;
  let createdDraftId = null;
  let cleaned = false;

  try {
    releaseLock = agent.acquireProcessLock();
    agent.loadKleinanzeigenSession({ required: true });
    process.env.NEMOCLAW_MODE = "live";
    const readDrafts = () => agent.executeTool("ka_get_drafts", {});
    beforeDrafts = await readDrafts();
    expectedListing = naturalListing(beforeDrafts);
    expectedListing.imagePaths = [
      path.join(root, "workspace/images/raw/smoke-lamp-front.png"),
      path.join(root, "workspace/images/raw/smoke-lamp-rear.png"),
      path.join(root, "workspace/images/raw/smoke-lamp-defect.png"),
    ];
    assertNaturalExternalContent(expectedListing);

    process.stdout.write("1/4 Sichtbares Formular und Kategorie werden geprüft.\n");
    const preparation = await agent.TOOLS.ka_prepare_listing.fn(expectedListing);
    if (preparation?.status !== "ready" || !preparation.preparationId) {
      const code = preparation?.diagnostic?.code || preparation?.status || "UNKNOWN";
      throw new Error(`Die sichtbare Vorbereitung ist nicht bereit (${code}).`);
    }
    const draftArgs = await agent.TOOLS.ka_save_prepared_draft.prepareForApproval({
      preparationId: preparation.preparationId,
    });

    process.stdout.write("2/4 Drei Bilder werden hochgeladen und der Entwurf wird über den Go-Broker gespeichert.\n");
    const saveOperation = await runApprovedAction(
      agent,
      broker,
      chatId,
      "ka_save_prepared_draft",
      draftArgs,
      gateway
    );
    createdDraftId = saveOperation.remoteId;
    if (!createdDraftId) throw new Error("Der abgeschlossene Draft-Vorgang enthält keine Entwurfs-ID.");

    process.stdout.write("3/4 Ein unabhängiger Read verifiziert Inhalt, Kategorie, Preis und drei Bilder.\n");
    const afterCreate = await pollDrafts(
      readDrafts,
      drafts => drafts.some(draft => String(draft.id) === String(createdDraftId))
    );
    const created = verifiedCreatedDraft(
      beforeDrafts,
      afterCreate,
      expectedListing,
      createdDraftId
    );

    process.stdout.write("4/4 Genau dieser Entwurf wird über einen zweiten Go-Vorgang gelöscht und erneut gelesen.\n");
    const deleteArgs = agent.TOOLS.ka_delete_draft.prepare({ draftId: String(created.id) });
    await runApprovedAction(
      agent,
      broker,
      chatId,
      "ka_delete_draft",
      deleteArgs,
      gateway
    );
    const afterDelete = await pollDrafts(
      readDrafts,
      drafts => !drafts.some(draft => String(draft.id) === String(created.id))
    );
    cleaned = !afterDelete.some(draft => String(draft.id) === String(created.id));
    if (!cleaned) throw new Error("Der erstellte Entwurf ist nach dem Cleanup noch vorhanden.");

    process.stdout.write(`${[
      "Kleinanzeigen Draft-E2E OK",
      `category=${created.categoryId}`,
      `images=${created.images}`,
      "approval=2x-go",
      "cleanup=verified",
      "published=no",
    ].join(" | ")}\n`);
  } finally {
    agent.clearPending(chatId);
    await discardPreparedFormSession().catch(() => {});
    if (!cleaned) {
      try {
        const drafts = await agent.requireAuthenticatedKa().getDrafts();
        if (!createdDraftId && expectedListing) {
          const candidates = newDraftsSince(beforeDrafts, drafts).filter(draft => (
            String(draft.title || "").trim() === expectedListing.title
          ));
          if (candidates.length === 1) createdDraftId = String(candidates[0].id);
        }
        if (drafts.some(draft => String(draft.id) === String(createdDraftId))) {
          await agent.requireAuthenticatedKa().deleteDraft(String(createdDraftId));
          const remaining = await agent.requireAuthenticatedKa().getDrafts();
          cleaned = !remaining.some(draft => String(draft.id) === String(createdDraftId));
        }
      } catch (cleanupError) {
        console.error(`Cleanup erforderlich: ${cleanupError.message}`);
      }
    }
    if (releaseLock) releaseLock();
    store.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(`Kleinanzeigen Draft-E2E fehlgeschlagen: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  CONFIRM_FLAG,
  assertNaturalExternalContent,
  main,
  naturalListing,
  newDraftsSince,
  requireExplicitConfirmation,
  verifiedCreatedDraft,
};
