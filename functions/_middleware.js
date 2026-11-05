// Cloudflare Pages Function : transmet /.netlify/functions/* vers Netlify côté serveur.
// Le navigateur ne contacte donc plus jamais *.netlify.app (utile quand ce domaine est bloqué).
// (v12) Relaie aussi /__/auth/* vers Firebase pour la connexion Google.
// Variable optionnelle (Cloudflare > Settings > Variables) : API_ORIGIN = https://votre-site.netlify.app
const DEFAULT_API_ORIGIN = 'https://noria-statistique.netlify.app';

export async function onRequest(context) {
  const url = new URL(context.request.url);

  // Connexion Google (Firebase Auth) : relais /__/auth/* et /__/firebase/* vers Firebase, sans passer par Netlify.
  if (url.pathname.startsWith('/__/auth/') || url.pathname.startsWith('/__/firebase/')) {
    const fbTarget = 'https://statanalyse-pro.firebaseapp.com' + url.pathname + url.search;
    const fbHeaders = new Headers(context.request.headers);
    fbHeaders.delete('host');
    const fbMethod = context.request.method;
    try {
      const r = await fetch(fbTarget, {
        method: fbMethod,
        headers: fbHeaders,
        body: (fbMethod !== 'GET' && fbMethod !== 'HEAD') ? context.request.body : undefined,
        redirect: 'manual',
      });
      return new Response(r.body, { status: r.status, statusText: r.statusText, headers: r.headers });
    } catch (e) {
      return new Response('Firebase Auth injoignable', { status: 502 });
    }
  }

  if (!url.pathname.startsWith('/.netlify/functions/')) return context.next();

  const apiOrigin = String((context.env && context.env.API_ORIGIN) || DEFAULT_API_ORIGIN).replace(/\/$/, '');
  const target = apiOrigin + url.pathname + url.search;

  const headers = new Headers(context.request.headers);
  headers.delete('host');
  const ip = context.request.headers.get('CF-Connecting-IP');
  if (ip) headers.set('x-forwarded-for', ip);

  const method = context.request.method;
  const hasBody = method !== 'GET' && method !== 'HEAD';
  try {
    const res = await fetch(target, {
      method,
      headers,
      body: hasBody ? context.request.body : undefined,
      redirect: 'manual',
    });
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Passerelle Netlify injoignable : ' + (e && e.message || e) }), {
      status: 502, headers: { 'Content-Type': 'application/json' },
    });
  }
}
