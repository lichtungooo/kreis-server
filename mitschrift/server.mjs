// Mitschrift-Dienst fuer die Konferenz (Conferencing-Modul im Real Life Stack).
//
// Jeder Browser schreibt nur sein EIGENES Mikrofon mit. Er erkennt selbst,
// wann sein Mensch spricht, und schickt jeden Sprachabschnitt hierher. Der
// Dienst gibt den Text zurueck, der Browser legt ihn mit Name, Beginn und Ende
// ins Protokoll. Darum stimmt der Name immer, ohne Sprechererkennung.
//
// Erkennung: NVIDIA Nemotron 3.5 ASR Streaming 0.6B ueber transcribe.cpp, auf
// der CPU. Der Weg stammt aus Antons Redekreis (github.com/antontranelis/
// talking-circle, MIT); das Modell liegt schon in dessen Volume.
//
// Ein Modell traegt immer nur einen laufenden Strom (transcribe.cpp,
// "Thread-safety"). Darum laufen alle Abschnitte durch EINE Warteschlange.
// Bei 3,3-facher Echtzeit auf vier Kernen reicht das fuer ein Gespraech, in
// dem meist einer spricht.
//
// Zutritt: dasselbe LiveKit-Token, mit dem man im Raum sitzt. Der Dienst
// prueft die Unterschrift mit dem LiveKit-Geheimnis. Ton wird nirgends
// gespeichert; er lebt nur, bis sein Text da ist.

import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import { createHmac, timingSafeEqual } from "node:crypto"
import { WebSocketServer } from "ws"
import { TranscribeModel } from "transcribe-cpp"

const PORT = Number(process.env.PORT || 7884)
const GEHEIMNIS = process.env.LIVEKIT_API_SECRET
const HERKUNFT = (process.env.ERLAUBTE_HERKUNFT || "").split(",").map((h) => h.trim()).filter(Boolean)
const MODELL_ORDNER = process.env.MODELL_ORDNER || "/models"
const FADEN = Number(process.env.MITSCHRIFT_FAEDEN || 3)

// Grenzen. Ein Abschnitt ist ein Satz oder ein paar, kein Vortrag: Der
// Browser schneidet spaetestens nach 30 Sekunden.
const RATE = 16000
const ABSCHNITT_MAX_S = 31
const WARTESCHLANGE_MAX = 40
const JE_VERBINDUNG_MAX = 4
const VERBINDUNGEN_MAX = 80

if (!GEHEIMNIS) {
  console.error("LIVEKIT_API_SECRET fehlt.")
  process.exit(1)
}

// --- Zutritt -----------------------------------------------------------------

const b64 = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64")

/**
 * Prueft ein LiveKit-Token (JWT, HS256). Gibt Raum, Kennung und Namen zurueck
 * oder null. Eine Sperre prueft, was jemand nicht hat: das Geheimnis.
 */
export function tokenPruefen(token, geheimnis = GEHEIMNIS, jetzt = Date.now()) {
  if (typeof token !== "string") return null
  const teile = token.split(".")
  if (teile.length !== 3) return null
  try {
    const kopf = JSON.parse(b64(teile[0]).toString())
    if (kopf.alg !== "HS256") return null
    const soll = createHmac("sha256", geheimnis).update(`${teile[0]}.${teile[1]}`).digest()
    const ist = b64(teile[2])
    if (soll.length !== ist.length || !timingSafeEqual(soll, ist)) return null
    const inhalt = JSON.parse(b64(teile[1]).toString())
    if (typeof inhalt.exp !== "number" || inhalt.exp * 1000 < jetzt) return null
    const raum = inhalt.video?.room
    if (typeof raum !== "string" || !inhalt.video?.roomJoin) return null
    return { raum, wer: String(inhalt.sub ?? ""), name: String(inhalt.name ?? "") }
  } catch {
    return null
  }
}

function herkunftErlaubt(herkunft) {
  if (!herkunft) return true
  return HERKUNFT.length === 0 || HERKUNFT.includes(herkunft)
}

// --- Erkennung ---------------------------------------------------------------

function modellFinden() {
  if (process.env.MITSCHRIFT_MODELL) return process.env.MITSCHRIFT_MODELL
  const vorzug = ["Q8_0", "Q6_K", "Q5_K_M", "Q4_K_M"]
  const da = fs.existsSync(MODELL_ORDNER) ? fs.readdirSync(MODELL_ORDNER).filter((f) => f.endsWith(".gguf")) : []
  da.sort((a, b) => rang(a) - rang(b))
  function rang(f) { const i = vorzug.findIndex((q) => f.includes(q)); return i < 0 ? vorzug.length : i }
  if (!da.length) throw new Error(`Kein Sprachmodell (.gguf) in ${MODELL_ORDNER}.`)
  return path.join(MODELL_ORDNER, da[0])
}

let sitzung = null
let modellName = ""
let schlange = Promise.resolve()
let wartend = 0
const gemessen = { abschnitte: 0, tonMs: 0, rechenMs: 0 }

async function laden() {
  const datei = modellFinden()
  modellName = path.basename(datei)
  const t0 = Date.now()
  const modell = await TranscribeModel.load(datei)
  sitzung = modell.createSession({ nThreads: FADEN })
  console.log(`Modell bereit in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${modellName}, ${FADEN} Faeden`)
}

/**
 * Ein Abschnitt, von vorn bis hinten, so wie Antons Redekreis einen Beitrag
 * erkennt: Strom auf, Ton hinein, abschliessen, Strom zuruecksetzen.
 */
