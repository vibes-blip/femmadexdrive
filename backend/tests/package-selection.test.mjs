import test from "node:test";
import assert from "node:assert/strict";
import {calculateSuggestedPrice, resolvePackageSelection} from "../netlify/functions/_package-selection.mjs";

test("books with a package category and no measurements", () => {
  const selection = resolvePackageSelection({packageCategory: "small"});
  assert.equal(selection.packageCategory, "small");
  assert.equal(selection.packageSize, "small");
  assert.equal(selection.vehicleType, "motorcycle");
  assert.deepEqual(selection.measurements, {
    weightKg: null,
    lengthCm: null,
    widthCm: null,
    heightCm: null
  });
  assert.equal(selection.requiresManualReview, true);
});

test("medium and bulky categories use provisional vehicles and need inspection", () => {
  const medium = resolvePackageSelection({packageCategory: "medium"});
  const bulky = resolvePackageSelection({packageCategory: "bulky"});
  assert.equal(medium.vehicleType, "car");
  assert.equal(bulky.vehicleType, "van");
  assert.equal(medium.requiresManualReview, true);
  assert.equal(bulky.requiresManualReview, true);
});

test("legacy size requests and existing measurements remain supported", () => {
  const legacy = resolvePackageSelection({
    size: "large",
    weightKg: "20",
    lengthCm: "80",
    widthCm: "50",
    heightCm: "40"
  });
  assert.equal(legacy.packageCategory, "bulky");
  assert.equal(legacy.packageSize, "very_large");
  assert.equal(legacy.vehicleType, "lorry");
  assert.deepEqual(legacy.measurements, {weightKg: 20, lengthCm: 80, widthCm: 50, heightCm: 40});
  assert.deepEqual(
    resolvePackageSelection({size: "small", weightKg: 0, lengthCm: 0, widthCm: 0, heightCm: 0}).measurements,
    {weightKg: null, lengthCm: null, widthCm: null, heightCm: null}
  );
});

test("rejects invalid category, measurements and missing route distance", () => {
  assert.throws(() => resolvePackageSelection({packageCategory: "unknown"}), /valid package category/);
  assert.throws(() => resolvePackageSelection({packageCategory: "unknown", size: "small"}), /valid package category/);
  assert.throws(() => resolvePackageSelection({packageCategory: "small", weightKg: -1}), /non-negative/);
  assert.throws(() => calculateSuggestedPrice(Number.NaN, "small"), /valid calculated route distance/);
  assert.throws(() => calculateSuggestedPrice(1000, "unknown"), /valid package size/);
});

test("package size changes only the suggested quote amount", () => {
  assert.equal(calculateSuggestedPrice(5000, "small"), 2000);
  assert.equal(calculateSuggestedPrice(5000, "medium"), 2500);
  assert.equal(calculateSuggestedPrice(5000, "large"), 3000);
});

test("original route pricing and package adjustments remain unchanged", () => {
  assert.equal(calculateSuggestedPrice(10000, "small"), 2250);
  assert.equal(calculateSuggestedPrice(10000, "medium"), 2750);
  assert.equal(calculateSuggestedPrice(10000, "large"), 3250);
  assert.equal(calculateSuggestedPrice(1000, "small"), 2000);
});
