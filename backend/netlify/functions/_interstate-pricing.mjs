export function calculateInterstatePrice(distanceMeters, pricing, serviceTier = "standard") {
 if (!Number.isFinite(distanceMeters) || distanceMeters <= 0) {
  throw new Error("A valid road-route distance is required to price this delivery.");
 }
 if (!pricing || !Array.isArray(pricing.distance_bands) || pricing.distance_bands.length === 0) {
  throw new Error("A published interstate pricing schedule is unavailable.");
 }
 if (!["standard","express"].includes(serviceTier)) {
  throw new Error("Select a valid interstate delivery service.");
 }
 const distanceKm=distanceMeters/1000;
 if (pricing.maximum_distance_km!==null&&pricing.maximum_distance_km!==undefined&&
    Number.isFinite(Number(pricing.maximum_distance_km))&&distanceKm>Number(pricing.maximum_distance_km)) {
  throw new Error("This route exceeds the maximum distance in the published pricing schedule.");
 }
 const bands=pricing.distance_bands;
 let lower=0,charge=0;
 const appliedBands=[];
 for(let index=0;index<bands.length;index++){
  const band=bands[index];
  const rate=Number(band?.rate_per_km);
  const upper=band?.up_to_km===null?null:Number(band?.up_to_km);
  if(!Number.isFinite(rate)||rate<0||
    (upper!==null&&(!Number.isFinite(upper)||upper<=lower))||
    (upper===null&&index!==bands.length-1)||
    (upper!==null&&index===bands.length-1)) {
   throw new Error("The published pricing schedule has invalid or incomplete distance bands.");
  }
  const segmentKm=Math.max(0,Math.min(distanceKm,upper===null?distanceKm:upper)-lower);
  const segmentCharge=segmentKm*rate;
  charge+=segmentCharge;
  appliedBands.push({fromKm:lower,toKm:upper===null?distanceKm:Math.min(distanceKm,upper),ratePerKm:rate,amount:segmentCharge});
  if(upper===null||distanceKm<=upper)break;
  lower=upper;
 }
 const lastBand=bands[bands.length-1];
 if(lastBand.up_to_km!==null&&distanceKm>Number(lastBand.up_to_km)) {
  throw new Error("This route exceeds the configured distance bands.");
 }
 const baseFare=Number(pricing.base_fare),minimumFare=Number(pricing.minimum_fare);
 const operatingCostFloor=Number(pricing.operating_cost_floor);
 const premium=serviceTier==="express"?Number(pricing.express_premium_percent):0;
 if(!Number.isFinite(baseFare)||baseFare<0||!Number.isFinite(minimumFare)||minimumFare<0||
    !Number.isFinite(operatingCostFloor)||operatingCostFloor<=0||
    !Number.isFinite(premium)||premium<0) {
  throw new Error("The published pricing schedule is incomplete or has no validated operating-cost floor.");
 }
 const subtotal=baseFare+charge;
 const expressAmount=Math.round(subtotal*premium/100);
 const calculatedPrice=Math.max(minimumFare,Math.round(subtotal+expressAmount));
 if(calculatedPrice<operatingCostFloor) {
  throw new Error("The calculated quote is below the configured operating-cost floor; request an Operations review.");
 }
 return {
  price:calculatedPrice,
  breakdown:{
   baseFare,
   distanceKm:Number(distanceKm.toFixed(2)),
   appliedBands:appliedBands.map(band=>({...band,amount:Math.round(band.amount)})),
   distanceCharge:Math.round(charge),
   expressPremiumPercent:premium,
   expressPremiumAmount:expressAmount,
   minimumFare,
   operatingCostFloor,
   total:calculatedPrice
  }
 };
}