async function erkennen(pcm, sprache) {
  const strom = await sitzung.stream({
    language: sprache,
    commitPolicy: "stable_prefix",
    // 1040 ms Vorausschau, die genaueste Stufe (wie im Redekreis).
    family: { kind: "parakeet", attContextRight: 13 },
  })
  try {
    const STUECK = 2048 // 128 ms, die Groesse, in der der Redekreis fuettert
    for (let i = 0; i < pcm.length; i += STUECK) await strom.feed(pcm.subarray(i, i + STUECK))
    await strom.finalize()
    return (strom.text.committed || strom.text.full || "").trim()
  } finally {
    strom.reset()
  }
}

/** Reiht einen Abschnitt ein. Alle laufen nacheinander durch das eine Modell. */
function einreihen(pcm, sprache) {
  wartend++
  const auftrag = schlange.then(async () => {
    const t0 = Date.now()
    try {
      return await erkennen(pcm, sprache)
    } finally {
      wartend--
      gemessen.abschnitte++
      gemessen.tonMs += (pcm.length / RATE) * 1000
      gemessen.rechenMs += Date.now() - t0
    }
  })
  schlange = auftrag.then(() => {}, () => {})
  return auftrag
}

/** Int16 (wie der Browser schickt) in Float32 (wie das Modell will). */
function alsFliess(roh) {
  const ganz = new Int16Array(roh.buffer, roh.byteOffset, Math.floor(roh.byteLength / 2))
  const aus = new Float32Array(ganz.length)
  for (let i = 0; i < ganz.length; i++) aus[i] = ganz[i] / 32768
  return aus
}

// --- Server ------------------------------------------------------------------

const server = http.createServer((anfrage, antwort) => {
  if (anfrage.url === "/mitschrift/gesund") {
    const bereit = Boolean(sitzung)
    antwort.writeHead(bereit ? 200 : 503, { "Content-Type": "application/json", "Cache-Control": "no-store" })
    antwort.end(JSON.stringify({
      bereit,
      modell: modellName,
      wartend,
      abschnitte: gemessen.abschnitte,
      // Wie viel schneller als Echtzeit die Erkennung laeuft.
      faktor: gemessen.rechenMs ? Number((gemessen.tonMs / gemessen.rechenMs).toFixed(2)) : null,
    }))
    return
  }
  antwort.writeHead(404, { "Content-Type": "text/plain" })
  antwort.end("nicht hier")
})

const wss = new WebSocketServer({
  server,
  path: "/mitschrift",
  maxPayload: ABSCHNITT_MAX_S * RATE * 2 + 1024,
  verifyClient: ({ origin }, fertig) => {
    if (!herkunftErlaubt(origin)) { console.warn("Abgewiesen, fremde Herkunft:", origin); return fertig(false, 403) }
    if (wss.clients.size >= VERBINDUNGEN_MAX) return fertig(false, 503)
    fertig(true)
  },
})

wss.on("connection", (ws) => {
  let zutritt = null
  let sprache = "de-DE"
  let naechsterAbschnitt = null
  let offen = 0
  const senden = (n) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(n)) }

  // Wer sich nicht binnen zehn Sekunden ausweist, fliegt.
  const frist = setTimeout(() => { if (!zutritt) ws.close(4401, "kein Zutritt") }, 10_000)

  ws.on("message", async (daten, binaer) => {
    if (!binaer) {
      let n
      try { n = JSON.parse(daten.toString()) } catch { return }
      if (n.typ === "hallo") {
        zutritt = tokenPruefen(n.token)
        if (!zutritt) { senden({ typ: "fehler", text: "Das Raum-Token stimmt nicht oder ist abgelaufen." }); ws.close(4403, "Token"); return }
        clearTimeout(frist)
        if (typeof n.sprache === "string" && /^[a-z]{2}(-[A-Z]{2})?$/.test(n.sprache)) sprache = n.sprache
        senden({ typ: "bereit", modell: modellName, laedt: !sitzung })
      } else if (n.typ === "abschnitt" && zutritt && typeof n.id === "string" && n.id.length <= 80) {
        naechsterAbschnitt = n.id
      }
      return
    }

    // Ton: gehoert zum zuletzt angekuendigten Abschnitt.
    const id = naechsterAbschnitt
    naechsterAbschnitt = null
    if (!zutritt || !id) return
    if (!sitzung || offen >= JE_VERBINDUNG_MAX || wartend >= WARTESCHLANGE_MAX) {
      senden({ typ: "text", id, text: "", verworfen: true, grund: !sitzung ? "laedt" : "voll" })
      return
    }
    const pcm = alsFliess(daten)
    if (pcm.length < RATE * 0.3) { senden({ typ: "text", id, text: "" }); return }
    offen++
    try {
      const text = await einreihen(pcm, sprache)
      senden({ typ: "text", id, text })
    } catch (fehler) {
      console.error("Erkennung fehlgeschlagen:", fehler?.message ?? fehler)
      senden({ typ: "text", id, text: "", verworfen: true, grund: "fehler" })
    } finally {
      offen--
    }
  })

  ws.on("close", () => clearTimeout(frist))
})

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  server.listen(PORT, () => {
    console.log(`Mitschrift wach auf Port ${PORT}. Erlaubte Herkunft: ${HERKUNFT.join(", ") || "jede"}`)
    laden().catch((e) => { console.error(e.message); process.exit(1) })
  })
}
