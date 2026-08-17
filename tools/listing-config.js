"use strict";

function kleinanzeigenListingConfig(env = process.env) {
  const zipCode = String(env.KA_DEFAULT_ZIP_CODE || "").trim();
  const contactName = String(env.KA_CONTACT_NAME || "").trim();
  const problems = [];

  if (!/^\d{5}$/.test(zipCode) || zipCode === "00000") {
    problems.push("gültige Standard-PLZ");
  }
  if (!contactName) {
    problems.push("Profilname");
  } else if (contactName.length > 30) {
    problems.push("gültiger Profilname (maximal 30 Zeichen)");
  }

  return {
    ready: problems.length === 0,
    zipCode,
    contactName,
    problems,
  };
}

module.exports = { kleinanzeigenListingConfig };
