import React, { lazy, Suspense, useEffect, useState } from "react";

const LiveCall = lazy(() => import("./LiveCall.jsx"));

export default function RiderVoiceCalls({ session, supabase, toast }) {
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let current = true;
    const load = async () => {
      const { data, error } = await supabase.from("orders")
        .select("id,tracking_number,status")
        .eq("rider_id", session.user.id)
        .in("status", ["accepted", "picked_up", "on_the_way", "at_door", "delivered"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!current) return;
      if (error) toast(error.message);
      setOrder(data || null);
      setLoading(false);
    };
    void load();
    const channel = supabase.channel(`rider-voice-order-${session.user.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "orders", filter: `rider_id=eq.${session.user.id}` }, load)
      .subscribe();
    return () => { current = false; void supabase.removeChannel(channel); };
  }, [session.user.id, supabase, toast]);
  if (loading || !order) return null;
  return <main className="page voice-call-page" id="rider-call"><section className="panel">
    <span className="eyebrow">DELIVERY CALL</span><h2>{order.tracking_number}</h2>
    <p>Talk with the customer assigned to this delivery.</p>
    <Suspense fallback={<p>Preparing secure voice call…</p>}><LiveCall orderId={order.id} session={session} supabase={supabase} peerName="your customer"/></Suspense>
  </section></main>;
}
