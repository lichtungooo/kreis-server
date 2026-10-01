// Mitschrift-Dienst fuer die Konferenz (Conferencing-Modul im Real Life Stack).
//
// Jeder Browser schreibt nur sein EIGENES Mikrofon mit; darum stimmt der Name
// von selbst, ohne Sprechererkennung. Spricht sein Mensch, schickt er den Ton
// laufend hierher, Block fuer Block (128 ms). Der Dienst speist ihn in einen
// Erkennungsstrom und gibt den Text zurueck, waehrend gesprochen wird. So wie
// Antons Redekreis (github.com/antontranelis/talking-circle, MIT), dessen Weg
// und Modell (aus seinem Volume) hier laufen.
//
// Erkennung: NVIDIA Nemotron 3.5 ASR Streaming 0.6B ueber transcribe.cpp, auf
// der CPU. Ein Modell traegt genau einen laufenden Strom (transcribe.cpp,
// "Thread-safety") und kostet rund 1 GB Speicher. Darum gibt es PLAETZE: je
// Platz ein Modell. Sprechen mehr Menschen zugleich, als Plaetze da sind,
// wartet der Ton der anderen und wird danach aufgeholt (gut dreifach schneller
// als Echtzeit).
//
// Zutritt: dasselbe LiveKit-Token, mit dem man im Raum sitzt. Ton wird nirgends
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
const PLAETZE = Math.max(1, Number(process.env.MITSCHRIFT_PLAETZE || 1))
// 1040 ms Vorausschau, die genaueste Stufe (wie im Redekreis). Kleiner heisst
// schneller sichtbar und etwas ungenauer (0, 1, 6 oder 13).
const VORAUSSCHAU = Number(process.env.MITSCHRIFT_VORAUSSCHAU || 13)

const RATE = 16000
const BLOCK_MAX = 16384 // Bytes je Tonblock; der Browser schickt 4096 (128 ms)
const RUECKSTAND_MAX_S = 90 // so viel Ton darf warten, dann faellt er weg
const LIVE_MS = 250 // so oft hoechstens geht der wachsende Text hinaus
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

// --- Abschnitte und Plaetze ----------------------------------------------------

/**
 * Ein Abschnitt: was ein Mensch am Stueck sagt. Bloecke kommen an, waehrend er
 * spricht; `fertig` heisst, der Browser hat das Ende gemeldet.
 */
export class Abschnitt {
  constructor(id, senden) {
    this.id = id
    this.senden = senden
    this.bloecke = []
    this.fertig = false
    this.verworfen = false
    this.wartendeS = 0
    this.wecker = null
  }
  dazu(pcm) {
    if (this.fertig || this.verworfen) return
    this.wartendeS += pcm.length / RATE
    if (this.wartendeS > RUECKSTAND_MAX_S) { this.verworfen = true; this.bloecke = []; this.wecken(); return }
    this.bloecke.push(pcm)
    this.wecken()
  }
  ende() { this.fertig = true; this.wecken() }
  wecken() { const w = this.wecker; this.wecker = null; w?.() }
  /** Der naechste Block, oder null, wenn nichts mehr kommt. Wartet, solange gesprochen wird. */
  async naechster() {
    for (;;) {
      if (this.verworfen) return null
      const b = this.bloecke.shift()
      if (b) { this.wartendeS -= b.length / RATE; return b }
      if (this.fertig) return null
      await new Promise((r) => { this.wecker = r })
    }
  }
}

/** Eine Warteschlange mit festen Plaetzen; jeder Platz nimmt den naechsten Abschnitt. */
export class Plaetze {
  constructor(sitzungen, erkennen) {
    this.frei = [...sitzungen]
    this.wartend = []
    this.erkennen = erkennen
    this.belegt = 0
  }
  anstellen(abschnitt) { this.wartend.push(abschnitt); this.verteilen() }
  verteilen() {
    while (this.frei.length && this.wartend.length) {
      const sitzung = this.frei.shift()
      const a = this.wartend.shift()
      this.belegt++
      this.erkennen(sitzung, a).finally(() => { this.belegt--; this.frei.push(sitzung); this.verteilen() })
    }
  }
}

const gemessen = { abschnitte: 0, tonMs: 0, rechenMs: 0 }
const sitzungen = []
let modellName = ""
let plaetze = null

function modellFinden() {
  if (process.env.MITSCHRIFT_MODELL) return process.env.MITSCHRIFT_MODELL
  const vorzug = ["Q8_0", "Q6_K", "Q5_K_M", "Q4_K_M"]
  const rang = (f) => { const i = vorzug.findIndex((q) => f.includes(q)); return i < 0 ? vorzug.length : i }
  const da = fs.existsSync(MODELL_ORDNER) ? fs.readdirSync(MODELL_ORDNER).filter((f) => f.endsWith(".gguf")) : []
  da.sort((a, b) => rang(a) - rang(b))
  if (!da.length) throw new Error(`Kein Sprachmodell (.gguf) in ${MODELL_ORDNER}.`)
  return path.join(MODELL_ORDNER, da[0])
}

