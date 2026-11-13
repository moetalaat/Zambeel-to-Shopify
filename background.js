// Zambeel to Shopify - background service worker.
// All network calls live here so an import survives the popup closing.

const ZAMBEEL_ENDPOINT = "https://9039b4.myshopify.com/api/2025-07/graphql.json";
const ZAMBEEL_TOKEN = "2c4a7aa64f86e19eb0edbd3380aa544e"; // public storefront token shipped in Zambeel's own site bundle
const ADMIN_API_VERSION = "2025-01";

const PRODUCT_QUERY = `
query($handle: String!) {
  product(handle: $handle) {
    id
    title
    handle
    descriptionHtml
    vendor
    productType
    tags
    images(first: 50) { nodes { url altText } }
    options { name optionValues { name } }
    variants(first: 100) {
      nodes {
        title
        sku
        price { amount currencyCode }
        compareAtPrice { amount }
        selectedOptions { name value }
      }
    }
  }
}`;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handlers = {
    FETCH_PRODUCT: () => fetchZambeelProduct(msg.handle),
    IMPORT_PRODUCT: () => importProduct(msg.payload),
    TEST_CONNECTION: () => testConnection(msg.domain, msg.clientId, msg.clientSecret),
    DOWNLOAD_IMAGES: () => downloadImages(msg.handle, msg.urls),
  };
  const handler = handlers[msg.type];
  if (!handler) return false;
  handler()
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
  return true; // keep the message channel open for the async response
});

async function fetchZambeelProduct(handle) {
  const res = await fetch(ZAMBEEL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Storefront-Access-Token": ZAMBEEL_TOKEN,
    },
    body: JSON.stringify({ query: PRODUCT_QUERY, variables: { handle } }),
  });
  if (!res.ok) throw new Error(`Zambeel API returned HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0].message);
  const p = json.data?.product;
  if (!p) throw new Error(`Product "${handle}" not found on Zambeel.`);

  const cleanDesc = (p.descriptionHtml || "")
    .replace(/\s+data-(?:start|end)="[^"]*"/g, "") // ChatGPT authoring artifacts
    .replace(/zambeel(?:\s*-\s*NGB General Trading)?/gi, ""); // never leak the supplier name

  // Images embedded in the description hotlink Zambeel's CDN (the URL path is
  // their store id, a dead giveaway) and would break if they delete them. Lift
  // them into the gallery so Shopify re-hosts them under your own store, and
  // drop the <img> tags from the body text.
  const embedded = [];
  const descNoImg = cleanDesc
    .replace(/<img[^>]*\bsrc="([^"]+)"[^>]*>/gi, (_m, src) => { embedded.push(src); return ""; })
    .replace(/<p>\s*<\/p>/gi, "")
    .trim();

  const seen = new Set();
  const images = [];
  const pushImg = (url, altText) => {
    const key = url.split("?")[0];
    if (seen.has(key)) return;
    seen.add(key);
    images.push({ url, altText: stripBrand(altText) });
  };
  for (const i of p.images.nodes) pushImg(i.url, i.altText || p.title);
  for (const src of embedded) pushImg(src, p.title);

  return {
    handle: p.handle,
    title: stripBrand(p.title) || p.title,
    descriptionHtml: descNoImg,
    productType: p.productType || "",
    // Drop any Zambeel-identifying tags; keep the useful category ones.
    tags: (p.tags || []).filter((t) => !/zambeel/i.test(t)),
    images,
    options: p.options.map((o) => ({ name: o.name, values: o.optionValues.map((v) => v.name) })),
    variants: p.variants.nodes.map((v) => ({
      title: v.title,
      sku: v.sku || "",
      cost: v.price.amount,
      currency: v.price.currencyCode,
      compareAt: v.compareAtPrice?.amount || null,
      selectedOptions: v.selectedOptions,
    })),
  };
}

// Remove any mention of the supplier's brand from a string (product title,
// image alt text) so nothing points back to Zambeel.
function stripBrand(s) {
  return String(s || "")
    .replace(/\s*[-–—|:]\s*zambeel\b.*$/i, "") // "Product Name - Zambeel..." -> "Product Name"
    .replace(/\bzambeel\b[^A-Za-z0-9]*/gi, "") // stray "Zambeel" anywhere
    .replace(/\s{2,}/g, " ")
    .trim();
}

async function getSettings() {
  const s = await chrome.storage.local.get(["storeDomain", "clientId", "clientSecret", "vendorName", "saveSourceLink", "markup", "defaultStatus", "shopName", "shopCurrency"]);
  return s;
}

function normalizeDomain(domain) {
  let d = (domain || "").trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (d && !d.includes(".")) d += ".myshopify.com";
  return d;
}

function assertMyshopify(d) {
  if (!d.endsWith(".myshopify.com")) {
    throw new Error(`"${d || "(empty)"}" is not a .myshopify.com domain. Use your store's myshopify domain, not a custom domain. Find the handle in your admin URL: admin.shopify.com/store/<handle> becomes <handle>.myshopify.com.`);
  }
}

