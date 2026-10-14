import test from "node:test";
import assert from "node:assert/strict";
import {calculatePriceForDeliverySpeed, calculateSuggestedPrice, resolvePackageSelection} from "../netlify/functions/_package-selection.mjs";

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

test("standard parcel prices have a ₦1,500 minimum and scale by road distance", () => {
  assert.equal(calculateSuggestedPrice(1200, "small"), 1500);
  assert.equal(calculateSuggestedPrice(5000, "medium"), 1500);
  assert.equal(calculateSuggestedPrice(10000, "small"), 2250);
});

test("large and bulky delivery prices are four times the standard route price", () => {
  assert.equal(calculateSuggestedPrice(1200, "large"), 6000);
  assert.equal(calculateSuggestedPrice(10000, "very_large"), 9000);
});

test("fast delivery doubles the standard quote without adding a flat surcharge", () => {
  assert.equal(calculatePriceForDeliverySpeed(1500, "standard"), 1500);
  assert.equal(calculatePriceForDeliverySpeed(1500, "fast"), 3000);
  assert.equal(calculatePriceForDeliverySpeed(2250, "fast"), 4500);
  assert.throws(() => calculatePriceForDeliverySpeed(-1, "fast"), /standard delivery price/);
  assert.throws(() => calculatePriceForDeliverySpeed(2000, "priority"), /valid delivery speed/);
});

test("1.2 km examples match the published ₦1,500-minimum standard, bulky and fast prices", () => {
  const standard = calculateSuggestedPrice(1200, "small");
  assert.equal(standard, 1500);
  assert.equal(calculateSuggestedPrice(1200, "large"), 6000);
  assert.equal(calculatePriceForDeliverySpeed(standard, "fast"), 3000);
});
