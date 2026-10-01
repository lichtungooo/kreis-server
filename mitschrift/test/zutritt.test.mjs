// Der Zutritt: Nur ein echtes, gueltiges LiveKit-Token fuer einen Raum oeffnet
// die Mitschrift. Laeuft ohne Modell (node --test).
import { test } from "node:test"
import assert from "node:assert/strict"
import { createHmac } from "node:crypto"

process.env.LIVEKIT_API_SECRET = "geheim-fuer-den-test"
const { tokenPruefen } = await import("../server.mjs")

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url")
function token(inhalt, geheimnis = "geheim-fuer-den-test", alg = "HS256") {
  const kopf = b64({ alg, typ: "JWT" })
  const koerper = b64(inhalt)
  const unterschrift = createHmac("sha256", geheimnis).update(`${kopf}.${koerper}`).digest("base64url")
  return `${kopf}.${koerper}.${unterschrift}`
}
const gueltig = { sub: "m-abc", name: "Anna", exp: Math.floor(Date.now() / 1000) + 600, video: { room: "garten", roomJoin: true } }

test("ein gueltiges Token gibt Raum, Kennung und Namen", () => {
  assert.deepEqual(tokenPruefen(token(gueltig)), { raum: "garten", wer: "m-abc", name: "Anna" })
})

test("falsches Geheimnis, abgelaufen, ohne Raum, anderer Algorithmus: kein Zutritt", () => {
  assert.equal(tokenPruefen(token(gueltig, "anderes")), null)
  assert.equal(tokenPruefen(token({ ...gueltig, exp: Math.floor(Date.now() / 1000) - 1 })), null)
  assert.equal(tokenPruefen(token({ ...gueltig, video: {} })), null)
  assert.equal(tokenPruefen(token(gueltig, "geheim-fuer-den-test", "none")), null)
  assert.equal(tokenPruefen("kein.token"), null)
  assert.equal(tokenPruefen(undefined), null)
})

test("ein veraenderter Inhalt bricht die Unterschrift", () => {
  const [k, , u] = token(gueltig).split(".")
  const falsch = b64({ ...gueltig, video: { room: "fremd", roomJoin: true } })
  assert.equal(tokenPruefen(`${k}.${falsch}.${u}`), null)
})
