const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
require("dotenv").config();

puppeteer.use(StealthPlugin());

const IG_USER = process.env.IG_USER;
const IG_PASS = process.env.IG_PASS;
const IG_COOKIES = process.env.IG_COOKIES; // base64-encoded JSON array of cookies

if (!IG_USER || !IG_PASS) {
  console.warn("ℹ️ IG_USER/IG_PASS not set; will attempt scrape without login.");
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function ensureLogsDir() {
  const dir = path.join(process.cwd(), "logs");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function writeLogFile(basename, payload) {
  ensureLogsDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(process.cwd(), "logs", `${basename}-${stamp}.txt`);
  const fmtTrail = (arr) => (!arr || !arr.length) ? "∅ (empty)\n" : arr.map((it,i)=>`[${i+1}] ${it.label}
  tag:    ${it.tag}
  class:  ${it.class}
  title:  ${it.title}
  text:   ${it.text}
  html:   ${it.html}
`).join("\n");
  const txt = `# Instagram Scrape Debug Log
Target: ${payload.url}
When:   ${new Date().toString()}

== RESULT ==
Posts:     ${payload.posts}
Followers: ${payload.followers}
Following: ${payload.following}

== SOURCE ==
${payload.source}

== FOLLOWERS TRAIL ==
${fmtTrail(payload.debug?.followersTrail)}

== FOLLOWING TRAIL ==
${fmtTrail(payload.debug?.followingTrail)}

== POSTS TRAIL ==
${fmtTrail(payload.debug?.postsTrail)}

== HEADER [title] ELEMENTS ==
${fmtTrail(payload.debug?.headerTitleNodes)}

== BRITTLE CLASS (.x5n08af .x1s688f .x1lliihq) NEAR HEADER ==
${fmtTrail(payload.debug?.brittleNodes)}
`;
  fs.writeFileSync(file, txt, "utf8");
  console.log(`📝 wrote log -> ${file}`);
}

async function loadCookies(page) {
  if (!IG_COOKIES) return;
  try {
    const json = Buffer.from(IG_COOKIES, 'base64').toString('utf8');
    const cookies = JSON.parse(json);
    if (Array.isArray(cookies) && cookies.length) {
      const norm = cookies.map(c => ({ domain: '.instagram.com', ...c }));
      await page.setCookie(...norm);
      console.log(`🍪 loaded ${norm.length} cookies from secret`);
    }
  } catch (e) {
    console.warn("⚠️ Failed to load IG_COOKIES:", e?.message || e);
  }
}

async function acceptCookies(page) {
  try {
    await page.evaluate(() => {
      const texts = [
        "allow all","accept all","accept","only allow essential","allow essential",
        "only allow essential cookies","izinkan semua","terima","setuju","accept necessary"
      ];
      const nodes = Array.from(document.querySelectorAll('button, [role="button"], a'));
      const btn = nodes.find(b => texts.some(t => (b.textContent||"").toLowerCase().includes(t)));
      if (btn) btn.click();
    });
  } catch {}
  await sleep(1200);
}

function expandCompact(str) {
  if (!str) return null;
  const s = String(str).trim().toLowerCase().replace(/,/g, "");
  const m = s.match(/^([\d.]+)\s*([kmb])?$/i);
  if (!m) {
    const n = parseInt(s.replace(/[^\d]/g, ""), 10);
    return Number.isNaN(n) ? null : n;
  }
  const n = parseFloat(m[1]);
  const suf = (m[2] || "").toLowerCase();
  const mult = suf === "k" ? 1e3 : suf === "m" ? 1e6 : suf === "b" ? 1e9 : 1;
  return Math.round(n * mult);
}
function pickMorePrecise(a, b) {
  if (a == null) return b;
  if (b == null) return a;
  return String(a).length >= String(b).length ? a : b;
}

// New: wait for any of the selectors in any frame, with retries
async function waitForAnySelectorInFrames(page, selectors, opts = {}) {
  const attempts = opts.attempts ?? 5;
  const perTryTimeout = opts.timeout ?? 10000;
  for (let i = 0; i < attempts; i++) {
    const frames = page.frames();
    for (const sel of selectors) {
      for (const f of frames) {
        try {
          const handle = await f.waitForSelector(sel, { visible: true, timeout: perTryTimeout });
          if (handle) return { handle, frame: f, selector: sel };
        } catch (_) {}
      }
    }
    // On retry, try to reveal the login form if present
    try {
      await page.evaluate(() => {
        const texts = ["log in","masuk","login"]; // EN + ID
        const btn = Array.from(document.querySelectorAll('a,button'))
          .find(b => texts.some(t => (b.textContent||'').toLowerCase().includes(t)));
        if (btn) btn.click();
      });
    } catch (_) {}
    await sleep(1500);
  }
  throw new Error(`Element not found: one of ${selectors.join(', ')}`);
}

async function login(page) {
  const maxRetries = 3;
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      await page.goto("https://www.instagram.com/accounts/login/", {
        waitUntil: "domcontentloaded",
        timeout: 90000,
      });
      break; // Success, exit loop
    } catch (error) {
      attempt++;
      console.log(`Login attempt ${attempt} failed: ${error.message}`);
      if (attempt >= maxRetries) {
        throw new Error(`Failed to load login page after ${maxRetries} attempts: ${error.message}`);
      }
      await sleep(2000 * attempt);
    }
  }

  // Best-effort cookie banner
  await acceptCookies(page);

  // Sometimes the login lives inside an iframe — search all frames
  const { handle: usernameHandle, frame: usernameFrame } = await waitForAnySelectorInFrames(page, [
    'input[name="username"]',
    'input[aria-label="Phone number, username, or email"]',
    'input[aria-label="Username"]'
  ], { attempts: 6, timeout: 12000 });

  // Find matching password input in the same frame, fall back to any frame
  let passwordHandle = null;
  if (usernameFrame) {
    try {
      passwordHandle = await usernameFrame.waitForSelector('input[name="password"], input[type="password"]', { visible: true, timeout: 12000 });
    } catch (_) {}
  }
  if (!passwordHandle) {
    const { handle } = await waitForAnySelectorInFrames(page, [
      'input[name="password"]',
      'input[type="password"]'
    ], { attempts: 6, timeout: 12000 });
    passwordHandle = handle;
  }

  await usernameHandle.type(IG_USER, { delay: 45 });
  await passwordHandle.type(IG_PASS, { delay: 45 });

  // Submit: try nearest form submit, then generic button[type=submit]
  const submitted = await page.evaluate((selUser) => {
    const input = document.querySelector(selUser) || document.querySelector('input[name="username"]');
    const form = input?.closest('form');
    if (form) { form.submit?.(); return true; }
    const btn = Array.from(document.querySelectorAll('button[type="submit"], button'))
      .find(b => (b.textContent||'').toLowerCase().includes('log in') || b.type === 'submit');
    if (btn) { btn.click(); return true; }
    return false;
  }, 'input[name="username"]').catch(()=>false);

  if (!submitted) {
    try { await page.click('button[type="submit"]'); } catch (_) {}
  }

  // move past login
  await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 120000 }).catch(()=>{});

  // Persist cookies after successful login (printed as base64 to hide raw JSON)
  try {
    const cookies = await page.cookies();
    const b64 = Buffer.from(JSON.stringify(cookies), 'utf8').toString('base64');
    console.log("🍪 session cookies (base64):", b64.slice(0, 80) + '...');
  } catch {}

  // Dismiss “Not now” prompts
  await page.evaluate(() => {
    const clickByText = (arr) => {
      const btns = Array.from(document.querySelectorAll("button"));
      const hit = btns.find(b => arr.some(t => (b.textContent||"").toLowerCase().includes(t)));
      if (hit) hit.click();
    };
    clickByText(["not now","bukan sekarang","later"]);
  }).catch(()=>{});
}

