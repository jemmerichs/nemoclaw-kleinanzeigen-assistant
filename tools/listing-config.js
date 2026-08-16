"use strict";

function kleinanzeigenListingConfig(env = process.env) {
  const zipCode = String(env.KA_DEFAULT_ZIP_CODE || "").trim();
  const locationId = String(env.KA_DEFAULT_LOCATION_ID || "").trim();
  const contactName = String(env.KA_CONTACT_NAME || "").trim();
  const problems = [];

  if (!/^\d{5}$/.test(zipCode) || zipCode === "00000") {
    problems.push("gültige Standard-PLZ");
  }
  if (!locationId) {
    problems.push("interne Kleinanzeigen-Orts-ID");
  } else if (locationId.length > 50) {
    problems.push("gültige interne Kleinanzeigen-Orts-ID");
  } else if (zipCode && locationId === zipCode) {
    problems.push("eigenständige Kleinanzeigen-Orts-ID (nicht die PLZ)");
  }
  if (!contactName) {
    problems.push("Profilname");
  } else if (contactName.length > 30) {
    problems.push("gültiger Profilname (maximal 30 Zeichen)");
  }

  return {
    ready: problems.length === 0,
    zipCode,
    locationId,
    contactName,
    problems,
  };
}

module.exports = { kleinanzeigenListingConfig };
