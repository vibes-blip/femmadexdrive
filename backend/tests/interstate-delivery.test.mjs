import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {calculateInterstatePrice} from "../netlify/functions/_interstate-pricing.mjs";

const read=path=>readFileSync(new URL(path,import.meta.url),"utf8");

const schedule={
 base_fare:500,
 minimum_fare:750,
 operating_cost_floor:1000,
 express_premium_percent:25,
 maximum_distance_km:700,
 distance_bands:[
  {up_to_km:100,rate_per_km:300},
  {up_to_km:300,rate_per_km:220},
  {up_to_km:700,rate_per_km:180}
 ]
};

test("interstate prices apply marginal distance bands and configured express premium",()=>{
 const standard=calculateInterstatePrice(150000,schedule,"standard");
 assert.equal(standard.price,41500);
 assert.equal(standard.breakdown.distanceCharge,41000);
 assert.deepEqual(standard.breakdown.appliedBands.map(band=>band.amount),[30000,11000]);
 const express=calculateInterstatePrice(150000,schedule,"express");
 assert.equal(express.price,51875);
 assert.equal(express.breakdown.expressPremiumAmount,10375);
});

test("interstate pricing refuses distance, floor and malformed-band underquotes",()=>{
 assert.throws(()=>calculateInterstatePrice(701000,schedule),/maximum distance/);
 assert.throws(()=>calculateInterstatePrice(1000,{...schedule,operating_cost_floor:10000}),/below the configured operating-cost floor/);
 assert.throws(()=>calculateInterstatePrice(1000,{...schedule,distance_bands:[
  {up_to_km:null,rate_per_km:10},
  {up_to_km:100,rate_per_km:10}
 ]}),/invalid or incomplete distance bands/);
});

test("station routes and interstate quotes remain isolated from verified sender pickup",()=>{
 const migration=read("../supabase/migrations/030_interstate_stations_routes_pricing.sql");
 const quote=read("../netlify/functions/interstate-quote.mjs");
 const app=read("../../frontend/src/App.jsx");
 const interstateUi=read("../../frontend/src/InterstateBooking.jsx");
 assert.match(migration,/pickup_state_status text not null default 'unverified'/);
 assert.match(migration,/destination_station_snapshot jsonb/);
 assert.match(migration,/interstate_route_snapshot jsonb/);
 assert.match(migration,/public\.current_user_role\(\) in \('admin','supervisor'\)/);
 assert.match(migration,/create_interstate_delivery_quote/);
 assert.match(migration,/publish_delivery_pricing_version/);
 assert.match(quote,/p_pickup_address:pickupAddress/);
 assert.match(quote,/p_pickup_state:input\.pickupState\.trim\(\)/);
 assert.match(migration,/or p_weight_kg is null or p_weight_kg<=0/);
 assert.match(quote,/p_destination_station_id:destination\.id/);
 assert.match(quote,/pickupStateRequiresOperationsVerification:true/);
 assert.match(quote,/p_vehicle_type:vehicleClass/);
 assert.match(migration,/arrived_origin_terminal/);
 assert.match(migration,/advance_interstate_shipment/);
 assert.match(interstateUi,/Sender pickup remains separate/);
 assert.match(interstateUi,/shoes in a box, a book, phone, small gift, clothing, groceries, or a securely sealed meal\/snack for immediate consumption/);
 assert.match(interstateUi,/A handbag, grocery bag, several small items together, or a medium carton/);
 assert.match(interstateUi,/package-medium\.svg/);
 assert.match(interstateUi,/Enter the sender's real doorstep address/);
 assert.match(interstateUi,/approved station and route limits/);
 assert.match(quote,/coordinates/);
 assert.match(app,/form\.pickup/);
});
