// Kreis — Oberfläche.
//
// Der Aufbau folgt dem, was Menschen aus Videokonferenzen kennen, damit
// niemand neu lernen muss, wo was liegt. Die Wörter sind unsere.

(function () {
  "use strict"

  const { Room, RoomEvent, Track } = LivekitClient
  const $ = (id) => document.getElementById(id)

  const TOKEN_WEG = location.origin + "/token"
  const SERVER_WEG = "wss://" + location.host
  const ZEICHEN = { hand: "✋", daumen: "👍", klatschen: "👏", herz: "💛", lachen: "😄", langsamer: "🐢" }
  const ZEICHEN_DAUER = 4000

  // ---------- Zustand ----------
  let raum = null
  let raumName = ""
  let zugang = ""
  let seit = null
  let takt = null
  let ansicht = merken("kreis-ansicht") || "galerie"
  let seitenblatt = null
  let angeheftet = null
  let vorschauStrom = null
  let hall = null
  let pegelTakt = 0
  let erkennung = null
  let sollErkennen = false
  let leertasteHaelt = false
  let warStumm = false
  let gelesenBis = 0

  const chat = []
  const rede = []
  const haende = new Set()
  const zeichen = new Map()
  let kameras = []
  let mikrofone = []

  function merken(schluessel, wert) {
    try {
      if (wert === undefined) return localStorage.getItem(schluessel)
      localStorage.setItem(schluessel, wert)
    } catch { return null }
  }

  function melden(text, art) {
    $("meldung").innerHTML = text ? `<div class="meldung ${art || "fehler"}">${text}</div>` : ""
  }

  function lampe(welche, gut) {
    const el = $("l-" + welche)
    el.classList.remove("gut", "schlecht")
    el.classList.add(gut ? "gut" : "schlecht")
  }

  function initialen(name) {
    return (name || "").split(/\s+/).map((t) => t[0]).filter(Boolean).join("").slice(0, 2).toUpperCase() || "?"
  }

  /** Aus einem Namen eine ruhige, immer gleiche Farbe. */
  function farbe(text) {
    const toene = ["#4F7FBF", "#3F9B7A", "#8B6BB5", "#B5834F", "#B55F6B", "#3F9B9B", "#5F6BB5", "#A5704F"]
    let summe = 0
    for (let i = 0; i < (text || "").length; i++) summe = (summe + text.charCodeAt(i)) % 997
    return toene[summe % toene.length]
  }

  const uhr = (wann) => new Date(wann).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })

  // ---------- Geräte ----------
  async function geraeteHolen() {
    try {
      const alle = await navigator.mediaDevices.enumerateDevices()
      const nimm = (art, wort) => alle.filter((g) => g.kind === art)
        .map((g, i) => ({ id: g.deviceId, name: g.label || `${wort} ${i + 1}` }))
      kameras = nimm("videoinput", "Kamera")
      mikrofone = nimm("audioinput", "Mikrofon")
      geraeteZeichnen()
    } catch {}
  }

  function geraeteZeichnen() {
    const fuellen = (el, liste, gewaehlt) => {
      el.innerHTML = '<option value="">Was das System wählt</option>' +
        liste.map((g) => `<option value="${g.id}"${g.id === gewaehlt ? " selected" : ""}>${g.name}</option>`).join("")
    }
    if (mikrofone.length) { $("feld-mikro").classList.remove("verstecken"); fuellen($("e-mikro"), mikrofone, merken("kreis-mikro")) }
    if (kameras.length) { $("feld-kamera").classList.remove("verstecken"); fuellen($("e-kamera"), kameras, merken("kreis-kamera")) }
  }

  // ---------- Vorschau im Vorraum ----------
  let vorMikro = true
  let vorKamera = false

  async function vorschauBauen() {
    vorschauStopp()
    $("v-selbst").classList.toggle("verstecken", !vorKamera)
    $("v-aus").classList.toggle("verstecken", vorKamera)
    $("pegel").classList.toggle("verstecken", !vorMikro)
    if (!vorMikro && !vorKamera) return

    try {
      const mikroId = $("e-mikro").value
      const kameraId = $("e-kamera").value
      vorschauStrom = await navigator.mediaDevices.getUserMedia({
        video: vorKamera ? (kameraId ? { deviceId: kameraId } : true) : false,
        audio: vorMikro ? (mikroId ? { deviceId: mikroId } : true) : false,
      })
      melden("")
      geraeteHolen()

      if (vorKamera) $("v-selbst").srcObject = vorschauStrom

      if (vorMikro) {
        hall = new AudioContext()
        const quelle = hall.createMediaStreamSource(vorschauStrom)
        const messer = hall.createAnalyser()
        messer.fftSize = 256
        quelle.connect(messer)
        const daten = new Uint8Array(messer.frequencyBinCount)
        const messen = () => {
          messer.getByteFrequencyData(daten)
          const mittel = daten.reduce((s, w) => s + w, 0) / daten.length
          $("pegel-balken").style.width = Math.min(100, (mittel / 110) * 100) + "%"
          pegelTakt = requestAnimationFrame(messen)
        }
        messen()
      }
    } catch (e) {
      const t = String(e.message || e)
      melden(/Permission|denied|NotAllowed/i.test(t)
        ? "Der Browser gibt Kamera oder Mikrofon nicht frei. Links in der Adresszeile lässt sich das ändern."
        : t)
    }
  }

  function vorschauStopp() {
    cancelAnimationFrame(pegelTakt)
    if (hall) { hall.close(); hall = null }
    vorschauStrom?.getTracks().forEach((t) => t.stop())
    vorschauStrom = null
  }

  $("v-mikro").onclick = () => {
    vorMikro = !vorMikro
    $("v-mikro").classList.toggle("aus", !vorMikro)
    $("v-mikro").innerHTML = `<svg><use href="#i-mikro${vorMikro ? "" : "-aus"}"/></svg>`
    vorschauBauen()
  }
  $("v-kamera").onclick = () => {
    vorKamera = !vorKamera
    $("v-kamera").classList.toggle("aus", !vorKamera)
    $("v-kamera").innerHTML = `<svg><use href="#i-video${vorKamera ? "" : "-aus"}"/></svg>`
    vorschauBauen()
  }
  $("e-mikro").onchange = () => { merken("kreis-mikro", $("e-mikro").value); vorschauBauen() }
  $("e-kamera").onchange = () => { merken("kreis-kamera", $("e-kamera").value); vorschauBauen() }

  // ---------- Dienste prüfen ----------
  async function dienstePruefen() {
    try { lampe("token", (await fetch(TOKEN_WEG + "/gesund")).ok) } catch { lampe("token", false) }
    try {
      const a = await fetch(location.origin + "/rtc/validate")
      lampe("livekit", a.status === 401 || a.ok)
    } catch { lampe("livekit", false) }
  }

  // ---------- Raum anlegen ----------
  $("anlegen").onclick = async () => {
    const name = $("e-raum").value.trim().toLowerCase()
    if (!name) { melden("Gib dem Raum zuerst einen Namen."); return }
    melden("")
    try {
      const a = await fetch(`${TOKEN_WEG}/raum?raum=${encodeURIComponent(name)}`)
      const k = await a.json()
      if (!a.ok) throw new Error(k.fehler)
      zugang = k.zugang
      raumName = k.raum
      $("e-raum").value = k.raum
      const link = `${location.origin}/#${k.raum}:${k.zugang}`
      $("teilen-link").value = link
      $("teilen").classList.remove("verstecken")
      history.replaceState(null, "", `#${k.raum}:${k.zugang}`)
      melden("Der Raum steht. Gib den Link weiter, dann kommen die anderen dazu.", "gut")
    } catch (e) {
      melden(e.message || "Der Raum ließ sich nicht anlegen.")
    }
  }

  $("teilen-kopieren").onclick = async () => {
    try {
      await navigator.clipboard.writeText($("teilen-link").value)
      $("teilen-kopieren").textContent = "kopiert"
      setTimeout(() => ($("teilen-kopieren").textContent = "Kopieren"), 1800)
    } catch {
      $("teilen-link").select()
    }
  }

  // ---------- Beitreten ----------
  $("beitreten").onclick = async () => {
    const name = $("e-name").value.trim()
    const wunschRaum = $("e-raum").value.trim().toLowerCase()
    if (!name) { melden("Trag deinen Namen ein, damit die anderen wissen, wer da ist."); return }
    if (!wunschRaum) { melden("Welcher Raum?"); return }
    merken("kreis-name", name)

    // Ohne Zugangswort erst eines holen. Das geht, weil jeder mit dem
    // Raumnamen auch den Zugang bekommen kann. Der Schutz liegt darin,
    // dass Raumnamen nicht geraten werden.
    if (!zugang || raumName !== wunschRaum) {
      try {
        const a = await fetch(`${TOKEN_WEG}/raum?raum=${encodeURIComponent(wunschRaum)}`)
        const k = await a.json()
        if (!a.ok) throw new Error(k.fehler)
        zugang = k.zugang
        raumName = k.raum
      } catch (e) { melden(e.message || "Dieser Raum geht nicht auf."); return }
    }

    melden("")
    $("beitreten").disabled = true
    $("beitreten").textContent = "verbindet"

    try {
      const adresse = new URL(TOKEN_WEG)
      adresse.searchParams.set("raum", raumName)
      adresse.searchParams.set("name", name)
      adresse.searchParams.set("zugang", zugang)
      const a = await fetch(adresse)
      const k = await a.json()
      if (!a.ok) throw new Error(k.fehler)

      raum = new Room({ adaptiveStream: true, dynacast: true })
      lauschen(raum)

      vorschauStopp()
      await raum.connect(SERVER_WEG, k.token)

      const mikroId = $("e-mikro").value
      const kameraId = $("e-kamera").value
      if (vorMikro) await raum.localParticipant.setMicrophoneEnabled(true, mikroId ? { deviceId: mikroId } : undefined)
      if (vorKamera) await raum.localParticipant.setCameraEnabled(true, kameraId ? { deviceId: kameraId } : undefined)

      seit = Date.now()
      takt = setInterval(dauerZeigen, 1000)
      $("vorraum").classList.add("verstecken")
      $("raum").classList.remove("verstecken")
      $("k-raum").textContent = raumName
      ansichtSetzen(ansicht)
      zeichnen()
    } catch (e) {
      melden(e.message || "Die Verbindung kam nicht zustande.")
      raum = null
    } finally {
      $("beitreten").disabled = false
      $("beitreten").textContent = "Beitreten"
    }
  }

  function lauschen(r) {
    const frisch = () => zeichnen()
    ;[RoomEvent.ParticipantConnected, RoomEvent.ParticipantDisconnected,
      RoomEvent.TrackSubscribed, RoomEvent.TrackUnsubscribed,
      RoomEvent.TrackMuted, RoomEvent.TrackUnmuted,
      RoomEvent.LocalTrackPublished, RoomEvent.LocalTrackUnpublished,
      RoomEvent.ActiveSpeakersChanged].forEach((e) => r.on(e, frisch))

    r.on(RoomEvent.Disconnected, () => gehen(true))

    r.on(RoomEvent.DataReceived, (last) => {
      try {
        const n = JSON.parse(new TextDecoder().decode(last))
        if (n.art === "rede") redeAblegen(n.zeile)
        else if (n.art === "chat") { chat.push(n.zeile); if (seitenblatt === "chat") gelesenBis = chat.length; seiteZeichnen(); zahlen() }
        else if (n.art === "zeichen") { zeichen.set(n.wer, { z: n.zeichen, wann: Date.now() }); zeichnen(); setTimeout(zeichnen, ZEICHEN_DAUER + 60) }
        else if (n.art === "hand") { n.oben ? haende.add(n.wer) : haende.delete(n.wer); zeichnen() }
      } catch {}
    })
  }

  async function sende(nachricht) {
    if (!raum) return
    await raum.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(nachricht)), { reliable: true })
  }

  // ---------- Bühne ----------
  function alle() {
    if (!raum) return []
    return [raum.localParticipant, ...raum.remoteParticipants.values()]
  }

  function kachel(person, gross, geteilt) {
    const ich = person === raum.localParticipant
    const el = document.createElement("div")
    el.className = "kachel" + (gross ? " gross-kachel" : "") + (person.isSpeaking ? " spricht" : "")

    const quelle = geteilt ? Track.Source.ScreenShare : Track.Source.Camera
    const zeigt = geteilt ? person.isScreenShareEnabled : person.isCameraEnabled
    const pub = person.getTrackPublication(quelle)

    if (zeigt && pub?.track) {
      const v = document.createElement("video")
      v.autoplay = true; v.playsInline = true; v.muted = true
      v.className = geteilt ? "geteilt" : (ich ? "selbst" : "")
      pub.track.attach(v)
      el.appendChild(v)
    } else {
      const k = document.createElement("div")
      k.className = "initialen"
      const name = person.name || person.identity
      k.innerHTML = `<b style="background:${farbe(name)}">${initialen(name)}</b>`
      el.appendChild(k)
    }

    if (!ich && !geteilt) {
      const ton = person.getTrackPublication(Track.Source.Microphone)
      if (ton?.track) { const a = document.createElement("audio"); a.autoplay = true; ton.track.attach(a); el.appendChild(a) }
    }

    const z = zeichen.get(person.identity)
    const frisch = z && Date.now() - z.wann < ZEICHEN_DAUER
    if (haende.has(person.identity) || frisch) {
      const oben = document.createElement("div")
      oben.className = "oben"
      if (haende.has(person.identity)) oben.innerHTML += '<span class="hand">✋</span>'
      if (frisch) oben.innerHTML += `<span>${ZEICHEN[z.z] || ""}</span>`
      el.appendChild(oben)
    }

    if (!geteilt) {
      const nadel = document.createElement("button")
      nadel.className = "anheften"
      nadel.dataset.fest = String(angeheftet === person.identity)
      nadel.title = angeheftet === person.identity ? "Nicht mehr festhalten" : "Groß festhalten"
      nadel.innerHTML = '<svg><use href="#i-nadel"/></svg>'
      nadel.onclick = () => { angeheftet = angeheftet === person.identity ? null : person.identity; zeichnen() }
      el.appendChild(nadel)
    }

    const fuss = document.createElement("div")
    fuss.className = "fuss"
    fuss.innerHTML = (person.isMicrophoneEnabled || geteilt ? "" : '<span class="stumm-zeichen"><svg><use href="#i-mikro-aus"/></svg></span>') +
      `<span class="wer">${person.name || person.identity}${ich && !geteilt ? " (ich)" : ""}${geteilt ? " teilt den Bildschirm" : ""}</span>`
    el.appendChild(fuss)

    return el
  }

  function zeichnen() {
    if (!raum) return
    const leute = alle()
    const buehne = $("buehne")
    buehne.innerHTML = ""

    const teilend = leute.find((p) => p.isScreenShareEnabled)

    if (ansicht === "galerie" && !teilend) {
      buehne.className = "raster"
      buehne.dataset.viele = String(Math.min(4, Math.ceil(Math.sqrt(leute.length))))
      leute.forEach((p) => buehne.appendChild(kachel(p, false, false)))
    } else {
      buehne.className = ""
      buehne.removeAttribute("data-viele")
      buehne.style.display = "flex"
      buehne.style.flexDirection = "column"
      buehne.style.gap = "10px"

      let grosse = teilend
      if (!grosse && angeheftet) grosse = leute.find((p) => p.identity === angeheftet)
      if (!grosse) grosse = leute.find((p) => p.isSpeaking && p !== raum.localParticipant)
      if (!grosse) grosse = leute.find((p) => p !== raum.localParticipant) || leute[0]

      const oben = document.createElement("div")
      oben.className = "gross"
      if (grosse) oben.appendChild(kachel(grosse, true, Boolean(teilend)))
      buehne.appendChild(oben)

      const rest = teilend ? leute : leute.filter((p) => p !== grosse)
      if (rest.length) {
        const streifen = document.createElement("div")
        streifen.className = "streifen"
        rest.forEach((p) => streifen.appendChild(kachel(p, false, false)))
        buehne.appendChild(streifen)
      }
    }

    knoepfeZeichnen()
    zahlen()
    if (seitenblatt) seiteZeichnen()
  }

  function knoepfeZeichnen() {
    if (!raum) return
    const mikro = raum.localParticipant.isMicrophoneEnabled
    const kamera = raum.localParticipant.isCameraEnabled
    const teilt = raum.localParticipant.isScreenShareEnabled

    $("s-mikro").className = "knopf" + (mikro ? "" : " warnung")
    $("s-mikro").innerHTML = `<svg><use href="#i-mikro${mikro ? "" : "-aus"}"/></svg><span class="wort">${mikro ? "Ton an" : "stumm"}</span>`
    $("s-kamera").className = "knopf" + (kamera ? "" : " warnung")
    $("s-kamera").innerHTML = `<svg><use href="#i-video${kamera ? "" : "-aus"}"/></svg><span class="wort">${kamera ? "Bild an" : "kein Bild"}</span>`
    $("s-teilen").setAttribute("aria-pressed", String(teilt))
    $("s-hand").setAttribute("aria-pressed", String(haende.has(raum.localParticipant.identity)))
    $("stumm-hinweis").classList.toggle("verstecken", mikro)
  }

  function zahlen() {
    const n = alle().length
    $("z-menschen").textContent = String(n)
    $("z-menschen").classList.toggle("verstecken", n < 1)
    const offen = Math.max(0, chat.length - gelesenBis)
    $("z-chat").textContent = String(offen)
    $("z-chat").classList.toggle("verstecken", offen === 0 || seitenblatt === "chat")
  }

  function dauerZeigen() {
    if (!seit) return
    const s = Math.floor((Date.now() - seit) / 1000)
    const m = Math.floor(s / 60), h = Math.floor(m / 60)
    $("k-dauer").textContent = h > 0
      ? `${h}:${String(m % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`
      : `${m}:${String(s % 60).padStart(2, "0")}`
  }

  // ---------- Ansicht ----------
  function ansichtSetzen(welche) {
    ansicht = welche
    merken("kreis-ansicht", welche)
    $("a-galerie").setAttribute("aria-pressed", String(welche === "galerie"))
    $("a-sprecher").setAttribute("aria-pressed", String(welche === "sprecher"))
    zeichnen()
  }
  $("a-galerie").onclick = () => ansichtSetzen("galerie")
  $("a-sprecher").onclick = () => ansichtSetzen("sprecher")

  $("k-vollbild").onclick = async () => {
    if (document.fullscreenElement) { await document.exitFullscreen() }
    else { await document.documentElement.requestFullscreen().catch(() => {}) }
  }
  document.addEventListener("fullscreenchange", () => {
    $("k-vollbild").innerHTML = `<svg><use href="#i-${document.fullscreenElement ? "klein" : "gross"}"/></svg>`
  })

  // ---------- Steuerung ----------
  $("s-mikro").onclick = async () => {
    if (!raum) return
    await raum.localParticipant.setMicrophoneEnabled(!raum.localParticipant.isMicrophoneEnabled)
    zeichnen()
  }
  $("s-kamera").onclick = async () => {
    if (!raum) return
    await raum.localParticipant.setCameraEnabled(!raum.localParticipant.isCameraEnabled)
    zeichnen()
  }
  $("s-teilen").onclick = async () => {
    if (!raum) return
    try { await raum.localParticipant.setScreenShareEnabled(!raum.localParticipant.isScreenShareEnabled) } catch {}
    zeichnen()
  }
  $("s-hand").onclick = async () => {
    if (!raum) return
    const wer = raum.localParticipant.identity
    const oben = !haende.has(wer)
    oben ? haende.add(wer) : haende.delete(wer)
    zeichnen()
    await sende({ art: "hand", wer, oben })
  }

  // Aufklapp-Felder
  function aufklappBinden(knopf, kasten, fuellen) {
    knopf.onclick = (e) => {
      e.stopPropagation()
      const offen = !kasten.classList.contains("verstecken")
      document.querySelectorAll(".aufklapp").forEach((k) => k.classList.add("verstecken"))
      if (!offen) { fuellen?.(); kasten.classList.remove("verstecken") }
    }
  }
  document.addEventListener("click", () => document.querySelectorAll(".aufklapp").forEach((k) => k.classList.add("verstecken")))
  document.querySelectorAll(".aufklapp").forEach((k) => k.addEventListener("click", (e) => e.stopPropagation()))

  aufklappBinden($("s-zeichen"), $("k-zeichen"))
  $("k-zeichen").querySelectorAll("button").forEach((b) => {
    b.onclick = async () => {
      const art = b.dataset.z
      zeichen.set(raum.localParticipant.identity, { z: art, wann: Date.now() })
      zeichnen()
      setTimeout(zeichnen, ZEICHEN_DAUER + 60)
      $("k-zeichen").classList.add("verstecken")
      await sende({ art: "zeichen", wer: raum.localParticipant.identity, zeichen: art })
    }
  })

  function geraeteListe(kasten, liste, titel, art) {
    kasten.innerHTML = `<div class="titel">${titel}</div>` + (liste.length
      ? liste.map((g) => `<button class="eintrag" data-id="${g.id}"><svg><use href="#i-haken"/></svg><span>${g.name}</span></button>`).join("")
      : '<div class="leer">Nichts gefunden.</div>')
    kasten.querySelectorAll(".eintrag").forEach((b) => {
      b.onclick = async () => {
        await raum?.switchActiveDevice(art, b.dataset.id)
        merken(art === "audioinput" ? "kreis-mikro" : "kreis-kamera", b.dataset.id)
        kasten.classList.add("verstecken")
      }
    })
  }
  aufklappBinden($("s-mikro-pfeil"), $("k-mikro"), () => { geraeteHolen(); geraeteListe($("k-mikro"), mikrofone, "Mikrofon", "audioinput") })
  aufklappBinden($("s-kamera-pfeil"), $("k-kamera"), () => { geraeteHolen(); geraeteListe($("k-kamera"), kameras, "Kamera", "videoinput") })

  // ---------- Seitenleiste ----------
  const TITEL = { menschen: "Wer ist da", chat: "Geschriebenes", protokoll: "Protokoll" }

  function seiteOeffnen(blatt) {
    seitenblatt = seitenblatt === blatt ? null : blatt
    $("seite").classList.toggle("verstecken", !seitenblatt)
    ;["menschen", "chat", "protokoll"].forEach((b) => $("s-" + b).setAttribute("aria-pressed", String(seitenblatt === b)))
    if (seitenblatt === "chat") { gelesenBis = chat.length; zahlen() }
    if (seitenblatt) { $("seite-titel").textContent = TITEL[seitenblatt]; seiteZeichnen() }
  }
  $("s-menschen").onclick = () => seiteOeffnen("menschen")
  $("s-chat").onclick = () => seiteOeffnen("chat")
  $("s-protokoll").onclick = () => { if (!sollErkennen) protokollStart(); seiteOeffnen("protokoll") }
  $("seite-zu").onclick = () => seiteOeffnen(seitenblatt)

  function seiteZeichnen() {
    const koerper = $("seite-koerper")
    const fuss = $("seite-fuss")
    const anzahl = $("seite-anzahl")
    $("warn-protokoll").classList.add("verstecken")
    anzahl.classList.add("verstecken")
    const untenWar = koerper.scrollHeight - koerper.scrollTop - koerper.clientHeight < 90

    if (seitenblatt === "menschen") {
      const leute = alle()
      anzahl.textContent = String(leute.length)
      anzahl.classList.remove("verstecken")
      koerper.innerHTML = leute.map((p) => {
        const name = p.name || p.identity
        const ich = p === raum.localParticipant
        return `<div class="person">
          <span class="bild" style="background:${farbe(name)}">${initialen(name)}</span>
          <span class="name">${name}${ich ? " <em>(ich)</em>" : ""}</span>
          <span class="zeichen">
            ${haende.has(p.identity) ? '<svg style="color:var(--gelb)"><use href="#i-hand"/></svg>' : ""}
            ${p.isScreenShareEnabled ? '<svg style="color:var(--blau)"><use href="#i-teilen"/></svg>' : ""}
            ${p.isSpeaking ? '<span class="redet"></span>' : ""}
            ${p.isMicrophoneEnabled ? "" : '<svg style="color:var(--rot)"><use href="#i-mikro-aus"/></svg>'}
          </span>
        </div>`
      }).join("")
      fuss.classList.add("verstecken")
      return
    }

    if (seitenblatt === "chat") {
      koerper.innerHTML = chat.length ? chat.map((z) => `
        <div class="satz chat">
          <div class="kopfzeile"><b>${z.name}</b><time>${uhr(z.wann)}</time></div>
          <p>${z.text.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]))}</p>
        </div>`).join("") : '<div class="nichts">Noch nichts geschrieben.</div>'

      fuss.classList.remove("verstecken")
      if (!fuss.querySelector("textarea")) {
        fuss.innerHTML = '<textarea id="chat-feld" rows="1" placeholder="Schreiben, Enter schickt"></textarea>' +
          '<button class="senden" id="chat-senden" disabled><svg><use href="#i-senden"/></svg></button>'
        const feld = $("chat-feld")
        const knopf = $("chat-senden")
        feld.oninput = () => { knopf.disabled = !feld.value.trim() }
        feld.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); chatSenden() } }
        knopf.onclick = chatSenden
      }
      if (untenWar) koerper.scrollTop = koerper.scrollHeight
      return
    }

    if (seitenblatt === "protokoll") {
      if (!rede.length && !sollErkennen) $("warn-protokoll").classList.remove("verstecken")
      koerper.innerHTML = rede.length ? rede.map((z) => `
        <div class="satz rede ${z.offen ? "offen" : ""}">
          <div class="kopfzeile"><b>${z.name}</b><time>${uhr(z.wann)}</time></div>
          <p>${z.text}</p>
        </div>`).join("") : `<div class="nichts">${sollErkennen ? "Hört zu." : "Noch nichts gesagt."}</div>`

      fuss.classList.remove("verstecken")
      fuss.innerHTML =
        `<button class="breit ${sollErkennen ? "laeuft" : ""}" id="p-schalter">${sollErkennen ? "läuft mit, anhalten" : "mitlaufen lassen"}</button>` +
        (rede.length ? '<button class="eckig betont" id="p-sichern" title="Herunterladen"><svg><use href="#i-sichern"/></svg></button>' +
          '<button class="eckig" id="p-leeren" title="Leeren"><svg><use href="#i-eimer"/></svg></button>' : "")
      $("p-schalter").onclick = () => (sollErkennen ? protokollHalt() : protokollStart())
      if ($("p-sichern")) $("p-sichern").onclick = protokollSichern
      if ($("p-leeren")) $("p-leeren").onclick = () => { rede.length = 0; seiteZeichnen() }
      if (untenWar) koerper.scrollTop = koerper.scrollHeight
    }
  }

  async function chatSenden() {
    const feld = $("chat-feld")
    const text = feld.value.trim()
    if (!text || !raum) return
    const zeile = { id: Date.now() + "", wer: raum.localParticipant.identity, name: raum.localParticipant.name || "ich", text, wann: Date.now() }
    chat.push(zeile)
    gelesenBis = chat.length
    feld.value = ""
    $("chat-senden").disabled = true
    seiteZeichnen()
    await sende({ art: "chat", zeile })
  }

  // ---------- Protokoll ----------
  function redeAblegen(zeile) {
    const i = rede.findIndex((z) => z.wer === zeile.wer && z.offen)
    if (i >= 0) rede.splice(i, 1)
    if (zeile.text.trim()) rede.push({ ...zeile, offen: zeile.vorlaeufig })
    if (rede.length > 400) rede.splice(0, rede.length - 400)
    if (seitenblatt === "protokoll") seiteZeichnen()
  }

  function protokollStart() {
    if (!raum) return
    const Bauplan = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!Bauplan) { alert("Dieser Browser kennt keine Spracherkennung. Chrome und Edge tragen sie."); return }

    erkennung = new Bauplan()
    erkennung.lang = "de-DE"
    erkennung.continuous = true
    erkennung.interimResults = true

    erkennung.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const text = String(e.results[i][0]?.transcript ?? "").trim()
        if (!text) continue
        const zeile = {
          id: Date.now() + "-" + i,
          wer: raum.localParticipant.identity,
          name: raum.localParticipant.name || "ich",
          text, wann: Date.now(), vorlaeufig: !e.results[i].isFinal,
        }
        redeAblegen(zeile)
        sende({ art: "rede", zeile })
      }
    }
    erkennung.onerror = (e) => {
      const art = String(e?.error ?? "")
      if (art === "no-speech" || art === "aborted") return
      console.warn("Spracherkennung:", art)
    }
    // Chrome beendet sie nach einer Weile Stille von selbst.
    erkennung.onend = () => { if (sollErkennen) { try { erkennung.start() } catch {} } }

    try {
      erkennung.start()
      sollErkennen = true
      $("p-laeuft").classList.remove("verstecken")
      $("s-protokoll").setAttribute("aria-pressed", "true")
      if (seitenblatt === "protokoll") seiteZeichnen()
    } catch {}
  }

  function protokollHalt() {
    sollErkennen = false
    try { erkennung?.stop() } catch {}
    erkennung = null
    $("p-laeuft").classList.add("verstecken")
    if (seitenblatt === "protokoll") seiteZeichnen()
  }

  function protokollSichern() {
    const text = rede.filter((z) => !z.offen)
      .map((z) => `${uhr(z.wann)}  ${z.name}: ${z.text}`).join("\n")
    const kopf = `Kreis ${raumName}\n${new Date().toLocaleString("de-DE")}\nDabei: ${alle().map((p) => p.name || p.identity).join(", ")}\n\n`
    const blob = new Blob([kopf + text], { type: "text/plain;charset=utf-8" })
    const a = document.createElement("a")
    a.href = URL.createObjectURL(blob)
    a.download = `kreis-${raumName}-${new Date().toISOString().slice(0, 10)}.txt`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  // ---------- Leertaste hält das Mikrofon offen ----------
  const schreibtGerade = () => {
    const z = document.activeElement
    return z && (z.tagName === "INPUT" || z.tagName === "TEXTAREA" || z.isContentEditable)
  }
  window.addEventListener("keydown", async (e) => {
    if (e.code !== "Space" || e.repeat || !raum || schreibtGerade()) return
    e.preventDefault()
    warStumm = !raum.localParticipant.isMicrophoneEnabled
    if (warStumm) await raum.localParticipant.setMicrophoneEnabled(true)
    leertasteHaelt = true
    zeichnen()
  })
  window.addEventListener("keyup", async (e) => {
    if (e.code !== "Space" || !leertasteHaelt || !raum) return
    e.preventDefault()
    if (warStumm) await raum.localParticipant.setMicrophoneEnabled(false)
    leertasteHaelt = false
    zeichnen()
  })

  // ---------- Gehen ----------
  $("s-gehen").onclick = () => gehen(false)

  async function gehen(vonAussen) {
    protokollHalt()
    clearInterval(takt)
    if (raum && !vonAussen) await raum.disconnect()
    raum = null; seit = null
    haende.clear(); zeichen.clear()
    chat.length = 0; rede.length = 0; gelesenBis = 0
    seitenblatt = null
    $("seite").classList.add("verstecken")
    $("raum").classList.add("verstecken")
    $("vorraum").classList.remove("verstecken")
    vorschauBauen()
  }

  // ---------- Start ----------
  const name = merken("kreis-name")
  if (name) $("e-name").value = name

  // Ein Link der Form #raum:zugang bringt direkt in den Raum.
  const teil = location.hash.slice(1)
  if (teil.includes(":")) {
    const [r, z] = teil.split(":")
    raumName = r; zugang = z
    $("e-raum").value = r
    $("feld-raum").classList.add("verstecken")
    $("vorraum-titel").textContent = "Kreis " + r
    $("vorraum-unter").textContent = "Du bist eingeladen. Trag deinen Namen ein und komm dazu."
    $("anlegen").classList.add("verstecken")
    $("marke-hin").textContent = "Du wurdest eingeladen"
  } else if (teil) {
    $("e-raum").value = teil
  }

  dienstePruefen()
  geraeteHolen()
  vorschauBauen()
})()
