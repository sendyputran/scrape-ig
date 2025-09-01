const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
require("dotenv").config();

puppeteer.use(StealthPlugin());

const IG_USER = process.env.IG_USER;
const IG_PASS = process.env.IG_PASS;

if (!IG_USER || !IG_PASS) {
  console.error("❌ Set IG_USER and IG_PASS in .env");
  process.exit(1);
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

async function login(page) {
  const maxRetries = 3;
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      await page.goto("https://www.instagram.com/accounts/login/", {
        waitUntil: "networkidle2",
        timeout: 60000,
      });
      break; // Success, exit loop
    } catch (error) {
      attempt++;
      console.log(`Login attempt ${attempt} failed: ${error.message}`);
      if (attempt >= maxRetries) {
        throw new Error(`Failed to load login page after ${maxRetries} attempts: ${error.message}`);
      }
      // Wait before retrying (exponential backoff)
      await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
    }
  }

  // Best-effort cookie banner
  await page.evaluate(() => {
    const texts = ["allow all","accept all","accept","only allow essential","Izinkan semua"];
    const btn = Array.from(document.querySelectorAll("button")).find(b =>
      texts.some(t => (b.textContent || "").toLowerCase().includes(t)));
    if (btn) btn.click();
  }).catch(()=>{});

  await page.waitForSelector('input[name="username"]', { visible: true, timeout: 60000 });
  await page.type('input[name="username"]', IG_USER, { delay: 45 });
  await page.type('input[name="password"]', IG_PASS, { delay: 45 });
  await page.click('button[type="submit"]');

  // move past login
  await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }).catch(()=>{});

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
  await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

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
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 900 });

  await login(page);

  for (const t of targets) {
    try {
      const res = await scrapeProfile(page, t);
      console.log(`📊 ${t} ->`, res);
      await sleep(1200);
    } catch (err) {
      console.error(`❌ Failed for ${t}:`, err?.message || err);
    }
  }

  await browser.close();
})();
