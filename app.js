/*
  Gesetzessammlung Web-App - Version 07.11.2026f
  Grundgerüst: Datenbank laden, einfache Suche, Liste, Anzeige der Vorschrift.

  Daten (aus LawWebExport.vb): Texts = Zeilen [Gesetz, Land, Paragraf, Nummer, Text, Html]
  Namen wie in der Windows-App: Variablen und Funktionen mit großem Anfangsbuchstaben, englisch.
*/
"use strict";


// ======================================================================
// Spalten und Zustand
// ======================================================================
const ColGesetz = 0, ColLand = 1, ColParagraf = 2, ColNummer = 3, ColText = 4, ColHtml = 5;
const FormatVersion = 1;
const AppVersion = "24";      // wie CacheName in sw.js – wird im Lade-Fenster angezeigt
const MaxResults = 1000;           // mehr Treffer werden nicht angezeigt (Liste bleibt flüssig)

const State = {
  Data: null,                      // ganze Datendatei (Version, Created, Css, Laws, Texts)
  Texts: [],                       // alle Vorschriften
  LawKeys: new Map(),              // "baugb" -> [{ Gesetz, Land, First, Last }]  (Gesetz klein geschrieben)
  Results: [],                     // Indizes in Texts
  CurrentIndex: -1,                // angezeigte Vorschrift
  Words: []                        // Suchwörter für die Markierung
};

const El = id => document.getElementById(id);
const WideScreen = window.matchMedia("(min-width: 700px)");
const IsWide = () => document.body.classList.contains("TwoColumns");


// ======================================================================
// Start
// ======================================================================
window.addEventListener("load", async () => {
  // Offline-Fähigkeit (nur über https bzw. localhost möglich)
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  // Daten sollen nicht automatisch vom System gelöscht werden
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  El("SearchBox").addEventListener("input", SearchBox_Input);
  El("ResultList").addEventListener("click", ResultList_Click);
  El("ResultList").addEventListener("keydown", ResultList_KeyDown);
  El("SearchBox").addEventListener("keydown", SearchBox_KeyDown);
  El("BackButton").addEventListener("click", () => history.back());
  El("PreviousButton").addEventListener("click", () => ShowText(State.CurrentIndex - 1, true));
  El("NextButton").addEventListener("click", () => ShowText(State.CurrentIndex + 1, true));
  El("MenuButton").addEventListener("click", () => ShowMenu(true));
  El("LayoutButton").addEventListener("click", LayoutButton_Click);
  WideScreen.addEventListener("change", ApplyLayout);   // iPad drehen, Split View, Fenstergröße
  window.addEventListener("resize", ApplyLayout);        // Vergrößerung der Leseansicht anpassen
  ApplyLayout();
  El("CloseMenuButton").addEventListener("click", () => ShowMenu(false));
  El("FileInput").addEventListener("change", FileInput_Change);
  El("AppVersion").textContent = "App-Version " + AppVersion;
  window.addEventListener("popstate", () => document.body.classList.remove("ShowDetail"));

  ShowWelcome("Datenbank wird geladen …");
  try {
    const Buffer = await LoadFromStorage();
    if (Buffer) {
      ApplyData(await UnpackData(Buffer));
    } else {
      ShowWelcome("Noch keine Daten auf diesem Gerät.", true);
    }
  } catch (Ex) {
    ShowWelcome("Die gespeicherte Datenbank konnte nicht gelesen werden: " + Ex.message, true);
  }
});


// ======================================================================
// Datenbank: Datei einlesen, entpacken, auf dem Gerät speichern
// ======================================================================
async function FileInput_Change(E) {
  const File = E.target.files[0];
  E.target.value = "";
  if (!File) return;
  El("DataInfo").textContent = "Datei wird gelesen …";
  try {
    const Buffer = await File.arrayBuffer();
    const Data = await UnpackData(Buffer);     // erst prüfen, dann speichern
    await SaveToStorage(Buffer);
    ApplyData(Data);
    ShowMenu(false);
  } catch (Ex) {
    El("DataInfo").textContent = "Fehler: " + Ex.message;
  }
}

