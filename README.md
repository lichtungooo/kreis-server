# kreis-server

**LiveKit und Token-Dienst für das Kreis-Modul im Real Life Network**

Trägt den Raum, in dem Menschen und später auch Eli zusammen sitzen: Video, Audio, Daten-Kanal für Live-Transkript und Chat.

| | |
|---|---|
| Adresse | `kreis.wir.ooo` |
| SFU | [LiveKit](https://livekit.com), Apache 2.0 |
| Konzept | `d:\Workspace\30-konzepte\kreis-modul\konzept.md` |
| Modul | `20-repos/rln/src/modules/kreis/` |

## Drei Dienste

**livekit** ist der SFU. Er nimmt die Ströme aller Teilnehmer entgegen und leitet sie weiter. Läuft im Host-Netz, weil WebRTC viele UDP-Ports braucht und NAT zwischen Container und Welt die Verbindung sonst zerlegt.

**token** stellt kurzlebige Zutritts-Token aus. Er existiert aus einem Grund: **das API-Geheimnis darf niemals in den Browser.** Ein Token gilt eine Stunde, für genau einen Raum, mit genau einem Namen. Die Lehre dahinter steht in `memory/feedback_sperre_pruefbares.md`: eine Sperre prüft, was jemand **nicht hat**, niemals was er behaupten kann.

**mitschrift** schreibt mit, was in der Konferenz gesagt wird (Conferencing-Modul im Real Life Stack). Jeder Browser schickt nur die Sprachabschnitte seines eigenen Mikrofons; darum stimmt der Name immer, ohne Sprechererkennung. Erkannt wird mit **NVIDIA Nemotron 3.5 ASR Streaming 0.6B** (Gewichte unter OpenMDW 1.1, der freien Modell-Lizenz der Linux Foundation) über [transcribe.cpp](https://github.com/handy-computer/transcribe.cpp) auf der CPU, nach dem Weg aus Antons [Redekreis](https://github.com/antontranelis/talking-circle) (MIT). Das Modell (rund 750 MB) liest der Dienst nur lesend aus dessen Volume `talking-circle_modelle`. Zutritt nur mit dem LiveKit-Token des Raums; der Ton bleibt nirgends liegen. Ein Modell trägt einen Strom zugleich, darum laufen alle Abschnitte durch eine Warteschlange. Gemessen auf vier Kernen: rund 3,3-fache Echtzeit, 1,3 GB Speicher. Lebenszeichen mit Messwerten: `https://kreis.wir.ooo/mitschrift/gesund`.

## Einrichten

```bash
cp .env.beispiel .env
# Schlüssel und Geheimnis erzeugen:
openssl rand -hex 16   # für LIVEKIT_API_KEY
openssl rand -hex 32   # für LIVEKIT_API_SECRET
# beides in .env eintragen, dann:
docker compose up -d
```

Die Datei `.env` bleibt auf dem Server und geht nie ins Repo.

## Ports

| Port | Wofür | Von außen |
|---|---|---|
| 7881 | LiveKit HTTP und WebSocket | über Traefik |
| 7882 | WebRTC über UDP | direkt, Firewall öffnen |
| 7883 | WebRTC über TCP, wenn UDP blockiert | direkt |
| 3478 | TURN über UDP | direkt |
| 5349 | TURN über TLS | über Traefik |
| 7880 | Token-Dienst | über Traefik, Pfad `/token` |
| 7884 | Mitschrift | über Traefik, Pfad `/mitschrift` (WebSocket) |

## Was der Host noch braucht

**UDP-Empfangspuffer vergrößern.** LiveKit warnt beim Start:

```
UDP receive buffer is too small for a production set-up
{"current": 425984, "suggested": 5000000}
```

Für einen Kreis mit wenigen Leuten trägt der kleine Puffer. Ab etwa zehn gleichzeitigen Teilnehmern gehen Pakete verloren, und das äußert sich als stockender Ton, nicht als Fehlermeldung. Als root:

```bash
echo "net.core.rmem_max=5000000" >> /etc/sysctl.d/99-livekit.conf
echo "net.core.wmem_max=5000000" >> /etc/sysctl.d/99-livekit.conf
sysctl --system
```

**Ports öffnen**, falls eine Firewall davorsteht: UDP 7882 und 3478, TCP 7883. Auf dem Strato-Server steht aktuell keine.

## Prüfen

```bash
curl https://kreis.wir.ooo/token/gesund          # erwartet: wach
curl -H "Origin: http://localhost:5173" \
  "https://kreis.wir.ooo/token?raum=probe&name=Timo"
```

Eine Anfrage ohne eingetragene Herkunft wird mit 403 abgewiesen. Das ist Absicht.

## Was hier bewusst fehlt

- **Keine Aufzeichnung.** Wer mitschneiden will, braucht die Zustimmung aller. Kommt später mit eigener Freigabe-Regel.
- **Keine Moderatoren-Rechte.** Wer den Raum-Namen hat, ist drin. Für einen Kreis unter Bekannten reicht das.
- **Keine Telefon-Einwahl.** Später über SIP möglich.
