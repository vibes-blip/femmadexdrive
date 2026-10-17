import { sb, json, body, err, userFromRequest, HttpError } from "./_lib.mjs";
import { isCurrentAssignedRiderDelivery, isCurrentCustomerDelivery } from "./_rider-location-security.mjs";

const ORS_DIRECTIONS_URL = "https://api.openrouteservice.org/v2/directions/driving-car/geojson";

export default async request => {
  if (request.method === "OPTIONS") return new Response("", { status: 204 });
  try {
    const user = await userFromRequest(request);
    const input = await body(request);
    if (typeof input?.orderId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.orderId)) {
      throw new HttpError("Delivery location is unavailable.", 404);
    }

    const db = sb();
    const { data: order, error: orderError } = await db.from("orders")
      .select("customer_id,rider_id,status,journey_type,origin_station_snapshot,pickup_latitude,pickup_longitude,dropoff_latitude,dropoff_longitude")
      .eq("id", input.orderId)
      .maybeSingle();
    if (orderError) {
      console.error("Could not verify customer delivery for location lookup", orderError.message);
      throw new HttpError("Delivery location is temporarily unavailable.", 503);
    }
    const customerRequest = isCurrentCustomerDelivery(order, user.id);
    const riderRequest = isCurrentAssignedRiderDelivery(order, user.id);
    if (!customerRequest && !riderRequest) {
      throw new HttpError("Delivery location is unavailable.", 404);
    }

    const { data: rider, error: riderError } = await db.from("riders")
      .select("id,lat,lng,last_seen_at,approval_status")
      .eq("id", order.rider_id)
      .maybeSingle();
    if (riderError) {
      console.error("Could not load authorized rider location", riderError.message);
      throw new HttpError("Delivery location is temporarily unavailable.", 503);
    }
    if (!rider || rider.id !== order.rider_id || rider.approval_status !== "approved") {
      throw new HttpError("Delivery location is unavailable.", 404);
    }
    const locationAge = rider?.last_seen_at ? Date.now() - new Date(rider.last_seen_at).getTime() : Infinity;
    const hasCurrentLocation =
      Number.isFinite(Number(rider?.lat)) &&
      Number.isFinite(Number(rider?.lng)) &&
      Number.isFinite(locationAge) &&
      locationAge >= 0 &&
      locationAge <= 90_000;
    if (!hasCurrentLocation) {
      return json({
        location: null,
        etaMinutes: null,
        etaStatus: "Rider location is not currently available.",
        etaTarget: customerRequest ? (order.journey_type==="interstate"?"origin terminal":"recipient") : "pickup",
      });
    }

    const location = {
      latitude: Number(rider.lat),
      longitude: Number(rider.lng),
      updatedAt: rider.last_seen_at,
    };
    const interstateOrigin=order.journey_type==="interstate"?order.origin_station_snapshot:null;
    const target = customerRequest
      ? interstateOrigin
        ? {latitude:interstateOrigin.latitude,longitude:interstateOrigin.longitude}
        : { latitude: order.dropoff_latitude, longitude: order.dropoff_longitude }
      : { latitude: order.pickup_latitude, longitude: order.pickup_longitude };
    const etaTarget=customerRequest?(interstateOrigin?"origin terminal":"recipient"):"pickup";
    if (!process.env.ORS_API_KEY ||
        !Number.isFinite(Number(target.latitude)) ||
        !Number.isFinite(Number(target.longitude))) {
      return json({
        location,
        etaMinutes: null,
        etaStatus: "Route estimate is unavailable.",
        etaTarget,
      });
    }

    let routeResponse;
    try {
      routeResponse = await fetch(ORS_DIRECTIONS_URL, {
        method: "POST",
        headers: { Authorization: process.env.ORS_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          coordinates: [
            [location.longitude, location.latitude],
            [Number(target.longitude), Number(target.latitude)],
          ],
          instructions: false,
        }),
      });
    } catch (error) {
      console.error("Authorized rider route request failed", error.message);
      return json({
        location,
        etaMinutes: null,
        etaStatus: "Route estimate is temporarily unavailable.",
        etaTarget,
      });
    }
    if (!routeResponse.ok) {
      console.error("Route provider rejected authorized rider route request", { status: routeResponse.status });
      return json({
        location,
        etaMinutes: null,
        etaStatus: "Route estimate is temporarily unavailable.",
        etaTarget,
      });
    }

    let durationSeconds;
    try {
      durationSeconds = (await routeResponse.json()).features?.[0]?.properties?.summary?.duration;
    } catch (error) {
      console.error("Route provider returned invalid authorized rider route response", error.message);
      return json({
        location,
        etaMinutes: null,
        etaStatus: "Route estimate is temporarily unavailable.",
        etaTarget,
      });
    }
    if (typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds) || durationSeconds < 0) {
      return json({
        location,
        etaMinutes: null,
        etaStatus: "Route estimate is temporarily unavailable.",
        etaTarget,
      });
    }

    return json({
      location,
      etaMinutes: Math.ceil(durationSeconds / 60),
      etaStatus: "OpenRouteService route estimate; traffic conditions may differ.",
      etaTarget,
    });
  } catch (error) {
    return err(error);
  }
};