// gzip entpacken und JSON lesen
async function UnpackData(Buffer) {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("Dieser Browser kann die Datei nicht entpacken (iOS 16.4 oder neuer nötig).");
  }
  const Stream = new Blob([Buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
  const Json = await new Response(Stream).text();
  const Data = JSON.parse(Json);
  if (!Data || !Array.isArray(Data.Texts)) throw new Error("Die Datei enthält keine Gesetzestexte.");
  if (Data.Version > FormatVersion) throw new Error("Die Datei ist neuer als die App – bitte App neu laden.");
  return Data;
}

// Daten übernehmen und Verzeichnis der Gesetze aufbauen
function ApplyData(Data) {
  State.Data = Data;
  State.Texts = Data.Texts;
  State.LawKeys = new Map();
  let Previous = null;
  State.Texts.forEach((Row, Index) => {
    if (Previous && Previous.Gesetz === Row[ColGesetz] && Previous.Land === Row[ColLand]) {
      Previous.Last = Index;
      return;
    }
    Previous = { Gesetz: Row[ColGesetz], Land: Row[ColLand], First: Index, Last: Index };
    const Key = Row[ColGesetz].toLowerCase();
    if (!State.LawKeys.has(Key)) State.LawKeys.set(Key, []);
    State.LawKeys.get(Key).push(Previous);
  });

  // Stylesheet der Windows-App; "body" wird zum Anzeigebereich #LawBody
  // Einzüge in cm werden zu em (bezogen auf 16px), damit sie in der Leseansicht mit der Schrift wachsen
  El("LawCss").textContent = (Data.Css || "").replace(/\bbody\b/g, "#LawBody")
    .replace(/(\d+(?:\.\d+)?)cm\b/g, (Match, Value) => (Value * 37.795 / 16).toFixed(3) + "em");

  const Created = Data.Created ? new Date(Data.Created).toLocaleString("de-DE") : "unbekannt";
  El("DataInfo").textContent = `${State.Texts.length.toLocaleString("de-DE")} Vorschriften aus ` +
    `${CountLaws().toLocaleString("de-DE")} Gesetzen, Stand ${Created}.`;
  RunSearch();
}

function CountLaws() {
  let Count = 0;
  State.LawKeys.forEach(List => Count += List.length);
  return Count;
}

// Speicher im Browser (IndexedDB): ein einziger Eintrag "Data" mit der gepackten Datei
function OpenStorage() {
  return new Promise((Resolve, Reject) => {
    const Request = indexedDB.open("Gesetzessammlung", 1);
    Request.onupgradeneeded = () => Request.result.createObjectStore("Files");
    Request.onsuccess = () => Resolve(Request.result);
    Request.onerror = () => Reject(Request.error);
  });
}

async function SaveToStorage(Buffer) {
  const Db = await OpenStorage();
  return new Promise((Resolve, Reject) => {
    const Transaction = Db.transaction("Files", "readwrite");
    Transaction.objectStore("Files").put(Buffer, "Data");
    Transaction.oncomplete = () => Resolve();
    Transaction.onerror = () => Reject(Transaction.error);
  });
}

async function LoadFromStorage() {
  const Db = await OpenStorage();
  return new Promise((Resolve, Reject) => {
    const Request = Db.transaction("Files").objectStore("Files").get("Data");
    Request.onsuccess = () => Resolve(Request.result || null);
    Request.onerror = () => Reject(Request.error);
  });
}


// ======================================================================
// Suche
//   "baugb"                     ganzes Gesetz
//   "baugb 35"                  Nummer 35 (auch Teil 35, Anlage 35)
//   "baugb 3-13"                Nummernbereich
//   "baugb 3a"                  genau "§ 3a"
//   "lbo bw 5"                  Gesetz mit Land
//   "baugb außenbereich"        Wort im Gesetz
//   "außenbereich"              Volltext in allen Gesetzen (alle Wörter müssen vorkommen)
//   "§ 35 Abs. 1 BauGB"         Zitat wird umgestellt
//   "\"schädliche Umwelt\""     Phrase: Wörter genau in dieser Reihenfolge
//   "baugb 34 + 35"             Oder: Teile mit "+" oder " OR " getrennt; ein Teil ohne Gesetz
//   "lärm OR geräusch"          gilt für das Gesetz des ersten Teils (hier: kein Gesetz = Volltext)
// ======================================================================
let SearchTimer = null;

function SearchBox_Input() {
  // iPhone: beim Tippen zurück zur Liste
  if (document.body.classList.contains("ShowDetail") && !IsWide()) history.back();
  clearTimeout(SearchTimer);
  SearchTimer = setTimeout(RunSearch, 250);
}

// Suchfeld "?": Liste der Gesetze in der Sammlung.
// Titelzeilen (erste Zeile jedes Gesetzes, Nummer 0) = je Gesetz eine Zeile, sortiert nach Land, dann Gesetz.
// Über die erste Zeile statt nur über Nummer 0, damit kein Gesetz doppelt oder gar nicht erscheint.
function ShowLawList() {
  State.Words = [];
  State.Results = [];
  State.LawKeys.forEach(List => List.forEach(Law => State.Results.push(Law.First)));
  const Compare = (X, Y) => X.localeCompare(Y, "de", { sensitivity: "base", numeric: true });
  State.Results.sort((A, B) => Compare(State.Texts[A][ColLand], State.Texts[B][ColLand]) ||
                               Compare(State.Texts[A][ColGesetz], State.Texts[B][ColGesetz]));
  ShowResults();
  El("ListInfo").textContent = `${State.Results.length} Gesetze · ` + DataStand();
}

function RunSearch() {
  if (!State.Data) return;
  if (El("SearchBox").value.trim() === "?") { ShowLawList(); return; }
  const Queries = ParseInput(El("SearchBox").value);
  State.Words = [].concat(...Queries.map(Q => Q.Words));
  if (Queries.length === 0) {
    State.Results = [];
    ClearText();                                  // Detailbereich leeren
    El("ListInfo").textContent = DataStand() + " · Version " + AppVersion;
    El("ResultList").innerHTML = `<div class="Welcome">Suchbegriff eingeben, z.B.<ul>` +
      `<li>baugb 35</li><li>baugb 30-35</li><li>baugb außenbereich</li><li>§ 35 Abs. 1 BauGB</li>` +
      `<li>"schädliche Umwelteinwirkungen"</li><li>baugb 34 + 35</li></ul>` +
      `<p>Suchbegriffe wie baugb 35 oder § 35 baugb werden nur als Gesetze und Paragrafen gesucht, nicht im Volltext. ` +
      `Suchbegriffe in Anführungszeichen werden nur im Volltext gesucht, auch wenn es sich um Gesetze handelt.</p>` +
      `<p>? im Suchfeld zeigt eine Liste der in der Gesetzessammlung enthaltenen Gesetze.</p>` +
      `<p>Gesetzessammlung<br>© 2026 Bernd Schieferdecker</p></div>`;
    return;
  }
  // Oder: Treffer aller Teile zusammenführen (jede Vorschrift einmal, in der Reihenfolge der Sammlung)
  const Found = new Set();
  for (const Query of Queries) for (const Index of FindTexts(Query)) Found.add(Index);
  State.Results = [...Found].sort((A, B) => A - B);
  ShowResults();
}

// Suchzeile in Oder-Teile zerlegen; jeder Teil wird mit ParseQuery gelesen
function ParseInput(Input) {
  // Typografische Anführungszeichen (iPhone-Tastatur) wie normale behandeln
  const Text = Input.replace(/[„“”«»]/g, '"').trim();
  if (Text === "") return [];
  // "+" und " OR " trennen – aber nicht innerhalb einer Phrase in "…"
  const Parts = [];
  let Current = "", InPhrase = false;
  for (let I = 0; I < Text.length; I++) {
    const C = Text[I];
    if (C === '"') InPhrase = !InPhrase;
    if (!InPhrase && C === "+") { Parts.push(Current); Current = ""; continue; }
    if (!InPhrase && /^\sOR\s/.test(Text.substr(I, 4))) { Parts.push(Current); Current = ""; I += 2; continue; }
    Current += C;
  }
  Parts.push(Current);

  const Queries = [];
  let FirstLaws = null;
  for (const Part of Parts) {
    const Query = ParseQuery(Part);
    if (Query.Empty) continue;
    // Teil ohne Gesetz übernimmt das Gesetz des ersten Teils ("baugb 34 + 35")
    if (Queries.length === 0) FirstLaws = Query.Laws;
    else if (!Query.Laws && FirstLaws) {
      const WithLaw = ParseQuery(Part, FirstLaws);
      Object.assign(Query, WithLaw);
    }
    Queries.push(Query);
  }
  return Queries;
}

// Einen Teil der Suchzeile zerlegen. Laws: Gesetz vorgeben (für Oder-Teile ohne eigenes Gesetz)
function ParseQuery(Input, Laws) {
  let Text = Input.trim().replace(/\s+/g, " ");
  const Query = { Empty: Text === "" || Text === '"', Laws: null, NumberFrom: null, NumberTo: null, Label: null, Words: [] };
  if (Query.Empty) return Query;

  // Zitat umstellen: "§ 35 Abs. 1 Satz 2 BauGB" -> "BauGB 35"; "§ 1 16. BImSchV" -> "16. BImSchV 1"
  // Auch für Gesetze, die nicht in der Sammlung sind ("§ 1 GWB" -> "GWB 1"); nicht bei "…" (dann Volltext)
  const Citation = Text.match(/^(?:§§?|art\.?|artikel)\s*(\d+[a-z]?)\b/i);
  if (Citation && !Text.includes('"')) {
    const Parts = Text.split(" ");
    let Done = false;
    for (const Length of [2, 1]) {
      const Law = Parts.slice(-Length).join(" ");
      if (Parts.length > Length && State.LawKeys.has(Law.toLowerCase())) {
        Text = Law + " " + Citation[1];
        Done = true;
        break;
      }
    }
    const Last = Parts[Parts.length - 1];
    if (!Done && Parts.length > 2 && IsLawName(Last)) {
      // zweiteilig wie "16. BImSchV": vorletztes Teil "16." gehört dazu
      const Before = Parts[Parts.length - 2];
      Text = (/^\d+\.$/.test(Before) && Parts.length > 3 ? Before + " " : "") + Last + " " + Citation[1];
    }
  }

  // Wörter und Phrasen ("…" bleibt ein Suchbegriff)
  let Tokens = [];
  for (const Match of Text.matchAll(/"([^"]*)"?|(\S+)/g)) {
    if (Match[1] !== undefined) {
      if (Match[1].trim() !== "") Tokens.push({ Text: Match[1].trim(), Phrase: true });
    } else {
      Tokens.push({ Text: Match[2], Phrase: false });
    }
  }
  const Plain = Count => Tokens.length >= Count && Tokens.slice(0, Count).every(T => !T.Phrase);

  // Gesetz: erst zwei Wörter ("16. BImSchV"), dann ein Wort
  if (Laws) {
    Query.Laws = Laws;
  } else {
    for (const Length of [2, 1]) {
      if (!Plain(Length)) continue;
      const Key = Tokens.slice(0, Length).map(T => T.Text).join(" ").toLowerCase();
      if (State.LawKeys.has(Key)) {
        Query.Laws = State.LawKeys.get(Key);
        Tokens = Tokens.slice(Length);
        break;
      }
    }
    // Gesetz, das nicht in der Sammlung ist: "GWB 1", "16. BImSchV 3" (Name, dann Nummer)
    // -> als Gesetz suchen (keine Treffer), nicht im Volltext. Mit "GWB" in Anführungszeichen: Volltext.
    if (!Query.Laws) {
      for (const Length of [2, 1]) {
        if (!Plain(Length + 1)) continue;
        const Name = Tokens.slice(0, Length).map(T => T.Text);
        const NameOk = Length === 1 ? IsLawName(Name[0]) : /^\d+\.$/.test(Name[0]) && IsLawName(Name[1]);
        if (NameOk && /^(\d+|\d+-\d+|\d+[a-z])$/i.test(Tokens[Length].Text)) {
          Query.Laws = [];
          Query.UnknownLaw = Name.join(" ");
          Tokens = Tokens.slice(Length);
          break;
        }
      }
    }
  }

  // Land nach dem Gesetz ("LBO BW")
  if (Query.Laws && !Laws && Plain(1)) {
    const Land = Tokens[0].Text.toLowerCase();
    const WithLand = Query.Laws.filter(L => L.Land.toLowerCase() === Land);
    if (WithLand.length > 0) {
      Query.Laws = WithLand;
      Tokens = Tokens.slice(1);
    }
  }

  // Nummer nach dem Gesetz: "35", "3-13", "3a"
  if (Query.Laws && Plain(1)) {
    const First = Tokens[0].Text;
    let Match;
    if ((Match = First.match(/^(\d+)-(\d+)$/))) {
      Query.NumberFrom = +Match[1];
      Query.NumberTo = +Match[2];
      Tokens = Tokens.slice(1);
    } else if ((Match = First.match(/^\d+$/))) {
      Query.NumberFrom = Query.NumberTo = +Match[0];
      Tokens = Tokens.slice(1);
    } else if ((Match = First.match(/^\d+[a-z]$/i))) {
      Query.Label = Match[0].toLowerCase();
      Tokens = Tokens.slice(1);
    }
  }

  // Rest: Wörter und Phrasen (Platzhalter * wird ignoriert)
  Query.Words = Tokens.map(T => T.Text.replace(/\*/g, "")).filter(T => T !== "");
  return Query;
}

