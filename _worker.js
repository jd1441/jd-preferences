// Cloudflare Pages — advanced-mode Worker (single file at repo root).
// Serves the static preferences page and handles POST /api/preferences,
// updating the contact in Mailchimp via the Marketing API.
//
// The ONLY required env var is MAILCHIMP_API_KEY (a secret). The audience
// and group IDs are discovered automatically from the account by name, so
// no other configuration is needed. MAILCHIMP_AUDIENCE_ID may optionally be
// set to pin a specific audience.

const AUDIENCE_NAME = "Jing Daily Subscriber List";

// Form checkbox key -> the Mailchimp group name to match, and whether to
// disambiguate duplicate names by picking the one with the most subscribers
// (used for "The Daily", which exists in more than one category).
const GROUP_TARGETS = {
  the_daily: { name: "The Daily", byMaxSubs: true },
  jing_daily_pro: { name: "Jing Daily Pro", byMaxSubs: false },
  sunday_roundup: { name: "The Sunday Roundup", byMaxSubs: false },
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/preferences") {
      if (request.method === "GET") return handleGet(request, env);
      if (request.method === "POST") return handlePreferences(request, env);
      return json({ error: "Method not allowed." }, 405);
    }
    return env.ASSETS.fetch(request);
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Cached discovery result, reused for the life of the isolate.
let discoveryCache = null;

async function discover(apiKey, audienceOverride) {
  if (discoveryCache) return discoveryCache;

  const dc = apiKey.split("-").pop();
  const base = "https://" + dc + ".api.mailchimp.com/3.0";
  const headers = { Authorization: "Basic " + btoa("any:" + apiKey) };
  const getJson = async (path) => {
    const r = await fetch(base + path, { headers });
    if (!r.ok) throw new Error("Mailchimp API " + r.status + " for " + path);
    return r.json();
  };

  // Find the audience (list).
  let listId = audienceOverride || null;
  if (!listId) {
    const lists = (await getJson("/lists?count=200&fields=lists.id,lists.name")).lists || [];
    const match = lists.find((l) => l.name === AUDIENCE_NAME) || lists[0];
    if (!match) throw new Error("No audience found.");
    listId = match.id;
  }

  // Gather every interest (group) across all categories.
  const cats = (await getJson("/lists/" + listId + "/interest-categories?count=200")).categories || [];
  let interests = [];
  for (const c of cats) {
    const r = await getJson("/lists/" + listId + "/interest-categories/" + c.id + "/interests?count=200");
    interests = interests.concat(r.interests || []);
  }

  const pick = (name, byMaxSubs) => {
    const matches = interests.filter(
      (i) => (i.name || "").trim().toLowerCase() === name.toLowerCase()
    );
    if (!matches.length) return null;
    if (byMaxSubs) matches.sort((a, b) => (b.subscriber_count || 0) - (a.subscriber_count || 0));
    return matches[0].id;
  };

  const groups = {};
  for (const key of Object.keys(GROUP_TARGETS)) {
    groups[key] = pick(GROUP_TARGETS[key].name, GROUP_TARGETS[key].byMaxSubs);
  }

  discoveryCache = { listId, groups };
  return discoveryCache;
}

// GET /api/preferences?email=... -> the contact's current group membership,
// so the page can pre-check the boxes to reflect what they're already on.
async function handleGet(request, env) {
  const url = new URL(request.url);
  const email = (url.searchParams.get("email") || "").trim().toLowerCase();
  const groups = { the_daily: false, jing_daily_pro: false, sunday_roundup: false };

  if (!email || email.indexOf("@") === -1) {
    return json({ error: "A valid email address is required." }, 400);
  }

  const apiKey = env.MAILCHIMP_API_KEY;
  if (!apiKey || apiKey.indexOf("-") === -1) {
    return json({ error: "Server is not configured." }, 500);
  }

  let info;
  try {
    info = await discover(apiKey, env.MAILCHIMP_AUDIENCE_ID);
  } catch (e) {
    return json({ error: "Could not read your account configuration." }, 502);
  }

  const dc = apiKey.split("-").pop();
  const apiUrl =
    "https://" + dc + ".api.mailchimp.com/3.0/lists/" + info.listId + "/members/" + md5(email);

  let res;
  try {
    res = await fetch(apiUrl, {
      headers: { Authorization: "Basic " + btoa("any:" + apiKey) },
    });
  } catch (e) {
    return json({ error: "Could not reach the email service." }, 502);
  }

  if (res.status === 404) {
    return json({ exists: false, status: null, groups });
  }
  if (!res.ok) {
    return json({ error: "Lookup failed." }, 502);
  }

  const member = await res.json();
  const memberInterests = member.interests || {};
  for (const key of Object.keys(GROUP_TARGETS)) {
    const id = info.groups[key];
    if (id) groups[key] = memberInterests[id] === true;
  }
  return json({ exists: true, status: member.status, groups });
}

