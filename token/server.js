// Token-Dienst fuer den Kreis.
//
// Zwei Aufgaben:
//   1. Raeume anlegen und ihren Zugang ausstellen.
//   2. Zutritts-Token ausstellen, wenn der Zugang stimmt.
//
// Das API-Geheimnis von LiveKit liegt niemals im Browser. Siehe
// memory/feedback_sperre_pruefbares.md.

import http from "node:http"
import { createHmac, timingSafeEqual } from "node:crypto"
import { AccessToken } from "livekit-server-sdk"

const SCHLUESSEL = process.env.LIVEKIT_API_KEY
const GEHEIMNIS = process.env.LIVEKIT_API_SECRET
const PORT = Number(process.env.PORT || 7880)
const HERKUNFT = (process.env.ERLAUBTE_HERKUNFT || "").split(",").map((h) => h.trim()).filter(Boolean)

if (!SCHLUESSEL || !GEHEIMNIS) {
  console.error("LIVEKIT_API_KEY und LIVEKIT_API_SECRET fehlen.")
  process.exit(1)
}

// Raum- und Personennamen bleiben eng. Was nicht passt, wird abgewiesen
// statt zurechtgebogen.
const RAUM_MUSTER = /^[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]$/
const NAME_MUSTER = /^[\p{L}\p{N} .,'’-]{1,48}$/u

/**
 * Das Zugangswort eines Raums.
 *
 * Es wird aus dem Raumnamen abgeleitet, nicht gespeichert. Wer den
 * Raumnamen kennt, kommt trotzdem nicht hinein, denn ohne das Server-
 * geheimnis laesst sich das Wort nicht errechnen. Und derselbe Raum
 * traegt immer dasselbe Wort, darum bleibt ein verschickter Link gueltig.
 *
 * Ein Raum laesst sich so nicht einzeln schliessen. Fuer einen Kreis
 * unter Bekannten traegt das; wer mehr braucht, speichert Raeume.
 */
function zugangswort(raum) {
  return createHmac("sha256", GEHEIMNIS)
    .update("kreis-raum:" + raum)
    .digest("base64url")
    .slice(0, 12)
}

/** Vergleich ohne Zeitverrat: die Dauer sagt nichts ueber den Inhalt. */
function gleich(a, b) {
  const einer = Buffer.from(String(a))
  const anderer = Buffer.from(String(b))
  if (einer.length !== anderer.length) return false
  return timingSafeEqual(einer, anderer)
}

/**
 * Darf diese Anfrage bedient werden.
 *
 * ⚠ Eine Anfrage ohne `Origin` ist erlaubt, und das ist kein Loch.
 *
 * Der Browser setzt diesen Kopf nur, wenn die Seite von woanders kommt.
 * Ruft die Seite auf kreis.wir.ooo ihren eigenen Dienst, fehlt er. Wer
 * ihn als "nicht eingetragen" liest, sperrt die eigene Seite aus.
 *
 * Was hier geprueft wird, ist genau das, was CORS leisten kann: dass
 * eine FREMDE Seite im Browser eines Menschen keine Token zieht. Gegen
 * ein Programm ohne Browser hilft kein Kopf, denn der laesst sich frei
 * setzen. Dagegen steht das Zugangswort.
 */
function herkunftErlaubt(anfrage) {
  const herkunft = anfrage.headers.origin
  if (!herkunft) return true
  return HERKUNFT.includes(herkunft)
}

function kopfzeilen(herkunft) {
  return {
    // Ohne Herkunft braucht es keine Freigabe, dann ist es dieselbe Seite.
    "Access-Control-Allow-Origin": herkunft || "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  }
}

function antworte(antwort, code, koerper, herkunft) {
  antwort.writeHead(code, kopfzeilen(herkunft))
  antwort.end(JSON.stringify(koerper))
}

const server = http.createServer(async (anfrage, antwort) => {
  const adresse = new URL(anfrage.url, "http://kreis")
  const herkunft = anfrage.headers.origin
  const weg = adresse.pathname

  if (weg === "/token/gesund") {
    antwort.writeHead(200, { "Content-Type": "text/plain" })
    antwort.end("wach")
    return
  }

  if (anfrage.method === "OPTIONS") {
    antwort.writeHead(herkunftErlaubt(anfrage) ? 204 : 403, kopfzeilen(herkunft))
    antwort.end()
    return
  }

  if (anfrage.method !== "GET") {
    antworte(antwort, 405, { fehler: "Nur GET." }, herkunft)
    return
  }

  if (!herkunftErlaubt(anfrage)) {
    console.warn("Abgewiesen, fremde Herkunft:", herkunft)
    antworte(antwort, 403, { fehler: "Diese Herkunft ist hier nicht eingetragen." }, herkunft)
    return
  }

  // ---- Einen Raum anlegen und sein Zugangswort zurueckgeben ----
  if (weg === "/token/raum") {
    const raum = (adresse.searchParams.get("raum") || "").toLowerCase().trim()
    if (!RAUM_MUSTER.test(raum)) {
      antworte(antwort, 400, {
        fehler: "Der Raumname trägt Kleinbuchstaben, Ziffern, Strich und Unterstrich, drei bis vierundsechzig Zeichen.",
      }, herkunft)
      return
    }
    antworte(antwort, 200, { raum, zugang: zugangswort(raum) }, herkunft)
    return
  }

  // ---- Zutritt geben, wenn das Zugangswort stimmt ----
  if (weg === "/token") {
    const raum = (adresse.searchParams.get("raum") || "").toLowerCase().trim()
    const name = adresse.searchParams.get("name") || ""
    const zugang = adresse.searchParams.get("zugang") || ""

    if (!RAUM_MUSTER.test(raum)) {
      antworte(antwort, 400, { fehler: "Der Raumname passt nicht." }, herkunft)
      return
    }
    if (!NAME_MUSTER.test(name)) {
      antworte(antwort, 400, { fehler: "Der Name trägt bis zu achtundvierzig Zeichen, keine Steuerzeichen." }, herkunft)
      return
    }
    if (!gleich(zugang, zugangswort(raum))) {
      antworte(antwort, 403, { fehler: "Dieser Zugang stimmt für diesen Raum nicht." }, herkunft)
      return
    }

    try {
      // Eine eigene Kennung je Mensch und Sitzung, damit zwei mit
      // gleichem Namen sich nicht gegenseitig aus dem Raum werfen.
      const wer = `g-${Math.random().toString(36).slice(2, 10)}`

      const token = new AccessToken(SCHLUESSEL, GEHEIMNIS, {
        identity: wer,
        name,
        // Vier Stunden. Laenger sitzt niemand, und wer doch, holt neu.
        ttl: "4h",
      })
      token.addGrant({
        room: raum,
        roomJoin: true,
        canPublish: true,
        canSubscribe: true,
        // Der Daten-Kanal traegt Protokoll, Chat, Zeichen und Haende.
        canPublishData: true,
      })

      antworte(antwort, 200, { token: await token.toJwt(), kennung: wer }, herkunft)
    } catch (fehler) {
      console.error("Token fehlgeschlagen:", fehler)
      antworte(antwort, 500, { fehler: "Das Token ließ sich nicht ausstellen." }, herkunft)
    }
    return
  }

  antworte(antwort, 404, { fehler: "Diesen Weg gibt es nicht." }, herkunft)
})

server.listen(PORT, () => {
  console.log(`Token-Dienst wach auf Port ${PORT}. Erlaubte Herkunft: ${HERKUNFT.join(", ") || "jede"}`)
})
