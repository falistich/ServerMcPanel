# Lantern Minecraft Panel

Dashboard personale self-hosted per controllare un singolo server Minecraft Java Edition. Backend Node.js, Express e Socket.IO; frontend HTML/CSS/JavaScript senza build step o richieste a servizi esterni.

## Struttura

```text
.xsegret/
├── .env.example          # Configurazione locale da copiare in .env
├── .gitignore
├── package.json
├── package-lock.json     # Generato da npm install
├── server.js             # API, sessioni, processo Java e Socket.IO
├── data/                 # Account, impostazioni, upload e backup; esclusi da git
└── public/
    ├── index.html        # Interfaccia dashboard
    ├── app.js            # UI, API e aggiornamenti live
    └── styles.css        # Tema responsive
```

## Avvio su Windows

Prerequisiti: Node.js 20 o successivo, Java compatibile con il software scelto e un file `.jar` (Paper, Vanilla, Velocity o altro software Java). In questo ambiente `JAVA_COMMAND` è impostato su Temurin Java 25.0.4; controlla i requisiti del JAR e dei plugin, perché build vecchie potrebbero richiedere un runtime diverso.

1. Apri PowerShell nella cartella del progetto ed esegui `Copy-Item .env.example .env`.
2. Modifica `.env`: imposta `MC_SERVER_DIR` a una cartella dedicata vuota (per Velocity, una cartella proxy separata). Lascia `MC_SERVER_JAR` commentato se vuoi usare il pulsante **Crea server**. Genera un `SESSION_SECRET` casuale (esempio riportato nel commento di `.env.example`).
3. Esegui `npm install` e poi `npm start`.
4. Apri `http://127.0.0.1:3000` e crea il primo account. È l’unico account admin automatico.
5. Dalla sezione Accessi, crea gli account degli amici e abilita singolarmente l’accesso console. I nuovi account partono senza permesso console.

Per creare un’istanza usa **Crea server** dalla Panoramica: assegna un nome, scegli Paper, Vanilla o Velocity, versione, Java installata e, facoltativamente, un hostname come `play.esempio.it`. Paper/Vanilla richiedono la conferma esplicita della EULA; il JAR ufficiale viene verificato via checksum e il server non parte fino a quando premi **Avvia server**. Puoi cambiare l’hostname da Dati server anche in seguito.

Per abilitare la creazione di altri admin, imposta `ADMIN_CREATION_CODE` in `.env` con un segreto separato di almeno 12 caratteri (24 o più consigliati) e riavvia il pannello. Sulla schermata di login usa **Admin Create** e inserisci il codice, il nuovo nome e una password personale. Ogni admin sceglie una password distinta di almeno 12 caratteri; non viene usata una password universale.

Il server accetta `HOST`, `PORT`, `MC_SERVER_DIR`, `MC_SERVER_JAR`, `JAVA_COMMAND`, `SESSION_SECRET` e `COOKIE_SECURE` dall’ambiente o da `.env`. Senza configurazione, crea `minecraft-server/` accanto al progetto e cerca `server.jar` lì. Sulla pagina Dati server l’admin trova runtime Java, processo, directory, rete, porta e impostazioni sicure lette da `server.properties` o `velocity.toml`.

Per RAM, si può impostare `-Xms` e `-Xmx` dal pannello. Il massimo è limitato al 75% della memoria fisica rilevata per lasciare risorse al sistema operativo; quantità dichiarate come 8 TB non vengono accettate se l’hardware non le possiede. Le impostazioni valgono al successivo avvio del processo Java.

## Funzioni hosting

