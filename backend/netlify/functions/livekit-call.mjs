import { AccessToken, TrackSource } from "livekit-server-sdk";
import { sb, json, body, err, userFromRequest } from "./_lib.mjs";

const activeOrderStatuses = new Set([
  "paid", "accepted", "picked_up", "on_the_way", "at_door", "delivered",
]);
const terminalStates = new Set(["ended", "declined", "missed", "failed"]);

const issueToken = async (identity, displayName, roomName) => {
  const { LIVEKIT_API_KEY: apiKey, LIVEKIT_API_SECRET: apiSecret, LIVEKIT_URL: serverUrl } = process.env;
  if (!apiKey || !apiSecret || !serverUrl || !serverUrl.startsWith("wss://")) {
    throw new Error("Voice calls are not configured on the server yet.");
  }
  const token = new AccessToken(apiKey, apiSecret, { identity, name: displayName || identity, ttl: "10m" });
  token.addGrant({ roomJoin: true, room: roomName, canPublishSources: [TrackSource.MICROPHONE], canPublishData: true, canSubscribe: true });
  return { token: await token.toJwt(), serverUrl };
};

export default async (req) => {
  if (req.method === "OPTIONS") return new Response("", { status: 204 });
  try {
    const user = await userFromRequest(req);
    const input = await body(req);
    const db = sb();
    const action = String(input.action || "");

    if (action === "start") {
      const { data: order, error: orderError } = await db.from("orders")
        .select("id,customer_id,rider_id,status").eq("id", input.orderId).maybeSingle();
      if (orderError) throw orderError;
      if (!order || !order.rider_id || !activeOrderStatuses.has(order.status)) {
        throw new Error("Voice calls are available once a rider is assigned to an active delivery.");
      }
      if (![order.customer_id, order.rider_id].includes(user.id)) {
        throw new Error("Only this delivery's customer and assigned rider can call.");
      }
      const { data: activeCall, error: activeCallError } = await db.from("call_logs")
        .select("id,status,started_at").eq("order_id", order.id)
        .in("status", ["ringing", "answered"]).limit(1).maybeSingle();
      if (activeCallError) throw activeCallError;
      if (activeCall?.status === "ringing" && Date.now() - new Date(activeCall.started_at).getTime() > 45_000) {
        const { error } = await db.from("call_logs").update({ status: "missed", ended_at: new Date().toISOString(), duration_seconds: 0 })
          .eq("id", activeCall.id).eq("status", "ringing");
        if (error) throw error;
      } else if (activeCall) {
        throw new Error("There is already a call in progress for this delivery.");
      }
      if (!process.env.LIVEKIT_URL || !process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET) {
        throw new Error("Voice calling is not configured on the server yet.");
      }

      const receiverId = user.id === order.customer_id ? order.rider_id : order.customer_id;
      const roomName = `delivery-${order.id}`;
      const { data: profile } = await db.from("profiles").select("full_name,email").eq("id", user.id).maybeSingle();
      const liveKitToken = await issueToken(user.id, profile?.full_name || user.email, roomName);
      const { data: room, error: roomError } = await db.from("chat_rooms").upsert({
        order_id: order.id, customer_id: order.customer_id, rider_id: order.rider_id,
        status: "active", closed_at: null,
      }, { onConflict: "order_id" }).select("id").single();
      if (roomError) throw roomError;
      const { data: call, error: callError } = await db.from("call_logs").insert({
        order_id: order.id, caller_id: user.id, receiver_id: receiverId,
        call_type: "voip", status: "ringing",
      }).select("id,order_id,caller_id,receiver_id,status,started_at").single();
      if (callError?.code === "23505") throw new Error("There is already a call in progress for this delivery.");
      if (callError) throw callError;
      return json({ call, roomId: room.id, roomName, ...liveKitToken });
    }

    if (!["answer", "decline", "end", "timeout"].includes(action) || !input.callId) throw new Error("Invalid call request.");
    const { data: call, error: callError } = await db.from("call_logs")
      .select("id,order_id,caller_id,receiver_id,status,started_at,answered_at").eq("id", input.callId).maybeSingle();
    if (callError) throw callError;
    if (!call || ![call.caller_id, call.receiver_id].includes(user.id)) throw new Error("Call not found or you are not a participant.");
    const { data: order, error: orderError } = await db.from("orders")
      .select("id,customer_id,rider_id,status").eq("id", call.order_id).maybeSingle();
    if (orderError) throw orderError;
    if (!order || ![order.customer_id, order.rider_id].includes(user.id)) throw new Error("You are no longer a participant in this delivery.");
    if (action === "answer" && !activeOrderStatuses.has(order.status)) throw new Error("This delivery is no longer active.");

    if (action === "answer") {
      if (user.id !== call.receiver_id || call.status !== "ringing") throw new Error("This call is no longer waiting for you.");
      const { data: profile } = await db.from("profiles").select("full_name,email").eq("id", user.id).maybeSingle();
      const roomName = `delivery-${order.id}`;
      const liveKitToken = await issueToken(user.id, profile?.full_name || user.email, roomName);
      const { data: answeredRows, error } = await db.from("call_logs").update({ status: "answered", answered_at: new Date().toISOString() })
        .eq("id", call.id).eq("status", "ringing").select("id");
      if (error) throw error;
      if (!answeredRows?.length) throw new Error("This call is no longer waiting for you.");
      return json({ call: { ...call, status: "answered" }, roomName, ...liveKitToken });
    }

    if (action === "decline" && user.id !== call.receiver_id) throw new Error("Only the receiving participant can decline this call.");
    if (action === "timeout" && (call.status !== "ringing" || Date.now() - new Date(call.started_at).getTime() < 45_000)) throw new Error("This call has not timed out.");
    if (terminalStates.has(call.status)) return json({ ok: true, call });
    const status = action === "decline" ? "declined" : action === "timeout" ? "missed" : "ended";
    const endedAt = new Date().toISOString();
    const duration = call.status === "answered" ? Math.max(0, Math.floor((Date.now() - new Date(call.answered_at || call.started_at || endedAt).getTime()) / 1000)) : 0;
    const { error: updateError } = await db.from("call_logs").update({ status, ended_at: endedAt, duration_seconds: duration }).eq("id", call.id);
    if (updateError) throw updateError;
    return json({ ok: true, call: { ...call, status } });
  } catch (error) {
    return err(error);
  }
};
