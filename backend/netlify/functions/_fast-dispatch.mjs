const activeStatuses = ["accepted", "picked_up", "on_the_way", "at_door", "delivered"];
const routeCheckFreshMs = 120_000;
const locationFreshMs = 120_000;
const directionsUrl = "https://api.openrouteservice.org/v2/directions/driving-car/geojson";
const queryPageSize = 1000;

const validPoint = (lat, lng) =>
  lat !== null && lat !== undefined && lat !== "" &&
  lng !== null && lng !== undefined && lng !== "" &&
  Number.isFinite(Number(lat)) && Number(lat) >= -90 && Number(lat) <= 90 &&
  Number.isFinite(Number(lng)) && Number(lng) >= -180 && Number(lng) <= 180;

export async function readAllRows(query) {
  const rows = [];
  for (let offset = 0; ; offset += queryPageSize) {
    const {data, error} = await query.range(offset, offset + queryPageSize - 1);
    if (error) return {data: null, error};
    const page = data || [];
    rows.push(...page);
    if (page.length < queryPageSize) return {data: rows, error: null};
  }
}

export function compatibleVehicle(riderVehicle, orderVehicle) {
  const rider = String(riderVehicle || "").trim().toLowerCase();
  const order = String(orderVehicle || "").trim().toLowerCase();
  if (["bike", "motorcycle"].includes(order)) return ["bike", "motorcycle"].includes(rider);
  if (["car", "van"].includes(order)) return rider === order;
  if (["truck", "lorry"].includes(order)) return ["truck", "lorry"].includes(rider);
  return false;
}

export function fastPickupRouteStatus(etaMinutes, maxPickupMinutes) {
  if (!Number.isInteger(etaMinutes) || etaMinutes < 0 ||
      !Number.isInteger(maxPickupMinutes) || maxPickupMinutes < 1) return "unavailable";
  return etaMinutes <= maxPickupMinutes ? "eligible" : "too_far";
}

