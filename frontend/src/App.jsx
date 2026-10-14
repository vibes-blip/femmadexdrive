import React,{useEffect,useMemo,useRef,useState} from "react";
import {createClient} from "@supabase/supabase-js";
import "maplibre-gl/dist/maplibre-gl.css";
import "./home.css";
import RiderVoiceCalls from "./RiderVoiceCalls.jsx";
import CustomerVoiceCalls from "./CustomerVoiceCalls.jsx";
import AdminDispatchControls from "./AdminDispatchControls.jsx";
import AdminWalletPayouts from "./AdminWalletPayouts.jsx";
import CustomerDispatchUpdates from "./CustomerDispatchUpdates.jsx";
import RiderDispatch from "./RiderDispatch.jsx";
import RiderWallet from "./RiderWallet.jsx";
import VoiceControl from "./VoiceControl.jsx";
import {AdminSupportInbox,CarePortal,CustomerCareAdmin,CustomerCareChat} from "./CustomerCare.jsx";
import {bookingDetailsFromConversation} from "./bookingAssistant.js";
import {Address,DeliveryLocationMap,NavigationLink} from "./MapboxLocation.jsx";
import {API_BASE} from "./api.js";
import {ArrowRight,Bike,Box,Check,CheckCircle2,Clock3,Headphones,LogIn,LogOut,MapPin,Menu,MessageCircle,Mic,Navigation,Package,Phone,RefreshCw,Send,ShieldCheck,Truck,UserPlus,X,WalletCards,LockKeyhole,AlertTriangle,Radio,Star} from "lucide-react";


const url=import.meta.env.VITE_SUPABASE_URL, key=import.meta.env.VITE_SUPABASE_ANON_KEY;
function authStorage(){
 const memory=new Map();
 try{
  const projectRef=new URL(url).hostname.split(".")[0];
  window.localStorage.removeItem(`sb-${projectRef}-auth-token`);
  return window.sessionStorage;
 }catch(error){
  console.warn("Browser session storage is unavailable; authentication will last only until this page closes.",error.message);
  return {
   getItem:key=>memory.get(key)||null,
   setItem:(key,value)=>{memory.set(key,value)},
   removeItem:key=>{memory.delete(key)}
  };
 }
}
const supabase=url&&key?createClient(url,key,{auth:{storage:authStorage()}}):null;
const ADMIN_HOST=String(import.meta.env.VITE_ADMIN_HOST||"femmadexdrive.netlify.app").trim();
const DISPATCH_TERMS_VERSION="dispatch-terms-2026-10-12";

