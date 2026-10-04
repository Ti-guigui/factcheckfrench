// lib/api.js — Cœur du fact-checking : extraction d'affirmations + vérification sourcée.
// Utilisé par le service worker (background.js) et le panneau latéral (sidepanel.js).

export const DEFAULT_API_URL = "https://api.anthropic.com/v1/messages";
export const DEFAULT_MODEL = "claude-sonnet-4-6";

// Modèles qui acceptent la recherche web avec filtrage dynamique (web_search_20260209).
// Les autres (Haiku 4.5…) restent sur la variante de base.
const MODELES_RECHERCHE_DYNAMIQUE = [
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-5-5",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
];

const SOURCES_PRIORITAIRES = `Sources à privilégier (par ordre) :
1. Données officielles françaises : INSEE, vie-publique.fr, Légifrance, data.gouv.fr, Cour des comptes, Assemblée nationale, Sénat, ministères (.gouv.fr)
2. Données officielles européennes/internationales : Eurostat, OCDE, ONU, OMS, Banque mondiale, FMI
3. Fact-checkers reconnus : AFP Factuel, Les Décodeurs (Le Monde), CheckNews (Libération), Vrai ou Faux (franceinfo)
4. Presse de référence avec données vérifiables
À éviter comme preuve : blogs, réseaux sociaux, sites partisans, tribunes d'opinion.`;

export async function getSettings() {
  const defaults = {
    apiKey: "",
    apiUrl: DEFAULT_API_URL,
    model: DEFAULT_MODEL,
    maxSearches: 3,
    autoCheck: true,
    langue: "fr-FR",
  };
  const stored = await chrome.storage.local.get(defaults);
  const settings = { ...defaults, ...stored };
  settings.apiUrl = (settings.apiUrl || "").trim() || DEFAULT_API_URL;
  return settings;
}

function webSearchTool(apiUrl, model, maxSearches) {
  // Un proxy (free-claude-code…) n'émule que la variante de base de la recherche web.
  const apiOfficielle = apiUrl === DEFAULT_API_URL;
  const type = apiOfficielle && MODELES_RECHERCHE_DYNAMIQUE.includes(model)
    ? "web_search_20260209"
    : "web_search_20250305";
  return { type, name: "web_search", max_uses: Number(maxSearches) || 3 };
}

async function postMessages({ apiUrl, apiKey, body }) {
  let response;
  try {
    response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(`Impossible de joindre ${apiUrl}. Vérifiez votre connexion (ou que le proxy local est lancé).`);
  }

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    const msg = err?.error?.message || `Erreur API (${response.status})`;
    if (response.status === 401) throw new Error("Clé API invalide. Vérifiez-la dans les réglages.");
    if (response.status === 429) throw new Error("Limite de débit atteinte. Patientez quelques secondes.");
    throw new Error(msg);
  }
  return response.json();
}

/**
 * Appel Messages API. Gère `pause_turn` (la recherche web côté serveur peut
 * rendre la main avant la fin) en relançant avec la réponse partielle.
 * Retourne la liste complète des blocs de contenu de l'assistant.
 */
async function callClaude({ apiUrl, apiKey, model, system, messages, tools, maxTokens = 2000 }) {
  const conversation = [...messages];
  const contenu = [];

  for (let tour = 0; tour < 4; tour++) {
    const body = { model, max_tokens: maxTokens, system, messages: conversation };
    if (tools) body.tools = tools;

    const data = await postMessages({ apiUrl, apiKey, body });
    contenu.push(...(data.content || []));

    if (data.stop_reason === "refusal") {
      throw new Error("Le modèle a refusé de traiter cette demande.");
    }
    if (data.stop_reason !== "pause_turn") return contenu;

    conversation.push({ role: "assistant", content: data.content });
  }
  return contenu;
}

