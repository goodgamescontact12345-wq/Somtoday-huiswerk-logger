# Somtoday Huiswerk Logger

Een browserextensie (Manifest V3) die **elk huiswerk-item vastlegt dat Somtoday toont**,
**waarschuwt zodra een docent iets wijzigt** en de **volledige geschiedenis** bewaart —
in de geest van Vencord's MessageLogger, maar voor Somtoday.

Doel: zichtbaar maken wanneer huiswerk op het laatste moment wordt toegevoegd of
veranderd. Scholen hebben daar vaak regels over; met deze logger heb je in ieder geval
vastgelegd wat er stond, wanneer het er stond en wat er daarna anders werd.

## Hoe het werkt

De extensie bouwt de Somtoday-API niet na en vraagt niet om je wachtwoord. In plaats
daarvan leest ze mee met de verzoeken die de Somtoday-webapp zelf doet:

```
Somtoday-pagina (MAIN world)
  src/injected.js   haakt in op fetch + XMLHttpRequest, leest JSON-antwoorden mee
        │  window.postMessage
  src/content.js    brug naar de extensie (geen logica)
        │  chrome.runtime.sendMessage
  src/background.js normaliseert → vergelijkt met vorige stand → schrijft + meldt
        │
  IndexedDB (indexedDB "somtoday-huiswerk-logger")
        │
  src/history.js    geschiedenis, diffs, tijdlijn, bewijs exporteren
```

Omdat de pagina zijn eigen sessie gebruikt, werkt dit met elke schoolomgeving en zonder
OAuth-trucs. Er worden geen tokens of cookies opgeslagen.

## Wat er wordt vastgelegd

Per huiswerk-item een record met de canonieke velden (titel, vak, omschrijving, deadline,
docent, soort, inleverplicht, aantal bijlagen) **plus de volledige ruwe JSON** van
Somtoday. Dat laatste is belangrijk: als een docent iets wijzigt dat de logger niet als
veld kent (een bijlage, een opmerking), wordt dat alsnog gedetecteerd en bewaard.

Bij elke ophaalactie:

- **nieuw** — item stond nog niet eerder in de data;
- **gewijzigd** — veld-voor-veld diff met de vorige stand (deadline, omschrijving, …);
- **verdwenen** — item zit niet meer in de data (alleen als de ophaalactie compleet lijkt,
  dus niet bij paginering).

Velden die Somtoday bij elk antwoord zelf bijwerkt (`laatstGewijzigdOp`, `_links`, …)
worden genegeerd, anders zou elke pagina-load een nepwijziging zijn.

## Installeren

1. Open `chrome://extensions` (of `edge://extensions`).
2. Zet **Ontwikkelaarsmodus** aan.
3. Kies **Load unpacked** / **Uitgepakte extensie laden** en selecteer deze map.
4. Open Somtoday in een tab en log in.

De extensie heeft iconen nodig; die staan in `icons/`. Ontbreken ze? Genereer ze met:

```bash
npm run icons
```

## Gebruiken