- Stato online/offline, avvio, arresto controllato e riavvio controllato del processo Minecraft.
- Creazione guidata Paper, Vanilla o Velocity, con nome, versione, runtime Java installato e download ufficiale verificato via checksum. Paper/Vanilla richiedono conferma EULA. La creazione è per una directory dedicata vuota e non sovrascrive file esistenti.
- Indirizzo LAN automatico con porta e hostname personalizzato modificabile. L’hostname viene mostrato/copiato, ma non crea un record DNS: configura un record A/AAAA sul provider DNS verso l’IP pubblico e fai port forwarding della porta del server sul router. Se usi una porta diversa da 25565 aggiungi anche un record SRV. Con IP pubblico dinamico serve un servizio DDNS.
- Per un hostname scelto dopo la creazione, apri **Dati server**, salva il dominio (es. `play.esempio.it`) e poi configura DNS A/AAAA e router; l’indirizzo salvato resta solo un’etichetta finché quei record non sono propagati.
- Pagina admin Dati server con runtime, percorso, PID/uptime, RAM, bind/porta, indirizzi LAN e impostazioni non segrete.
- Console live e comandi; snapshot giocatori tramite comando `list`.
- CPU host, memoria host, spazio libero del volume server e uptime del processo aggiornati ogni 5 secondi. Le metriche sono dell’host, non un profiler preciso del solo processo Java.
- Scelta del tipo Paper/Spigot/Vanilla o Velocity; argomenti Java e comando di arresto sono adattati al tipo. Scelta fra JAR presenti nella root e upload fino a 2 GB; nessun JAR viene scaricato automaticamente.
- File manager con creazione/modifica/eliminazione admin, lettura per utenti autenticati e protezione traversal.
- Backup ZIP manuali e schedulati ogni 6, 12 o 24 ore, fino a 10 snapshot con rotazione automatica dei più vecchi. I backup sono conservati in `data/backups/` sullo stesso host: scarica una copia esterna per proteggerti da guasti del disco.
- Download e restore backup; il restore sostituisce l’intera cartella server, estrae in staging e rifiuta percorsi ZIP non sicuri. Richiede server spento.
- Account utenti creati dall’admin e permesso console revocabile.

La dashboard non include ancora installer automatici/versioni da Modrinth o Paper API, task schedulati arbitrari, database gestiti, protezione DDoS, firewall o gestione simultanea di più processi. I provider hosting distribuiti offrono infrastruttura e rete dedicate che un pannello self-hosted non può replicare sul PC locale.

### Velocity

Seleziona **Velocity proxy** nella pagina Software, carica il JAR ufficiale e avvialo: il pannello omette `nogui` e usa `shutdown` per l’arresto controllato. Al primo avvio Velocity genera `velocity.toml`, modificabile dal file manager. Configura lì i server backend e il forwarding moderno con un segreto; proteggi i backend affinché accettino connessioni solo dal proxy. Il pannello gestisce un solo processo Java alla volta, quindi i backend Paper/Vanilla vanno avviati separatamente. Consulta la [guida ufficiale PaperMC](https://docs.papermc.io/velocity/getting-started/) per requisiti Java e sicurezza.

## Comportamento e sicurezza

- Per impostazione predefinita il pannello ascolta solo su `127.0.0.1`; non è esposto a Internet. `HOST=0.0.0.0` consente l’accesso dalla LAN: usalo solo su una rete fidata e con password forti. Questo starter non fornisce HTTPS, gestione certificati, MFA o protezione da una macchina LAN compromessa.
- Password con hash bcrypt; massimo 10 tentativi di login/registrazione ogni 15 minuti per IP. Le sessioni usano il MemoryStore predefinito di Express: vengono perse al riavvio ed è adatto a un singolo processo personale, non a un deployment pubblico o multi-processo.
- Il primo account è admin. Gli account utente successivi sono creati dall’admin; gli ulteriori admin richiedono password admin attuale e `ADMIN_CREATION_CODE`. File, cartelle, impostazioni heap, ciclo di vita del server, plugin e modifica dei file sono operazioni admin. Utenti autorizzati possono leggere i file ed entrare nella console live.
- Le risoluzioni del file manager sono confinate alla cartella server anche attraverso link simbolici. La console esegue comandi Minecraft inviandoli allo standard input del processo Java; l’admin e gli utenti con permesso console hanno quindi capacità operative elevate sul server.
- L’upload accetta `.jar` fino a 100 MB; carica solo plugin fidati. Modifiche a file in uso non vengono validate semanticamente. Non sono inclusi download da Modrinth/Spigot.
- L’upload del JAR server è limitato a 2 GB. La selezione del JAR è permessa solo a server spento. I backup automatici sono disattivati per default; gli snapshot locali condividono il disco con il server. Il restore offline sostituisce completamente la directory e il servizio resta fermo dopo l’operazione.
- Imposta `SESSION_SECRET` prima dell’uso condiviso: se non specificato viene generato temporaneamente a ogni avvio e le sessioni scadono al riavvio. `.env`, `data/` e il server sono ignorati da git.

## Comandi

- `npm run check`: verifica sintassi JavaScript di backend e frontend.
- `npm start`: avvia il pannello.