// Treffer suchen: Indizes der passenden Zeilen
function FindTexts(Query) {
  const Patterns = Query.Words.map(W => new RegExp(WordPattern(W), "i"));
  const LabelPattern = Query.Label ? new RegExp("^\\S+\\s+" + EscapeRegExp(Query.Label) + "\\b", "i") : null;
  const Results = [];

  const Check = Index => {
    const Row = State.Texts[Index];
    if (Query.NumberFrom !== null && (Row[ColNummer] < Query.NumberFrom || Row[ColNummer] > Query.NumberTo)) return;
    if (LabelPattern && !LabelPattern.test(Row[ColParagraf])) return;
    for (const Pattern of Patterns) {
      if (!Pattern.test(Row[ColText]) && !Pattern.test(Row[ColParagraf])) return;
    }
    Results.push(Index);
  };

  if (Query.Laws) {
    for (const Law of Query.Laws) for (let I = Law.First; I <= Law.Last; I++) Check(I);
  } else {
    for (let I = 0; I < State.Texts.length; I++) Check(I);
  }
  return Results;
}

// Suchmuster für ein Wort oder eine Phrase: zwischen den Wörtern einer Phrase beliebiger Leerraum (auch Zeilenwechsel)
function WordPattern(Word) {
  return Word.split(/\s+/).map(EscapeRegExp).join("\\s+");
}

