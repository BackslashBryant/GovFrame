import assert from "node:assert/strict";
import test from "node:test";

import librarySearchArtifact from "../../data/generated/library-search.json";

import { HOME_LIBRARY_DISCOVERY } from "../../src/ui/lib/homeTagConstellation";
import { rawTypesForKind } from "../../src/ui/lib/informationArchitecture";

const browseCounts = librarySearchArtifact.library_search.browse_counts;

test("Home Library discovery follows the practitioner sequence, not record volume", () => {
  assert.equal(HOME_LIBRARY_DISCOVERY.length, 5);
  // Ordered the way the work runs — what applies, what it requires, how it is
  // checked, how it is built, what it defends against — not by record count.
  assert.deepEqual(
    HOME_LIBRARY_DISCOVERY.map((item) => item.id),
    [
      "requirements",
      "baselines-profiles",
      "process-methods",
      "technical-rules",
      "threats-defenses",
    ],
  );

  for (const item of HOME_LIBRARY_DISCOVERY) {
    assert.ok(item.count > 0, `${item.id} resolves to records`);
    assert.ok(item.patch.kind, `${item.id} filters the Library by one published record kind`);
    assert.ok(item.question.length > 0, `${item.id} states the question it answers`);
  }
});

test("every Home card filters by record kind, never by technology tag", () => {
  // Mixing record kinds with technology tags in one row put two unrelated
  // taxonomies side by side and made the group impossible to reason about.
  for (const item of HOME_LIBRARY_DISCOVERY) {
    assert.equal(item.patch.tags, undefined, `${item.id} must not filter by tag`);
  }
});

test("Home Library discovery counts come directly from the Library browse artifact", () => {
  // Refreshed publisher inventories change these totals. The exact contract is
  // agreement with the current browse artifact; ordering and nonempty groups
  // are checked above, and source admission gates the underlying inventory.
  for (const item of HOME_LIBRARY_DISCOVERY) {
    const expected = rawTypesForKind(item.patch.kind as string).reduce(
      (total, rawType) =>
        total +
        Number(
          browseCounts.object_types[rawType as keyof typeof browseCounts.object_types] || 0,
        ),
      0,
    );
    assert.equal(item.count, expected, item.id);
  }
});
