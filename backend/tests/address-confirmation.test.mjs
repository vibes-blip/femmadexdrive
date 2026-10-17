import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import addressSearch,{formatAddress} from "../netlify/functions/address-search.mjs";
import {formatGeoapifyAddress,reverseGeocode} from "../netlify/functions/_geocoding.mjs";
import {sameNigeriaState} from "../netlify/functions/quote.mjs";
import {addressWithHouseNumber,houseNumberFromInput,preserveCustomerAddress} from "../../frontend/src/address-format.js";

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
 assert.equal(preserveCustomerAddress("43 Awoseyin Street, Lagos","43, Awo","43","43"),"43, Awoseyin Street, Lagos");
 assert.equal(preserveCustomerAddress("43 Awoseyin Street, Lagos","Flat 4B, 43 Awoseyin Street","43","43"),"43, Awoseyin Street, Lagos (Flat 4B, 43 Awoseyin Street)");
 assert.equal(preserveCustomerAddress("Pinned location, Lagos, Nigeria","43 Awoseyin Street, Lagos, Nigeria","43",""),"43, Pinned location, Lagos, Nigeria (43 Awoseyin Street, Lagos, Nigeria)");
 assert.equal(preserveCustomerAddress("Awoseyin Street, Lagos","Awoseyin Street",""),"Awoseyin Street, Lagos");
});

test("Geoapify autocomplete prioritizes exact house numbers and keeps coordinates",async()=>{
 const originalFetch=global.fetch;
 const originalKey=process.env.GEOAPIFY_API_KEY;
 process.env.GEOAPIFY_API_KEY="test-geoapify-key";
 let requestedUrl;
 global.fetch=async input=>{
  requestedUrl=new URL(input);
  return Response.json({results:[
   {name:"Awoseyin Street",street:"Awoseyin Street",city:"Lagos",country:"Nigeria",lat:6.525,lng:3.38,result_type:"street"},
   {housenumber:"43",street:"Awoseyin Street",city:"Lagos",country:"Nigeria",formatted:"43 Awoseyin Street, Lagos, Nigeria",lat:6.5244,lon:3.3792,result_type:"building"}
  ]});
 };
 try{
  const response=await addressSearch(new Request("https://femmadexdrive.test/api/address-search?q=43%2C%20Awoseyin%20Street"));
  assert.equal(response.status,200);
  const {results}=await response.json();
  assert.equal(requestedUrl.hostname,"api.geoapify.com");
  assert.equal(requestedUrl.pathname,"/v1/geocode/autocomplete");
  assert.equal(requestedUrl.searchParams.get("text"),"43, Awoseyin Street");
  assert.equal(results[0].houseNumber,"43");
  assert.equal(results[0].precision,"building");
  assert.equal(results[0].provider,"Geoapify");
  assert.deepEqual([results[0].lat,results[0].lng],[6.5244,3.3792]);
 }finally{
  global.fetch=originalFetch;
  if(originalKey===undefined)delete process.env.GEOAPIFY_API_KEY;
  else process.env.GEOAPIFY_API_KEY=originalKey;
 }
});

test("Geoapify reverse geocoding verifies a map point before OSM fallbacks",async()=>{
 const originalFetch=global.fetch;
 const originalKey=process.env.GEOAPIFY_API_KEY;
 process.env.GEOAPIFY_API_KEY="test-geoapify-key";
 let requestedUrl;
 global.fetch=async input=>{
  requestedUrl=new URL(input);
  return Response.json({results:[{
   housenumber:"43",street:"Awoseyin Street",city:"Lagos",state:"Lagos State",country:"Nigeria",country_code:"ng",
   formatted:"43 Awoseyin Street, Lagos, Nigeria",lat:6.5245,lon:3.3793
  }]});
 };
 try{
  const result=await reverseGeocode(6.5244,3.3792);
  assert.equal(requestedUrl.pathname,"/v1/geocode/reverse");
  assert.equal(result.provider,"Geoapify");
  assert.equal(result.houseNumber,"43");
  assert.equal(result.state,"Lagos State");
  assert.equal(result.countryCode,"ng");
  assert.deepEqual([result.lat,result.lng],[6.5244,3.3792]);
  assert.equal(formatGeoapifyAddress({housenumber:"43",street:"Awoseyin Street",lat:6.5244,lon:3.3792}).precision,"building");
 }finally{
  global.fetch=originalFetch;
  if(originalKey===undefined)delete process.env.GEOAPIFY_API_KEY;
  else process.env.GEOAPIFY_API_KEY=originalKey;
 }
});

