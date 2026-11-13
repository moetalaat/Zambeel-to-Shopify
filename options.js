const $ = (id) => document.getElementById(id);

function send(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!res) return reject(new Error("No response from background worker."));
      res.ok ? resolve(res.data) : reject(new Error(res.error));
    });
  });
}

function setMsg(text, kind) {
  const el = $("msg");
  el.textContent = text;
  el.className = "msg" + (kind ? " " + kind : "");
}

function getMarket() {
  const on = document.querySelector("#market button.on");
  return on ? on.dataset.val : "";
}
function setMarket(val) {
  document.querySelectorAll("#market button").forEach((b) => b.classList.toggle("on", b.dataset.val === val));
}
document.querySelectorAll("#market button").forEach((b) =>
  b.addEventListener("click", () => {
    setMarket(b.dataset.val);
    chrome.storage.local.set({ defaultCountry: b.dataset.val }); // market persists immediately
  })
);

async function load() {
  const s = await chrome.storage.local.get(["storeDomain", "clientId", "clientSecret", "vendorName", "defaultCountry", "markup", "defaultStatus", "shopName", "shopCurrency"]);
  if (s.storeDomain) $("domain").value = s.storeDomain;
  if (s.clientId) $("clientId").value = s.clientId;
  if (s.clientSecret) $("clientSecret").value = s.clientSecret;
  if (s.vendorName) $("vendor").value = s.vendorName;
  $("sourceLink").checked = s.saveSourceLink !== false; // default on
  // Default a fresh install to KSA-only, since that's the common case, and
  // persist it so the popup and this page agree from the start.
  if (s.defaultCountry === undefined) await chrome.storage.local.set({ defaultCountry: "KSA" });
  setMarket(s.defaultCountry === undefined ? "KSA" : s.defaultCountry);
  if (s.markup) $("markup").value = s.markup;
  if (s.defaultStatus) $("status").value = s.defaultStatus;
  if (s.shopName) setMsg(`Connected to ${s.shopName} (${s.shopCurrency}).`, "ok");
}

async function saveFields() {
  const markup = Number($("markup").value);
  await chrome.storage.local.set({
    storeDomain: $("domain").value.trim(),
    clientId: $("clientId").value.trim(),
    clientSecret: $("clientSecret").value.trim(),
    vendorName: $("vendor").value.trim(),
    saveSourceLink: $("sourceLink").checked,
    defaultCountry: getMarket(),
    markup: markup > 0 ? markup : 2,
    defaultStatus: $("status").value,
  });
}

$("btn-save").addEventListener("click", async () => {
  await saveFields();
  setMsg("Saved.", "ok");
});

$("btn-test").addEventListener("click", async () => {
  const btn = $("btn-test");
  btn.disabled = true;
  setMsg("Testing (fetching a token, then querying your store)...");
  try {
    // A new token must be minted against the current credentials, so drop any stale cache first.
    await chrome.storage.local.remove("tokenCache");
    const r = await send({
      type: "TEST_CONNECTION",
      domain: $("domain").value,
      clientId: $("clientId").value.trim(),
      clientSecret: $("clientSecret").value.trim(),
    });
    $("domain").value = r.domain;
    await chrome.storage.local.set({ shopName: r.name, shopCurrency: r.currency });
    await saveFields();
    if (r.onlineStore) {
      setMsg(`Connected to ${r.name} (currency ${r.currency}). New products will publish to your Online Store.`, "ok");
    } else {
      setMsg(`Connected to ${r.name} (currency ${r.currency}), but the Online Store channel isn't reachable. Add the read_publications and write_publications scopes to your app so imports publish automatically.`, "warn");
    }
  } catch (err) {
    setMsg(err.message, "err");
  } finally {
    btn.disabled = false;
  }
});

load();