function extractText(content) {
  // Avec la recherche web, la réponse est découpée en plusieurs blocs texte
  // (citations) : on les recolle sans séparateur pour ne pas casser le JSON.
  return content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function parseJson(text) {
  const clean = text.replace(/```json|```/g, "").trim();
  const start = clean.indexOf("{");
  const startArr = clean.indexOf("[");
  const first = startArr !== -1 && (startArr < start || start === -1) ? startArr : start;
  if (first === -1) throw new Error("Réponse illisible du modèle.");
  const end = clean.lastIndexOf(clean[first] === "[" ? "]" : "}");
  try {
    return JSON.parse(clean.slice(first, end + 1));
  } catch (_) {
    throw new Error("Réponse illisible du modèle.");
  }
}

/**
 * Étape 1 — Extraire les affirmations vérifiables d'un fragment de transcription.
 * Retourne [{ claim, categorie }] — vide si rien de vérifiable.
 */
export async function extraireAffirmations(texte, locuteur) {
  const { apiKey, apiUrl, model } = await getSettings();
  if (!apiKey) throw new Error("Aucune clé API configurée. Ouvrez les réglages de l'extension.");

  const system = `Tu es un assistant de fact-checking pour le débat public français.
On te donne un fragment de transcription orale (souvent imparfaite : mots mal transcrits, ponctuation absente).
Ta seule tâche : repérer les AFFIRMATIONS FACTUELLES VÉRIFIABLES.

Une affirmation vérifiable contient un fait précis contrôlable : chiffre, statistique, date, événement, contenu d'une loi, citation attribuée, comparaison chiffrée, fait historique.
NE RETIENS PAS : opinions, promesses de campagne, prédictions, jugements de valeur, généralités vagues, questions rhétoriques.

Reformule chaque affirmation en une phrase autonome et claire (corrige les erreurs évidentes de transcription, garde le sens exact).
Réponds UNIQUEMENT avec un tableau JSON, sans texte autour :
[{"claim": "...", "categorie": "économie|social|sécurité|immigration|environnement|institutions|santé|éducation|international|autre"}]
Si aucune affirmation vérifiable : []`;

  const contexte = locuteur ? `Locuteur : ${locuteur}\n` : "";
  const content = await callClaude({
    apiUrl,
    apiKey,
    model,
    system,
    maxTokens: 4000,
    messages: [{ role: "user", content: `${contexte}Fragment :\n"""${texte}"""` }],
  });

  const parsed = parseJson(extractText(content));
  return Array.isArray(parsed) ? parsed.filter((a) => a && a.claim) : [];
}

/**
 * Étape 2 — Vérifier une affirmation avec recherche web.
 * Retourne { verdict, explication, sources: [{titre, url}], confiance }
 */
export async function verifierAffirmation(claim, locuteur) {
  const { apiKey, apiUrl, model, maxSearches } = await getSettings();
  if (!apiKey) throw new Error("Aucune clé API configurée. Ouvrez les réglages de l'extension.");

  const system = `Tu es un fact-checker rigoureux et politiquement neutre, spécialiste du débat public français.
On te donne UNE affirmation à vérifier. Utilise la recherche web pour trouver des sources fiables et récentes.

${SOURCES_PRIORITAIRES}

Verdicts possibles (choisis le plus juste) :
- "vrai" : exact, confirmé par des sources fiables
- "plutot_vrai" : globalement exact, imprécision mineure (chiffre arrondi, léger décalage temporel)
- "trompeur" : contient du vrai mais présenté de façon à induire en erreur (cadrage, omission, hors contexte)
- "faux" : contredit par les sources fiables
- "inverifiable" : impossible à trancher avec les sources disponibles

Règles :
- Neutralité absolue : même rigueur quel que soit le bord politique.
- Distingue le fait brut de son interprétation.
- Si les chiffres varient selon la source/méthode, dis-le.
- Explication : 2 à 4 phrases, en français, précises et sobres. Cite les chiffres corrects si l'affirmation est fausse ou trompeuse.

Après tes recherches, réponds UNIQUEMENT avec ce JSON (sans texte autour) :
{"verdict": "vrai|plutot_vrai|trompeur|faux|inverifiable", "explication": "...", "confiance": "haute|moyenne|basse", "sources": [{"titre": "...", "url": "https://..."}]}`;

  const contexte = locuteur ? ` (déclarée par ${locuteur})` : "";
  const content = await callClaude({
    apiUrl,
    apiKey,
    model,
    system,
    maxTokens: 8000,
    tools: [webSearchTool(apiUrl, model, maxSearches)],
    messages: [
      {
        role: "user",
        content: `Affirmation à vérifier${contexte} :\n"${claim}"`,
      },
    ],
  });

  const result = parseJson(extractText(content));
  if (!result.verdict) throw new Error("Verdict manquant dans la réponse.");
  result.sources = Array.isArray(result.sources) ? result.sources.slice(0, 5) : [];
  return result;
}

/**
 * Raccourci — vérifier directement un texte sélectionné (article, tweet...).
 * Extrait puis vérifie, en une passe si le texte est déjà une affirmation unique.
 */
export async function verifierTexteSelectionne(texte) {
  const affirmations = await extraireAffirmations(texte, null);
  if (affirmations.length === 0) {
    return { affirmations: [], message: "Aucune affirmation factuelle vérifiable dans ce passage (opinion, promesse ou généralité)." };
  }
  return { affirmations };
}

export const VERDICT_LABELS = {
  vrai: "Vrai",
  plutot_vrai: "Plutôt vrai",
  trompeur: "Trompeur",
  faux: "Faux",
  inverifiable: "Invérifiable",
};