// Sieht aus wie eine Gesetzesabkürzung: enthält Buchstaben, keine Satzzeichen außer Punkt/Bindestrich
function IsLawName(Text) {
  return /[A-Za-zÄÖÜäöüß]/.test(Text) && /^[\wÄÖÜäöüß.\-]+$/.test(Text);
}

function EscapeRegExp(Text) {
  return Text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}


// ======================================================================
// Liste
// ======================================================================
function ShowResults() {
  const Count = State.Results.length;
  El("ListInfo").textContent = (Count === 0 ? "Keine Treffer" :
    Count > MaxResults ? `${Count.toLocaleString("de-DE")} Treffer (erste ${MaxResults})` :
    `${Count.toLocaleString("de-DE")} Treffer`) + " · " + DataStand();

  const Html = [];
  for (const Index of State.Results.slice(0, MaxResults)) {
    const Row = State.Texts[Index];
    Html.push(`<div class="Item" data-index="${Index}">` +
      `<div class="ItemLaw">${Encode(Row[ColGesetz])} · ${Encode(Row[ColLand])}</div>` +
      `<div class="ItemParagraf">${Encode(Row[ColParagraf])}</div></div>`);
  }
  // Nichts gefunden: Hinweis und Google-Suche (öffnet Safari bzw. den Standardbrowser)
  if (Count === 0) {
    const Url = "https://www.google.com/search?q=" + encodeURIComponent(El("SearchBox").value.trim());
    Html.push(`<div class="Welcome">In der Gesetzessammlung wurde nichts gefunden.` +
      `<a class="BigButton GoogleButton" href="${Url}" target="_blank" rel="noopener">mit Google suchen</a></div>`);
  }
  El("ResultList").innerHTML = Html.join("");
  El("ResultList").scrollTop = 0;

  // iPad: erste Vorschrift gleich anzeigen; ohne Treffer den Detailbereich leeren
  if (Count === 0) ClearText();
  else if (IsWide()) ShowText(State.Results[0], false);
}

