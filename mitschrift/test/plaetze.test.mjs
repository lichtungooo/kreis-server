// Abschnitte und Plaetze ohne Modell: Bloecke kommen an, waehrend gesprochen
// wird; mehr Sprechende als Plaetze warten und werden danach aufgeholt.
import { test } from "node:test"
import assert from "node:assert/strict"

process.env.LIVEKIT_API_SECRET = "geheim-fuer-den-test"
const { Abschnitt, Plaetze } = await import("../server.mjs")

const block = () => new Float32Array(2048)
const warte = () => new Promise((r) => setTimeout(r, 0))

/** Eine Attrappe der Erkennung: zaehlt Bloecke, bis der Abschnitt endet. */
function zaehlend(protokoll) {
  return async (sitzung, a) => {
    let n = 0
    for (let b = await a.naechster(); b; b = await a.naechster()) n++
    protokoll.push({ sitzung, id: a.id, bloecke: n, verworfen: a.verworfen })
  }
}

test("ein Abschnitt reicht Bloecke durch, waehrend gesprochen wird, und endet mit dem Ende", async () => {
  const fertig = []
  const p = new Plaetze(["s1"], zaehlend(fertig))
  const a = new Abschnitt("a-1", () => {})
  p.anstellen(a)
  a.dazu(block()); a.dazu(block())
  await warte()
  assert.equal(fertig.length, 0, "noch offen, der Mensch spricht")
  a.dazu(block()); a.ende()
  await warte(); await warte()
  assert.deepEqual(fertig, [{ sitzung: "s1", id: "a-1", bloecke: 3, verworfen: false }])
})

test("zwei sprechen zugleich bei einem Platz: der zweite wartet, sein Ton geht nicht verloren", async () => {
  const fertig = []
  const p = new Plaetze(["s1"], zaehlend(fertig))
  const anna = new Abschnitt("anna", () => {})
  const bert = new Abschnitt("bert", () => {})
  p.anstellen(anna); p.anstellen(bert)
  for (let i = 0; i < 5; i++) { anna.dazu(block()); bert.dazu(block()) }
  bert.ende()
  await warte()
  assert.equal(p.wartend.length, 1)
  anna.ende()
  for (let i = 0; i < 5; i++) await warte()
  assert.deepEqual(fertig.map((f) => [f.id, f.bloecke]), [["anna", 5], ["bert", 5]])
})

test("zwei Plaetze: beide laufen zugleich", async () => {
  const fertig = []
  const p = new Plaetze(["s1", "s2"], zaehlend(fertig))
  const anna = new Abschnitt("anna", () => {})
  const bert = new Abschnitt("bert", () => {})
  p.anstellen(anna); p.anstellen(bert)
  assert.equal(p.belegt, 2)
  anna.ende(); bert.ende()
  for (let i = 0; i < 4; i++) await warte()
  assert.equal(fertig.length, 2)
  assert.equal(p.belegt, 0)
})

test("zu viel wartender Ton faellt weg, statt den Speicher zu fuellen", () => {
  const a = new Abschnitt("lang", () => {})
  const sekunde = new Float32Array(16000)
  for (let i = 0; i < 95; i++) a.dazu(sekunde)
  assert.equal(a.verworfen, true)
  assert.equal(a.bloecke.length, 0)
})

test("Ton an einer ungeraden Stelle im Puffer wird richtig gelesen (der Absturz vom 01.10.2026)", async () => {
  const { alsFliess } = await import("../server.mjs")
  const gross = Buffer.alloc(9)
  gross.writeInt16LE(16384, 1)
  gross.writeInt16LE(-32768, 3)
  const ungerade = gross.subarray(1, 5) // beginnt bei Byte 1
  assert.equal(ungerade.byteOffset % 2, 1)
  assert.deepEqual([...alsFliess(ungerade)], [0.5, -1])
})