function normalizeHost(value){
 const trimmed=String(value||"").trim();
 if(!trimmed)return "";
 try{
  const parsed=new URL(/^https?:\/\//i.test(trimmed)?trimmed:`https://${trimmed}`);
  return parsed.hostname.replace(/:\d+$/,"")||"";
 }catch{
  return trimmed.replace(/^https?:\/\//i,"").replace(/\/.*$/,"").replace(/:\d+$/,"") || "";
 }
}


const api=(path,body={},token,signal)=>fetch(`${API_BASE}/${path}`,{method:"POST",headers:{"Content-Type":"application/json",...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body),...(signal?{signal}:{})}).then(async r=>{const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||"Request failed");return d});
const money=n=>`₦${Number(n||0).toLocaleString()}`;
const clean=s=>String(s||"").replace(/[<>]/g,"").trim();
const orderAddress=address=>clean(address);
const fmt=d=>d?new Date(d).toLocaleString([],{dateStyle:"medium",timeStyle:"short"}):"—";
const statusLabels={searching:"Finding rider",price_review:"Awaiting price review",pending_admin_review:"Awaiting price verification",approved:"Price approved",rejected:"Quote requires review",expired:"Quote expired",awaiting_payment:"Awaiting payment",paid:"Waiting for a rider",accepted:"Rider assigned",picked_up:"Package picked up",on_the_way:"Rider moving",at_door:"At destination",delivered:"Delivery awaiting confirmation",completed:"Delivered",cancelled:"Cancelled"};
const contactStatuses=new Set(["accepted","picked_up","on_the_way","at_door","delivered"]);
const liveLocationStatuses=new Set(["accepted","picked_up","on_the_way","at_door"]);
const packageCategoryLabels={small:"Small & Medium Parcel",medium:"Small & Medium Parcel",bulky:"Large & Bulky Items"};
const deliverySpeedLabels={standard:"Standard Delivery",fast:"Fast Delivery — Within 2 Hours"};
const packageCategoryForOrder=order=>order?.package_category||(["large","very_large"].includes(order?.package_size)?"bulky":order?.package_size==="small"?"small":"medium");

function path(){let p=location.pathname.replace(/\/+$/,"")||"/"; if(p==="/rider")return"rider";if(p==="/track")return"track";if(p==="/admin")return"admin";if(p==="/book")return"book";if(p==="/terms")return"terms";if(p==="/care")return"care";if(p==="/login")return"login";if(p==="/payment-result")return"payment-result";return"customer"}
function go(p){history.pushState({}, "", p);dispatchEvent(new PopStateEvent("popstate"));scrollTo({top:0,behavior:"smooth"})}
function scrollToSection(id){document.getElementById(id)?.scrollIntoView({behavior:"smooth",block:"center"})}

function useSession(){
 const [session,setSession]=useState(null),[profile,setProfile]=useState(null),[loading,setLoading]=useState(!!supabase),[profileLoading,setProfileLoading]=useState(false),[profileError,setProfileError]=useState("");
 const currentUserId=useRef(null);
 const [profileRevision,setProfileRevision]=useState(0);
 useEffect(()=>{if(!supabase){setLoading(false);return}let mounted=true,authEventReceived=false;const {data}=supabase.auth.onAuthStateChange((event,nextSession)=>{authEventReceived=true;if(!mounted)return;const nextUserId=nextSession?.user?.id||null;if(currentUserId.current!==nextUserId){currentUserId.current=nextUserId;setProfile(null);setProfileError("");setProfileLoading(!!nextUserId)}else if(event==="SIGNED_IN"||event==="USER_UPDATED"){setProfile(null);setProfileError("");setProfileLoading(!!nextUserId);setProfileRevision(value=>value+1)}setSession(nextSession||null);setLoading(false)});const timeout=setTimeout(()=>{if(mounted&&!authEventReceived)setLoading(false)},10000);supabase.auth.getSession().then(({data:result,error})=>{if(!mounted||authEventReceived)return;if(error)console.error("Could not restore Supabase session",error.message);const restoredSession=result?.session||null;currentUserId.current=restoredSession?.user?.id||null;setSession(restoredSession);setProfile(null);setProfileError("");setProfileLoading(!!restoredSession);setLoading(false)}).catch(error=>{if(!mounted||authEventReceived)return;console.error("Could not restore Supabase session",error);currentUserId.current=null;setSession(null);setProfile(null);setProfileError("");setProfileLoading(false);setLoading(false)});return()=>{mounted=false;clearTimeout(timeout);data.subscription.unsubscribe()}},[]);
 useEffect(()=>{if(!supabase||!session){setProfile(null);setProfileLoading(false);setProfileError("");return}let mounted=true;setProfile(null);setProfileLoading(true);setProfileError("");(async()=>{try{const {data,error}=await supabase.from("profiles").select("*").eq("id",session.user.id).maybeSingle();if(error)throw new Error(`Could not load your account profile: ${error.message}`);if(!data)throw new Error("Your account profile is missing. Ask operations to finish setting up your account.");if(data.role==="rider"){const {data:r,error:riderError}=await supabase.from("riders").select("*").eq("id",session.user.id).maybeSingle();if(riderError)throw new Error(`Could not load your rider profile: ${riderError.message}`);if(mounted)setProfile({...data,rider:r||null})}else if(mounted)setProfile(data)}catch(error){if(mounted){console.error("Could not load signed-in user profile",error);setProfileError(error.message)}}finally{if(mounted)setProfileLoading(false)}})();return()=>{mounted=false}},[session?.user?.id,profileRevision]);
 useEffect(()=>{if(!supabase||!session?.user?.id)return;const channel=supabase.channel(`profile-role-${session.user.id}`).on("postgres_changes",{event:"UPDATE",schema:"public",table:"profiles",filter:`id=eq.${session.user.id}`},()=>{setProfile(null);setProfileError("");setProfileLoading(true);setProfileRevision(value=>value+1)}).subscribe();return()=>{void supabase.removeChannel(channel)}},[session?.user?.id]);
 return {session,profile,setProfile,loading,profileLoading,profileError}
}

export default function App(){
 const [page,setPage]=useState(path()),[modal,setModal]=useState(null),[toast,setToast]=useState(""),[menu,setMenu]=useState(false);
 const {session,profile,setProfile,loading,profileLoading,profileError}=useSession();
 useEffect(()=>{const f=()=>setPage(path());addEventListener("popstate",f);return()=>removeEventListener("popstate",f)},[]);
 useEffect(()=>{setMenu(false)},[page]);
 useEffect(()=>{
  const metadata={
   customer:["FemmaDexDrive | Delivery and Dispatch in Nigeria","Book a delivery with route-based pricing, Operations-approved quotes, secure Paystack checkout and delivery updates.","/"],
   book:["Book a Dispatch | FemmaDexDrive","Prepare your delivery draft without an account; sign in or create a customer account to request an Operations-approved quote and pay securely.","/book"],
   terms:["Dispatch and Failed-Delivery Terms | FemmaDexDrive","Review FemmaDexDrive's draft dispatch, failed-delivery, redelivery and unclaimed-goods terms.","/terms"],
   care:["Customer Care Team | FemmaDexDrive","Apply for an approved FemmaDexDrive customer-care account or sign in to the private support inbox.","/care"],
   login:["Sign in | FemmaDexDrive","Sign in to your FemmaDexDrive account.","/login"],
   track:["Track a Delivery | FemmaDexDrive","Look up a FemmaDexDrive delivery using its tracking number.","/track"]
  };
  const [title,description,canonical]=metadata[page]||metadata.customer;
  document.title=title;
  const descriptionTag=document.querySelector('meta[name="description"]');
  if(descriptionTag)descriptionTag.setAttribute("content",description);
  const canonicalTag=document.querySelector('link[rel="canonical"]');
  if(canonicalTag)canonicalTag.setAttribute("href",`https://femmadexdrive.netlify.app${canonical}`);
  const ogUrl=document.querySelector('meta[property="og:url"]');
  if(ogUrl)ogUrl.setAttribute("content",`https://femmadexdrive.netlify.app${canonical}`);
 },[page]);
 useEffect(()=>{
  if(location.pathname.replace(/\/+$/,"")!=="/.netlify/functions/paystack-callback")return;
  const params=new URLSearchParams(location.search),reference=params.get("reference")||params.get("trxref");
  if(!reference){go("/payment-result?status=missing");return}
  location.replace(`${API_BASE}/paystack-callback?reference=${encodeURIComponent(reference)}`);
 },[]);
 useEffect(()=>{if(toast){const t=setTimeout(()=>setToast(""),3500);return()=>clearTimeout(t)}},[toast]);
 useEffect(()=>{
  if(!supabase||!session||profile?.role!=="rider")return;
  let active=true;
  const channel=supabase.channel(`rider-approval-${session.user.id}`)
   .on("postgres_changes",{event:"UPDATE",schema:"public",table:"riders",filter:`id=eq.${session.user.id}`},event=>{
    setProfile(current=>current?{...current,rider:{...current.rider,...event.new}}:current);
   })
   .subscribe(status=>{if(status==="CHANNEL_ERROR")setToast("Live approval updates are unavailable. Refresh this page to check your rider status.")});
  supabase.from("riders").select("*").eq("id",session.user.id).maybeSingle().then(({data,error})=>{
   if(!active)return;
   if(error){setToast(`Could not refresh rider approval: ${error.message}`);return}
   if(data)setProfile(current=>current?{...current,rider:{...current.rider,...data}}:current);
  });
  return()=>{active=false;supabase.removeChannel(channel)};
 },[session?.user?.id,profile?.role,profile?.rider?.approval_status]);
 const logout=async()=>{
  if(!supabase)return;
  try{
   const {error}=await supabase.auth.signOut();
   if(error)throw error;
   setProfile(null);
   setProfileError("");
   setProfileLoading(false);
   setModal(null);
   go("/login");
  }catch(error){
   console.error("Sign out failed",error);
   setToast("Could not sign out. Your session is still active; please retry.");
  }
 };
 if(loading)return <Loading/>;
 if(!supabase)return <Setup/>;
 if(session&&profileLoading)return <Loading/>;
 if(session&&profileError)return <Blocked title="Dashboard connection failed" detail={profileError} onAction={logout}/>;
 const adminHostOk=[location.hostname, location.host].some(host=>normalizeHost(host)===normalizeHost(ADMIN_HOST)) || ["localhost","127.0.0.1"].includes(location.hostname);
 return <><Header page={page} session={session} profile={profile} menu={menu} setMenu={setMenu} logout={logout} open={(role,mode)=>setModal({role,mode})}/>
 {page==="login"&&<LoginLanding open={(r,m)=>setModal({role:r,mode:m})}/>}
 {(page==="customer"||page==="book")&&<Customer key={`${session?.user?.id||"guest"}:${profile?.role||"unresolved"}`} session={session} profile={profile} booking={page==="book"} open={(r,m)=>setModal({role:r,mode:m})} toast={setToast}/>}
 {page==="rider"&&<Rider key={`${session?.user?.id||"guest"}:${profile?.role||"unresolved"}`} session={session} profile={profile} open={(r,m)=>setModal({role:r,mode:m})} toast={setToast}/>}
 {page==="terms"&&<DispatchTerms/>}
 {page==="care"&&<CarePortal key={`${session?.user?.id||"guest"}:${profile?.role||"unresolved"}`} session={session} profile={profile} supabase={supabase} open={(role,mode)=>setModal({role,mode})} toast={setToast}/>}
 {page==="track"&&<Tracker/>}{page==="payment-result"&&<PaymentResult/>}
 {page==="admin"&&(!adminHostOk?<Blocked title="Private admin host required"/>:<Admin key={`${session?.user?.id||"signed-out"}:${profile?.role||"unresolved"}`} session={session} profile={profile} open={(r,m)=>setModal({role:r,mode:m})} toast={setToast}/>)}
 {page==="admin"&&adminHostOk&&session&&["admin","supervisor"].includes(profile?.role)&&<AdminCallLogs key={session.user.id} session={session} toast={setToast}/>}
 {page==="admin"&&adminHostOk&&session&&["admin","supervisor"].includes(profile?.role)&&<CustomerCareAdmin supabase={supabase} toast={setToast}/>}
 <Footer/>{modal&&<Auth role={modal.role} mode={modal.mode} close={()=>setModal(null)} toast={setToast}/>}<VoiceControl/>
 {toast&&<div className="toast">{toast}</div>}</>
}

function Setup(){return <main className="center"><div className="setup"><img className="brand-logo setup-logo" src="/images/Logo-mark.png" alt="FemmaDexDrive logo"/><h1>Connect Supabase</h1><p>Add your Supabase URL and anon key to Netlify. Address lookup and maps use OpenStreetMap; no map token is required. This build contains no fake accounts or sample delivery records.</p><pre>VITE_SUPABASE_URL=...{"\n"}VITE_SUPABASE_ANON_KEY=...</pre></div></main>}

function Loading(){return <main className="center loading-screen"><div className="loading-track" aria-hidden="true"><span className="flow-particles"/><img src="/images/loading-rider.svg" alt=""/></div><div className="loading-copy"><div className="spinner"/><p role="status">Loading FemmaDexDrive…</p></div></main>}
function Blocked({title,detail="The operations dashboard is available only on the configured admin hostname.",onAction}){return <main className="center"><LockKeyhole size={42}/><h1>{title}</h1><p>{detail}</p>{onAction&&<button className="secondary" onClick={onAction}>Sign out</button>}</main>}

function Header({page,session,profile,menu,setMenu,logout,open}){
 const navigate=destination=>{setMenu(false);go(destination)};
 return <header><button className="brand" onClick={()=>navigate("/")}><img className="brand-logo" src="/images/Logo-mark.png" alt="FemmaDexDrive logo"/><span><strong>FemmaDexDrive</strong><small>Dispatch that gets there.</small></span></button><button className="hamb" aria-label={menu?"Close navigation":"Open navigation"} aria-expanded={menu} onClick={()=>setMenu(!menu)}>{menu?<X/>:<Menu/>}</button><nav className={menu?"open":""}><button className={page==="customer"?"active":""} onClick={()=>navigate("/")}>Delivery</button><button className={page==="rider"?"active":""} onClick={()=>navigate("/rider")}>Riders</button><button className={page==="track"?"active":""} onClick={()=>navigate("/track")}>Track</button>{session?.user?.is_anonymous?<button onClick={()=>{setMenu(false);logout()}}><LogOut size={15}/> Exit guest booking</button>:session?<button onClick={()=>{setMenu(false);logout()}}><LogOut size={15}/> Sign out</button>:<button className="primary" onClick={()=>{setMenu(false);open("customer","login")}}><LogIn size={15}/> Sign in</button>}</nav></header>
}

function CustomerDashboard({session,profile,open,toast,allowGuestBooking=false}){
 const [orders,setOrders]=useState([]),[paymentHistory,setPaymentHistory]=useState({}),[returnRecords,setReturnRecords]=useState([]),[selected,setSelected]=useState(null),[busy,setBusy]=useState(false),[termsAccepted,setTermsAccepted]=useState(false),[form,setForm]=useState({pickup:"",dropoff:"",pickupInstructions:"",dropoffInstructions:"",pickupVerification:null,dropoffVerification:null,pickupConfirmed:false,dropoffConfirmed:false,recipientName:"",recipientPhone:"",customerEmail:"",description:"",packageCategory:"small",deliverySpeed:"standard"}),[coords,setCoords]=useState({pickup:null,dropoff:null}),[quote,setQuote]=useState(null),[message,setMessage]=useState(""),[chat,setChat]=useState([]),[contact,setContact]=useState(null),[liveRider,setLiveRider]=useState(null),[draftSaved,setDraftSaved]=useState(false),[networkOnline,setNetworkOnline]=useState(navigator.onLine),[walletBalance,setWalletBalance]=useState(0),[reviews,setReviews]=useState({}),[reviewRating,setReviewRating]=useState(0),[reviewText,setReviewText]=useState("");
 const [walletError,setWalletError]=useState("");
 const quoteInputRef=useRef("");
 const quoteAbortRef=useRef(null);
 const draftLoaded=useRef(false);
 const draftKey=`fddBookingDraft:${session?.user?.id||"guest"}`;
 useEffect(()=>{
  const update=()=>setNetworkOnline(navigator.onLine);
  addEventListener("online",update);addEventListener("offline",update);
  return()=>{removeEventListener("online",update);removeEventListener("offline",update)};
 },[]);
 useEffect(()=>{
  if(draftLoaded.current)return;
  draftLoaded.current=true;
  const saved=sessionStorage.getItem(draftKey)||(session?sessionStorage.getItem("fddBookingDraft:guest"):null);
  if(!saved)return;
  try{
   const draft=JSON.parse(saved);
   if(!draft?.form||typeof draft.form!=="object"||!draft?.coords||typeof draft.coords!=="object")throw new Error("Saved booking draft has an invalid format.");
   setForm(current=>({...current,...draft.form}));
   setCoords(draft.coords);
   setDraftSaved(true);
   if(session&&!sessionStorage.getItem(draftKey)){
    sessionStorage.setItem(draftKey,saved);
    sessionStorage.removeItem("fddBookingDraft:guest");
   }
  }catch(error){
   sessionStorage.removeItem(draftKey);
   if(session)sessionStorage.removeItem("fddBookingDraft:guest");
   toast(`Could not restore your saved booking details: ${error.message}`);
  }
 },[session?.user?.id,draftKey,toast]);
 useEffect(()=>{
  if(!draftLoaded.current||quote)return;
  try{sessionStorage.setItem(draftKey,JSON.stringify({form,coords,savedAt:Date.now()}));setDraftSaved(true)}
  catch(error){setDraftSaved(false);toast(`Could not save your booking draft on this device: ${error.message}`)}
 },[form,coords,quote,draftKey,toast]);
 useEffect(()=>{
  const applyVoiceField=detail=>{
   const field=detail?.field,value=typeof detail?.value==="string"?detail.value.trim():"";
   if(!value)return;
   if(field==="deliveryCategory"){
    const category=value.toLowerCase();
    if(!["small","medium","bulky","large","fast","standard"].includes(category))return;
    setForm(current=>category==="fast"
     ?{...current,packageCategory:current.packageCategory==="bulky"?"medium":current.packageCategory,deliverySpeed:"fast"}
     :category==="bulky"||category==="large"
      ?{...current,packageCategory:"bulky",deliverySpeed:"standard"}
      :category==="small"||category==="medium"
       ?{...current,packageCategory:category,deliverySpeed:"standard"}
       :{...current,deliverySpeed:"standard"});
    setQuote(null);
   }else if(["pickup","dropoff","description","recipientName","recipientPhone","customerEmail"].includes(field)){
    setForm(current=>({...current,[field]:value.slice(0,field==="description"?2000:field==="recipientName"?120:field==="recipientPhone"?40:500)}));
    if(field==="pickup"||field==="dropoff"){
     setCoords(current=>({...current,[field]:null}));
     toast("Voice address added. Choose a matching map suggestion to confirm its location.");
    }
    setQuote(null);
   }else return;
   scrollToSection("customer-booking-form");
  };
  const receiveVoiceField=event=>applyVoiceField(event.detail);
  addEventListener("fdd-voice-fill",receiveVoiceField);
  try{
   const saved=sessionStorage.getItem("fddVoiceBookingField");
   if(saved){
    const detail=JSON.parse(saved);
    sessionStorage.removeItem("fddVoiceBookingField");
    applyVoiceField(detail);
   }
  }catch(error){
   sessionStorage.removeItem("fddVoiceBookingField");
   toast(`Could not restore the voice booking detail: ${error.message}`);
  }
  return()=>removeEventListener("fdd-voice-fill",receiveVoiceField);
 },[toast]);
 useEffect(()=>{quoteInputRef.current=JSON.stringify([form,coords]);setQuote(null);if(quoteAbortRef.current){quoteAbortRef.current.abort();quoteAbortRef.current=null;setBusy(false)}},[form,coords]);
 useEffect(()=>()=>quoteAbortRef.current?.abort(),[]);
 useEffect(()=>{
  const savedDetails=sessionStorage.getItem("fddVoiceBookingDetails");
  if(savedDetails){
   sessionStorage.removeItem("fddVoiceBookingDetails");
   try{
    const details=JSON.parse(savedDetails);
    for(const field of ["pickup","dropoff","description","recipientName","recipientPhone"]){
     if(typeof details?.[field]==="string"&&details[field].trim())dispatchEvent(new CustomEvent("fdd-voice-fill",{detail:{field,value:details[field]}}));
    }
    const category=details?.deliverySpeed==="fast"?"fast":details?.packageCategory;
    if(["small","medium","bulky"].includes(category)||category==="fast")dispatchEvent(new CustomEvent("fdd-voice-fill",{detail:{field:"deliveryCategory",value:category}}));
    toast("I added the delivery details discussed in chat. Confirm both addresses using map suggestions before requesting a quote.");
   }catch(error){toast(`Could not restore the booking details from chat: ${error.message}`)}
   return;
  }
  const request=sessionStorage.getItem("fddVoiceBookingRequest");
  if(!request)return;
  sessionStorage.removeItem("fddVoiceBookingRequest");
  const details=bookingDetailsFromConversation(request);
  if(Object.keys(details).length){
   setForm(current=>({...current,...details}));
   if(details.pickup||details.dropoff)setCoords(current=>({...current,pickup:details.pickup?null:current.pickup,dropoff:details.dropoff?null:current.dropoff}));
  }else setForm(current=>({...current,description:request.slice(0,2000)}));
  toast("Your voice/chat request is in the booking form. Confirm named pickup and destination locations before requesting a quote.");
 },[]);
 const token=useMemo(()=>session?.access_token,[session?.access_token]);
 const load=async()=>{if(!session)return;const [ordersResult,returnsResult,walletResult]=await Promise.all([supabase.from("orders").select("*").eq("customer_id",session.user.id).order("created_at",{ascending:false}),supabase.from("dispatch_returns").select("*").eq("customer_id",session.user.id).order("created_at",{ascending:false}),supabase.rpc("get_customer_wallet_balance")]);if(ordersResult.error){toast(`Could not load your deliveries: ${ordersResult.error.message}`);return}if(returnsResult.error){toast(`Could not load returned-goods updates: ${returnsResult.error.message}`);return}if(walletResult.error){setWalletBalance(0);setWalletError("Your delivery-credit balance could not be verified; available credit is applied by the payment service at checkout.");toast(`Could not load your delivery-credit balance: ${walletResult.error.message}`);return}setWalletError("");setWalletBalance(Number(walletResult.data||0));const rows=ordersResult.data||[];setOrders(rows);setReturnRecords(returnsResult.data||[]);setSelected(current=>rows.find(o=>o.id===current?.id)||rows[0]||null);if(!rows.length){setPaymentHistory({});setReviews({});return}const [paymentsResult,reviewsResult]=await Promise.all([supabase.from("payments").select("order_id,status,created_at").in("order_id",rows.map(order=>order.id)).order("created_at",{ascending:false}),supabase.from("rider_reviews").select("order_id,rating,review_text").in("order_id",rows.map(order=>order.id))]);if(paymentsResult.error){toast(`Could not load payment history: ${paymentsResult.error.message}`);return}if(reviewsResult.error){toast(`Could not load rider reviews: ${reviewsResult.error.message}`);return}const latestByOrder={};for(const payment of paymentsResult.data||[])if(!latestByOrder[payment.order_id])latestByOrder[payment.order_id]=payment;setPaymentHistory(latestByOrder);setReviews(Object.fromEntries((reviewsResult.data||[]).map(review=>[review.order_id,review])))};
 useEffect(()=>{if(!session){setOrders([]);setPaymentHistory({});setReturnRecords([]);setSelected(null);setReviews({});setWalletBalance(0);setWalletError("");return}load();const c=supabase.channel(`customer-orders-${session.user.id}`).on("postgres_changes",{event:"*",schema:"public",table:"orders",filter:`customer_id=eq.${session.user.id}`},load).on("postgres_changes",{event:"*",schema:"public",table:"dispatch_returns",filter:`customer_id=eq.${session.user.id}`},load).subscribe();const timer=setInterval(load,15000);return()=>{clearInterval(timer);supabase.removeChannel(c)}},[session?.user?.id]);
 useEffect(()=>{setReviewRating(0);setReviewText("")},[selected?.id]);
 useEffect(()=>{if(!selected||!session){setChat([]);setContact(null);return}let active=true;setChat([]);setContact(null);const c=supabase.channel(`chat-${selected.id}`).on("postgres_changes",{event:"INSERT",schema:"public",table:"chat_messages",filter:`order_id=eq.${selected.id}`},e=>setChat(x=>x.some(m=>m.id===e.new.id)?x:[...x,e.new])).subscribe();Promise.all([supabase.rpc("get_delivery_contacts",{p_order_id:selected.id}),supabase.from("chat_messages").select("*").eq("order_id",selected.id).order("created_at")]).then(([contacts,messages])=>{if(!active)return;if(contacts.error)toast(contacts.error.message);setContact(contacts.data?.[0]||null);if(messages.error){toast(messages.error.message);return}setChat(current=>{const byId=new Map(current.map(m=>[m.id,m]));for(const m of messages.data||[])byId.set(m.id,m);return [...byId.values()].sort((a,b)=>new Date(a.created_at)-new Date(b.created_at))})});return()=>{active=false;supabase.removeChannel(c)}},[selected?.id,session?.user?.id]);
 useEffect(()=>{
  const canTrack=selected?.rider_id&&liveLocationStatuses.has(selected.status);
  if(!canTrack){setLiveRider(null);return}
  let active=true;
  const loadLocation=async()=>{
   try{
    const result=await api("rider-location",{orderId:selected.id},token);
    if(active)setLiveRider(result);
   }catch(error){
    if(active)setLiveRider({location:null,etaMinutes:null,etaStatus:error.message||"Live rider location is unavailable."});
   }
  };
  loadLocation();
  const timer=setInterval(loadLocation,15000);
  return()=>{active=false;clearInterval(timer)};
 },[selected?.id,selected?.rider_id,selected?.status,token]);
 const getQuote=async e=>{e.preventDefault();if(busy)return;if(!termsAccepted)return toast("Please review and accept the dispatch terms before requesting a quote.");const inputSnapshot=JSON.stringify([form,coords]);if(quote&&inputSnapshot===quoteInputRef.current)return toast("This delivery quote has already been submitted.");if(!form.pickup||!form.dropoff||!form.description||!form.recipientName.trim())return toast("Enter pickup, drop-off, package details, and recipient name.");if(!session?.user?.email&&!profile?.email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.customerEmail.trim()))return toast("Enter a valid email address for your Paystack receipt.");if(!coords.pickup||!coords.dropoff)return toast("Select a named address from the suggestions, choose a recent place, use your location, or pin it on the map.");if(!session){sessionStorage.setItem(draftKey,JSON.stringify({form,coords,savedAt:Date.now()}));setDraftSaved(true);open("customer","login");return toast("Your delivery draft is saved on this device. Sign in or create an account to request the secure quote.");}const controller=new AbortController();quoteAbortRef.current=controller;setBusy(true);setQuote(null);try{const d=await api("quote",{pickupAddress:orderAddress(form.pickup,form.pickupInstructions),dropoffAddress:orderAddress(form.dropoff,form.dropoffInstructions),pickupCoordinates:coords.pickup,dropoffCoordinates:coords.dropoff,description:clean(form.description),recipientName:clean(form.recipientName),recipientPhone:clean(form.recipientPhone),customerEmail:clean(form.customerEmail),packageCategory:form.packageCategory,deliverySpeed:form.deliverySpeed,termsVersion:DISPATCH_TERMS_VERSION,termsAccepted:true},token,controller.signal);if(controller.signal.aborted||inputSnapshot!==quoteInputRef.current)return;setOrders(current=>[d.order,...current.filter(order=>order.id!==d.order.id)]);setSelected(d.order);setQuote(d);sessionStorage.removeItem(draftKey);setDraftSaved(false);setTimeout(()=>scrollToSection("customer-quote-status"),0);let notificationError=null;try{await api("notify",{type:"new_delivery",orderId:d.order.id},token)}catch(error){notificationError=error;console.error("Delivery quote was created, but the operations email could not be sent",error)}toast(notificationError?"Quote submitted and visible in the operations dashboard, but its admin email notification failed.":"Delivery quote submitted for FemmaDexDrive price verification.")}catch(error){if(inputSnapshot===quoteInputRef.current&&!controller.signal.aborted)toast(error.message)}finally{if(quoteAbortRef.current===controller){quoteAbortRef.current=null;setBusy(false)}}};
 const pay=async order=>{setBusy(true);try{const d=await api("create-paystack-payment",{orderId:order.id},token);if(d.alreadyPaid){go(`/payment-result?status=success${d.walletOnly?"&walletOnly=1":""}`);return}const checkoutUrl=new URL(d.checkoutUrl);if(checkoutUrl.protocol!=="https:")throw new Error("Paystack returned an invalid checkout link. Please contact support before retrying.");location.assign(checkoutUrl.href)}catch(e){console.error("Could not start delivery payment",e);toast(e.message||"Secure payment could not be started. Please try again.");setBusy(false)}};
 const requestRedelivery=async record=>{setBusy(true);try{const {data,error}=await supabase.rpc("request_return_redelivery",{p_return_id:record.id});if(error)throw error;if(typeof data!=="string"||!data)throw new Error("A redelivery order was not returned. Please contact support before retrying.");await load();toast(`Redelivery quote created for ${money(record.redelivery_fee)}. Continue to secure payment.`);await pay({id:data})}catch(error){toast(`Could not request redelivery: ${error.message}`);setBusy(false)}};
 const useCancelledOrderAsDraft=order=>{setForm({pickup:order.pickup_address||"",dropoff:order.dropoff_address||"",pickupInstructions:"",dropoffInstructions:"",pickupVerification:null,dropoffVerification:null,pickupConfirmed:false,dropoffConfirmed:false,recipientName:order.recipient_name||"",recipientPhone:order.recipient_phone||"",customerEmail:profile?.email||session?.user?.email||"",description:order.goods_description||"",packageCategory:packageCategoryForOrder(order),deliverySpeed:order.delivery_speed||"standard"});setCoords({pickup:order.pickup_latitude!==null&&order.pickup_longitude!==null?{lat:Number(order.pickup_latitude),lng:Number(order.pickup_longitude)}:null,dropoff:order.dropoff_latitude!==null&&order.dropoff_longitude!==null?{lat:Number(order.dropoff_latitude),lng:Number(order.dropoff_longitude)}:null});setQuote(null);scrollToSection("customer-booking-form");toast("Delivery details copied into the booking form. Review each address and get a new quote before paying.")};
 const selectedReturn=returnRecords.find(record=>record.order_id===selected?.id);
 const confirm=async order=>{const {error}=await supabase.rpc("confirm_delivery",{p_order_id:order.id});if(error)return toast(error.message);toast("Delivery confirmed. You can now rate your rider.");load()};
 const submitReview=async event=>{event.preventDefault();if(!selected||selected.status!=="completed"||!selected.rider_id)return;if(reviewRating<1||reviewRating>5)return toast("Choose a rating from 1 to 5 stars.");const review={order_id:selected.id,customer_id:session.user.id,rider_id:selected.rider_id,rating:reviewRating,review_text:reviewText.trim()||null};const {data,error}=await supabase.from("rider_reviews").insert(review).select("order_id,rating,review_text").single();if(error){toast(error.code==="23505"?"This delivery has already been rated.":"Could not submit your rider rating: "+error.message);return}setReviews(current=>({...current,[selected.id]:data}));toast("Thank you for rating your rider.")};
 const send=async e=>{e.preventDefault();if(!selected||!message.trim())return;const {error}=await supabase.from("chat_messages").insert({order_id:selected.id,sender_id:session.user.id,body:clean(message)});if(error)toast(error.message);else setMessage("")};
 if(!session&&!allowGuestBooking)return <Landing open={open}/>;
 return <main className="page customer-particle-page"><section className="hero"><div><span className="eyebrow">{session?`WELCOME ${profile?.full_name||session?.user?.user_metadata?.full_name||"Customer"}`:"GUEST BOOKING DRAFT"}</span><h1>Send goods.<br/><em>Track every handoff.</em></h1><p>{session?"Choose a package category and describe your items. Operations verifies safe vehicle capacity and the final price before payment.":"Prepare your delivery details without signing in. Your draft stays on this device; sign in only when you're ready to request a quote."}</p></div><div className="hero-card"><Package size={34}/><strong>Seamless Delivery Experience</strong><span>Request a Rider → Secure Payment → Fast Delivery.</span></div></section>
 {session&&<section className="panel customer-wallet-card" aria-label="Delivery cashback wallet"><WalletCards size={26}/><div><span className="eyebrow">DELIVERY CREDIT · NOT WITHDRAWABLE</span><strong>{walletError?"Balance unavailable":money(walletBalance)}</strong><p>{walletError||"Earn 2% of the verified price on your seventh completed, paid delivery. Credit is automatically applied to later delivery payments; unused credit carries forward."}</p></div></section>}
 <div className="grid"><section className="panel" id="customer-booking-form"><h2>Book a dispatch</h2><form onSubmit={getQuote} className="form"><p className="draft-status" role="status">{!networkOnline?"Offline — your unsent booking draft stays saved on this device.":draftSaved?"Draft saved on this device for interrupted or slow connections.":""}</p><Address label="Pickup address" value={form.pickup} onChange={v=>{setForm({...form,pickup:v});setCoords(current=>({...current,pickup:null}));setQuote(null)}} onSelect={(address,point)=>{setForm(current=>({...current,pickup:address}));setCoords(current=>({...current,pickup:point}));setQuote(null)}} coordinates={coords.pickup}/><Address label="Receiver address" value={form.dropoff} onChange={v=>{setForm({...form,dropoff:v});setCoords(current=>({...current,dropoff:null}));setQuote(null)}} onSelect={(address,point)=>{setForm(current=>({...current,dropoff:address}));setCoords(current=>({...current,dropoff:point}));setQuote(null)}} coordinates={coords.dropoff}/>{!session?.user?.email&&!profile?.email&&<label>Contact email (for your Paystack receipt)<input type="email" autoComplete="email" required value={form.customerEmail} onChange={event=>setForm(current=>({...current,customerEmail:event.target.value}))} placeholder="you@example.com"/></label>}<fieldset className="package-section"><legend>Delivery category</legend><div className="package-cards">{[{id:"small-medium",title:"Small & Medium Parcel",description:"Documents, phones, clothes, shoes, groceries and small packages.",vehicle:"Standard delivery · ₦1,500 minimum",image:"/images/package-small.jpg"},{id:"bulky",title:"Large & Bulky Items",description:"Furniture, appliances and large or heavy boxes.",vehicle:"4× standard price · suitable vehicle required",image:"/images/package-bulky.jpg"},{id:"fast",title:"Fast Delivery — Within 2 Hours",description:"Urgent small and medium parcels.",vehicle:"2× standard price · 2-hour target after rider acceptance",image:"/images/package-fast.jpg"}].map(item=>{const selectedCard=item.id==="small-medium"?form.deliverySpeed==="standard"&&form.packageCategory!=="bulky":item.id==="bulky"?form.packageCategory==="bulky"&&form.deliverySpeed==="standard":form.deliverySpeed==="fast";return <label className={`package-card ${selectedCard?"selected":""}`} key={item.id}><input type="radio" name="deliveryCategory" value={item.id} checked={selectedCard} onChange={()=>setForm(current=>item.id==="bulky"?{...current,packageCategory:"bulky",deliverySpeed:"standard"}:item.id==="fast"?{...current,packageCategory:current.packageCategory==="bulky"?"medium":current.packageCategory,deliverySpeed:"fast"}:{...current,packageCategory:current.packageCategory==="bulky"?"small":current.packageCategory,deliverySpeed:"standard"})}/><img src={item.image} alt=""/><span className="package-card-copy"><strong>{item.title}</strong><small>{item.description}</small><small className="package-vehicle">{item.vehicle}</small></span></label>})}</div>{form.packageCategory!=="bulky"&&<div className="package-size-estimate"><span>Estimated parcel size for standard pricing:</span><label><input type="radio" name="estimatedPackageSize" value="small" checked={form.packageCategory==="small"} onChange={()=>setForm(current=>({...current,packageCategory:"small"}))}/> Small</label><label><input type="radio" name="estimatedPackageSize" value="medium" checked={form.packageCategory==="medium"} onChange={()=>setForm(current=>({...current,packageCategory:"medium"}))}/> Medium</label></div>}<p className="package-safety">Category is a guide, not a measurement or capacity guarantee. FemmaDexDrive operations will verify the quoted vehicle and price before payment; oversized or uncertain loads may need inspection.</p></fieldset><label>Package description<textarea required value={form.description} onChange={e=>setForm({...form,description:e.target.value})} placeholder="Describe the item(s) so operations can verify the vehicle"/></label><label>Recipient name<input required maxLength="120" value={form.recipientName} onChange={e=>setForm({...form,recipientName:e.target.value})} placeholder="Who will receive it?"/></label><label>Recipient phone<input type="tel" maxLength="40" value={form.recipientPhone} onChange={e=>setForm({...form,recipientPhone:e.target.value})} placeholder="Optional"/></label><button className="primary wide" disabled={busy}>{busy?"Calculating…":"Calculate delivery price"} <ArrowRight size={18}/></button></form>
 <div className="terms-consent"><label><input type="checkbox" checked={termsAccepted} onChange={event=>setTermsAccepted(event.target.checked)}/> I have read and agree to the <a href="/terms" target="_blank" rel="noreferrer">dispatch terms and return policy</a>, including the recipient-unavailable redelivery charge.</label></div>
 {quote&&<div className="quote"><span className="eyebrow">DELIVERY QUOTE</span><h3>Awaiting price verification</h3><div className="two"><span><b>{quote.distanceKm} km</b><small>OpenRouteService road distance</small></span><span><b>{quote.durationMinutes} min</b><small>Estimated driving time</small></span></div><p>Your delivery price is being verified by FemmaDexDrive. Payment will be available after operations approves the price.</p></div>}</section>
 <section className="panel">
  <div className="panel-head"><h2>My deliveries</h2><RefreshCw size={18}/></div>
  {orders.length===0?<Empty text="Your deliveries will appear here."/>:orders.map(order=>{const latestPayment=paymentHistory[order.id];const paymentLabel=order.payment_status==="paid"?"Paid":latestPayment?.status==="failed"?"Payment failed · Unpaid":latestPayment?.status==="pending"?"Payment processing":order.payment_status==="unpaid"?"Unpaid":order.payment_status;return <button className={`order ${selected?.id===order.id?"selected":""}`} key={order.id} onClick={()=>setSelected(order)}><div><b>{order.tracking_number}</b><small>{order.pickup_address} → {order.dropoff_address}</small><small>{packageCategoryLabels[packageCategoryForOrder(order)]}</small></div><span>{statusLabels[order.status]||order.status}<small>{paymentLabel}</small></span><strong>{["pending_admin_review","rejected","expired","price_review"].includes(order.status)?"Price under review":money(order.final_price)}</strong></button>})}
  {selected&&<div className="selected-detail" id="customer-quote-status">
   <h3>{selected.tracking_number}</h3>
   <p><strong>Package category:</strong> {packageCategoryLabels[packageCategoryForOrder(selected)]} · {selected.goods_description}</p>
   <p><strong>Service:</strong> {deliverySpeedLabels[selected.delivery_speed]||"Standard delivery"}</p>
   {selected.delivery_speed==="fast"&&selected.pickup_deadline_at&&<PickupDeadline acceptedAt={selected.accepted_at} deadlineAt={selected.pickup_deadline_at}/>}
   {selected.vehicle_type&&<p><strong>Operations vehicle selection:</strong> {selected.vehicle_type}</p>}
   <p><strong>Pickup:</strong> {selected.pickup_address}</p>
   <p><strong>Drop-off:</strong> {selected.dropoff_address}</p>
   <p><strong>Payment:</strong> {selected.payment_status==="paid"?"Paid":paymentHistory[selected.id]?.status==="failed"?"Payment failed. Order remains unpaid; you can retry securely below.":selected.payment_status==="unpaid"?"Unpaid":selected.payment_status}</p>
   {selected.payment_status==="paid"&&!selected.rider_id&&!["completed","cancelled"].includes(selected.status)&&<div className="notice"><b>Waiting for a rider</b><br/>Your payment is confirmed. The delivery remains in the matching queue until an eligible rider accepts it.</div>}
   {selected.rider_id&&liveLocationStatuses.has(selected.status)&&<div className="notice rider-tracking"><b>Assigned rider location and arrival estimate</b>{liveRider?.location?<><p>{liveRider.etaMinutes===null?liveRider.etaStatus:`About ${liveRider.etaMinutes} minutes to the recipient · ${liveRider.etaStatus}`}</p><small>Last location update: {fmt(liveRider.location.updatedAt)}</small><MapLink label="View rider's last reported location" address="" lat={liveRider.location.latitude} lng={liveRider.location.longitude}/></>:<p>{liveRider?.etaStatus||"Waiting for the rider's first location update."}</p>}</div>}
   <div className="two"><span><b>{selected.distance_km||"—"} km</b><small>Verified driving distance</small></span><span><b>{selected.duration_minutes||"—"} min</b><small>Estimated driving time</small></span></div>
   <div className="location-links"><MapLink label="Pickup map" address={selected.pickup_address} lat={selected.pickup_latitude} lng={selected.pickup_longitude}/><MapLink label="Destination map" address={selected.dropoff_address} lat={selected.dropoff_latitude} lng={selected.dropoff_longitude}/></div>
   {selected.rider_id&&contactStatuses.has(selected.status)&&<div className="contact-actions"><button className="secondary" onClick={()=>scrollToSection("customer-chat")}><MessageCircle size={16}/> Chat with rider</button><button className="primary" onClick={()=>scrollToSection("customer-call")}><Phone size={16}/> Call rider</button></div>}
   <div className="timeline">{["awaiting_payment","paid","accepted","picked_up","on_the_way","at_door","delivered","completed"].map(step=><span className={["completed","delivered","at_door","on_the_way","picked_up","accepted","paid"].includes(selected.status)&&["awaiting_payment","paid","accepted","picked_up","on_the_way","at_door","delivered","completed"].indexOf(step)<=["awaiting_payment","paid","accepted","picked_up","on_the_way","at_door","delivered","completed"].indexOf(selected.status)?"done":""} key={step}/>)}</div>
   {selected.status==="pending_admin_review"&&(selected.quote_expires_at&&new Date(selected.quote_expires_at).getTime()<=Date.now()?<div className="notice">This delivery quote has expired. Please calculate a new quote.</div>:<div className="notice"><b>Awaiting price verification</b><br/>Your delivery price is being verified by FemmaDexDrive. Payment is unavailable until operations approves the price.</div>)}
   {selected.status==="approved"&&<div className="quote"><span className="eyebrow">DELIVERY SUMMARY</span><h3>{money(selected.final_price)}</h3><p><b>Verified vehicle:</b> {selected.vehicle_type}</p><p><b>Pickup:</b> {selected.pickup_address}</p><p><b>Drop-off:</b> {selected.dropoff_address}</p><p>{selected.distance_km} km · {selected.duration_minutes} min estimated driving time</p><p>✓ Price verified by FemmaDexDrive. Continue only if you approve this final vehicle and price.</p>{walletBalance>0&&<p className="wallet-payment-note"><WalletCards size={15}/> {money(walletBalance)} delivery credit will be applied automatically at checkout.</p>}<button className="primary wide" onClick={()=>pay(selected)} disabled={busy}>{busy?"Preparing secure payment…":"Continue to Payment"}</button></div>}
   {selected.status==="awaiting_payment"&&<>{walletBalance>0&&<p className="wallet-payment-note"><WalletCards size={15}/> {money(walletBalance)} delivery credit will be applied automatically at checkout.</p>}<button className="primary wide" onClick={()=>pay(selected)} disabled={busy}>{busy?"Preparing secure payment…":`Pay ${money(selected.final_price)} securely`}</button></>}
   {selected.status==="completed"&&selected.rider_id&&<div className="notice rider-review" id="rider-review"><b>Your delivery is complete. How was your rider?</b>{reviews[selected.id]?<p role="status">Thank you — you rated this delivery {reviews[selected.id].rating} out of 5 stars.{reviews[selected.id].review_text?` “${reviews[selected.id].review_text}”`:""}</p>:<form onSubmit={submitReview}><p>Your rating helps us improve delivery service.</p><div className="rider-review-stars" role="radiogroup" aria-label="Rate your rider from 1 to 5 stars">{[1,2,3,4,5].map(value=><button type="button" key={value} role="radio" aria-checked={reviewRating===value} aria-label={`${value} ${value===1?"star":"stars"}`} className={reviewRating>=value?"selected":""} onClick={()=>setReviewRating(value)}><Star size={23} fill={reviewRating>=value?"currentColor":"none"}/></button>)}</div><label>Optional comment<textarea value={reviewText} onChange={event=>setReviewText(event.target.value)} maxLength={1000} rows={3} placeholder="Share a short note about your delivery"/></label><button className="primary" disabled={reviewRating<1}>Submit rider rating</button></form>}</div>}
   {selected.status==="rejected"&&<div className="notice">Your delivery quote requires further review. Please try again or contact FemmaDexDrive.</div>}
   {(selected.status==="expired"||selected.status==="price_review")&&<div className="notice">{selected.status==="expired"?"This delivery quote has expired. Please calculate a new quote.":"Operations is reviewing the delivery price. Payment will appear here when the final price is confirmed."}</div>}
   {selected.status==="delivered"&&<button className="primary wide" onClick={()=>confirm(selected)}>Confirm delivery</button>}
   {selected.status==="cancelled"&&<div className="notice"><b>Cancelled delivery details remain available.</b><br/>Use these details as a starting draft for a new quote; no new order is created until you request one.<button className="secondary wide" onClick={()=>useCancelledOrderAsDraft(selected)}>Use details as a booking draft</button></div>}
   {selectedReturn&&<div className="notice return-status"><b>Returned goods · {selectedReturn.status.replaceAll("_"," ")}</b><p>{selectedReturn.customer_notified_at?`Customer notified ${fmt(selectedReturn.customer_notified_at)}. Collection deadline: ${fmt(selectedReturn.collection_deadline_at)}.`:"Operations must record when you were notified before the collection period begins."}</p><p>Original dispatch price: {money(selectedReturn.original_price)} · Total redelivery charge: {money(selectedReturn.redelivery_fee)} (45% of the original price, not added to it).</p>{selectedReturn.status==="awaiting_collection"&&selectedReturn.customer_notified_at&&new Date(selectedReturn.collection_deadline_at).getTime()>Date.now()&&<button className="primary wide" disabled={busy} onClick={()=>requestRedelivery(selectedReturn)}>{busy?"Preparing secure checkout…":`Request redelivery for ${money(selectedReturn.redelivery_fee)}`}</button>}{selectedReturn.status==="redelivery_requested"&&selectedReturn.redelivery_order_id&&<p>Redelivery was requested. Select its separate delivery record to retry payment if checkout was interrupted.</p>}{selectedReturn.status==="unclaimed"&&<p>The collection deadline has passed. Contact FemmaDexDrive Operations to discuss lawful next steps.</p>}</div>}
   <a className="track-link" href={`/track?tracking=${encodeURIComponent(selected.tracking_number)}`}>Open public tracking</a>
  </div>}
 </section></div>
 {selected&&selected.rider_id&&contactStatuses.has(selected.status)&&<section className="panel chat" id="customer-chat"><div className="panel-head"><div><span className="eyebrow">PRIVATE DELIVERY CHAT</span><h2>Customer ↔ Rider</h2>{contact?.rider_name&&<small className="chat-contact">{contact.rider_name} · {contact.rider_phone||"Phone unavailable"}</small>}</div><MessageCircle/></div><div className="chatbox">{chat.map(m=><div className={m.sender_id===session.user.id?"mine":"theirs"} key={m.id}>{m.body}<small>{fmt(m.created_at)}</small></div>)}</div><form className="chat-form" onSubmit={send}><input aria-label="Message rider" value={message} onChange={e=>setMessage(e.target.value)} placeholder="Message rider"/><button className="primary" aria-label="Send message"><Send size={17}/></button></form></section>}</main>
}