// Dev Dashboard apps use the client credentials grant: exchange Client ID +
// Secret for a 24h Admin API token, then refresh automatically. The token
// endpoint only answers on the *.myshopify.com domain, never a custom domain.
async function mintToken(domain, clientId, clientSecret) {
  let res;
  try {
    res = await fetch(`https://${domain}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
    });
  } catch (e) {
    throw new Error(`Could not reach https://${domain}. Make sure it is your correct .myshopify.com domain and that you are online.`);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    const detail = json.error_description || json.error || `HTTP ${res.status}`;
    throw new Error(`Could not get a Shopify token (${detail}). Check the store domain (must be the .myshopify.com one), the Client ID/Secret, and that the app is installed on the store.`);
  }
  const ttl = (json.expires_in || 86399) - 300; // refresh 5 min early
  return { token: json.access_token, expiresAt: Date.now() + ttl * 1000 };
}

async function getValidToken(domain, clientId, clientSecret, forceRefresh = false) {
  if (!forceRefresh) {
    const { tokenCache } = await chrome.storage.local.get("tokenCache");
    if (tokenCache && tokenCache.domain === domain && tokenCache.expiresAt > Date.now()) {
      return tokenCache.token;
    }
  }
  const fresh = await mintToken(domain, clientId, clientSecret);
  await chrome.storage.local.set({ tokenCache: { domain, token: fresh.token, expiresAt: fresh.expiresAt } });
  return fresh.token;
}

async function adminGraphql(domain, token, query, variables) {
  const res = await fetch(`https://${domain}/admin/api/${ADMIN_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 401 || res.status === 403) {
    const e = new Error("Shopify rejected the access token (HTTP " + res.status + "). The app may be missing the write_products scope.");
    e.code = 401;
    throw e;
  }
  if (!res.ok) throw new Error(`Shopify Admin API returned HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join("; "));
  return json.data;
}

// Runs a query with a fresh-enough token, re-minting once on a 401 in case the
// cached token was revoked before its stated expiry.
async function adminGraphqlAuthed(domain, clientId, clientSecret, query, variables) {
  const token = await getValidToken(domain, clientId, clientSecret);
  try {
    return await adminGraphql(domain, token, query, variables);
  } catch (err) {
    if (err.code === 401) {
      const retryToken = await getValidToken(domain, clientId, clientSecret, true);
      return await adminGraphql(domain, retryToken, query, variables);
    }
    throw err;
  }
}

const PUBLICATIONS_QUERY = `{ publications(first: 30) { nodes { id name } } }`;
const PUBLISH_MUTATION = `
  mutation publish($id: ID!, $input: [PublicationInput!]!) {
    publishablePublish(id: $id, input: $input) {
      userErrors { field message }
    }
  }`;

// The Online Store sales channel is a "publication". Products created through
// the API aren't on any channel by default, so we look up its id (cached per
// store) and publish to it after each import.
async function getOnlineStorePublicationId(domain, clientId, clientSecret) {
  const { publication } = await chrome.storage.local.get("publication");
  if (publication && publication.domain === domain && publication.id) return publication.id;
  const data = await adminGraphqlAuthed(domain, clientId, clientSecret, PUBLICATIONS_QUERY);
  const nodes = data.publications?.nodes || [];
  const online = nodes.find((p) => /online store/i.test(p.name || ""));
  const id = online?.id || null;
  if (id) await chrome.storage.local.set({ publication: { domain, id } });
  return id;
}

function isScopeError(msg) {
  return /access denied|not approved|publication|scope/i.test(msg);
}

async function testConnection(domain, clientId, clientSecret) {
  const d = normalizeDomain(domain);
  if (!d || !clientId || !clientSecret) throw new Error("Enter the store domain, Client ID, and Client Secret.");
  assertMyshopify(d);
  const data = await adminGraphqlAuthed(d, clientId, clientSecret, `{ shop { name currencyCode } }`);
  // Best-effort: confirm we can see the Online Store channel (needs the
  // publications scopes). Don't fail the connection if we can't.
  let onlineStore = false;
  try {
    onlineStore = !!(await getOnlineStorePublicationId(d, clientId, clientSecret));
  } catch { /* scope not granted yet */ }
  return { domain: d, name: data.shop.name, currency: data.shop.currencyCode, onlineStore };
}

// payload: { title, descriptionHtml, vendor, productType, tags, status,
//            images: [{url, altText}],
//            variants: [{ sku, price, compareAt, selectedOptions: [{name, value}] }] }
async function importProduct(payload) {
  const { storeDomain, clientId, clientSecret, vendorName, saveSourceLink } = await getSettings();
  const domain = normalizeDomain(storeDomain);
  if (!domain || !clientId || !clientSecret) throw new Error("Shopify store is not configured. Open the extension settings first.");
  assertMyshopify(domain);
  if (!payload.variants.length) throw new Error("Select at least one variant to import.");

  // Drop any option that has only one distinct value across the selected
  // variants (e.g. Zambeel's "Country where you want to sell?" once a single
  // market is chosen). If nothing remains, import as a single-variant product.
  const optionNames = payload.variants[0].selectedOptions.map((o) => o.name);
  const keptOptions = optionNames.filter((name) => {
    const values = new Set(payload.variants.map((v) => v.selectedOptions.find((o) => o.name === name)?.value));
    return values.size > 1;
  });

  // Dropshipping: don't track inventory. Untracked variants are always
  // available, so products never import as "sold out". (You hold no stock;
  // Zambeel fulfils.) tracked:false makes inventoryPolicy moot, but we keep
  // CONTINUE so the product stays sellable even if you later switch tracking on.
  const inventoryItemFor = (sku) => ({ sku, tracked: false });

  let productOptions, variants;
  if (keptOptions.length === 0) {
    productOptions = [{ name: "Title", values: [{ name: "Default Title" }] }];
    variants = [
      {
        optionValues: [{ optionName: "Title", name: "Default Title" }],
        price: payload.variants[0].price,
        compareAtPrice: payload.variants[0].compareAt || null,
        inventoryItem: inventoryItemFor(payload.variants[0].sku),
        inventoryPolicy: "CONTINUE",
      },
    ];
  } else {
    productOptions = keptOptions.map((name) => ({
      name,
      values: [...new Set(payload.variants.map((v) => v.selectedOptions.find((o) => o.name === name).value))].map((n) => ({ name: n })),
    }));
    variants = payload.variants.map((v) => ({
      optionValues: keptOptions.map((name) => ({
        optionName: name,
        name: v.selectedOptions.find((o) => o.name === name).value,
      })),
      price: v.price,
      compareAtPrice: v.compareAt || null,
      inventoryItem: inventoryItemFor(v.sku),
      inventoryPolicy: "CONTINUE",
    }));
  }

  const input = {
    title: payload.title,
    descriptionHtml: payload.descriptionHtml,
    vendor: (vendorName || "").trim(), // your brand, never the supplier
    productType: payload.productType,
    status: payload.status === "ACTIVE" ? "ACTIVE" : "DRAFT",
    tags: payload.tags,
    files: payload.images.map((img) => ({
      originalSource: img.url,
      alt: img.altText,
      contentType: "IMAGE",
    })),
    productOptions,
    variants,
  };

  // Private supplier link, stored as a product metafield (namespace "zambeel").
  // Not shown to customers; visible to you in the product's admin page. Lets you
  // jump back to the Zambeel listing to check stock/price later.
  if (saveSourceLink !== false && payload.sourceHandle) {
    input.metafields = [
      {
        namespace: "zambeel",
        key: "source_url",
        type: "url",
        value: `https://products.myzambeel.com/products/${payload.sourceHandle}`,
      },
    ];
  }

  const mutation = `
    mutation($input: ProductSetInput!) {
      productSet(input: $input, synchronous: true) {
        product { id title handle }
        userErrors { field message }
      }
    }`;

  const data = await adminGraphqlAuthed(domain, clientId, clientSecret, mutation, { input });
  const result = data.productSet;
  if (result.userErrors?.length) {
    throw new Error("Shopify: " + result.userErrors.map((e) => e.message).join("; "));
  }
  const numericId = result.product.id.split("/").pop();
  const storeName = domain.replace(".myshopify.com", "");
  const outcome = {
    productId: result.product.id,
    title: result.product.title,
    adminUrl: `https://admin.shopify.com/store/${storeName}/products/${numericId}`,
    published: false,
    publishNote: "",
  };

  // Add the product to the Online Store sales channel (draft or active alike).
  try {
    const pubId = await getOnlineStorePublicationId(domain, clientId, clientSecret);
    if (!pubId) {
      outcome.publishNote = "Online Store channel not found on this store.";
    } else {
      const pub = await adminGraphqlAuthed(domain, clientId, clientSecret, PUBLISH_MUTATION, {
        id: result.product.id,
        input: [{ publicationId: pubId }],
      });
      const errs = pub.publishablePublish?.userErrors || [];
      if (errs.length) outcome.publishNote = errs.map((e) => e.message).join("; ");
      else outcome.published = true;
    }
  } catch (e) {
    outcome.publishNote = isScopeError(e.message)
      ? "Product created, but publishing needs the read_publications and write_publications scopes. Add them to your app, then Test connection again."
      : "Product created, but could not publish to Online Store: " + e.message;
  }

  // Cache so the popup can show the result even if it was closed mid-import.
  await chrome.storage.session.set({ lastImport: { ...outcome, at: Date.now(), sourceHandle: payload.sourceHandle } });
  return outcome;
}

async function downloadImages(handle, urls) {
  let n = 0;
  for (const url of urls) {
    n += 1;
    const clean = url.split("?")[0];
    const ext = (clean.match(/\.(jpe?g|png|gif|webp)$/i) || [, "jpg"])[1];
    await chrome.downloads.download({
      url,
      filename: `Zambeel/${handle}/${handle}-${String(n).padStart(2, "0")}.${ext}`,
      conflictAction: "uniquify",
    });
  }
  return { count: n };
}
