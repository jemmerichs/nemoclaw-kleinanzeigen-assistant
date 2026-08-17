"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { readVisibleFormControls } = require("../tools/kleinanzeigen-form-state");

test("visible form state reads the current readonly city field without a name attribute", () => {
  const controls = {
    categoryId: { value: "82" },
    zipCode: { value: "80636" },
    locationId: { value: "16360" },
    contactName: { value: "Jannik" },
  };
  const city = { id: "ad-city", value: "Neuhausen-Nymphenburg - Neuhausen" };
  const locationLabel = { textContent: "Ort", control: city };
  const root = {
    querySelector(selector) {
      const named = selector.match(/^input\[name="([^"]+)"\]$/);
      if (named) return controls[named[1]] || null;
      if (selector === "#ad-city") return city;
      return null;
    },
    querySelectorAll(selector) {
      return selector === "label[for]" ? [locationLabel] : [];
    },
  };

  assert.deepEqual(readVisibleFormControls(root), {
    categoryId: "82",
    zipCode: "80636",
    locationId: "16360",
    locationName: "Neuhausen-Nymphenburg - Neuhausen",
    contactName: "Jannik",
  });
});