// Stand der Daten, knapp: "Stand: 7.11.26"
function DataStand() {
  const Created = State.Data && State.Data.Created ? new Date(State.Data.Created) : null;
  if (!Created || isNaN(Created)) return "";
  return `Stand: ${Created.getDate()}.${Created.getMonth() + 1}.${String(Created.getFullYear()).slice(-2)}`;
}

function ResultList_Click(E) {
  const Item = E.target.closest(".Item");
  if (Item) ShowText(+Item.dataset.index, true);
}

// ======================================================================
// Ein- oder zweispaltig
//   Zwei Spalten nur auf breiten Bildschirmen und nur, wenn nicht mit dem Umschalter abgeschaltet.
//   Die Wahl wird je Gerät gemerkt.
// ======================================================================
function SingleColumnChosen() {
  try { return localStorage.getItem("SingleColumn") === "1"; } catch { return false; }
}

function LayoutButton_Click() {
  try { localStorage.setItem("SingleColumn", SingleColumnChosen() ? "0" : "1"); } catch { }
  ApplyLayout();
}

function ApplyLayout() {
  const TwoColumns = WideScreen.matches && !SingleColumnChosen();

  // Leseansicht (iPad/PC einspaltig): Text wie in der Zweispaltenansicht umbrechen, aber auf die volle Breite
  // vergrößern – Faktor = volle Breite / Breite der rechten Spalte (Fensterbreite - 320px Liste)
  const ReadingView = WideScreen.matches && !TwoColumns;
  document.body.classList.toggle("ReadingView", ReadingView);
  document.documentElement.style.setProperty("--ReadingZoom",
    (window.innerWidth / Math.max(1, window.innerWidth - 320)).toFixed(3));

  if (TwoColumns === IsWide() && document.body.dataset.LayoutDone) return;
  document.body.dataset.LayoutDone = "1";
  El("LayoutDivider").style.display = TwoColumns ? "" : "none";   // Symbol: mit Trennlinie = zweispaltig
  El("LayoutButton").title = TwoColumns ? "Einspaltige Ansicht" : "Zweispaltige Ansicht";

  if (TwoColumns) {
    // zurück zu zwei Spalten: Vorschrift rechts
    if (document.body.classList.contains("ShowDetail")) history.back();
    document.body.classList.add("TwoColumns");
    if (State.CurrentIndex >= 0) ShowText(State.CurrentIndex, false);
  } else {
    // eine Spalte: mit der angezeigten Vorschrift beginnen ("‹" führt zur Liste)
    document.body.classList.remove("TwoColumns");
    if (State.CurrentIndex >= 0) ShowText(State.CurrentIndex, true);
  }
}