test("same-state local delivery validation requires verified Nigerian state metadata",()=>{
 assert.equal(sameNigeriaState({state:"Lagos State",country:"Nigeria"},{state:"lagos",countryCode:"ng"}),true);
 assert.equal(sameNigeriaState({state:"FCT",country:"Nigeria"},{state:"Federal Capital Territory",country:"Nigeria"}),true);
 assert.equal(sameNigeriaState({state:"Lagos",country:"Nigeria"},{state:"Ogun",country:"Nigeria"}),false);
 assert.equal(sameNigeriaState({state:"Lagos",country:"Nigeria"},{state:"Accra",country:"Ghana"}),false);
 assert.equal(sameNigeriaState({state:null,country:"Nigeria"},{state:"Lagos",country:"Nigeria"}),false);
});

test("booking shows only the chosen dispatch form and keeps worldwide delivery unavailable",()=>{
 assert.match(bookingUi,/DispatchTypePicker value=\{dispatchType\}/);
 assert.match(bookingUi,/dispatchType==="state-to-state"&&<InterstateBooking/);
 assert.match(bookingUi,/dispatchType==="within-state"&&<section className="panel" id="customer-booking-form"/);
 assert.match(bookingUi,/International \/ worldwide/);
 assert.match(bookingUi,/Cross-border dispatch is not available yet/);
 assert.match(bookingUi,/disabled aria-disabled="true"/);
});

test("selected and edited addresses stay concise and preserve route coordinates",()=>{
 assert.match(locationUi,/houseNumberFromInput/);
 assert.match(locationUi,/preserveCustomerAddress\(providerAddress,originalInput/);
 assert.match(locationUi,/customerAddress=\{value\}/);
 assert.match(locationUi,/onSelect\(selectedPoint,query\.trim\(\)\|\|String\(customerAddress\|\|""\)\.trim\(\)\)/);
 assert.match(locationUi,/Search address or type a street and building number/);
 assert.match(locationUi,/value=\{coordinates\?value:query\}/);
 assert.doesNotMatch(locationUi,/address-details/);
 assert.doesNotMatch(locationUi,/Location precision:/);
 assert.doesNotMatch(locationUi,/Provider-formatted location/);
 assert.doesNotMatch(locationUi,/Provider result type/);
 assert.doesNotMatch(locationUi,/Landmark or delivery instructions/);
 assert.doesNotMatch(locationUi,/I confirm this complete address and the selected map pin/);
 assert.doesNotMatch(locationUi,/This location was copied from an existing order/);
 assert.doesNotMatch(locationUi,/addressForOrder/);
 assert.match(locationUi,/choose\(\{lat:position\.coords\.latitude,lng:position\.coords\.longitude\}\)/);
 assert.match(locationUi,/handleMarkerDrag/);
 assert.match(bookingUi,/const orderAddress=address=>clean\(address\)/);
 assert.match(bookingUi,/pickupAddress:orderAddress\(form\.pickup/);
 assert.match(bookingUi,/dropoffAddress:orderAddress\(form\.dropoff/);
 assert.match(quoteHandler,/p_pickup_address:pickupAddress/);
 assert.match(quoteHandler,/p_dropoff_address:dropoffAddress/);
 assert.match(quoteHandler,/coordinates:\[\[pickupLongitude,pickupLatitude\],\[dropoffLongitude,dropoffLatitude\]\]/);
 assert.match(orderSchema,/pickup_address text not null, dropoff_address text not null/);
 assert.match(bookingUi,/address:active\?\.dropoff_address/);
 assert.match(bookingUi,/const interstatePickup=active\?\.journey_type==="interstate"&&active\.origin_station_snapshot/);
 assert.match(bookingUi,/address:active\?\.dropoff_address,latitude:active\?\.dropoff_latitude,longitude:active\?\.dropoff_longitude/);
 assert.match(bookingUi,/riderDestination=interstatePickup\?\{\s*address:interstatePickup\.address/);
 assert.match(bookingUi,/from\("orders"\)\.select\("\*"\)/);
});

test("existing autocomplete debounce, mobile suggestions, and pin coordinate handling remain in place",()=>{
 assert.match(locationUi,/setTimeout\(async\(\)=>/);
 assert.match(locationUi,/searchAddresses\(searchText/);
 assert.match(locationUi,/controller\.abort\(\)/);
 assert.match(locationUi,/setSelectedPoint\(\{lat:point\.lat,lng:point\.lng\}\)/);
 assert.match(locationUi,/setLngLat\(\[point\.lng,point\.lat\]\)/);
 assert.doesNotMatch(read("../../frontend/src/styles.css"),/address-details/);
 assert.match(read("../../frontend/src/styles.css"),/overflow-wrap:anywhere/);
});