async function routeMinutes(fetchImpl, apiKey, from, to) {
  if (!apiKey || !validPoint(from.lat, from.lng) || !validPoint(to.lat, to.lng)) return null;
  const response = await fetchImpl(directionsUrl, {
    method: "POST",
    headers: {Authorization: apiKey, "Content-Type": "application/json"},
    body: JSON.stringify({
      coordinates: [[Number(from.lng), Number(from.lat)], [Number(to.lng), Number(to.lat)]],
      instructions: false,
    }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) {
    console.error("OpenRouteService rejected fast pickup ETA request", {status: response.status});
    return null;
  }
  const seconds = (await response.json()).features?.[0]?.properties?.summary?.duration;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0
    ? Math.ceil(seconds / 60)
    : null;
}

async function saveRouteCheck(db, offer, status, etaMinutes, checkedAt) {
  const {error} = await db.from("rider_offers")
    .update({
      route_check_status: status,
      pickup_eta_minutes: etaMinutes,
      route_checked_at: checkedAt,
    })
    .eq("id", offer.id)
    .eq("status", "offered");
  if (error) throw new Error(`Could not save fast pickup route check: ${error.message}`);
}

async function addRouteAlert(db, order) {
  const {data:existing, error:lookupError} = await db.from("dispatch_alerts")
    .select("id")
    .eq("order_id", order.id)
    .eq("alert_type", "fast_pickup_unavailable")
    .is("resolved_at", null)
    .limit(1);
  if (lookupError) throw new Error(`Could not inspect fast dispatch alerts: ${lookupError.message}`);
  if (existing?.length) return;
  const {error} = await db.from("dispatch_alerts").insert({
    order_id: order.id,
    alert_type: "fast_pickup_unavailable",
    details: "No compatible online rider currently has a verified pickup route within the configured fast-service window. The paid delivery remains pending.",
  });
  if (error) throw new Error(`Could not record fast dispatch alert: ${error.message}`);
}

async function resolveRouteAlert(db, orderId, resolvedAt) {
  const {error} = await db.from("dispatch_alerts")
    .update({resolved_at: resolvedAt})
    .eq("order_id", orderId)
    .eq("alert_type", "fast_pickup_unavailable")
    .is("resolved_at", null);
  if (error) throw new Error(`Could not resolve fast dispatch alert: ${error.message}`);
}

export async function refreshFastOfferRouteChecks(
  db,
  {fetchImpl = fetch, apiKey = process.env.ORS_API_KEY, riderId = null, now = Date.now()} = {},
) {
  const checkedAt = new Date(now).toISOString();
  const [{data:offers,error:offerError},{data:orders,error:orderError},{data:riders,error:riderError},{data:settings,error:settingsError}] =
    await Promise.all([
      readAllRows(db.from("rider_offers")
        .select("id,order_id,rider_id,route_check_status,pickup_eta_minutes,route_checked_at")
        .eq("status", "offered")
        .order("offered_at", {ascending: true})
        .order("id", {ascending: true})),
      readAllRows(db.from("orders")
        .select("id,tracking_number,vehicle_type,pickup_latitude,pickup_longitude,status,payment_status,rider_id,delivery_speed")
        .eq("delivery_speed", "fast")
        .eq("payment_status", "paid")
        .in("status", ["paid", "searching"])
        .is("rider_id", null)
        .order("id", {ascending: true})),
      readAllRows(db.from("riders")
        .select("id,vehicle_type,is_online,approval_status,lat,lng,last_seen_at")
        .eq("approval_status", "approved")
        .eq("is_online", true)
        .order("id", {ascending: true})),
      db.from("delivery_service_rules")
        .select("pickup_deadline_minutes")
        .eq("delivery_speed", "fast")
        .maybeSingle(),
    ]);
  if (offerError) throw new Error(`Could not load outstanding fast offers: ${offerError.message}`);
  if (orderError) throw new Error(`Could not load pending fast deliveries: ${orderError.message}`);
  if (riderError) throw new Error(`Could not load online riders for fast dispatch: ${riderError.message}`);
  if (settingsError) throw new Error(`Could not load fast delivery timing rules: ${settingsError.message}`);
  if (!Number.isInteger(settings?.pickup_deadline_minutes) || settings.pickup_deadline_minutes < 1) {
    throw new Error("Fast delivery pickup timing rules are not configured.");
  }

  const orderById = new Map((orders || []).map(order => [order.id, order]));
  const riderById = new Map((riders || []).map(rider => [rider.id, rider]));
  const offerGroups = new Map();
  let updated = 0, routeBudget = riderId ? 100 : 30;

  for (const offer of offers || []) {
    const order = orderById.get(offer.order_id);
    if (!order || order.payment_status !== "paid" || order.rider_id || !["paid", "searching"].includes(order.status)) continue;
    const rider = riderById.get(offer.rider_id);
    if (!rider || !compatibleVehicle(rider.vehicle_type, order.vehicle_type)) continue;
    const checks = offerGroups.get(order.id) || [];
    checks.push(offer);
    offerGroups.set(order.id, checks);
    if (riderId && offer.rider_id !== riderId) continue;

    const lastChecked = offer.route_checked_at ? Date.parse(offer.route_checked_at) : 0;
    if (Number.isFinite(lastChecked) && now - lastChecked >= 0 && now - lastChecked < routeCheckFreshMs) continue;
    if (routeBudget <= 0) continue;
    routeBudget--;

    const locationAt = rider.last_seen_at ? Date.parse(rider.last_seen_at) : NaN;
    const locationFresh = Number.isFinite(locationAt) && now - locationAt >= 0 && now - locationAt <= locationFreshMs &&
      validPoint(rider.lat, rider.lng);
    let etaMinutes = null;
    if (locationFresh) {
      try {
        etaMinutes = await routeMinutes(
          fetchImpl,
          apiKey,
          {lat: rider.lat, lng: rider.lng},
          {lat: order.pickup_latitude, lng: order.pickup_longitude},
        );
      } catch (error) {
        console.error("Could not calculate fast pickup route ETA", error.message);
      }
    }
    const status = fastPickupRouteStatus(etaMinutes, settings.pickup_deadline_minutes);
    await saveRouteCheck(db, offer, status, etaMinutes, checkedAt);
    offer.route_check_status = status;
    offer.pickup_eta_minutes = etaMinutes;
    offer.route_checked_at = checkedAt;
    updated++;
  }

  for (const [orderId, candidates] of offerGroups) {
    const checkedCandidates = candidates.filter(candidate => {
      const time = candidate.route_checked_at ? Date.parse(candidate.route_checked_at) : NaN;
      return candidate.route_check_status && Number.isFinite(time) && now - time >= 0 && now - time < routeCheckFreshMs;
    });
    if (checkedCandidates.length !== candidates.length) continue;
    const order = orderById.get(orderId);
    if (checkedCandidates.every(candidate => ["too_far", "unavailable"].includes(candidate.route_check_status))) {
      await addRouteAlert(db, order);
    } else if (checkedCandidates.some(candidate => candidate.route_check_status === "eligible")) {
      await resolveRouteAlert(db, orderId, checkedAt);
    }
  }
  return updated;
}