// PC-Tastatur: Pfeil hoch/runter blättert durch die Treffer (Bild hoch/runter um 10, Pos1/Ende)
function ResultList_KeyDown(E) {
  const Steps = { ArrowDown: 1, ArrowUp: -1, PageDown: 10, PageUp: -10, End: 1e9, Home: -1e9 };
  if (!(E.key in Steps)) return;
  E.preventDefault();
  MoveSelection(Steps[E.key]);
}

// Pfeil runter in der Suchzeile: in die Liste wechseln
function SearchBox_KeyDown(E) {
  if (E.key !== "ArrowDown" && E.key !== "Enter") return;
  if (State.Results.length === 0) return;
  E.preventDefault();
  El("ResultList").focus();
  if (E.key === "ArrowDown") MoveSelection(State.Results.indexOf(State.CurrentIndex) < 0 ? 0 : 1);
}

function MoveSelection(Step) {
  const Shown = Math.min(State.Results.length, MaxResults);
  if (Shown === 0) return;
  const Position = State.Results.indexOf(State.CurrentIndex);
  let NewPosition = Position < 0 ? 0 : Position + Step;
  NewPosition = Math.max(0, Math.min(Shown - 1, NewPosition));
  ShowText(State.Results[NewPosition], false);
}

function ShowWelcome(Message, WithButton) {
  El("ResultList").innerHTML = `<div class="Welcome">${Encode(Message)}` +
    (WithButton ? `<label class="BigButton">Datenbank laden …<input type="file" hidden onchange="FileInput_Change(event)"></label>` : "") +
    `</div>`;
}

