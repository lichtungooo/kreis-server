// Token-Dienst fuer den Kreis.
//
// Drei Aufgaben:
//   1. Raeume anlegen und ihre zwei Zugaenge ausstellen.
//   2. Zutritts-Token ausstellen, wenn ein Zugang stimmt.
//   3. Was nur ein Moderator darf: stummschalten, entfernen.
//
// Das API-Geheimnis von LiveKit liegt niemals im Browser. Siehe
// memory/feedback_sperre_pruefbares.md.

import http from "node:http"
import { createHmac, timingSafeEqual } from "node:crypto"
import { AccessToken, RoomServiceClient } from "livekit-server-sdk"

const SCHLUESSEL = process.env.LIVEKIT_API_KEY
const GEHEIMNIS = process.env.LIVEKIT_API_SECRET
const PORT = Number(process.env.PORT || 7880)
const HERKUNFT = (process.env.ERLAUBTE_HERKUNFT || "").split(",").map((h) => h.trim()).filter(Boolean)
// Der Weg zum LiveKit-Server im Docker-Netz, fuer die Moderator-Befehle.
const LIVEKIT_WEG = process.env.LIVEKIT_WEG || "http://kreis-livekit:7881"

if (!SCHLUESSEL || !GEHEIMNIS) {
  console.error("LIVEKIT_API_KEY und LIVEKIT_API_SECRET fehlen.")
  process.exit(1)
}

const saal = new RoomServiceClient(LIVEKIT_WEG, SCHLUESSEL, GEHEIMNIS)

// Raum- und Personennamen bleiben eng. Was nicht passt, wird abgewiesen
// statt zurechtgebogen.
const RAUM_MUSTER = /^[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]$/
const NAME_MUSTER = /^[\p{L}\p{N} .,'’-]{1,48}$/u
const KENNUNG_MUSTER = /^[a-zA-Z0-9_-]{1,64}$/

/**
 * Die zwei Zugaenge eines Raums.
 *
 * Sie werden aus dem Raumnamen abgeleitet, nicht gespeichert. Wer den
 * Raumnamen kennt, kommt trotzdem nicht hinein, denn ohne das Server-
 * geheimnis laesst sich kein Wort errechnen. Und derselbe Raum traegt
 * immer dieselben Woerter, darum bleibt ein verschickter Link gueltig.
 *
 * Zwei getrennte Woerter, damit ein Gast-Link nicht zum Moderator macht.
 * Wer den Raum anlegt, bekommt beide; wer eingeladen wird, nur eines.
 */
function zugangswort(raum, rolle) {
  return createHmac("sha256", GEHEIMNIS)
    .update(`kreis-raum:${rolle}:${raum}`)
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

/** Welche Rolle dieses Wort traegt. Null, wenn es zu keiner passt. */
function rolleVon(raum, wort) {
  if (gleich(wort, zugangswort(raum, "moderator"))) return "moderator"
  if (gleich(wort, zugangswort(raum, "gast"))) return "gast"
  return null
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
 * setzen. Dagegen stehen die Zugangsworte.
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

  const raum = (adresse.searchParams.get("raum") || "").toLowerCase().trim()

  // ---- Einen Raum anlegen und beide Zugaenge zurueckgeben ----
  if (weg === "/token/raum") {
    if (!RAUM_MUSTER.test(raum)) {
      antworte(antwort, 400, {
        fehler: "Der Raumname trägt Kleinbuchstaben, Ziffern, Strich und Unterstrich, drei bis vierundsechzig Zeichen.",
      }, herkunft)
      return
    }
    antworte(antwort, 200, {
      raum,
      moderator: zugangswort(raum, "moderator"),
      gast: zugangswort(raum, "gast"),
    }, herkunft)
    return
  }

  // ---- Zutritt geben, wenn ein Zugangswort stimmt ----
  if (weg === "/token") {
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

    const rolle = rolleVon(raum, zugang)
    if (!rolle) {
      antworte(antwort, 403, { fehler: "Dieser Zugang stimmt für diesen Raum nicht." }, herkunft)
      return
    }

    try {
      // Eine eigene Kennung je Mensch und Sitzung, damit zwei mit
      // gleichem Namen sich nicht gegenseitig aus dem Raum werfen.
      const wer = `${rolle === "moderator" ? "m" : "g"}-${Math.random().toString(36).slice(2, 10)}`

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

      antworte(antwort, 200, { token: await token.toJwt(), kennung: wer, rolle }, herkunft)
    } catch (fehler) {
      console.error("Token fehlgeschlagen:", fehler)
      antworte(antwort, 500, { fehler: "Das Token ließ sich nicht ausstellen." }, herkunft)
    }
    return
  }

  // ---- Was nur ein Moderator darf ----
  //
  // ⚠ Diese Befehle laufen ueber die Server-API von LiveKit, nicht ueber
  // den Browser. Ein Teilnehmer kann einen anderen nicht selbst
  // stummschalten, und das ist richtig so: die Sperre haengt am
  // Moderator-Wort, das er nicht hat, nicht an einer Behauptung.
  if (weg === "/token/mod") {
    const zugang = adresse.searchParams.get("zugang") || ""
    const was = adresse.searchParams.get("was") || ""
    const wen = adresse.searchParams.get("wen") || ""

    if (!RAUM_MUSTER.test(raum)) {
      antworte(antwort, 400, { fehler: "Der Raumname passt nicht." }, herkunft)
      return
    }
    if (!KENNUNG_MUSTER.test(wen)) {
      antworte(antwort, 400, { fehler: "Die Kennung passt nicht." }, herkunft)
      return
    }
    if (rolleVon(raum, zugang) !== "moderator") {
      console.warn("Moderator-Befehl ohne Moderator-Wort:", raum, was)
      antworte(antwort, 403, { fehler: "Das darf nur, wer den Raum führt." }, herkunft)
      return
    }

    try {
      if (was === "stumm") {
        // Alle Ton-Spuren dieser Person stumm stellen.
        const leute = await saal.listParticipants(raum)
        const person = leute.find((p) => p.identity === wen)
        if (!person) {
          antworte(antwort, 404, { fehler: "Diese Person ist nicht im Raum." }, herkunft)
          return
        }
        const spuren = (person.tracks || []).filter((t) => t.type === 0 || t.source === 2)
        for (const spur of spuren) {
          await saal.mutePublishedTrack(raum, wen, spur.sid, true)
        }
        antworte(antwort, 200, { getan: "stumm", wen, spuren: spuren.length }, herkunft)
        return
      }

      if (was === "raus") {
        await saal.removeParticipant(raum, wen)
        antworte(antwort, 200, { getan: "raus", wen }, herkunft)
        return
      }

      antworte(antwort, 400, { fehler: "Unbekannter Befehl." }, herkunft)
    } catch (fehler) {
      console.error("Moderator-Befehl fehlgeschlagen:", fehler)
      antworte(antwort, 500, { fehler: "Der Befehl ging nicht durch." }, herkunft)
    }
    return
  }

  antworte(antwort, 404, { fehler: "Diesen Weg gibt es nicht." }, herkunft)
})

server.listen(PORT, () => {
  console.log(`Token-Dienst wach auf Port ${PORT}. Erlaubte Herkunft: ${HERKUNFT.join(", ") || "jede"}`)
  console.log(`LiveKit erreichbar unter ${LIVEKIT_WEG}`)
})
