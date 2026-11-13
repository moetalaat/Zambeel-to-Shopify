// Zambeel to Shopify - popup logic. All network work happens in background.js.

let product = null; // normalized product from Zambeel
let settings = {};

// Zambeel's wholesale-only "which market are you reselling in" option.
const COUNTRY_RE = /country where you want to sell/i;

const $ = (id) => document.getElementById(id);

function show(stateId) {
  for (const id of ["state-loading", "state-notproduct", "state-error", "state-product", "state-success"]) {
    $(id).classList.toggle("hidden", id !== stateId);
  }
  // The manual-tools menu only makes sense once a product is loaded.
  $("btn-tools").hidden = stateId !== "state-product";
  closeToolsMenu();
}

function closeToolsMenu() {
  $("tools-menu").classList.add("hidden");
  $("btn-tools").setAttribute("aria-expanded", "false");
}

function send(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!res) return reject(new Error("No response from background worker."));
      res.ok ? resolve(res.data) : reject(new Error(res.error));
    });
  });
}

function extractHandle(url) {
  try {
    const u = new URL(url);
    if (u.hostname !== "products.myzambeel.com") return null;
    const m = u.pathname.match(/^\/(?:ar\/)?products\/([^/?#]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  } catch {
    return null;
  }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function money(amount, currency) {
  const n = Number(amount);
  return `${currency ? currency + " " : ""}${n.toFixed(2)}`;
}

function suggestedPrice(cost) {
  const markup = Number(settings.markup) > 0 ? Number(settings.markup) : 2;
  return (Number(cost) * markup).toFixed(2);
}

function renderProduct() {
  $("p-thumb").src = product.images[0]?.url || "";
  $("p-title").value = product.title;
  $("p-sub").textContent = `${product.images.length} image${product.images.length === 1 ? "" : "s"} · ${product.variants.length} variant${product.variants.length === 1 ? "" : "s"} · costs in ${product.variants[0]?.currency || "AED"}`;

  // Apply the default-market preference, but only if at least one variant
  // actually matches it (otherwise keep everything so nothing is lost).
  const variantCountry = (v) => v.selectedOptions.find((o) => COUNTRY_RE.test(o.name))?.value;
  const wantedRaw = settings.defaultCountry;
  const anyMatch = product.variants.some((v) => {
    const c = variantCountry(v);
    return !c || c === wantedRaw;
  });
  const wanted = wantedRaw && anyMatch ? wantedRaw : "";

  const wrap = $("variants");
  wrap.innerHTML = "";
  let shown = 0;
  product.variants.forEach((v, i) => {
    const c = variantCountry(v);
    // With a market set, hide the other market's variants entirely.
    if (wanted && c && c !== wanted) return;
    shown += 1;
    const row = document.createElement("div");
    row.className = "variant-row";
    row.innerHTML = `
      <div class="vr-top">
        <input type="checkbox" data-i="${i}" checked />
        <div class="variant-name" title="${esc(v.title)}">${esc(v.title)}</div>
        <div class="variant-cost">cost ${money(v.cost, "")}</div>
      </div>
      <div class="vr-bottom">
        <label>SKU
          <div class="sku-wrap">
            <input type="text" class="sku" data-sku="${i}" value="${esc(v.sku)}" spellcheck="false" readonly />
            <button type="button" class="sku-edit" title="Edit SKU" aria-label="Edit SKU">
              <svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 4.5l2 2M4 16l1-3.5 8-8 2.5 2.5-8 8L4 16z"/></svg>
            </button>
          </div>
        </label>
        <label>Your price<input type="number" min="0" step="0.01" data-price="${i}" value="${suggestedPrice(v.cost)}" /></label>
      </div>
    `;
    row.querySelector("input[type=checkbox]").addEventListener("change", (e) => {
      row.classList.toggle("off", !e.target.checked);
    });
    wrap.appendChild(row);
  });

  const markup = Number(settings.markup) > 0 ? Number(settings.markup) : 2;
  const cur = settings.shopCurrency ? ` Store currency is ${settings.shopCurrency}.` : "";
  const market = wanted
    ? `Showing your ${wanted} variant${shown === 1 ? "" : "s"} (set in settings).`
    : "Untick variants you do not sell.";
  $("markup-hint").textContent = `Prices prefilled at ${markup}x cost. ${market}${cur}`;

  $("p-status").value = settings.defaultStatus === "ACTIVE" ? "ACTIVE" : "DRAFT";
  show("state-product");
}

function selectedVariants() {
  const rows = [...document.querySelectorAll("#variants .variant-row")];
  const out = [];
  rows.forEach((row) => {
    const cb = row.querySelector("input[type=checkbox]");
    if (!cb.checked) return;
    const i = Number(cb.dataset.i);
    const price = row.querySelector("input[data-price]").value;
    const sku = row.querySelector("input[data-sku]").value.trim();
    const v = product.variants[i];
    out.push({
      sku,
      price: Number(price).toFixed(2),
      compareAt: null,
      selectedOptions: v.selectedOptions,
    });
  });
  return out;
}

async function doImport() {
  const variants = selectedVariants();
  const status = $("import-status");
  status.classList.remove("hidden", "err");

  if (!variants.length) {
    status.textContent = "Select at least one variant.";
    status.classList.add("err");
    return;
  }
  if (variants.some((v) => !(Number(v.price) > 0))) {
    status.textContent = "Every selected variant needs a price above 0.";
    status.classList.add("err");
    return;
  }

  $("btn-import").disabled = true;
  status.textContent = "Creating product in Shopify (images can take a few seconds)...";

  try {
    const result = await send({
      type: "IMPORT_PRODUCT",
      payload: {
        sourceHandle: product.handle,
        title: $("p-title").value.trim() || product.title,
        descriptionHtml: product.descriptionHtml,
        productType: product.productType,
        tags: product.tags,
        status: $("p-status").value,
        images: product.images,
        variants,
      },
    });
    showSuccess(result);
  } catch (err) {
    status.textContent = err.message;
    status.classList.add("err");
  } finally {
    $("btn-import").disabled = false;
  }
}

function showSuccess(result) {
  $("success-title").textContent = result.title;
  $("success-link").href = result.adminUrl;
  const note = $("success-note");
  if (result.published) {
    note.textContent = "Published to your Online Store channel.";
    note.className = "success-note ok";
  } else {
    note.textContent = result.publishNote || "Created, but not added to a sales channel.";
    note.className = "success-note warn";
  }
  show("state-success");
}

function flash(btn, text) {
  const old = btn.textContent;
  btn.textContent = text;
  setTimeout(() => (btn.textContent = old), 1400);
}

async function copyHtml(html) {
  // Write both HTML and plain text so it pastes well into Shopify's editor.
  const item = new ClipboardItem({
    "text/html": new Blob([html], { type: "text/html" }),
    "text/plain": new Blob([html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()], { type: "text/plain" }),
  });
  await navigator.clipboard.write([item]);
}

async function init() {
  settings = await chrome.storage.local.get(["storeDomain", "clientId", "clientSecret", "defaultCountry", "markup", "defaultStatus", "shopCurrency"]);
  const configured = settings.storeDomain && settings.clientId && settings.clientSecret;
  $("banner-setup").classList.toggle("hidden", !!configured);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const handle = extractHandle(tab?.url || "");
  if (!handle) {
    // If an import finished after the popup closed, surface it.
    const { lastImport } = await chrome.storage.session.get("lastImport");
    if (lastImport && Date.now() - lastImport.at < 60000) {
      showSuccess(lastImport);
      return;
    }
    show("state-notproduct");
    return;
  }

  show("state-loading");
  try {
    product = await send({ type: "FETCH_PRODUCT", handle });
    renderProduct();
  } catch (err) {
    $("error-text").textContent = err.message;
    show("state-error");
  }
}

$("btn-settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("link-setup").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});
$("btn-retry").addEventListener("click", init);
$("btn-again").addEventListener("click", init);
$("btn-import").addEventListener("click", doImport);

// SKU fields are locked by default; the pencil unlocks one for editing.
$("variants").addEventListener("click", (e) => {
  const btn = e.target.closest(".sku-edit");
  if (!btn) return;
  const input = btn.parentElement.querySelector("input[data-sku]");
  if (input.hasAttribute("readonly")) {
    input.removeAttribute("readonly");
    btn.classList.add("editing");
    btn.title = "Lock SKU";
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  } else {
    input.setAttribute("readonly", "");
    btn.classList.remove("editing");
    btn.title = "Edit SKU";
  }
});

// Manual-tools dropdown (icon left of the gear).
$("btn-tools").addEventListener("click", (e) => {
  e.stopPropagation();
  const menu = $("tools-menu");
  const open = menu.classList.toggle("hidden") === false;
  $("btn-tools").setAttribute("aria-expanded", String(open));
});
document.addEventListener("click", (e) => {
  if (!$("tools-menu").classList.contains("hidden") && !e.target.closest("#tools-menu, #btn-tools")) {
    closeToolsMenu();
  }
});

// Runs a manual-tool action, flashes feedback on its label, then closes the menu.
async function runTool(itemId, action) {
  if (!product) return;
  const label = $(itemId).querySelector(".mi-label");
  try {
    flash(label, await action());
  } catch {
    flash(label, "Failed");
  }
  setTimeout(closeToolsMenu, 1000);
}

$("btn-download").addEventListener("click", () =>
  runTool("btn-download", async () => {
    const { count } = await send({ type: "DOWNLOAD_IMAGES", handle: product.handle, urls: product.images.map((i) => i.url) });
    return `Saving ${count}...`;
  })
);
$("btn-copy-desc").addEventListener("click", () =>
  runTool("btn-copy-desc", async () => {
    await copyHtml(product.descriptionHtml);
    return "Copied!";
  })
);
$("btn-copy-title").addEventListener("click", () =>
  runTool("btn-copy-title", async () => {
    await navigator.clipboard.writeText($("p-title").value.trim() || product.title);
    return "Copied!";
  })
);

init();