async function laden() {
  const datei = modellFinden()
  modellName = path.basename(datei)
  const t0 = Date.now()
  for (let i = 0; i < PLAETZE; i++) {
    const modell = await TranscribeModel.load(datei)
    sitzungen.push(modell.createSession({ nThreads: FADEN }))
  }
  plaetze = new Plaetze(sitzungen, erkennen)
  console.log(`Modell bereit in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${modellName}, ${PLAETZE} Platz/Plaetze, ${FADEN} Faeden, Vorausschau ${VORAUSSCHAU}`)
}

/**
 * Ein Abschnitt auf einem Platz: Strom auf, Bloecke hinein, sobald sie da
 * sind, den wachsenden Text hinausgeben, am Ende abschliessen und den Strom
 * zuruecksetzen. Wie Antons Redekreis einen Beitrag erkennt.
 */
async function erkennen(sitzung, a) {
  const t0 = Date.now()
  let tonS = 0
  let strom = null
  try {
    strom = await sitzung.stream({
      language: a.sprache,
      commitPolicy: "stable_prefix",
      family: { kind: "parakeet", attContextRight: VORAUSSCHAU },
    })
    let zuletzt = ""
    let gesendet = 0
    for (let b = await a.naechster(); b; b = await a.naechster()) {
      tonS += b.length / RATE
      await strom.feed(b)
      const { committed, tentative } = strom.text
      const jetzt = `${committed}\u0000${tentative}`
      if (jetzt !== zuletzt && Date.now() - gesendet >= LIVE_MS) {
        zuletzt = jetzt
        gesendet = Date.now()
        a.senden({ typ: "live", id: a.id, text: committed.trim(), vorlaeufig: tentative.trim() })
      }
    }
    if (a.verworfen) { a.senden({ typ: "text", id: a.id, text: "", verworfen: true, grund: "voll" }); return }
    await strom.finalize()
    a.senden({ typ: "text", id: a.id, text: (strom.text.committed || strom.text.full || "").trim() })
  } catch (fehler) {
    console.error("Erkennung fehlgeschlagen:", fehler?.message ?? fehler)
    a.senden({ typ: "text", id: a.id, text: "", verworfen: true, grund: "fehler" })
  } finally {
    try { strom?.reset() } catch {}
    gemessen.abschnitte++
    gemessen.tonMs += tonS * 1000
    gemessen.rechenMs += Date.now() - t0
  }
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
    const bereit = Boolean(plaetze)
    antwort.writeHead(bereit ? 200 : 503, { "Content-Type": "application/json", "Cache-Control": "no-store" })
    antwort.end(JSON.stringify({
      bereit,
      modell: modellName,
      plaetze: PLAETZE,
      belegt: plaetze?.belegt ?? 0,
      wartend: plaetze?.wartend.length ?? 0,
      abschnitte: gemessen.abschnitte,
      // Ton je Rechenzeit; beim Mitschreiben live liegt er nahe 1, weil der
      // Strom auf den Sprecher wartet. Aussagekraeftig beim Aufholen.
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
  maxPayload: BLOCK_MAX + 1024,
  verifyClient: ({ origin }, fertig) => {
    if (!herkunftErlaubt(origin)) { console.warn("Abgewiesen, fremde Herkunft:", origin); return fertig(false, 403) }
    if (wss.clients.size >= VERBINDUNGEN_MAX) return fertig(false, 503)
    fertig(true)
  },
})

wss.on("connection", (ws) => {
  let zutritt = null
  let sprache = "de-DE"
  let offen = null // der Abschnitt, in den die Bloecke gerade gehen
  const senden = (n) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(n)) }
  const frist = setTimeout(() => { if (!zutritt) ws.close(4401, "kein Zutritt") }, 10_000)

  ws.on("message", (daten, binaer) => {
    if (binaer) {
      if (zutritt && offen && daten.byteLength <= BLOCK_MAX) offen.dazu(alsFliess(daten))
      return
    }
    let n
    try { n = JSON.parse(daten.toString()) } catch { return }
    if (n.typ === "hallo") {
      zutritt = tokenPruefen(n.token)
      if (!zutritt) { senden({ typ: "fehler", text: "Das Raum-Token stimmt nicht oder ist abgelaufen." }); ws.close(4403, "Token"); return }
      clearTimeout(frist)
      if (typeof n.sprache === "string" && /^[a-z]{2}(-[A-Z]{2})?$/.test(n.sprache)) sprache = n.sprache
      senden({ typ: "bereit", modell: modellName, laedt: !plaetze })
      return
    }
    if (!zutritt || typeof n.id !== "string" || n.id.length > 80) return
    if (n.typ === "beginn") {
      offen?.ende()
      if (!plaetze) { senden({ typ: "text", id: n.id, text: "", verworfen: true, grund: "laedt" }); offen = null; return }
      offen = new Abschnitt(n.id, senden)
      offen.sprache = sprache
      plaetze.anstellen(offen)
    } else if (n.typ === "ende" && offen?.id === n.id) {
      offen.ende()
      offen = null
    }
  })

  ws.on("close", () => { clearTimeout(frist); offen?.ende(); offen = null })
})

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  server.listen(PORT, () => {
    console.log(`Mitschrift wach auf Port ${PORT}. Erlaubte Herkunft: ${HERKUNFT.join(", ") || "jede"}`)
    laden().catch((e) => { console.error(e.message); process.exit(1) })
  })
}
