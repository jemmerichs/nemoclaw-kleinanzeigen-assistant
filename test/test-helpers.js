"use strict";

const { normalizeFormState } = require("../tools/kleinanzeigen-form-state");

function withBoundKleinanzeigenForm(listing, overrides = {}) {
  const zipCode = overrides.zipCode || listing.zipCode || "80636";
  const contactName = overrides.contactName || listing.contactName || "Jannik";
  return {
    ...listing,
    ...normalizeFormState({
      categoryId: listing.categoryId,
      zipCode,
      locationId: overrides.locationId || listing.locationId || "16360",
      locationName: overrides.locationName || listing.locationName || "Testort",
      contactName,
      sessionRevision: overrides.sessionRevision || listing.sessionRevision || "test-session",
    }),
    contactName,
  };
}

module.exports = { withBoundKleinanzeigenForm };