/** Primary approach: use Instagram's web JSON (exact counts) */
async function fetchProfileJSON(page, username) {
  return await page.evaluate(async (uname) => {
    const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(uname)}`;
    const headers = {
      "X-Requested-With": "XMLHttpRequest",
      "X-IG-App-ID": "936619743392459", // web app id
    };
    const res = await fetch(url, { method: "GET", headers, credentials: "include" });
    if (!res.ok) {
      return { ok: false, status: res.status, text: await res.text() };
    }
    const json = await res.json();
    // shape: { data: { user: { edge_followed_by.count, edge_follow.count, edge_owner_to_timeline_media.count } } }
    const user = json?.data?.user;
    if (!user) return { ok: false, status: 200, text: "no user in payload" };
    return {
      ok: true,
      id: user.id,
      username: user.username,
      followers: user.edge_followed_by?.count ?? null,
      following: user.edge_follow?.count ?? null,
      posts: user.edge_owner_to_timeline_media?.count ?? null,
      full_name: user.full_name,
      is_private: user.is_private,
      is_verified: user.is_verified,
    };
  }, username);
}

/** Fallback: try DOM/og like before, and collect logs */
async function fallbackFromDOM(page, profileUrl) {
  // ensure header rendered (but IG may keep it empty, that's okay)
  await Promise.race([
    page.waitForSelector("header", { timeout: 15000 }),
    page.waitForSelector('meta[property="og:description"]', { timeout: 15000 }),
  ]).catch(()=>{});

  return await page.evaluate(() => {
    const sample = (s) => (s ? String(s).slice(0, 240).replace(/\s+/g, " ") : "");
    const add = (arr, label, el) => {
      if (!arr || !el) return;
      arr.push({
        label,
        tag: el.tagName,
        class: el.className,
        title: el.getAttribute?.("title") || "",
        text: (el.textContent || "").trim(),
        html: sample(el.outerHTML || ""),
      });
    };
    const parseTitleNum = (el) => {
      if (!el) return null;
      const t = el.getAttribute?.("title");
      if (!t) return null;
      const n = parseInt(t.replace(/[^\d]/g, ""), 10);
      return Number.isNaN(n) ? null : n;
    };
    const parseFromTextish = (el) => {
      if (!el) return null;
      const aria = el.getAttribute?.("aria-label") || "";
      if (aria) {
        const compact = (aria.match(/([\d.,]+)\s*([kmb])/i) || [])[0];
        if (compact) {
          const s = compact.toLowerCase().replace(/,/g, "");
          const mm = s.match(/^([\d.]+)\s*([kmb])$/i);
          if (mm) {
            let v = parseFloat(mm[1]);
            const u = mm[2].toLowerCase();
            const mult = u === "k" ? 1e3 : u === "m" ? 1e6 : u === "b" ? 1e9 : 1;
            return Math.round(v * mult);
          }
        }
        const digits = parseInt(aria.replace(/[^\d]/g, ""), 10);
        if (!Number.isNaN(digits)) return digits;
      }
      const text = (el.textContent || "").trim();
      const compact = (text.match(/([\d.,]+)\s*([kmb])/i) || [])[0];
      if (compact) {
        const s = compact.toLowerCase().replace(/,/g, "");
        const mm = s.match(/^([\d.]+)\s*([kmb])$/i);
        if (mm) {
          let v = parseFloat(mm[1]);
          const u = mm[2].toLowerCase();
          const mult = u === "k" ? 1e3 : u === "m" ? 1e6 : u === "b" ? 1e9 : 1;
          return Math.round(v * mult);
        }
      }
      const plain = parseInt(text.replace(/[^\d]/g, ""), 10);
      return Number.isNaN(plain) ? null : plain;
    };

    const followersTrail = [];
    const followingTrail = [];
    const postsTrail = [];

    const q = (sel) => document.querySelector(sel);

    // try locate anchors (may be missing on your layout)
    const followersA = q('a[href$="/followers/"]');
    const followingA = q('a[href$="/following/"]');

    let followers = null, following = null, posts = null;

    const tryAround = (anchor, which) => {
      const trail = which === "followers" ? followersTrail : which === "following" ? followingTrail : postsTrail;
      if (!anchor) { add(trail, "anchor(null)", { tagName:"NULL", className:"", outerHTML:"", textContent:"" }); return null; }
      // descendant [title]
      let el = anchor.querySelector?.("span[title],div[title]");
      add(trail, "descendant[title]", el);
      let n = parseTitleNum(el);
      if (n != null) return n;
      // self
      add(trail, "anchor", anchor);
      n = parseTitleNum(anchor);
      if (n != null) return n;
      // li
      const li = anchor.closest?.("li");
      add(trail, "closest li", li);
      el = li?.querySelector?.("span[title],div[title]");
      add(trail, "li->query[title]", el);
      n = parseTitleNum(el);
      if (n != null) return n;
      // parent chain
      let p = anchor.parentElement;
      while (p && p !== document.body) {
        add(trail, "parent", p);
        el = p.querySelector?.("span[title],div[title]");
        add(trail, "parent->query[title]", el);
        n = parseTitleNum(el);
        if (n != null) return n;
        n = parseTitleNum(p);
        if (n != null) return n;
        p = p.parentElement;
      }
      // siblings
      const sibs = [];
      if (anchor.previousElementSibling) sibs.push(anchor.previousElementSibling);
      if (anchor.nextElementSibling) sibs.push(anchor.nextElementSibling);
      if (li?.previousElementSibling) sibs.push(li.previousElementSibling);
      if (li?.nextElementSibling) sibs.push(li.nextElementSibling);
      for (const s of sibs) {
        add(trail, "sibling", s);
        el = s.querySelector?.("span[title],div[title]");
        add(trail, "sibling->query[title]", el);
        n = parseTitleNum(el || s);
        if (n != null) return n;
      }
      const parsed = parseFromTextish(anchor) ?? parseFromTextish(li);
      if (parsed != null) add(trail, "fallback(text/aria) used", anchor || li || { tagName:"NULL" });
      return parsed;
    };

    followers = tryAround(followersA, "followers");
    following = tryAround(followingA, "following");

    // posts LI (not followers/following)
    const statLis = Array.from(document.querySelectorAll("header section ul li"));
    if (statLis.length) {
      const postsLi = statLis.find(li => !li.querySelector('a[href$="/followers/"]') && !li.querySelector('a[href$="/following/"]')) || statLis[0];
      add(postsTrail, "posts-li", postsLi);
      const exact = postsLi?.querySelector?.("span[title],div[title]");
      add(postsTrail, "posts-li exact", exact);
      if (exact) {
        const maybe = parseTitleNum(exact);
        posts = maybe != null ? maybe : parseFromTextish(postsLi);
      } else {
        posts = parseFromTextish(postsLi);
      }
    } else {
      add(postsTrail, "posts-li(null)", { tagName:"NULL", className:"", outerHTML:"", textContent:"" });
    }

    // og:description
    const og = document.querySelector('meta[property="og:description"]')?.content || "";
    let ogFollowers = null, ogFollowing = null, ogPosts = null;
    if (og) {
      const rx = /([\d.,]+)\s*([kmb])?\s*Followers.*?([\d.,]+)\s*([kmb])?\s*Following.*?([\d.,]+)\s*([kmb])?\s*Posts/i;
      const m = og.match(rx);
      if (m) {
        ogFollowers = m[1] + (m[2] || "");
        ogFollowing = m[3] + (m[4] || "");
        ogPosts = m[5] + (m[6] || "");
      }
    }

    // extra: everything in header with [title]
    const headerTitleNodes = Array.from(document.querySelectorAll("header [title]")).map(el => ({
      label: "header [title]",
      tag: el.tagName,
      class: el.className,
      title: el.getAttribute("title") || "",
      text: (el.textContent || "").trim(),
      html: sample(el.outerHTML || "")
    }));
    const brittleNodes = Array.from(document.querySelectorAll("header .x5n08af.x1s688f.x1lliihq")).map(el => ({
      label: "brittle class node",
      tag: el.tagName,
      class: el.className,
      title: el.getAttribute("title") || "",
      text: (el.textContent || "").trim(),
      html: sample(el.outerHTML || "")
    }));

    return {
      dom: { posts, followers, following },
      og: { ogPosts, ogFollowers, ogFollowing },
      debug: { followersTrail, followingTrail, postsTrail, headerTitleNodes, brittleNodes }
    };
  });
}

async function scrapeProfile(page, target) {
  const isUrl = /^https?:\/\//i.test(target);
  const username = isUrl ? new URL(target).pathname.split("/").filter(Boolean)[0] : target.replace(/^@/,"");
  const url = isUrl ? target : `https://www.instagram.com/${username}/`;

  // Visit the profile first (keeps cookies/session warm)
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await acceptCookies(page);

  // PRIMARY: Web JSON
  const api = await fetchProfileJSON(page, username);
  if (api.ok) {
    const result = { url, posts: api.posts ?? null, followers: api.followers ?? null, following: api.following ?? null, source: "api" };
    // Also write a minimal DOM log to help future debugging
    const fallback = await fallbackFromDOM(page, url);
    writeLogFile(username, { ...result, debug: fallback.debug });
    return result;
  }

  // FALLBACK: DOM/og
  const fb = await fallbackFromDOM(page, url);
  const posts = pickMorePrecise(fb.dom.posts, expandCompact(fb.og.ogPosts));
  const followers = pickMorePrecise(fb.dom.followers, expandCompact(fb.og.ogFollowers));
  const following = pickMorePrecise(fb.dom.following, expandCompact(fb.og.ogFollowing));
  const result = { url, posts, followers, following, source: "dom/og" };
  writeLogFile(username, { ...result, debug: fb.debug });
  return result;
}

(async () => {
  const targets = process.argv.slice(2);
  if (!targets.length) {
    console.error("Usage: node scrape-ig-api.js <username|url> [more_usernames...]");
    process.exit(1);
  }

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-web-security",
      "--ignore-certificate-errors",
      "--ignore-ssl-errors",
      "--disable-features=VizDisplayCompositor",
  "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "--lang=en-US"
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 900 });
  try { await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" }); } catch {}
  await loadCookies(page);

  // Speed/stability: block heavy resources
  try {
    await page.setRequestInterception(true);
    page.on('request', req => {
      const type = req.resourceType();
      if (['image','media','font','stylesheet'].includes(type)) return req.abort();
      req.continue();
    });
  } catch {}
  page.setDefaultTimeout(60000);

  // We'll try scraping without login first; only login if needed

  for (const t of targets) {
    try {
      let res = await scrapeProfile(page, t);
      const needsLogin = [res.posts, res.followers, res.following].every(v => v == null);
      if (needsLogin && IG_USER && IG_PASS) {
        try {
          await login(page);
          res = await scrapeProfile(page, t);
        } catch (e) {
          console.warn("⚠️ Login attempt failed, continuing with no-login result.", e?.message || e);
        }
      }
      console.log(`📊 ${t} ->`, res);
      
      // Save to CSV
      const csvFile = path.join(process.cwd(), "data.csv");
      const timestamp = new Date().toISOString();
      const csvLine = `${timestamp},${res.url},${res.posts},${res.followers},${res.following}\n`;
      
      // Check if file exists to add header
      const header = "timestamp,url,posts,followers,following\n";
      if (!fs.existsSync(csvFile)) {
        fs.writeFileSync(csvFile, header);
      }
      fs.appendFileSync(csvFile, csvLine);
      console.log(`📝 Saved to ${csvFile}`);
      
      await sleep(1200);
    } catch (err) {
      console.error(`❌ Failed for ${t}:`, err?.message || err);
      try {
        const dir = ensureLogsDir();
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        await page.screenshot({ path: path.join(dir, `error-${t}-${ts}.png`) }).catch(()=>{});
        const html = await page.content().catch(()=>"");
        if (html) fs.writeFileSync(path.join(dir, `error-${t}-${ts}.html`), html, "utf8");
      } catch {}
    }
  }

  await browser.close();
})();
