import type { LoaderFunctionArgs } from "react-router";
import { authenticateAppProxyRequest } from "../subscriptions/app-proxy";
import { verifyPortalToken } from "../subscriptions/portal";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const proxy = authenticateAppProxyRequest(request);
  const token = new URL(request.url).searchParams.get("token") || "";
  try {
    const access = verifyPortalToken(token);
    if (access.shopDomain !== proxy.shop) throw new Error("Shop mismatch");
  } catch {
    return html("Subscription link expired", "Request a new secure link from the store.", "", 401);
  }
  const encodedToken = JSON.stringify(token).replace(/</g, "\\u003c");
  const script = `<script>const token=${encodedToken};const root=document.getElementById('root');async function api(body){const r=await fetch('/apps/subscriptions/portal?token='+encodeURIComponent(token),{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const d=await r.json();if(!r.ok||!d.ok)throw new Error(d.error||'Request failed');return d}async function load(){try{const d=await api();root.innerHTML=(d.groups||[]).map(g=>'<section><h2>'+esc(g.status)+' subscription</h2><p>'+g.lines.map(l=>l.quantity+' × '+esc(l.productTitle)).join(', ')+'</p><p>Next: '+(g.nextChargeAt?new Date(g.nextChargeAt).toLocaleDateString('en-IN'):'—')+'</p><button onclick="act(\\''+g.id+'\\',\\'skip\\')">Skip next</button> <button onclick="act(\\''+g.id+'\\',\\''+(g.status==='paused'?'resume':'pause')+'\\')">'+(g.status==='paused'?'Resume':'Pause')+'</button> <button onclick="act(\\''+g.id+'\\',\\'cancel\\')">Cancel at cycle end</button></section>').join('')||'<p>No subscription found.</p>'}catch(e){root.textContent=e.message}}async function act(groupId,action){await api({groupId,action});load()}function esc(v){const d=document.createElement('div');d.textContent=v||'';return d.innerHTML}load()</script>`;
  return html("Manage subscriptions", "Use the controls below for future deliveries.", script);
};

function html(title: string, message: string, script: string, status = 200) {
  return new Response(`<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>${title}</title><style>body{font-family:system-ui;max-width:720px;margin:50px auto;padding:20px;color:#18181b}section{border:1px solid #e5e1d8;border-radius:10px;padding:18px;margin:14px 0}button{background:#112557;color:#fff;border:0;border-radius:7px;padding:9px 12px;margin:3px}</style></head><body><h1>${title}</h1><p>${message}</p><div id="root"></div>${script}</body></html>`, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