async function handlePreferences(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "Invalid request body." }, 400);
  }

  const email = (body.email || "").trim().toLowerCase();
  const selected = body.groups || {};
  const unsubscribe = body.unsubscribe === true;

  if (!email || email.indexOf("@") === -1) {
    return json({ error: "A valid email address is required." }, 400);
  }

  const apiKey = env.MAILCHIMP_API_KEY;
  if (!apiKey || apiKey.indexOf("-") === -1) {
    return json({ error: "Server is not configured." }, 500);
  }

  let info;
  try {
    info = await discover(apiKey, env.MAILCHIMP_AUDIENCE_ID);
  } catch (e) {
    return json({ error: "Could not read your account configuration." }, 502);
  }

  // Build { interestId: true/false } for the groups we manage.
  const interests = {};
  for (const key of Object.keys(GROUP_TARGETS)) {
    const id = info.groups[key];
    if (id) interests[id] = selected[key] === true && !unsubscribe;
  }

  const payload = { email_address: email, status_if_new: "subscribed", interests };
  if (unsubscribe) payload.status = "unsubscribed";

  const dc = apiKey.split("-").pop();
  const apiUrl =
    "https://" + dc + ".api.mailchimp.com/3.0/lists/" + info.listId + "/members/" + md5(email);

  let mcRes;
  try {
    mcRes = await fetch(apiUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic " + btoa("any:" + apiKey),
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return json({ error: "Could not reach the email service." }, 502);
  }

  if (!mcRes.ok) {
    let detail = "";
    try {
      const err = await mcRes.json();
      detail = err.detail || err.title || "";
    } catch (e) {}
    return json({ error: detail || "The email service rejected the update." }, 502);
  }

  return json({ ok: true });
}

