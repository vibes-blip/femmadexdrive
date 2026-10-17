import test from "node:test";
import assert from "node:assert/strict";
import {publicTrackingView} from "../netlify/functions/_public-tracking-security.mjs";

const order={
 tracking_number:"FDD-1234ABCD",
 status:"delivered",
 journey_type:"interstate",
 accepted_at:"2026-10-01T08:00:00.000Z",
 pickup_at:"2026-10-01T09:00:00.000Z",
 at_door_at:"2026-10-01T10:00:00.000Z",
 delivered_at:"2026-10-01T10:30:00.000Z",
 completed_at:null,
 destination_station_snapshot:{name:"Approved Terminal",city:"City",state:"State",address:"private address"}
};

test("public interstate tracking reports carrier milestones without exposing private handoff notes",()=>{
 const view=publicTrackingView(order,[
  {event:"arrived_origin_terminal",created_at:"2026-10-01T10:30:00.000Z",note:"private sender phone and witness details"},
  {event:"ready_for_collection",created_at:"2026-10-02T10:30:00.000Z",note:"internal collection details"},
  {event:"pickup_state_classified",created_at:"2026-10-01T07:00:00.000Z",note:"private state verification"}
 ]);
 assert.equal(view.status,"in_transit");
 assert.deepEqual(view.completed_steps,[]);
 assert.deepEqual(view.destination_station,{name:"Approved Terminal",city:"City",state:"State"});
 assert.deepEqual(view.milestones,[
  {event:"arrived_origin_terminal",created_at:"2026-10-01T10:30:00.000Z"},
  {event:"ready_for_collection",created_at:"2026-10-02T10:30:00.000Z"}
 ]);
 assert.doesNotMatch(JSON.stringify(view),/private address|private sender|internal collection|state verification/);
});

test("local public tracking retains its existing response fields",()=>{
 const view=publicTrackingView({...order,journey_type:"local"});
 assert.deepEqual(Object.keys(view),["tracking_number","status","completed_steps"]);
 assert.equal(view.status,"delivered");
 assert.ok(view.completed_steps.includes("delivered"));
});
