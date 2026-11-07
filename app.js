/*
  Gesetzessammlung Web-App - Version 07.11.2026
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
const IsWide = () => window.matchMedia("(min-width: 700px)").matches;


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
  El("CloseMenuButton").addEventListener("click", () => ShowMenu(false));
  El("FileInput").addEventListener("change", FileInput_Change);
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
  El("LawCss").textContent = (Data.Css || "").replace(/\bbody\b/g, "#LawBody");

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
// Suche (erste, einfache Fassung)
//   "baugb"              ganzes Gesetz
//   "baugb 35"           Nummer 35 (auch Teil 35, Anlage 35)
//   "baugb 3-13"         Nummernbereich
//   "baugb 3a"           genau "§ 3a"
//   "lbo bw 5"           Gesetz mit Land
//   "baugb außenbereich" Wort im Gesetz
//   "außenbereich"       Volltext in allen Gesetzen (alle Wörter müssen vorkommen)
//   "§ 35 Abs. 1 BauGB"  Zitat wird umgestellt
// ======================================================================
let SearchTimer = null;

function SearchBox_Input() {
  // iPhone: beim Tippen zurück zur Liste
  if (document.body.classList.contains("ShowDetail") && !IsWide()) history.back();
  clearTimeout(SearchTimer);
  SearchTimer = setTimeout(RunSearch, 250);
}

function RunSearch() {
  if (!State.Data) return;
  const Query = ParseQuery(El("SearchBox").value);
  State.Words = Query.Words;
  if (Query.Empty) {
    State.Results = [];
    El("ListInfo").textContent = "";
    El("ResultList").innerHTML = `<div class="Welcome">Suchbegriff eingeben, z.B. <b>baugb 35</b>, ` +
      `<b>baugb außenbereich</b> oder <b>§ 35 Abs. 1 BauGB</b>.</div>`;
    return;
  }
  State.Results = FindTexts(Query);
  ShowResults();
}

// Suchzeile in ihre Teile zerlegen
function ParseQuery(Input) {
  let Text = Input.trim().replace(/\s+/g, " ");
  const Query = { Empty: Text === "", Laws: null, NumberFrom: null, NumberTo: null, Label: null, Words: [] };
  if (Query.Empty) return Query;

  // Zitat umstellen: "§ 35 Abs. 1 Satz 2 BauGB" -> "BauGB 35"; "§ 1 16. BImSchV" -> "16. BImSchV 1"
  const Citation = Text.match(/^(?:§§?|art\.?|artikel)\s*(\d+[a-z]?)\b/i);
  if (Citation) {
    const Parts = Text.split(" ");
    for (const Length of [2, 1]) {
      const Law = Parts.slice(-Length).join(" ");
      if (Parts.length > Length && State.LawKeys.has(Law.toLowerCase())) {
        Text = Law + " " + Citation[1];
        break;
      }
    }
  }

  let Tokens = Text.split(" ");

  // Gesetz: erst zwei Wörter ("16. BImSchV"), dann ein Wort
  for (const Length of [2, 1]) {
    if (Tokens.length < Length) continue;
    const Key = Tokens.slice(0, Length).join(" ").toLowerCase();
    if (State.LawKeys.has(Key)) {
      Query.Laws = State.LawKeys.get(Key);
      Tokens = Tokens.slice(Length);
      break;
    }
  }

  // Land nach dem Gesetz ("LBO BW")
  if (Query.Laws && Tokens.length > 0) {
    const Land = Tokens[0].toLowerCase();
    const WithLand = Query.Laws.filter(L => L.Land.toLowerCase() === Land);
    if (WithLand.length > 0) {
      Query.Laws = WithLand;
      Tokens = Tokens.slice(1);
    }
  }

  // Nummer nach dem Gesetz: "35", "3-13", "3a"
  if (Query.Laws && Tokens.length > 0) {
    let Match;
    if ((Match = Tokens[0].match(/^(\d+)-(\d+)$/))) {
      Query.NumberFrom = +Match[1];
      Query.NumberTo = +Match[2];
      Tokens = Tokens.slice(1);
    } else if ((Match = Tokens[0].match(/^\d+$/))) {
      Query.NumberFrom = Query.NumberTo = +Match[0];
      Tokens = Tokens.slice(1);
    } else if ((Match = Tokens[0].match(/^\d+[a-z]$/i))) {
      Query.Label = Match[0].toLowerCase();
      Tokens = Tokens.slice(1);
    }
  }

  // Rest: Wörter (Platzhalter * wird ignoriert)
  Query.Words = Tokens.map(T => T.replace(/\*/g, "")).filter(T => T !== "");
  return Query;
}

// Treffer suchen: Indizes der passenden Zeilen
function FindTexts(Query) {
  const Patterns = Query.Words.map(W => new RegExp(EscapeRegExp(W), "i"));
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

function EscapeRegExp(Text) {
  return Text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}


// ======================================================================
// Liste
// ======================================================================
function ShowResults() {
  const Count = State.Results.length;
  El("ListInfo").textContent = Count === 0 ? "Keine Treffer." :
    Count > MaxResults ? `${Count.toLocaleString("de-DE")} Treffer – die ersten ${MaxResults} werden angezeigt.` :
    `${Count.toLocaleString("de-DE")} Treffer`;

  const Html = [];
  for (const Index of State.Results.slice(0, MaxResults)) {
    const Row = State.Texts[Index];
    Html.push(`<div class="Item" data-index="${Index}">` +
      `<div class="ItemLaw">${Encode(Row[ColGesetz])} · ${Encode(Row[ColLand])}</div>` +
      `<div class="ItemParagraf">${Encode(Row[ColParagraf])}</div></div>`);
  }
  El("ResultList").innerHTML = Html.join("");
  El("ResultList").scrollTop = 0;

  // iPad: erste Vorschrift gleich anzeigen
  if (IsWide() && Count > 0) ShowText(State.Results[0], false);
}

function ResultList_Click(E) {
  const Item = E.target.closest(".Item");
  if (Item) ShowText(+Item.dataset.index, true);
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
  El("DetailLaw").textContent = `${Row[ColGesetz]} – ${Row[ColLand]}`;
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

function SameLaw(IndexA, IndexB) {
  const A = State.Texts[IndexA], B = State.Texts[IndexB];
  return A && B && A[ColGesetz] === B[ColGesetz] && A[ColLand] === B[ColLand];
}

// Suchwörter gelb markieren (nur im Text, nie in Tags); Rückgabe: erste Markierung
function Highlight(Root, Words) {
  const Clean = Words.filter(W => W.length > 1);
  if (Clean.length === 0) return null;
  const Pattern = new RegExp(Clean.map(EscapeRegExp).join("|"), "gi");
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
