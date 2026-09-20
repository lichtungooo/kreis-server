# kreis-server

**LiveKit und Token-Dienst für das Kreis-Modul im Real Life Network**

Trägt den Raum, in dem Menschen und später auch Eli zusammen sitzen: Video, Audio, Daten-Kanal für Live-Transkript und Chat.

| | |
|---|---|
| Adresse | `kreis.wir.ooo` |
| SFU | [LiveKit](https://livekit.com), Apache 2.0 |
| Konzept | `d:\Workspace\30-konzepte\kreis-modul\konzept.md` |
| Modul | `20-repos/rln/src/modules/kreis/` |

## Zwei Dienste

**livekit** ist der SFU. Er nimmt die Ströme aller Teilnehmer entgegen und leitet sie weiter. Läuft im Host-Netz, weil WebRTC viele UDP-Ports braucht und NAT zwischen Container und Welt die Verbindung sonst zerlegt.

**token** stellt kurzlebige Zutritts-Token aus. Er existiert aus einem Grund: **das API-Geheimnis darf niemals in den Browser.** Ein Token gilt eine Stunde, für genau einen Raum, mit genau einem Namen. Die Lehre dahinter steht in `memory/feedback_sperre_pruefbares.md`: eine Sperre prüft, was jemand **nicht hat**, niemals was er behaupten kann.

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
