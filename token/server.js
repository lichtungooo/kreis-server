// Token-Dienst fuer den Kreis.
//
// Eine Aufgabe: ein kurzlebiges Zutritts-Token ausstellen, damit das
// API-Geheimnis niemals im Browser liegt. Das Geheimnis ist etwas, das
// ein Browser nicht hat und nicht behaupten kann.
// Siehe memory/feedback_sperre_pruefbares.md.

import http from "node:http"
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
const RAUM_MUSTER = /^[a-zA-Z0-9_-]{1,64}$/
const NAME_MUSTER = /^[\p{L}\p{N} .,'’-]{1,48}$/u

function herkunftErlaubt(anfrage) {
  const herkunft = anfrage.headers.origin
  if (!herkunft) return false
  return HERKUNFT.includes(herkunft)
}

function kopfzeilen(herkunft) {
  return {
    "Access-Control-Allow-Origin": herkunft,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  }
}

function antworte(antwort, code, koerper, herkunft) {
  antwort.writeHead(code, kopfzeilen(herkunft || "null"))
  antwort.end(JSON.stringify(koerper))
}

const server = http.createServer(async (anfrage, antwort) => {
  const adresse = new URL(anfrage.url, "http://kreis")

  if (adresse.pathname === "/token/gesund") {
    antwort.writeHead(200, { "Content-Type": "text/plain" })
    antwort.end("wach")
    return
  }

  if (anfrage.method === "OPTIONS") {
    const herkunft = anfrage.headers.origin
    antwort.writeHead(herkunftErlaubt(anfrage) ? 204 : 403, kopfzeilen(herkunft || "null"))
    antwort.end()
    return
  }

  if (adresse.pathname !== "/token" || anfrage.method !== "GET") {
    antworte(antwort, 404, { fehler: "Diesen Weg gibt es nicht." })
    return
  }

  if (!herkunftErlaubt(anfrage)) {
    console.warn("Abgewiesen, fremde Herkunft:", anfrage.headers.origin)
    antworte(antwort, 403, { fehler: "Diese Herkunft ist hier nicht eingetragen." })
    return
  }

  const herkunft = anfrage.headers.origin
  const raum = adresse.searchParams.get("raum") || ""
  const name = adresse.searchParams.get("name") || ""
  const kennung = adresse.searchParams.get("kennung") || ""

  if (!RAUM_MUSTER.test(raum)) {
    antworte(antwort, 400, { fehler: "Der Raumname passt nicht: Buchstaben, Ziffern, Strich, bis 64 Zeichen." }, herkunft)
    return
  }
  if (!NAME_MUSTER.test(name)) {
    antworte(antwort, 400, { fehler: "Der Anzeigename passt nicht: bis 48 Zeichen, keine Steuerzeichen." }, herkunft)
    return
  }

  try {
    // Die Kennung trennt zwei Menschen mit gleichem Namen. Fehlt sie,
    // waechst eine aus dem Zufall.
    const wer = RAUM_MUSTER.test(kennung) ? kennung : `gast-${Math.random().toString(36).slice(2, 10)}`

    const token = new AccessToken(SCHLUESSEL, GEHEIMNIS, {
      identity: wer,
      name,
      // Eine Stunde reicht fuer einen Kreis. Wer laenger sitzt, holt neu.
      ttl: "1h",
    })
    token.addGrant({
      room: raum,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      // Der Daten-Kanal traegt Transkript und Chat.
      canPublishData: true,
    })

    antworte(antwort, 200, { token: await token.toJwt(), kennung: wer }, herkunft)
  } catch (fehler) {
    console.error("Token fehlgeschlagen:", fehler)
    antworte(antwort, 500, { fehler: "Das Token liess sich nicht ausstellen." }, herkunft)
  }
})

server.listen(PORT, () => {
  console.log(`Token-Dienst wach auf Port ${PORT}. Erlaubte Herkunft: ${HERKUNFT.join(", ") || "keine"}`)
})
