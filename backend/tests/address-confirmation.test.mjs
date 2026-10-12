import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import addressSearch,{formatAddress} from "../netlify/functions/address-search.mjs";
import {addressWithHouseNumber,houseNumberFromInput} from "../../frontend/src/address-format.js";

const read=path=>readFileSync(new URL(path,import.meta.url),"utf8");
const locationUi=read("../../frontend/src/MapboxLocation.jsx");
const bookingUi=read("../../frontend/src/App.jsx");
const quoteHandler=read("../netlify/functions/quote.mjs");
const orderSchema=read("../supabase/migrations/001_femmadexdrive_v2.sql");

const feature=(properties,lat=6.5244,lng=3.3792)=>({
 type:"Feature",
 geometry:{type:"Point",coordinates:[lng,lat]},
 properties
});

test("partial and exact address searches preserve the customer's query and provider suggestions",async()=>{
 const originalFetch=global.fetch;
 const queries=[];
 global.fetch=async input=>{
  const url=new URL(input);
  queries.push(url.searchParams.get("q"));
  const requested=url.searchParams.get("q");
  const features=requested==="43, Awoseyin Street"
   ?[feature({name:"43 Awoseyin Street",housenumber:"43",street:"Awoseyin Street",type:"house"})]
   :[
    feature({name:"Awoseyin Street",street:"Awoseyin Street",type:"street"},6.5244,3.3792),
    feature({name:"Awoseyin Road",street:"Awoseyin Road",type:"street"},6.525,3.38)
   ];
  return Response.json({features});
 };
 try{
  for(const query of ["43, Awo","43, Awoseyin Street","Awoseyin","Awoseyin Street"]){
   const url=`https://femmadexdrive.test/api/address-search?q=${encodeURIComponent(query)}`;
   const response=await addressSearch(new Request(url));
   assert.equal(response.status,200);
   const result=await response.json();
   assert.ok(result.results.length>0,`expected mocked provider matches for ${query}`);
   assert.ok(result.results.every(item=>/Awoseyin/i.test(item.address)),`expected relevant mocked Awoseyin matches for ${query}`);
  }
 }finally{
  global.fetch=originalFetch;
 }
 assert.deepEqual(queries,["43, Awo","43, Awoseyin Street","Awoseyin","Awoseyin Street"]);
});

test("provider house number and street precision are reported only when present in provider data",()=>{
 const street=formatAddress({name:"Awoseyin Street",street:"Awoseyin Street",type:"street"});
 assert.equal(street.precision,"street");
 assert.equal(street.houseNumber,null);
 assert.equal(street.resultType,"street");
 const building=formatAddress({housenumber:"43",street:"Awoseyin Street",type:"house"});
 assert.equal(building.precision,"building");
 assert.equal(building.houseNumber,"43");
 assert.equal(building.resultType,"house");
 assert.match(building.address,/43/);
 assert.equal(houseNumberFromInput("43, Awo"),"43");
 assert.equal(houseNumberFromInput("Awoseyin"),"");
 assert.equal(addressWithHouseNumber("Awoseyin Street, Lagos","43"),"43, Awoseyin Street, Lagos");
 assert.equal(addressWithHouseNumber("43 Awoseyin Street, Lagos","43","43"),"43, Awoseyin Street, Lagos");
 assert.equal(addressWithHouseNumber("43 Awoseyin Street, Lagos","45","43"),"45, Awoseyin Street, Lagos");
});

test("confirmed address and landmark persist separately from numeric route coordinates",()=>{
 assert.match(locationUi,/houseNumberFromInput/);
 assert.match(locationUi,/Street-level result only\. The building number could not be independently verified\./);
 assert.match(locationUi,/neither number is silently substituted/);
 assert.match(locationUi,/Delivery instructions:/);
 assert.match(locationUi,/required checked=\{addressConfirmed\}/);
 assert.match(locationUi,/handleMarkerDrag/);
 assert.match(bookingUi,/pickupAddress:orderAddress\(form\.pickup,form\.pickupInstructions\)/);
 assert.match(bookingUi,/dropoffAddress:orderAddress\(form\.dropoff,form\.dropoffInstructions\)/);
 assert.match(quoteHandler,/p_pickup_address:pickupAddress/);
 assert.match(quoteHandler,/p_dropoff_address:dropoffAddress/);
 assert.match(quoteHandler,/coordinates:\[\[pickupLongitude,pickupLatitude\],\[dropoffLongitude,dropoffLatitude\]\]/);
 assert.match(orderSchema,/pickup_address text not null, dropoff_address text not null/);
 assert.match(bookingUi,/active\.dropoff_address/);
 assert.match(bookingUi,/from\("orders"\)\.select\("\*"\)/);
});

test("existing autocomplete debounce, mobile suggestions, and pin coordinate handling remain in place",()=>{
 assert.match(locationUi,/setTimeout\(async\(\)=>/);
 assert.match(locationUi,/searchAddresses\(searchText/);
 assert.match(locationUi,/controller\.abort\(\)/);
 assert.match(locationUi,/setSelectedPoint\(\{lat:point\.lat,lng:point\.lng\}\)/);
 assert.match(locationUi,/setLngLat\(\[point\.lng,point\.lat\]\)/);
 assert.match(read("../../frontend/src/styles.css"),/@media\(max-width:520px\)\{\.address-confirmation/);
 assert.match(read("../../frontend/src/styles.css"),/overflow-wrap:anywhere/);
});
