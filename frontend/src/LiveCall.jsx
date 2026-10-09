import React, { useEffect, useRef, useState } from "react";
import { Phone, PhoneOff, Radio } from "lucide-react";
import { Room, RoomEvent } from "livekit-client";
import { API_BASE } from "./api.js";

const terminalStates = new Set(["ended", "declined", "missed", "failed"]);

export default function LiveCall({ orderId, session, supabase, peerName = "delivery partner" }) {
  const [call, setCall] = useState(null);
  const [state, setState] = useState("idle");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const roomRef = useRef(null);
  const mediaRef = useRef(null);
  const callRef = useRef(null);
  const peerNameRef = useRef(peerName);
  peerNameRef.current = peerName;

  useEffect(() => { callRef.current = call; }, [call]);

  const request = async (action, callId) => {
    const response = await fetch(`${API_BASE}/livekit-call`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ action, orderId, callId }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Could not complete the call request.");
    return result;
  };

  const disconnectRoom = async () => {
    const room = roomRef.current;
    roomRef.current = null;
    if (room) {
      try { await room.localParticipant.setMicrophoneEnabled(false); } catch {}
      room.disconnect();
    }
    if (mediaRef.current) mediaRef.current.replaceChildren();
  };

  const joinRoom = async ({ serverUrl, token }) => {
    await disconnectRoom();
    const room = new Room({ adaptiveStream: true, dynacast: true });
    roomRef.current = room;
    room.on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind !== "audio" || !mediaRef.current) return;
      const element = track.attach();
      element.autoplay = true;
      mediaRef.current.appendChild(element);
    });
    room.on(RoomEvent.TrackUnsubscribed, (track) => {
      for (const element of track.detach()) element.remove();
    });
    room.on(RoomEvent.Disconnected, () => {
      if (roomRef.current === room) {
        roomRef.current = null;
        setState("Call ended");
        const activeCall = callRef.current;
        if (activeCall?.status === "answered") {
          void request("end", activeCall.id).catch((e) => setError(e.message)).finally(() => setCall(null));
        }
      }
    });
    await room.connect(serverUrl, token);
    await room.localParticipant.setMicrophoneEnabled(true);
    setState(`Connected with ${peerNameRef.current}`);
  };

  useEffect(() => {
    let current = true;
    const handleCall = (row) => {
      if (!row || row.order_id !== orderId) return;
      setCall(row);
      if (terminalStates.has(row.status)) {
        setCall(null);
        setState(row.status === "declined" ? "Call declined" : "Call ended");
        void disconnectRoom();
      } else if (row.status === "ringing") {
        setState(row.receiver_id === session.user.id ? `Incoming call from ${peerNameRef.current}` : `Calling ${peerNameRef.current}…`);
      } else if (row.status === "answered") {
        setState(`Connected with ${peerNameRef.current}`);
      }
    };
    const channel = supabase.channel(`call-log-${orderId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "call_logs", filter: `order_id=eq.${orderId}` }, (event) => {
        if (current) handleCall(event.new);
      })
      .subscribe();
    supabase.from("call_logs")
      .select("id,order_id,caller_id,receiver_id,status,started_at,answered_at,ended_at,duration_seconds")
      .eq("order_id", orderId)
      .in("status", ["ringing", "answered"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data, error: loadError }) => {
        if (!current) return;
        if (loadError) setError(loadError.message);
        if (data) handleCall(data);
      });
    return () => {
      current = false;
      supabase.removeChannel(channel);
      const activeCall = callRef.current;
      if (activeCall?.status === "answered") void request("end", activeCall.id).catch((e) => setError(e.message));
      void disconnectRoom();
    };
  }, [orderId, session.user.id, supabase]);

  useEffect(() => {
    if (call?.status !== "ringing" || !call.started_at) return;
    const delay = Math.max(0, 45_000 - (Date.now() - new Date(call.started_at).getTime()));
    const timer = setTimeout(() => {
      void request("timeout", call.id)
        .then(() => { setCall(null); setState("Call missed"); })
        .catch((e) => setError(e.message));
    }, delay);
    return () => clearTimeout(timer);
  }, [call?.id, call?.started_at, call?.status]);

  const start = async () => {
    setError(""); setBusy(true); setState("Calling…");
    try { const result = await request("start"); setCall(result.call); await joinRoom(result); }
    catch (e) { setState("idle"); setError(e.message); setCall(null); }
    finally { setBusy(false); }
  };

  const answer = async () => {
    if (!call) return;
    setError(""); setBusy(true); setState("Joining call…");
    try { const result = await request("answer", call.id); setCall(result.call); await joinRoom(result); }
    catch (e) { setState(`Incoming call from ${peerNameRef.current}`); setError(e.message); }
    finally { setBusy(false); }
  };

  const finish = async (action = "end") => {
    const activeCall = call;
    setBusy(true); await disconnectRoom();
    if (activeCall) {
      try { await request(action, activeCall.id); }
      catch (e) { setError(e.message); }
    }
    setCall(null);
    setState(action === "decline" ? "Call declined" : "Call ended");
    setBusy(false);
  };

  const incoming = call?.status === "ringing" && call.receiver_id === session.user.id;
  const canCall = state === "idle" || ["Call ended", "Call declined"].includes(state);
  return <div className="live-call" aria-live="polite">
    <div className="live-call-status"><Radio size={16}/><span>{state === "idle" ? `Call ${peerName}` : state}</span></div>
    <div className="live-call-actions">
      {canCall && <button type="button" className="secondary" disabled={busy} onClick={start}><Phone size={16}/> Voice call</button>}
      {incoming && <><button type="button" className="primary" disabled={busy} onClick={answer}><Phone size={16}/> Answer</button><button type="button" className="secondary" disabled={busy} onClick={() => finish("decline")}><PhoneOff size={16}/> Decline</button></>}
      {call && !incoming && call.status === "answered" && <button type="button" className="secondary" disabled={busy} onClick={() => finish("end")}><PhoneOff size={16}/> End call</button>}
    </div>
    {error && <small className="live-call-error">{error}</small>}
    <div ref={mediaRef} className="live-call-media" aria-hidden="true"/>
  </div>;
}
