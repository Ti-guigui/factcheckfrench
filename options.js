// options.js — chargement / sauvegarde des réglages + test de la clé.

const DEFAULT_API_URL = "https://api.anthropic.com/v1/messages";
const MODELES_VALIDES = ["claude-sonnet-4-6", "claude-haiku-4-5", "claude-opus-4-8"];

const $ = (id) => document.getElementById(id);

async function load() {
  const s = await chrome.storage.local.get({
    apiKey: "",
    apiUrl: "",
    model: "claude-sonnet-4-6",
    maxSearches: 3,
    demoMode: false,
  });
  $("apiKey").value = s.apiKey;
  $("apiUrl").value = s.apiUrl === DEFAULT_API_URL ? "" : s.apiUrl;
  // Ancien identifiant daté de Haiku ou modèle inconnu : on retombe sur une option existante
  $("model").value = MODELES_VALIDES.includes(s.model)
    ? s.model
    : s.model.startsWith("claude-haiku-4-5") ? "claude-haiku-4-5" : "claude-sonnet-4-6";
  $("maxSearches").value = String(s.maxSearches);
  $("demoMode").checked = s.demoMode;
}

async function save() {
  const apiKey = $("apiKey").value.trim();
  const apiUrl = $("apiUrl").value.trim();
  const model = $("model").value;
  const maxSearches = Number($("maxSearches").value);
  const demoMode = $("demoMode").checked;
  const status = $("status");

  if (apiUrl && !/^https?:\/\//.test(apiUrl)) {
    status.textContent = "✗ L'adresse de l'API doit commencer par http:// ou https://";
    status.className = "err";
    return;
  }

  await chrome.storage.local.set({ apiKey, apiUrl, model, maxSearches, demoMode });

  if (!apiKey) {
    status.textContent = "Réglages enregistrés (aucune clé fournie).";
    status.className = "ok";
    return;
  }

  status.textContent = "Réglages enregistrés. Test de la clé en cours…";
  status.className = "";

  const url = apiUrl || DEFAULT_API_URL;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model,
        max_tokens: 16,
        messages: [{ role: "user", content: "ping" }],
      }),
    });
    if (r.ok) {
      status.textContent = "✓ Clé valide. Tout est prêt !";
      status.className = "ok";
    } else {
      const err = await r.json().catch(() => ({}));
      status.textContent = `✗ ${err?.error?.message || "Clé invalide ou modèle indisponible (" + r.status + ")."}`;
      status.className = "err";
    }
  } catch (e) {
    status.textContent = `✗ Impossible de joindre ${url}. Vérifiez votre connexion (ou que le proxy local est lancé).`;
    status.className = "err";
  }
}

$("save").addEventListener("click", save);
load();