/* ------------------------------------------------------------------ */
/* Minimal MD5 (public-domain, Joseph Myers). Mailchimp's subscriber  */
/* hash is the MD5 of the lowercase email; Web Crypto has no MD5.      */
/* ------------------------------------------------------------------ */
function md5(str) {
  function safeAdd(x, y) {
    const lsw = (x & 0xffff) + (y & 0xffff);
    const msw = (x >> 16) + (y >> 16) + (lsw >> 16);
    return (msw << 16) | (lsw & 0xffff);
  }
  function bitRol(num, cnt) {
    return (num << cnt) | (num >>> (32 - cnt));
  }
  function cmn(q, a, b, x, s, t) {
    return safeAdd(bitRol(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b);
  }
  function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
  function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
  function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
  function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t); }

  function binlMD5(x, len) {
    x[len >> 5] |= 0x80 << (len % 32);
    x[(((len + 64) >>> 9) << 4) + 14] = len;
    let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
    for (let i = 0; i < x.length; i += 16) {
      const olda = a, oldb = b, oldc = c, oldd = d;
      a = ff(a, b, c, d, x[i], 7, -680876936);
      d = ff(d, a, b, c, x[i + 1], 12, -389564586);
      c = ff(c, d, a, b, x[i + 2], 17, 606105819);
      b = ff(b, c, d, a, x[i + 3], 22, -1044525330);
      a = ff(a, b, c, d, x[i + 4], 7, -176418897);
      d = ff(d, a, b, c, x[i + 5], 12, 1200080426);
      c = ff(c, d, a, b, x[i + 6], 17, -1473231341);
      b = ff(b, c, d, a, x[i + 7], 22, -45705983);
      a = ff(a, b, c, d, x[i + 8], 7, 1770035416);
      d = ff(d, a, b, c, x[i + 9], 12, -1958414417);
      c = ff(c, d, a, b, x[i + 10], 17, -42063);
      b = ff(b, c, d, a, x[i + 11], 22, -1990404162);
      a = ff(a, b, c, d, x[i + 12], 7, 1804603682);
      d = ff(d, a, b, c, x[i + 13], 12, -40341101);
      c = ff(c, d, a, b, x[i + 14], 17, -1502002290);
      b = ff(b, c, d, a, x[i + 15], 22, 1236535329);
      a = gg(a, b, c, d, x[i + 1], 5, -165796510);
      d = gg(d, a, b, c, x[i + 6], 9, -1069501632);
      c = gg(c, d, a, b, x[i + 11], 14, 643717713);
      b = gg(b, c, d, a, x[i], 20, -373897302);
      a = gg(a, b, c, d, x[i + 5], 5, -701558691);
      d = gg(d, a, b, c, x[i + 10], 9, 38016083);
      c = gg(c, d, a, b, x[i + 15], 14, -660478335);
      b = gg(b, c, d, a, x[i + 4], 20, -405537848);
      a = gg(a, b, c, d, x[i + 9], 5, 568446438);
      d = gg(d, a, b, c, x[i + 14], 9, -1019803690);
      c = gg(c, d, a, b, x[i + 3], 14, -187363961);
      b = gg(b, c, d, a, x[i + 8], 20, 1163531501);
      a = gg(a, b, c, d, x[i + 13], 5, -1444681467);
      d = gg(d, a, b, c, x[i + 2], 9, -51403784);
      c = gg(c, d, a, b, x[i + 7], 14, 1735328473);
      b = gg(b, c, d, a, x[i + 12], 20, -1926607734);
      a = hh(a, b, c, d, x[i + 5], 4, -378558);
      d = hh(d, a, b, c, x[i + 8], 11, -2022574463);
      c = hh(c, d, a, b, x[i + 11], 16, 1839030562);
      b = hh(b, c, d, a, x[i + 14], 23, -35309556);
      a = hh(a, b, c, d, x[i + 1], 4, -1530992060);
      d = hh(d, a, b, c, x[i + 4], 11, 1272893353);
      c = hh(c, d, a, b, x[i + 7], 16, -155497632);
      b = hh(b, c, d, a, x[i + 10], 23, -1094730640);
      a = hh(a, b, c, d, x[i + 13], 4, 681279174);
      d = hh(d, a, b, c, x[i], 11, -358537222);
      c = hh(c, d, a, b, x[i + 3], 16, -722521979);
      b = hh(b, c, d, a, x[i + 6], 23, 76029189);
      a = hh(a, b, c, d, x[i + 9], 4, -640364487);
      d = hh(d, a, b, c, x[i + 12], 11, -421815835);
      c = hh(c, d, a, b, x[i + 15], 16, 530742520);
      b = hh(b, c, d, a, x[i + 2], 23, -995338651);
      a = ii(a, b, c, d, x[i], 6, -198630844);
      d = ii(d, a, b, c, x[i + 7], 10, 1126891415);
      c = ii(c, d, a, b, x[i + 14], 15, -1416354905);
      b = ii(b, c, d, a, x[i + 5], 21, -57434055);
      a = ii(a, b, c, d, x[i + 12], 6, 1700485571);
      d = ii(d, a, b, c, x[i + 3], 10, -1894986606);
      c = ii(c, d, a, b, x[i + 10], 15, -1051523);
      b = ii(b, c, d, a, x[i + 1], 21, -2054922799);
      a = ii(a, b, c, d, x[i + 8], 6, 1873313359);
      d = ii(d, a, b, c, x[i + 15], 10, -30611744);
      c = ii(c, d, a, b, x[i + 6], 15, -1560198380);
      b = ii(b, c, d, a, x[i + 13], 21, 1309151649);
      a = ii(a, b, c, d, x[i + 4], 6, -145523070);
      d = ii(d, a, b, c, x[i + 11], 10, -1120210379);
      c = ii(c, d, a, b, x[i + 2], 15, 718787259);
      b = ii(b, c, d, a, x[i + 9], 21, -343485551);
      a = safeAdd(a, olda);
      b = safeAdd(b, oldb);
      c = safeAdd(c, oldc);
      d = safeAdd(d, oldd);
    }
    return [a, b, c, d];
  }

  function binl2rstr(input) {
    let output = "";
    for (let i = 0; i < input.length * 32; i += 8) {
      output += String.fromCharCode((input[i >> 5] >>> (i % 32)) & 0xff);
    }
    return output;
  }
  function rstr2binl(input) {
    const output = [];
    for (let i = 0; i < input.length * 8; i += 8) {
      output[i >> 5] |= (input.charCodeAt(i / 8) & 0xff) << (i % 32);
    }
    return output;
  }
  function rstr2hex(input) {
    const hexTab = "0123456789abcdef";
    let output = "";
    for (let i = 0; i < input.length; i++) {
      const x = input.charCodeAt(i);
      output += hexTab.charAt((x >>> 4) & 0x0f) + hexTab.charAt(x & 0x0f);
    }
    return output;
  }
  function str2rstrUTF8(input) {
    return unescape(encodeURIComponent(input));
  }

  const rawInput = str2rstrUTF8(str);
  return rstr2hex(binl2rstr(binlMD5(rstr2binl(rawInput), rawInput.length * 8)));
}