function ShowMenu(Visible) {
  El("MenuPanel").hidden = !Visible;
}


// ======================================================================
// Anzeige der Vorschrift
// ======================================================================
function ShowText(Index, OpenDetail) {
  if (Index < 0 || Index >= State.Texts.length) return;

  State.CurrentIndex = Index;
  const Row = State.Texts[Index];
  El("DetailTitle").textContent = Row[ColParagraf];
  El("DetailLaw").textContent = `${Row[ColGesetz]} · ${Row[ColLand]}`;
  El("LawBody").innerHTML = Row[ColHtml];
  const FirstMark = Highlight(El("LawBody"), State.Words);

  El("PreviousButton").disabled = !(Index > 0 && SameLaw(Index - 1, Index));
  El("NextButton").disabled = !(Index < State.Texts.length - 1 && SameLaw(Index + 1, Index));

  // Markierung in der Liste
  document.querySelectorAll(".Item.Selected").forEach(Item => Item.classList.remove("Selected"));
  const Item = document.querySelector(`.Item[data-index="${Index}"]`);
  if (Item) {
    Item.classList.add("Selected");
    Item.scrollIntoView({ block: "nearest" });
  }

  // iPhone: zur Vorschrift wechseln (Zurück-Taste und Wischgeste führen zur Liste)
  if (OpenDetail && !IsWide() && !document.body.classList.contains("ShowDetail")) {
    history.pushState({ Detail: true }, "");
    document.body.classList.add("ShowDetail");
  }

  // erst jetzt scrollen (vorher ist die Vorschrift auf dem iPhone noch ausgeblendet)
  El("DetailScroll").scrollTop = 0;
  if (FirstMark) FirstMark.scrollIntoView({ block: "center" });
}

// Detailbereich leeren (z.B. wenn nichts gefunden wurde)
function ClearText() {
  State.CurrentIndex = -1;
  El("DetailTitle").textContent = "";
  El("DetailLaw").textContent = "";
  El("LawBody").innerHTML = "";
  El("PreviousButton").disabled = true;
  El("NextButton").disabled = true;
}

function SameLaw(IndexA, IndexB) {
  const A = State.Texts[IndexA], B = State.Texts[IndexB];
  return A && B && A[ColGesetz] === B[ColGesetz] && A[ColLand] === B[ColLand];
}

// Suchwörter gelb markieren (nur im Text, nie in Tags); Rückgabe: erste Markierung
function Highlight(Root, Words) {
  const Clean = Words.filter(W => W.length > 1);
  if (Clean.length === 0) return null;
  const Pattern = new RegExp(Clean.map(WordPattern).join("|"), "gi");
  const Walker = document.createTreeWalker(Root, NodeFilter.SHOW_TEXT);
  const Nodes = [];
  while (Walker.nextNode()) Nodes.push(Walker.currentNode);

  let First = null;
  for (const Node of Nodes) {
    const Text = Node.nodeValue;
    Pattern.lastIndex = 0;
    if (!Pattern.test(Text)) continue;
    Pattern.lastIndex = 0;
    const Fragment = document.createDocumentFragment();
    let Last = 0, Match;
    while ((Match = Pattern.exec(Text))) {
      Fragment.appendChild(document.createTextNode(Text.slice(Last, Match.index)));
      const Mark = document.createElement("mark");
      Mark.textContent = Match[0];
      Fragment.appendChild(Mark);
      if (!First) First = Mark;
      Last = Match.index + Match[0].length;
    }
    Fragment.appendChild(document.createTextNode(Text.slice(Last)));
    Node.parentNode.replaceChild(Fragment, Node);
  }
  return First;
}

function Encode(Text) {
  return String(Text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