function Customer({session,profile,booking=false,open,toast}){return <><CustomerDashboard session={session} profile={profile} allowGuestBooking={booking} open={open} toast={toast}/>{session&&<CustomerDispatchUpdates supabase={supabase} customerId={session.user.id} toast={toast}/>}{session&&<CustomerVoiceCalls session={session} supabase={supabase} toast={toast}/>}<PublicServiceGuide/><CustomerCareChat session={profile?.role==="customer"?session:null} supabase={supabase} toast={toast} open={open}/></>}
function DispatchTerms(){return <main className="page narrow"><section className="panel"><span className="eyebrow">CUSTOMER TERMS · DRAFT FOR LEGAL REVIEW</span><h1>Dispatch, failed-delivery and unclaimed-goods terms</h1><p>These proposed terms explain what happens when a sender or recipient is unavailable. They should be reviewed by a qualified lawyer in the applicable jurisdiction before being relied on as a contract.</p><h2>Availability and failed collection</h2><p>The customer must provide accurate pickup and destination details and ensure the sender and intended recipient (or an authorised representative) are available at the agreed location. The rider may report an unsuccessful pickup or delivery, and FemmaDexDrive may contact the customer and record the incident.</p><h2>Sender unavailable at pickup</h2><p>If the sender is unavailable when the rider attends, Operations may cancel that dispatch. Cancellation does not itself change the payment record or promise a refund. The customer may use the saved delivery details to request a new quote; any payment or refund is handled separately under the applicable payment terms.</p><h2>Recipient unavailable after handover</h2><p>If the recipient is unavailable after the rider has collected the goods, FemmaDexDrive may return the goods to the sender or another agreed safe location and record the return. A redelivery requested by the customer costs 45% of the original dispatch price as the total redelivery charge, not the original price plus another 45%. Redelivery is subject to confirmation by Operations and payment of that charge before the new delivery is arranged.</p><h2>Unclaimed returned goods</h2><p>After notifying the customer that the goods are ready for collection, FemmaDexDrive will hold them for three working days (Monday to Friday; weekends are excluded). After that period, FemmaDexDrive may take reasonable steps permitted by applicable law to handle the unclaimed goods. Nothing in these terms excludes liability that cannot lawfully be excluded, including liability arising from FemmaDexDrive&apos;s negligence or wilful misconduct.</p><h2>Price and payment</h2><p>The dispatch price is calculated from the selected route, package details, service and Operations&apos; approved quote. Payment is made through the existing secure checkout only after quote approval. A failed delivery report does not authorise an automatic charge or refund; Operations will confirm any redelivery arrangement and the amount due.</p><p><strong>Important:</strong> This is a practical draft, not legal advice or a guarantee of enforceability. Obtain local legal review and publish the final version with your company&apos;s registered details and contact information.</p><a className="primary" href="/book">Continue to booking</a></section></main>}
function PublicServiceGuide(){return <section className="panel service-guide"><span className="eyebrow">FEMMADEXDRIVE CUSTOMER INFORMATION</span><h2>How to book a delivery</h2><p>Prepare your delivery draft without signing in. Select pickup and destination on the map, describe the goods and recipient, and choose a dispatch type. Sign in or create a customer account when you are ready to request a quote. Operations checks the vehicle and approves the final price. Pay securely through Paystack only after approval; rider matching and live updates follow confirmed payment.</p><div className="actions"><a className="primary" href="/book">Open the booking dashboard</a><a className="secondary" href="/terms">Read dispatch and failed-delivery terms</a></div><h3 id="siri-shortcut-setup"> for femmadexdrive</h3><ol><li>Open the Shortcuts app and create a new shortcut.</li><li>Add the “URL” action and enter <code>https://femmadexdrive.netlify.app/book</code>.</li><li>Add “Open URLs”, name the shortcut “Book FemmaDexDrive”, then add it to Siri or say “Book FemmaDexDrive”.</li><li>Confirm map locations, sign in to request a quote, then review the approved price and use secure Paystack checkout.</li></ol><p>This opens the mobile-friendly website; it is not a native Siri integration. Voice input availability depends on the browser and device.</p><h3>Frequently asked questions</h3><details><summary>When can I pay?</summary><p>After FemmaDexDrive Operations verifies the vehicle and approves the delivery price. Payment uses the secure Paystack checkout.</p></details><details><summary>What if the recipient is unavailable?</summary><p>Operations may arrange return to sender. Requested redelivery costs 45% of the original dispatch price in total. See the <a href="/terms">full draft terms</a>.</p></details></section>}
function Landing({open}){return <main className="landing customer-particle-page"><div className="landing-copy"><span className="eyebrow">FEMMADEXDRIVE · LOCAL DELIVERY, MADE CLEAR</span><h1>Delivery that moves with you.</h1><p>Book a dispatch, get a road-distance quote, pay securely, then follow the delivery from rider assignment to doorstep.</p><div className="actions landing-actions"><button className="primary big" onClick={()=>go("/book")}>Book a Delivery <ArrowRight/></button><button className="secondary big" onClick={()=>dispatchEvent(new Event("fdd-open-care"))}><Mic/> Talk to AI</button></div><div className="landing-secondary" role="navigation" aria-label="More delivery options"><a href="/rider">Become a Rider <ArrowRight size={14}/></a><a href="/track">Track a Package <ArrowRight size={14}/></a></div></div><img src="/images/delivery-hero.jpg" alt="A FemmaDexDrive rider delivering a parcel" className="landing-img" fetchpriority="high"/><section className="cards"><Info icon={<Navigation/>} title="Route-based delivery" text="Choose pickup and destination, then review your route-based quote before confirming."/><Info icon={<Box/>} title="A suitable delivery option" text="Select a parcel category; Operations confirms vehicle suitability and approves the final price."/><Info icon={<ShieldCheck/>} title="Secure checkout" text="Pay through Paystack only after your delivery quote has been approved."/><Info icon={<MessageCircle/>} title="Help when you need it" text="Get FemmaDexCare assistance or continue through the secure booking dashboard."/></section></main>}
function Info({icon,title,text}){return <article className="info"><div>{icon}</div><h3>{title}</h3><p>{text}</p></article>}

function Empty({text}){return <div className="empty"><Package size={18}/>{text}</div>}
function PickupDeadline({acceptedAt,deadlineAt,etaMinutes,etaStatus}){
 const [now,setNow]=useState(Date.now());
 useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer)},[]);
 const remaining=Math.max(0,new Date(deadlineAt).getTime()-now);
 const hours=Math.floor(remaining/3600000);
 const minutes=Math.floor((remaining%3600000)/60000);
 const seconds=Math.floor((remaining%60000)/1000);
 const validEta=Number.isFinite(etaMinutes)&&etaMinutes>=0;
 return <div className="notice delivery-timing">
  <b>Fast delivery · pickup timing</b>
  <p>Accepted: {fmt(acceptedAt)} · Pickup arrival deadline: {fmt(deadlineAt)}</p>
  <p role="status" aria-live="polite">{remaining===0?"Pickup-arrival deadline passed. Contact operations for assistance.":`Time to pickup deadline: ${String(hours).padStart(2,"0")}:${String(minutes).padStart(2,"0")}:${String(seconds).padStart(2,"0")}`}</p>
  {validEta?<p>Route estimate to pickup: about {etaMinutes} minutes · expected arrival {fmt(new Date(now+etaMinutes*60000))}{etaStatus?` · ${etaStatus}`:""}</p>:etaStatus?<p>{etaStatus}</p>:null}
  {validEta&&remaining>0&&etaMinutes*60000>remaining&&<p><strong>Late-arrival warning:</strong> the current route estimate exceeds the remaining pickup window. Contact operations.</p>}
 </div>;
}
function MapLink({label,address,lat,lng}){const hasCoordinates=lat!==null&&lat!==undefined&&lng!==null&&lng!==undefined&&Number.isFinite(Number(lat))&&Number(lat)>=-90&&Number(lat)<=90&&Number.isFinite(Number(lng))&&Number(lng)>=-180&&Number(lng)<=180;const query=hasCoordinates?`${Number(lat)},${Number(lng)}`:String(address||"").trim();if(!query)return null;return <a className="map-link" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`} target="_blank" rel="noreferrer"><MapPin size={14}/>{label}</a>}

function PaymentResult(){const params=new URLSearchParams(location.search),[status]=useState(params.get("status")||"pending"),walletOnly=params.get("walletOnly")==="1";return <main className="center"><CheckCircle2 size={48} color="var(--accent)"/><h1>{status==="success"?"Payment received":"Payment status: "+status}</h1><p>{status==="success"?walletOnly?"Your delivery credit covered the full approved price. The credit has been applied and your delivery is ready for dispatch.":"Your payment is confirmed. Your delivery will become available to eligible riders.":"If you just completed payment, wait a moment and refresh your customer dashboard. The payment is verified before dispatching the order."}</p><button className="primary" onClick={()=>go("/")}>Back to FEMADEXDRIVE</button></main>}
function LoginLanding({open}){return <main className="center"><section className="result"><img className="brand-logo setup-logo" src="/images/Logo-mark.png" alt="FemmaDexDrive logo"/><span className="eyebrow">ACCOUNT ACCESS</span><h1>Sign in to FemmaDexDrive</h1><p>You have been signed out. Choose an account and sign in again to open its dashboard.</p><button className="primary" onClick={()=>open("customer","login")}><LogIn size={16}/> Sign in</button></section></main>}
function Tracker(){
 const [tracking,setTracking]=useState(new URLSearchParams(location.search).get("tracking")||""),[order,setOrder]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState("");
 const find=async e=>{e?.preventDefault();setBusy(true);setError("");try{const d=await api("public-track",{tracking:tracking.trim()});setOrder(d.order)}catch(e){setError(e.message);setOrder(null)}finally{setBusy(false)}};
 useEffect(()=>{if(tracking)find()},[]);
 return <main className="page narrow"><section className="panel"><span className="eyebrow">PUBLIC TRACKING</span><h1>Track your delivery</h1><p>Enter your tracking number to view delivery status. This page does not show exact locations or live GPS tracking.</p><form className="search" onSubmit={find}><input value={tracking} onChange={e=>setTracking(e.target.value.toUpperCase())} placeholder="FDD-XXXXXXXX"/><button className="primary" disabled={busy}>{busy?"Searching…":"Track"}</button></form>{error&&<div className="error">{error}</div>}{order&&<div className="track-result"><div className="order-top"><b>{order.tracking_number}</b><span>{statusLabels[order.status]||order.status}</span></div><p>Delivery progress</p><div className="tracking-line">{["accepted","picked_up","on_the_way","at_door","delivered","completed"].map(s=><div key={s} className={order.status===s||order.completed_steps?.includes(s)?"done":""}><i/><small>{statusLabels[s]}</small></div>)}</div></div>}</section></main>
}

function RiderLegacy({session,profile,open,toast}){
 const [jobs,setJobs]=useState([]),[active,setActive]=useState(null),[locationOrder,setLocationOrder]=useState(null),[pickupEstimate,setPickupEstimate]=useState(null),[online,setOnline]=useState(profile?.rider?.is_online||false),[acceptingOrderId,setAcceptingOrderId]=useState(null),[message,setMessage]=useState(""),[chat,setChat]=useState([]),[contact,setContact]=useState(null);
 const [problemReason,setProblemReason]=useState(""),[problemType,setProblemType]=useState("other");

 const load=async()=>{if(!session)return;try{const [available,mineResult]=await Promise.all([api("rider-offers",{},session.access_token),supabase.from("orders").select("*").eq("rider_id",session.user.id).order("created_at",{ascending:false})]);if(mineResult.error)throw mineResult.error;const all=[...(available.offers||[]),...(mineResult.data||[])];setJobs(all);setActive(current=>current?all.find(x=>x.id===current.id)||current:all.find(x=>x.rider_id===session.user.id&&!["completed","cancelled"].includes(x.status))||null)}catch(error){toast(`Could not refresh rider deliveries: ${error.message}`)}};
 useEffect(()=>{if(!session)return;if(profile?.role!=="rider"||profile?.rider?.approval_status!=="approved")return;load();const c=supabase.channel(`rider-${session.user.id}`).on("postgres_changes",{event:"*",schema:"public",table:"orders"},load).on("postgres_changes",{event:"*",schema:"public",table:"riders",filter:`id=eq.${session.user.id}`},load).on("postgres_changes",{event:"*",schema:"public",table:"rider_offers",filter:`rider_id=eq.${session.user.id}`},load).subscribe();const timer=setInterval(load,15000);return()=>{clearInterval(timer);supabase.removeChannel(c)}},[session?.user?.id,profile?.role,profile?.rider?.approval_status,profile?.rider?.is_online]);
 useEffect(()=>{
  if(profile?.role!=="rider"||profile.rider?.approval_status!=="approved"||!active||!["accepted","picked_up","on_the_way","at_door"].includes(active.status))return;
  if(!navigator.geolocation){toast("Live rider location is unavailable in this browser.");return}
  let lastSentAt=0,writing=false,reportedError=false;
  const watchId=navigator.geolocation.watchPosition(async position=>{
   const now=Date.now();
   if(writing||now-lastSentAt<15000)return;
   writing=true;
   try{
    const {error}=await supabase.rpc("update_assigned_rider_location",{
     p_lat:position.coords.latitude,
     p_lng:position.coords.longitude
    });
    if(error){if(!reportedError){reportedError=true;toast(`Could not update delivery location: ${error.message}`)}}
    else lastSentAt=now;
   }catch(error){
    if(!reportedError){reportedError=true;toast(`Could not update delivery location: ${error.message}`)}
   }finally{writing=false}
  },error=>{
   if(!reportedError){reportedError=true;toast(`Live location is unavailable: ${error.message}`)}
  },{enableHighAccuracy:true,maximumAge:10000,timeout:20000});
  return()=>navigator.geolocation.clearWatch(watchId);
 },[active?.id,active?.status,profile?.role,profile?.rider?.approval_status,toast]);
 useEffect(()=>{
  if(profile?.role!=="rider"||!session||active?.rider_id!==session.user.id||!active||!["accepted","picked_up","on_the_way","at_door"].includes(active.status)){
   setPickupEstimate(null);
   return;
  }
  let current=true;
  const refresh=async()=>{
   try{
    const result=await api("rider-location",{orderId:active.id},session.access_token);
    if(current)setPickupEstimate(result);
   }catch(error){
    if(current)setPickupEstimate({etaMinutes:null,etaStatus:error.message||"Pickup route estimate is unavailable."});
   }
  };
  refresh();
  const timer=setInterval(refresh,15000);
  return()=>{current=false;clearInterval(timer)};
 },[active?.id,active?.rider_id,active?.status,profile?.role,session?.access_token,session?.user?.id]);
 useEffect(()=>{setOnline(!!profile?.rider?.is_online)},[profile?.rider?.is_online]);
 useEffect(()=>{if(profile?.role==="rider"&&profile.rider?.approval_status==="approved"&&!profile.rider?.vehicle_type)toast("Your account is approved, but Operations must verify and set your vehicle type before compatible paid deliveries can appear.")},[profile?.role,profile?.rider?.approval_status,profile?.rider?.vehicle_type]);
 const hasActiveDispatch=jobs.some(order=>order.rider_id===session?.user?.id&&!["completed","cancelled"].includes(order.status))||(!!active&&!!session&&active.rider_id===session.user.id&&!["completed","cancelled"].includes(active.status));
 useEffect(()=>{
  if(profile?.role!=="rider"||profile.rider?.approval_status!=="approved"||!online||hasActiveDispatch||!navigator.geolocation)return;
  let lastSentAt=0,writing=false,reportedError=false;
  const watchId=navigator.geolocation.watchPosition(async position=>{
   const now=Date.now();
   if(writing||now-lastSentAt<30000)return;
   writing=true;
   try{
    const {error}=await supabase.rpc("update_rider_presence",{
     p_is_online:true,
     p_lat:position.coords.latitude,
     p_lng:position.coords.longitude
    });
    if(error){if(!reportedError){reportedError=true;toast(`Could not refresh your online availability: ${error.message}`)}}
    else lastSentAt=now;
   }catch(error){
    if(!reportedError){reportedError=true;toast(`Could not refresh your online availability: ${error.message}`)}
   }finally{writing=false}
  },error=>{
   if(!reportedError){reportedError=true;toast(`Fast-delivery pickup estimates need a current location: ${error.message}`)}
  },{enableHighAccuracy:true,maximumAge:10000,timeout:20000});
  return()=>navigator.geolocation.clearWatch(watchId);
 },[hasActiveDispatch,online,profile?.role,profile?.rider?.approval_status,toast]);
 useEffect(()=>{if(!active||!session){setChat([]);setContact(null);return}let isCurrent=true;setChat([]);setContact(null);const c=supabase.channel(`rchat-${active.id}`).on("postgres_changes",{event:"INSERT",schema:"public",table:"chat_messages",filter:`order_id=eq.${active.id}`},e=>setChat(x=>x.some(m=>m.id===e.new.id)?x:[...x,e.new])).subscribe();Promise.all([supabase.rpc("get_delivery_contacts",{p_order_id:active.id}),supabase.from("chat_messages").select("*").eq("order_id",active.id).order("created_at")]).then(([contacts,messages])=>{if(!isCurrent)return;if(contacts.error)toast(contacts.error.message);setContact(contacts.data?.[0]||null);if(messages.error){toast(messages.error.message);return}setChat(current=>{const byId=new Map(current.map(m=>[m.id,m]));for(const m of messages.data||[])byId.set(m.id,m);return [...byId.values()].sort((a,b)=>new Date(a.created_at)-new Date(b.created_at))})});return()=>{isCurrent=false;supabase.removeChannel(c)}},[active?.id,session?.user?.id]);
 const presence=async()=>{const n=!online;const update=(lat,lng)=>supabase.rpc("update_rider_presence",{p_is_online:n,p_lat:lat,p_lng:lng});const save=async(lat,lng)=>{const {data,error}=await update(lat,lng);if(error)return toast(error.message);setOnline(!!data?.is_online);await load()};if(!navigator.geolocation){await save(null,null);return}navigator.geolocation.getCurrentPosition(p=>save(p.coords.latitude,p.coords.longitude),()=>save(null,null),{enableHighAccuracy:true,timeout:12000})};
 const accept=async o=>{if(hasActiveDispatch)return toast("Complete your current delivery before accepting another.");if(acceptingOrderId)return;setAcceptingOrderId(o.id);try{const {data,error}=await supabase.rpc("accept_order",{p_order_id:o.id});if(error)throw error;setActive(data);setJobs(current=>[...current.filter(job=>job.id!==data.id),data]);toast("Delivery accepted.");await load()}catch(error){toast(error.message)}finally{setAcceptingOrderId(null)}};
 const decline=async(o,reason)=>{const {error}=await supabase.rpc("decline_order",{p_order_id:o.id,p_reason:reason||null});if(error)return toast(error.message);toast("Delivery declined. It remains available to other compatible riders.");await load()};
 const advance=async s=>{const {data,error}=await supabase.rpc("advance_order",{p_order_id:active.id,p_status:s});if(error)return toast(error.message);setActive(data);load();toast(`Updated: ${statusLabels[s]}`)};
 const reportProblem=async event=>{event.preventDefault();if(!active||problemReason.trim().length<3)return toast("Describe the delivery problem before submitting.");if(problemType==="other"){const {error}=await supabase.rpc("report_delivery_problem",{p_order_id:active.id,p_reason:problemReason.trim()});if(error)return toast(error.message);setProblemReason("");toast("Operations has been notified about the delivery problem.");return}const {data,error}=await supabase.rpc("report_delivery_exception",{p_order_id:active.id,p_issue:problemType,p_reason:problemReason.trim()});if(error)return toast(error.message);setProblemReason("");setProblemType("other");if(problemType==="sender_unavailable"){setActive(data);toast("Pickup failure recorded. This dispatch was cancelled without changing payment; its delivery details remain available to the customer as a draft.")}else{setActive(data);toast("Recipient-unavailable report sent to Operations. Keep the goods safe and follow the return/handover instructions.")}};
 const send=async e=>{e.preventDefault();if(!message.trim()||!active)return;const {error}=await supabase.from("chat_messages").insert({order_id:active.id,sender_id:session.user.id,body:clean(message)});if(error)toast(error.message);else setMessage("")};
 if(!session)return <RiderLanding open={open}/>;
 if(profile?.role!=="rider")return <Blocked title="Rider account required"/>;
 if(profile.rider?.approval_status==="suspended")return <Blocked title="Rider account temporarily suspended" detail="You cannot receive delivery offers while suspended. Contact FemmaDexDrive operations for assistance."/>;
 if(profile.rider?.approval_status!=="approved")return <PendingRider session={session} toast={toast} approvalStatus={profile.rider?.approval_status||"pending"}/>;
 return <main className="page">
  <section className="hero rider-hero">
   <div><span className="eyebrow">RIDER PORTAL</span><h1>Take the right jobs.<br/><em>Move them safely.</em></h1>
    <p>Review eligible paid offers and report delivery problems directly to operations.</p>
    <p className="notice">{hasActiveDispatch?"Assigned to a delivery":online?"Online and available":"Offline"} · {profile.rider?.vehicle_type||"Vehicle not registered"}</p>
    <button className={online?"secondary big":"primary big"} onClick={presence}><Radio/> {online?"Go offline":"Go online"}</button>
   </div><img src="/images/rider-hero.jpg" className="landing-img" alt="Rider"/><div className="rider-bike-particles" aria-hidden="true"><Bike size={24}/><i/><i/><i/></div>
  </section>
  <div className="grid">
   <section className="panel"><h2>Available deliveries</h2>
    {!online?<Empty text="You are offline and will not receive offers."/>:<RiderDispatch offers={jobs.filter(order=>["paid","searching"].includes(order.status)&&!order.rider_id)} hasActiveDispatch={hasActiveDispatch} acceptingOrderId={acceptingOrderId} onAccept={accept} onDecline={decline}/>}
   </section>
   <section className="panel"><h2>{active?active.tracking_number:"Active delivery"}</h2>
    {!active?<Empty text="Accept a delivery to control its stages."/>:<>
     <div className="route"><span>Pickup<br/><b>{active.pickup_address}</b></span><ArrowRight/><span>Destination<br/><b>{active.dropoff_address}</b></span></div>
     <div className="location-links"><MapLink label="Open pickup map" address={active.pickup_address} lat={active.pickup_latitude} lng={active.pickup_longitude}/><MapLink label="Open destination map" address={active.dropoff_address} lat={active.dropoff_latitude} lng={active.dropoff_longitude}/><NavigationLink label="Navigate to pickup" lat={active.pickup_latitude} lng={active.pickup_longitude}/><NavigationLink label="Navigate to customer" lat={active.dropoff_latitude} lng={active.dropoff_longitude}/></div>
     <button className="secondary" type="button" onClick={()=>setLocationOrder(active)}>View Customer Location</button>
     <p><strong>Recipient:</strong> {active.recipient_name||"Not provided"}{active.recipient_phone?` · ${active.recipient_phone}`:""}</p>
     <p><strong>Service:</strong> {deliverySpeedLabels[active.delivery_speed]||"Standard delivery"}{active.delivery_speed==="fast"&&!active.pickup_deadline_at?" · pickup-arrival deadline starts on acceptance":""}</p>
     {active.delivery_speed==="fast"&&active.pickup_deadline_at&&<PickupDeadline acceptedAt={active.accepted_at} deadlineAt={active.pickup_deadline_at} etaMinutes={pickupEstimate?.etaMinutes} etaStatus={pickupEstimate?.etaStatus}/>}
     <p><strong>Vehicle:</strong> {active.vehicle_type} · <strong>Package:</strong> {packageCategoryLabels[packageCategoryForOrder(active)]} · {active.goods_description}{active.weight_kg?` · ${active.weight_kg} kg`:""} · <strong>Delivery price:</strong> {money(active.final_price)}</p>
     {contactStatuses.has(active.status)&&<div className="contact-actions"><button className="secondary" onClick={()=>scrollToSection("rider-chat")}><MessageCircle size={16}/> Chat with customer</button><button className="primary" onClick={()=>scrollToSection("rider-call")}><Phone size={16}/> Call customer</button></div>}
     <div className="actions">{active.status==="accepted"&&<button className="primary" onClick={()=>advance("picked_up")}>Package picked up</button>}{active.status==="picked_up"&&<button className="primary" onClick={()=>advance("on_the_way")}>Start moving</button>}{active.status==="on_the_way"&&<button className="primary" onClick={()=>advance("at_door")}>Arrived at destination</button>}{active.status==="at_door"&&<button className="primary" onClick={()=>advance("delivered")}>Send delivery confirmation</button>}</div>
     {["accepted","picked_up","on_the_way","at_door"].includes(active.status)&&<form className="form" onSubmit={reportProblem}>
      <label>Problem type<select value={problemType} onChange={event=>setProblemType(event.target.value)}><option value="other">Other delivery problem</option>{active.status==="accepted"&&<option value="sender_unavailable">Sender unavailable at pickup</option>}{["on_the_way","at_door"].includes(active.status)&&<option value="recipient_unavailable">Recipient unavailable at destination</option>}</select></label>
      <label>Report a delivery problem<textarea value={problemReason} maxLength="1000" onChange={event=>setProblemReason(event.target.value)} placeholder="Describe what needs operations attention"/></label>
      <button className="secondary" disabled={problemReason.trim().length<3}>Notify operations</button>
     </form>}
     <div className="chat-room-head" id="rider-chat"><div><span className="eyebrow">PRIVATE DELIVERY CHAT</span><b>{contact?.customer_name||"Customer"}</b></div><span>{contact?.customer_phone||"Phone unavailable"}</span></div>
     <div className="chatbox">{chat.map(m=><div className={m.sender_id===session.user.id?"mine":"theirs"} key={m.id}>{m.body}<small>{fmt(m.created_at)}</small></div>)}</div>
     <form className="chat-form" onSubmit={send}><input aria-label="Message customer" value={message} onChange={e=>setMessage(e.target.value)} placeholder="Message customer"/><button className="primary" aria-label="Send message"><Send size={16}/></button></form>
    </>}
   </section>
  </div>
  {locationOrder&&<DeliveryLocationMap order={locationOrder} riderLocation={{lat:profile?.rider?.lat,lng:profile?.rider?.lng}} onClose={()=>setLocationOrder(null)}/>}
 </main>;

}
function Rider({session,profile,open,toast}){return <>{session&&profile?.role==="rider"&&<RiderWallet session={session} toast={toast}/>}<RiderLegacy session={session} profile={profile} open={open} toast={toast}/>{session&&profile?.role==="rider"&&profile?.rider?.approval_status==="approved"&&<RiderVoiceCalls session={session} supabase={supabase} toast={toast}/>}</>}

function PendingRider({session,toast,approvalStatus}){const [bike,setBike]=useState(null),[idFile,setIdFile]=useState(null),[busy,setBusy]=useState(false);const upload=async()=>{if(!bike&&!idFile)return toast("Select a bike/vehicle photo or identity document.");setBusy(true);try{for(const [file,kind] of [[bike,"bike"],[idFile,"identity"]]){if(!file)continue;const path=`${session.user.id}/${kind}-${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g,"_")}`;const {error}=await supabase.storage.from("rider-documents").upload(path,file,{upsert:false});if(error)throw error;const {error:updateError}=await supabase.rpc("save_rider_document_path",{p_kind:kind,p_path:path});if(updateError)throw updateError}toast("Documents uploaded for operations review.")}catch(e){toast(e.message)}finally{setBusy(false)}};const rejected=approvalStatus==="rejected";return <main className="center"><div className="setup"><Clock3 size={42}/><h1>{rejected?"Application needs review":"Application under review"}</h1><p>{rejected?"Operations could not approve this rider application. Contact FemmaDexDrive support for the review details and next steps.":<>Your rider details are under review. You&apos;ll be notified when an admin approves your application. Delivery access, chat, and calls will become available after approval.</>}</p>{!rejected&&<div className="form"><label>Bike / vehicle photo<input type="file" accept="image/*" onChange={e=>setBike(e.target.files?.[0]||null)}/></label><label>Identity document<input type="file" accept="image/*,.pdf" onChange={e=>setIdFile(e.target.files?.[0]||null)}/></label><button className="primary wide" disabled={busy} onClick={upload}>{busy?"Uploading…":"Submit verification files"}</button></div>}</div></main>}
function RiderLanding({open}){return <main className="landing rider-hero"><div><span className="eyebrow">RIDER NETWORK</span><h1>Join the delivery network.</h1><p>Apply with your rider, vehicle and identity information. Operations reviews the application before live dispatch access.</p><div className="actions"><button className="primary big" onClick={()=>open("rider","signup")}>Apply as rider <UserPlus/></button><button className="secondary big" onClick={()=>open("rider","login")}>Rider login <LogIn/></button></div></div><img src="/images/rider-hero.jpg" className="landing-img" alt="Rider"/><div className="rider-bike-particles" aria-hidden="true"><Bike size={24}/><i/><i/><i/></div></main>}

function Admin({session,profile,open,toast}){
 const [orders,setOrders]=useState([]),[riders,setRiders]=useState([]),[selected,setSelected]=useState(null),[price,setPrice]=useState(""),[reviewDetails,setReviewDetails]=useState(null),[adminNote,setAdminNote]=useState(""),[completedCount,setCompletedCount]=useState(null),[lastUpdated,setLastUpdated]=useState(null),[liveStatus,setLiveStatus]=useState("connecting"),[hasMoreHistory,setHasMoreHistory]=useState(false),[loadingHistory,setLoadingHistory]=useState(false),[search,setSearch]=useState(""),[statusFilter,setStatusFilter]=useState("all");
 const historyInitialized=useRef(false),historyCursor=useRef(null);
 const load=async()=>{if(!session||!["admin","supervisor"].includes(profile?.role))return;const orderFields="*,customer:profiles!orders_customer_id_fkey(full_name,email),rider:riders!orders_rider_id_fkey(display_name)";const fetchActive=async()=>{const collected=[];for(let offset=0;;offset+=500){const {data,error}=await supabase.from("orders").select(orderFields).not("status","in","(completed,cancelled)").order("created_at",{ascending:false}).order("id",{ascending:false}).range(offset,offset+499);if(error)return{data:null,error};const page=data||[];collected.push(...page);if(page.length<500)break}return{data:collected,error:null}};const [activeResult,historyResult,ridersResult,completedResult]=await Promise.all([fetchActive(),supabase.from("orders").select(orderFields).in("status",["completed","cancelled"]).order("created_at",{ascending:false}).order("id",{ascending:false}).range(0,199),supabase.from("riders").select("*").order("created_at",{ascending:false}),supabase.from("orders").select("id",{count:"exact",head:true}).eq("status","completed")]);if(activeResult.error){toast(`Could not load active deliveries: ${activeResult.error.message}`);return}if(historyResult.error){toast(`Could not load delivery history: ${historyResult.error.message}`);return}if(ridersResult.error){toast(`Could not load rider applications: ${ridersResult.error.message}`);return}if(completedResult.error){toast(`Could not load completed-delivery count: ${completedResult.error.message}`);return}const history=historyResult.data||[];const rows=[...(activeResult.data||[]),...history].sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));const latestIds=new Set(rows.map(item=>item.id));setOrders(current=>[...rows,...current.filter(item=>["completed","cancelled"].includes(item.status)&&!latestIds.has(item.id))]);setRiders(ridersResult.data||[]);setCompletedCount(completedResult.count);setLastUpdated(new Date());if(!historyInitialized.current){historyInitialized.current=true;const oldest=history[history.length-1];historyCursor.current=oldest?{created_at:oldest.created_at,id:oldest.id}:null;setHasMoreHistory(history.length===200)}setSelected(current=>current?rows.find(item=>item.id===current.id)||current:null)};
 const loadOlderHistory=async()=>{if(loadingHistory||!hasMoreHistory||!historyCursor.current)return;setLoadingHistory(true);try{const cursor=historyCursor.current;const {data,error}=await supabase.from("orders").select("*,customer:profiles!orders_customer_id_fkey(full_name,email),rider:riders!orders_rider_id_fkey(display_name)").in("status",["completed","cancelled"]).or(`created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`).order("created_at",{ascending:false}).order("id",{ascending:false}).range(0,199);if(error)throw error;const page=data||[];setOrders(current=>{const known=new Set(current.map(item=>item.id));return [...current,...page.filter(item=>!known.has(item.id))]});const oldest=page[page.length-1];historyCursor.current=oldest?{created_at:oldest.created_at,id:oldest.id}:cursor;setHasMoreHistory(page.length===200)}catch(error){toast(`Could not load older delivery records: ${error.message}`)}finally{setLoadingHistory(false)}};
 useEffect(()=>{if(!session||!["admin","supervisor"].includes(profile?.role))return;void load();const c=supabase.channel(`admin-live-${session.user.id}`).on("postgres_changes",{event:"*",schema:"public",table:"orders"},load).on("postgres_changes",{event:"*",schema:"public",table:"riders"},load).subscribe(status=>setLiveStatus(status==="SUBSCRIBED"?"connected":status==="CHANNEL_ERROR"||status==="TIMED_OUT"?"disconnected":"connecting"));const timer=setInterval(()=>void load(),30000);return()=>{clearInterval(timer);supabase.removeChannel(c)}},[session?.user?.id,profile?.role]);
 useEffect(()=>{if(!selected||!session||!["admin","supervisor"].includes(profile?.role)){setReviewDetails(null);return}let active=true;setReviewDetails(null);supabase.rpc("get_admin_delivery_quote",{p_order_id:selected.id}).then(({data,error})=>{if(!active)return;if(error){toast(`Could not load quote review details: ${error.message}`);return}const details=data?.[0]||null;setReviewDetails(details);if(details?.status==="pending_admin_review")setPrice(String(details.suggested_price))}).catch(error=>{if(active)toast(`Could not load quote review details: ${error.message}`)});return()=>{active=false}},[selected?.id,selected?.status,session?.user?.id,profile?.role]);
 const approve=async(id,yes)=>{const {error}=await supabase.rpc("approve_rider",{p_rider_id:id,p_approved:yes});if(error)return toast(error.message);load();if(!yes)return toast("Rider rejected");try{await api("notify",{type:"rider_approved",riderId:id},session.access_token);toast("Rider approved and confirmation email sent.")}catch(notificationError){console.error("Rider approval saved, but notification email failed",notificationError);toast(`Rider approved in Supabase, but confirmation email failed: ${notificationError.message}`)}};
 const notifyDispatchAlert=async alertId=>api("notify",{type:"dispatch_admin_alert",alertId},session.access_token);
 const setFinal=async()=>{if(!selected)return;const {data,error}=await supabase.rpc("approve_delivery_quote",{p_order_id:selected.id,p_price:Number(price),p_admin_note:adminNote||null});if(error)return toast(error.message);setSelected(data);setReviewDetails(current=>current?{...current,approved_price:Number(price),status:"approved",reviewed_by:session.user.id,reviewed_at:new Date().toISOString(),admin_note:adminNote||null}:current);setAdminNote("");toast("Price approved and customer payment enabled.");load()};
 const rejectQuote=async()=>{if(!selected)return;const {data,error}=await supabase.rpc("reject_delivery_quote",{p_order_id:selected.id,p_admin_note:adminNote||null});if(error)return toast(error.message);setSelected(data);setReviewDetails(current=>current?{...current,status:"rejected",reviewed_by:session.user.id,reviewed_at:new Date().toISOString(),admin_note:adminNote||null}:current);setAdminNote("");toast("Delivery quote rejected.");load()};
 const active=orders.filter(o=>!["completed","cancelled"].includes(o.status));
 const filteredOrders=orders.filter(order=>{
  const query=search.trim().toLowerCase();
  const matchesQuery=!query||[order.tracking_number,order.customer?.full_name,order.pickup_address,order.dropoff_address,order.rider?.display_name].some(value=>String(value||"").toLowerCase().includes(query));
  return matchesQuery&&(statusFilter==="all"||order.status===statusFilter);
 });
 const awaitingPrice=active.filter(order=>["pending_admin_review","price_review"].includes(order.status)).length;
 const awaitingRider=active.filter(order=>["paid","searching"].includes(order.status)&&!order.rider_id).length;
 const activeDispatches=active.filter(order=>["accepted","picked_up","on_the_way","at_door","delivered"].includes(order.status)).length;
 if(!session)return <main className="center admin-signin"><div className="admin-signin-card"><button className="primary big" onClick={()=>open("admin","login")}><LogIn size={18}/> Sign in</button><div><span className="eyebrow">FEMMADEXDRIVE OPERATIONS</span><h1>Admin sign in</h1><p>Sign in to open the live operations control hub.</p></div></div></main>;
 if(!["admin","supervisor"].includes(profile?.role))return <Blocked title="Not authorized"/>;
 return <main className="page admin-dashboard">
  <div className="admin-head"><div><span className="eyebrow">OPERATIONS</span><h1>FemmaDexDrive control</h1><p>Review suggested delivery prices before customers can pay.</p><small className={`live-indicator ${liveStatus}`}>{liveStatus==="connected"?"Live updates connected":liveStatus==="disconnected"?"Live updates interrupted":"Connecting to live updates"}{lastUpdated?` · Updated ${lastUpdated.toLocaleTimeString()}`:""}</small></div><button className="secondary" onClick={load}><RefreshCw/> Refresh</button></div>
  <div className="metrics"><Metric n={active.length} t="Active records"/><Metric n={awaitingPrice} t="Price reviews"/><Metric n={awaitingRider} t="Awaiting rider"/><Metric n={activeDispatches} t="In dispatch"/><Metric n={completedCount??"—"} t="Completed deliveries"/><Metric n={riders.filter(r=>r.is_online).length} t="Riders online"/></div>
  <nav className="admin-quick-nav" aria-label="Operations dashboard sections"><a href="#admin-support"><Headphones size={17}/> Customer chats</a><a href="#admin-records"><Package size={17}/> Delivery activity</a><a href="#admin-riders"><Bike size={17}/> Rider fleet</a><a href="#admin-dispatch"><Navigation size={17}/> Dispatch control</a><a href="#admin-calls"><Phone size={17}/> Delivery calls</a></nav>
  <AdminSupportInbox supabase={supabase} session={session} toast={toast}/>
  <div className="grid">
   <section className="panel admin-records" id="admin-records"><div className="panel-head"><h2>Delivery records</h2><span>{orders.length} loaded</span></div><div className="admin-filters"><input aria-label="Search delivery records" placeholder="Search tracking, customer, address, rider" value={search} onChange={event=>setSearch(event.target.value)}/><select aria-label="Filter by delivery status" value={statusFilter} onChange={event=>setStatusFilter(event.target.value)}><option value="all">All statuses</option>{[...new Set(orders.map(order=>order.status))].sort().map(status=><option key={status} value={status}>{statusLabels[status]||status}</option>)}</select></div>{filteredOrders.length?filteredOrders.map(order=><button className="order" key={order.id} onClick={()=>{setSelected(order);setPrice(String(order.final_price||""));setAdminNote("")}}><div><b>{order.tracking_number}</b><small>{order.customer?.full_name||"Customer"} · {fmt(order.created_at)}</small></div><span>{statusLabels[order.status]||order.status}</span><strong>{["pending_admin_review","price_review","rejected","expired"].includes(order.status)?"Review required":money(order.final_price)}</strong></button>):<Empty text="No delivery records match these filters."/>}{hasMoreHistory&&<button className="secondary history-more" disabled={loadingHistory} onClick={loadOlderHistory}>{loadingHistory?"Loading records…":"Load older records"}</button>}</section>
   <section className="panel admin-riders" id="admin-riders"><h2>Rider applications</h2>{riders.filter(r=>r.approval_status==="pending").map(r=><div className="job" key={r.id}><b>{r.display_name}</b><p>{r.vehicle_type} · {r.vehicle_registration}</p><div className="actions"><button className="primary" onClick={()=>approve(r.id,true)}>Approve</button><button className="secondary" onClick={()=>approve(r.id,false)}>Reject</button></div></div>)}{riders.filter(r=>r.approval_status==="pending").length===0&&<Empty text="No pending rider applications."/>}</section>
  </div>
  {selected&&<section className="panel">
   <h2>{selected.tracking_number}</h2>
   <div className="detail">
    <span><small>Customer</small><b>{selected.customer?.full_name||"Customer"}</b><small>{selected.customer?.email||"Email unavailable"}</small></span>
    <span><small>Pickup</small><b>{selected.pickup_address}</b><small>{selected.pickup_latitude}, {selected.pickup_longitude}</small></span>
    <span><small>Drop-off</small><b>{selected.dropoff_address}</b><small>{selected.dropoff_latitude}, {selected.dropoff_longitude}</small></span>
    <span><small>Recipient</small><b>{selected.recipient_name||"Not provided"}</b><small>{selected.recipient_phone||"Phone unavailable"}</small></span>
    <span><small>Package category / contents</small><b>{packageCategoryLabels[packageCategoryForOrder(selected)]}</b><small>{selected.goods_description} · {selected.weight_kg===null?"Actual weight not provided":`${selected.weight_kg} kg`}</small></span>
    <span><small>Dimensions</small><b>{[selected.length_cm,selected.width_cm,selected.height_cm].some(value=>value!==null)?`${selected.length_cm||"—"} × ${selected.width_cm||"—"} × ${selected.height_cm||"—"} cm`:"Not provided"}</b></span>
    <span><small>Road distance / ETA</small><b>{selected.distance_km||"—"} km · {selected.duration_minutes||"—"} min</b><small>{selected.distance_meters??reviewDetails?.distance_meters??"—"} m · {selected.duration_seconds??reviewDetails?.duration_seconds??"—"} sec</small></span>
    <span><small>Vehicle</small><b>{selected.vehicle_type}</b></span>
    <span><small>System suggested price</small><b>{reviewDetails?money(reviewDetails.suggested_price):selected.status==="price_review"?money(selected.system_price):"—"}</b></span>
    <span><small>Approved price</small><b>{reviewDetails?.status==="approved"&&reviewDetails.approved_price?money(reviewDetails.approved_price):"Not approved"}</b></span>
    <span><small>Quote review</small><b>{reviewDetails?.status?.replaceAll("_"," ")||"Review record unavailable"}</b></span>
    <span><small>Payment</small><b>{selected.payment_status}</b></span>
    <span><small>Status</small><b>{statusLabels[selected.status]||selected.status}</b></span>
   </div>
   {reviewDetails?.reviewed_at&&<p className="address-hint">Reviewed {fmt(reviewDetails.reviewed_at)} · Admin note: {reviewDetails.admin_note||"—"}</p>}
   {reviewDetails?.status==="pending_admin_review"&&<div className="form">
    <label>Approved customer price (NGN)<input type="number" min="1" step="1" value={price} onChange={event=>setPrice(event.target.value)}/></label>
    <label>Admin note (optional)<textarea maxLength="1000" value={adminNote} onChange={event=>setAdminNote(event.target.value)}/></label>
    <div className="actions"><button className="primary" disabled={!Number(price)} onClick={setFinal}>Approve price and send to customer</button><button className="secondary" onClick={rejectQuote}>Reject quote</button></div>
   </div>}
   {!reviewDetails&&["price_review","awaiting_payment"].includes(selected.status)&&<div className="form"><label>Final price (NGN)<input type="number" min="1" step="1" value={price} onChange={event=>setPrice(event.target.value)}/></label><button className="primary" onClick={setFinal}>Save final price</button></div>}
  </section>}
  <AdminDispatchControls supabase={supabase} session={session} profile={profile} orders={orders} riders={riders} selected={selected} toast={toast} refresh={load} notifyAdmin={notifyDispatchAlert}/>
  {profile.role==="admin"&&<AdminWalletPayouts session={session} supabase={supabase} toast={toast}/>}
 </main>
}
function Metric({n,t}){return <div className="metric"><b>{n}</b><span>{t}</span></div>}

function AdminCallLogs({session,toast}){
 const [calls,setCalls]=useState([]),[loading,setLoading]=useState(true);
 const load=async()=>{const {data,error}=await supabase.from("call_logs").select("id,call_type,status,started_at,duration_seconds,order:orders!call_logs_order_id_fkey(tracking_number),caller:profiles!call_logs_caller_id_fkey(full_name,email),receiver:profiles!call_logs_receiver_id_fkey(full_name,email)").order("created_at",{ascending:false}).limit(100);if(error){toast(error.message);setLoading(false);return}setCalls(data||[]);setLoading(false)};
 useEffect(()=>{void load();const channel=supabase.channel(`admin-calls-${session.user.id}`).on("postgres_changes",{event:"*",schema:"public",table:"call_logs"},load).subscribe();return()=>supabase.removeChannel(channel)},[session.user.id]);
 return <main className="page voice-call-page" id="admin-calls"><section className="panel"><div className="panel-head"><div><span className="eyebrow">PRIVATE COMPANY LOG</span><h2>Recent delivery calls</h2></div><Phone/></div>{loading?<Empty text="Loading call activity…"/>:calls.length===0?<Empty text="Completed voice calls will appear here."/>:calls.map(call=><article className="job call-log" key={call.id}><div className="order-top"><b>{call.order?.tracking_number||"Delivery"}</b><strong>{call.status}</strong></div><p>{call.caller?.full_name||call.caller?.email||"Caller"} → {call.receiver?.full_name||call.receiver?.email||"Recipient"}</p><small>{call.call_type.toUpperCase()} · {fmt(call.started_at)} · {call.duration_seconds??0}s</small></article>)}</section></main>;
}

function Auth({role,mode,close,toast}){
 const [email,setEmail]=useState(""),[password,setPassword]=useState(""),[name,setName]=useState(""),[phone,setPhone]=useState(""),[vehicle,setVehicle]=useState(""),[plate,setPlate]=useState(""),[bike,setBike]=useState(null),[idFile,setIdFile]=useState(null),[busy,setBusy]=useState(false),[msg,setMsg]=useState("");
 const transferGuestCareMemory=async(previousSession,conversation)=>{
  if(!previousSession?.user?.is_anonymous||!conversation?.conversationId)return"";
  const {data:{session:authenticatedSession}}=await supabase.auth.getSession();
  if(!authenticatedSession)throw new Error("Your signed-in session could not be restored.");
  let response;
  try{
   response=await fetch(`${API_BASE}/care-chat`,{
    method:"POST",
    headers:{"Content-Type":"application/json",Authorization:`Bearer ${authenticatedSession.access_token}`},
    body:JSON.stringify({transferConversationId:conversation.conversationId,previousAccessToken:previousSession.access_token})
   });
   const result=await response.json().catch(()=>({}));
   if(!response.ok)throw new Error(result.error||"The conversation could not be attached to your account.");
   const saved=JSON.parse(localStorage.getItem("fddCareConversation")||sessionStorage.getItem("fddCareConversation")||"null");
   if(saved?.conversationId===conversation.conversationId){
    localStorage.setItem("fddCareConversation",JSON.stringify({...saved,ownerId:authenticatedSession.user.id}));
    dispatchEvent(new Event("fdd-care-memory-updated"));
   }
   return"";
  }catch(caught){
   try{
    const saved=JSON.parse(localStorage.getItem("fddCareConversation")||sessionStorage.getItem("fddCareConversation")||"null");
    if(saved?.conversationId===conversation.conversationId){
     localStorage.setItem("fddCareConversation",JSON.stringify({...saved,ownerId:authenticatedSession.user.id,memoryTransferError:caught.message}));
     dispatchEvent(new Event("fdd-care-memory-updated"));
    }
   }catch(storageError){
    return`Signed in, but the FemmaDexCare conversation could not be transferred: ${caught.message}. The local chat copy could not be updated: ${storageError.message}.`;
   }
   return`Signed in, but the FemmaDexCare conversation could not be transferred: ${caught.message}. Your previous chat remains visible in this tab.`;
  }
 };
 const submit=async e=>{
  e.preventDefault();setBusy(true);setMsg("");
  try{
   if(mode==="login"){
    const {data:{session:previousSession}}=await supabase.auth.getSession();
    let conversation=null;
    try{conversation=JSON.parse(localStorage.getItem("fddCareConversation")||sessionStorage.getItem("fddCareConversation")||"null")}
    catch{localStorage.removeItem("fddCareConversation");sessionStorage.removeItem("fddCareConversation")}
    const destination=await signInAndGetDashboard(email,password);
    const transferMessage=destination==="/"&&previousSession?.user?.is_anonymous
     ?await transferGuestCareMemory(previousSession,conversation)
     :"";
    close();go(destination);toast(transferMessage||"Signed in.");
    return;
   }
   if(role==="admin")throw new Error("Admin accounts are created and authorized in Supabase; public signup is disabled.");
   const dashboardPath=role==="rider"?"/rider":role==="customer_care"?"/care":"/";
   const {data,error}=await supabase.auth.signUp({email:email.trim(),password,options:{emailRedirectTo:`${location.origin}${dashboardPath}`,data:{full_name:name.trim(),phone:phone.trim(),requested_role:role,vehicle_type:vehicle,vehicle_registration:plate.trim()}}});
   if(error)throw error;
   if(data.user&&role!=="customer_care")api("notify",{type:role==="rider"?"new_rider":"new_customer"},data.session?.access_token).catch(()=>{});
   if(data.session&&data.user){
    let documentError=null;
    if(role==="rider"&&(bike||idFile)){try{await uploadRiderDocuments(data.user.id,bike,idFile)}catch(error){documentError=error}}
    const destination=await dashboardForUser(data.user.id);
    close();go(destination);
    toast(documentError?`Account created. Upload verification files in your rider portal: ${documentError.message}`:"Account created and signed in.");
   }else setMsg(role==="rider"?"Account created. Check your email to confirm. After signing in at the rider page, upload your vehicle and identity documents.":role==="customer_care"?"Application received. Confirm your email, then wait for Operations to approve customer-care access.":"Account created. Check your email to confirm, then sign in.");
  }catch(caught){setMsg(caught.message)}
  finally{setBusy(false)}
 };
 return <div className="modal" onClick={close}><div className="modal-card" onClick={e=>e.stopPropagation()}><button className="close" onClick={close}><X/></button><span className="eyebrow">{role.toUpperCase()}</span><h2>{mode==="signup"?"Create account":"Sign in"}</h2><form className="form" onSubmit={submit}>{mode==="signup"&&<><label>Full name<input required value={name} onChange={e=>setName(e.target.value)}/></label><label>Phone<input required value={phone} onChange={e=>setPhone(e.target.value)}/></label>{role==="rider"&&<><label>Vehicle type<select required value={vehicle} onChange={e=>setVehicle(e.target.value)}><option value="">Select</option> <option>Motorcycle</option><option>Car</option><option>Truck</option><option>Van</option><option>Lorry</option></select></label><label>Plate number<input value={plate} onChange={e=>setPlate(e.target.value)}/></label><label>Bike/vehicle image<input type="file" accept="image/*" onChange={e=>setBike(e.target.files?.[0]||null)}/></label><label>Identity document<input type="file" accept="image/*,.pdf" onChange={e=>setIdFile(e.target.files?.[0]||null)}/></label></>}</>}<label>Email<input type="email" required value={email} onChange={e=>setEmail(e.target.value)}/></label><label>Password<input type="password" {...(mode==="signup"?{minLength:8}:{})} required value={password} onChange={e=>setPassword(e.target.value)}/></label>{mode==="login"&&<button type="button" className="ghost recovery" onClick={async()=>{if(!email)return setMsg("Enter your email first.");const {error}=await supabase.auth.resetPasswordForEmail(email,{redirectTo:`${location.origin}/`});setMsg(error?error.message:"Password reset instructions sent if that account exists.")}}>Forgot password?</button>}{msg&&<div className="notice">{msg}</div>}<button className="primary wide" disabled={busy}>{busy?"Working…":mode==="signup"?"Create account":"Sign in"} <ArrowRight size={17}/></button></form></div></div>
}

async function dashboardForUser(userId){const {data:accountProfile,error:profileError}=await supabase.from("profiles").select("role").eq("id",userId).maybeSingle();if(profileError)throw new Error(`Your account role could not be loaded: ${profileError.message}`);const actualRole=String(accountProfile?.role||"").toLowerCase();const destination=actualRole==="customer"?"/":actualRole==="rider"?"/rider":actualRole==="customer_care"?"/care":["admin","supervisor"].includes(actualRole)?"/admin":null;if(!destination)throw new Error("Your account has no valid profile role. Ask the company to finish setting up your profile.");return destination}
async function signInAndGetDashboard(email,password){const {data,error}=await supabase.auth.signInWithPassword({email:email.trim(),password});if(error)throw error;try{return await dashboardForUser(data.user.id)}catch(e){await supabase.auth.signOut();throw e}}
async function uploadRiderDocuments(userId,bike,idFile){for(const [file,kind] of [[bike,"bike"],[idFile,"identity"]]){if(!file)continue;const safeName=file.name.replace(/[^a-zA-Z0-9._-]/g,"_"),path=`${userId}/${kind}-${Date.now()}-${safeName}`;const {error:uploadError}=await supabase.storage.from("rider-documents").upload(path,file,{upsert:false});if(uploadError)throw uploadError;const {error:updateError}=await supabase.rpc("save_rider_document_path",{p_kind:kind,p_path:path});if(updateError)throw updateError}}

function Footer(){return <footer><div><img className="brand-logo footer-logo" src="/images/Logo-mark.png" alt="FemmaDexDrive logo"/><strong>FemmaDexDrive</strong><p>Customer delivery, rider operations and auditable dispatch tracking.</p></div><div><button onClick={()=>go("/book")}>Book dispatch</button><button onClick={()=>go("/rider")}>Join riders</button><button onClick={()=>go("/care")}>Customer-care team</button><button onClick={()=>go("/track")}>Track delivery</button><button onClick={()=>go("/terms")}>Dispatch terms</button></div><small>© {new Date().getFullYear()} FemmaDexDrive · Created by VibesTech</small></footer>}