- **Op de Somtoday-huiswerkpagina zelf**: rechts schuift een drawer open met de eerdere
  versies van dat item, met tijdstempels, wat er per versie veranderde, en wanneer de
  logger het voor het eerst zag. Zie [Versies op de Somtoday-pagina](#versies-op-de-somtoday-pagina).
- **Popup** (klik op het extensie-icoon): hoeveel items er vastgelegd zijn, wijzigingen
  vandaag, laatste controle, meldingen aan/uit en het controle-interval.
- **Geschiedenis** (knop in de popup of via een notificatie): wijzigingenlijst met filters,
  per wijziging een veldentabel (was → werd), de tijdlijn van dat item, de ruwe
  Somtoday-gegevens en **Kopieer als tekst** om iets aan een mentor of docent te laten zien.
- **Diagnose**: welke endpoints huiswerk opleveren, welke ophaalacties er waren en welke
  items er nu bekend zijn. Handig als je schoolomgeving een ander antwoordformaat blijkt
  te gebruiken.
- **Exporteer JSON**: volledige dump van items, gebeurtenissen en ophaalacties.

De logger controleert bij elke pageload, elke 10 minuten zolang een Somtoday-tab zichtbaar
open staat, en via een alarm (standaard elke 15 minuten) door eerder gedane GET-verzoeken
opnieuw te doen in een open Somtoday-tab.

Waarom niet gewoon vanuit de achtergrond? Somtoday authenticeert zijn REST-verkeer met een
Bearer-token dat de webapp zelf in het geheugen houdt (`POST /oauth2/token`, daarna
`Authorization: Bearer …` naar `api.somtoday.nl`). Dat token bestaat alleen binnen die
pagina. De replay in `src/injected.js` hergebruikt het daarom in het tabblad zelf, in het
geheugen — het wordt nooit opgeslagen of verstuurd. Lukt een replay niet meer omdat de
sessie verlopen is, dan zegt de popup dat. Zonder open Somtoday-tab kan er niets worden
opgehaald: de extensie logt niet zelfstandig in.

## Versies op de Somtoday-pagina

Open je een huiswerk-item in Somtoday, dan schuift er rechts een donkere drawer open, in
dezelfde stijl als Somtoday's eigen detailpaneel. Bovenaan staat **geschiedenis** met een
**×** om hem te verbergen; rechtsonder blijft dan een **Laat zien**-knop staan met het
aantal wijzigingen. Die keuze wordt onthouden, ook over paginas heen.

In de drawer:

- **huiswerk** — het item zoals het er nu staat: titel, datum, de omschrijving in een eigen
  blok, en een **Afvinken**-vakje (alleen lokaal bewaard, per item);
- **Voor het eerst gezien** — het moment waarop de logger dit item voor het eerst vastlegde;
- **Somtoday meldt aangemaakt** — alleen als Somtoday zelf een aanmaakdatum meestuurt;
- de **eerdere versies**, elk als een eigen blok met rode rand: de datum en omschrijving
  zoals ze toen waren, met daaronder de gewijzigde velden (was → werd);
- een knop naar de volledige geschiedenis, en een picker als er meerdere items op de
  pagina herkend worden.

Daarnaast zet de extensie één regel **in Somtoday's eigen huiswerkblok**, direct onder de
omschrijving: *Toegevoegd op 05-11-2026 14:22 · 2 wijzigingen*. Die regel heeft inline
styles, zodat Somtoday's CSS hem niet onzichtbaar maakt, en verdwijnt weer zodra je naar
een ander item gaat. Ook hier geldt: dat is het moment waarop de logger het item voor het
eerst zag — niet per se de officiële plaatsingsdatum van de docent.

Het paneel herkent het item via `src/lib/match.js`: eerst een id in de URL, dan de titel die
letterlijk op de pagina staat, dan titelwoorden plus het vak. Onder een drempel toont het
niets — een verkeerd item tonen is erger dan geen paneel tonen. Uitzetten kan met
"Toon versies op de Somtoday-pagina" in de popup.

Belangrijk: Somtoday heeft geen publieke DOM waar we op kunnen bouwen, dus dit is
patroonherkenning. Verandert de huiswerkpagina van opbouw, dan kan het paneel wegblijven of
het verkeerde item tonen. De opgeslagen geschiedenis is daar niet van afhankelijk.

## Rechten

| Permissie | Waarom |
| --- | --- |
| `host_permissions: https://*.somtoday.nl/*` | Alleen op Somtoday meelezen. |
| `storage`, `unlimitedStorage` | Geschiedenis lokaal bewaren. |
| `notifications` | Melding bij een wijziging. |
| `alarms` | Periodiek controleren. |

Geen netwerktoegang tot andere hosts, geen externe server, geen analytics. Er gaat niets
naar een server van derden: al het verkeer is het verkeer dat Somtoday zelf doet, en alle
opslag staat lokaal.

De officiële weg om Somtoday-data server-side op te halen is [Somtoday
Connect](https://som.today/partnerprogramma): een client-id via het partnerprogramma,
aangevraagd door een school of koppelpartner. Dat is geen route die een leerling zelf kan
nemen, en daarom werkt deze extensie met de sessie van de webapp.

## Beperkingen (lees dit)

- **Het in-page paneel is patroonherkenning.** Het koppelt een pagina aan een vastgelegd
  item via de URL of de titel. Zonder id in de URL kan het paneel ontbreken of een verkeerd
  item tonen; de geschiedenis zelf blijft kloppen.
- **"Voor het eerst gezien" is niet de aanmaaktijd van de docent.** Het is het moment waarop
  de logger het item zag. Alleen als Somtoday zelf een aanmaakdatum meestuurt, tonen we die
  erbij als "Somtoday meldt aangemaakt".
- **Herkennen is heuristisch.** Somtoday publiceert geen stabiele huiswerk-API. De logger
  scoort objecten op kenmerken (titel + deadline + vak-hint) in plaats van één vast
  endpoint te vertrouwen. Wijkt jouw schoolomgeving af, dan zie je in **Diagnose** dat er
  wel ophaalacties zijn maar geen items — meld dan de endpointnaam, dan kan de herkenning
  worden bijgesteld.
- **Tijdstempels zijn van jouw apparaat**, niet van Somtoday's server. Somtoday toont zelf
  geen wijzigingsgeschiedenis, dus dit is onderbouwing, geen juridisch bewijs. Zet je
  systeemklok goed en exporteer op tijd.
- **"Verdwenen" is conservatief.** Bij paginering of een gedeeltelijk antwoord wordt een
  ontbrekend item niet als verwijderd gemarkeerd.
- **Alleen GET-verzoeken worden herhaald.** Verstuurt de app huiswerk via POST of GraphQL,
  dan is een echte pageload nodig voor een nieuwe meting; de periodieke controle doet dan
  niets tot je Somtoday opent.
- **Eerste vastlegging is een inventarisatie.** Bij de eerste keer dat een endpoint wordt
  gezien, worden items als *nieuw* gelogd maar zonder melding, zodat je niet meteen een
  berg notificaties krijgt. Ze zijn standaard verborgen in de lijst ("Toon eerste
  vastlegging").
- **Alleen Chromium.** De extensie gebruikt `world: "MAIN"` in `content_scripts`
  (Chrome/Edge 111+). Firefox heeft een andere aanpak nodig.
- **Niet bedoeld om docenten te bestoken.** Gebruik het als geheugensteun en gespreksstof,
  niet als wapen.

## Ontwikkelen

Geen build-stap, geen dependencies. De extensie is platte ES-modules.

```bash
npm test        # unit tests voor herkenning, diff en weergave (node:test)
npm run icons   # iconen opnieuw genereren
```

```
manifest.json
src/
  injected.js     netwerk-hook in de pagina (MAIN world)
  content.js      brug pagina ↔ extensie
  background.js   service worker: normaliseren, diffen, opslaan, melden
  popup.html/js   status en instellingen
  history.html/js geschiedenis, diagnose, export
  panel.js        in-page versieweergave (shadow DOM)
  ui.css          gedeelde styling
  lib/
    extract.js    payload → huiswerk-records (heuristisch)
    diff.js       ruwe payload → veldwijzigingen
    match.js      pagina → vastgelegd item (heuristisch)
    describe.js   labels en leesbare weergave van wijzigingen
    store.js      IndexedDB (items, gebeurtenissen, ophaalacties, endpoints)
    util.js       hashes, datumparsing, formattering
test/             node:test suites
tools/            icoongenerator
```

## Privacy

Alles staat lokaal in je browserprofiel. Er gaat niets naar een server. Wissen kan met
**Wissen** in de geschiedenispagina of door de extensie te verwijderen. De export bevat
wél huiswerkgegevens en docentnamen — deel die alleen met wie je wilt.
