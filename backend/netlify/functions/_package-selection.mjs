const packageCategories = new Set(["small", "medium", "bulky"]);

const optionalAmount = (value, name) => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "number" && typeof value !== "string") {
    throw new Error(`${name} must be a valid non-negative number.`);
  }
  if (typeof value === "string" && !value.trim()) return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error(`${name} must be a valid non-negative number.`);
  }
  return amount === 0 ? null : amount;
};

const packageSizeForWeight = weight =>
  weight <= 2 ? "small" : weight <= 5 ? "medium" : weight <= 10 ? "large" : "very_large";

const categoryFromLegacySize = size => {
  if (size === "small") return "small";
  if (size === "medium") return "medium";
  if (size === "large" || size === "very_large") return "bulky";
  return null;
};

export function resolvePackageSelection(request) {
  const packageCategory = request.packageCategory === undefined || request.packageCategory === null
    ? categoryFromLegacySize(request.size)
    : packageCategories.has(request.packageCategory) ? request.packageCategory : null;
  if (!packageCategory) throw new Error("Select a valid package category.");

  const weightKg = optionalAmount(request.weightKg, "Package weight");
  const lengthCm = optionalAmount(request.lengthCm, "Package length");
  const widthCm = optionalAmount(request.widthCm, "Package width");
  const heightCm = optionalAmount(request.heightCm, "Package height");
  if ([weightKg, lengthCm, widthCm, heightCm].some(value => value !== null && value > 10000)
      || (weightKg !== null && weightKg > 1000)) {
    throw new Error("Package weight or dimensions are outside the supported range.");
  }

  const hasAnyMeasurement = [weightKg, lengthCm, widthCm, heightCm].some(value => value !== null);
  const hasCompleteDimensions = [lengthCm, widthCm, heightCm].every(value => value !== null && value > 0);
  const volume = hasCompleteDimensions ? lengthCm * widthCm * heightCm : 0;
  let packageSize = packageCategory === "bulky"
    ? (!request.packageCategory && request.size === "very_large" ? "very_large" : "large")
    : packageCategory;

  if (weightKg !== null && weightKg > 0) packageSize = packageSizeForWeight(weightKg);
  if (volume > 1_000_000) packageSize = "very_large";
  else if (volume > 250_000 && packageSize !== "very_large") packageSize = "large";
  else if (volume > 60_000 && packageSize === "small") packageSize = "medium";

  const measuredVehicle =
    weightKg > 250 || packageSize === "very_large" ? "lorry" :
      weightKg > 50 || packageSize === "large" ? "van" :
        weightKg > 12 || packageSize === "medium" ? "car" : "motorcycle";
  const vehicleType = hasAnyMeasurement
    ? measuredVehicle
    : !request.packageCategory && request.size === "very_large" ? "lorry" :
      packageCategory === "small" ? "motorcycle" :
        packageCategory === "medium" ? "car" : "van";

  return {
    packageCategory,
    packageSize,
    vehicleType,
    measurements: {weightKg, lengthCm, widthCm, heightCm},
    requiresManualReview:
      !hasAnyMeasurement || !hasCompleteDimensions || weightKg === null ||
      weightKg > 10 || packageCategory === "bulky" || packageSize === "very_large"
  };
}

export function calculateSuggestedPrice(distanceMeters, packageSize) {
  if (!Number.isFinite(distanceMeters) || distanceMeters < 0) {
    throw new Error("A valid calculated route distance is required to price this delivery.");
  }
  if (!["small", "medium", "large", "very_large"].includes(packageSize)) {
    throw new Error("A valid package size is required to price this delivery.");
  }
  const distanceKm = distanceMeters / 1000;
  const distanceCharge = Math.max(0, distanceKm - 5) * 150;
  const packageAdjustment = packageSize === "small" ? 0 : packageSize === "medium" ? 500 : 1000;
  return Math.max(2000, Math.round(1500 + distanceCharge)) + packageAdjustment;
}
