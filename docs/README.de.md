# Adaptive Reasoning Controller (Claude-Code-Mod)

Wählt für jeden neuen Auftrag die passende Effort-Stufe (`low`, `medium`, `high`, `xhigh`, `max`) und **setzt sie tatsächlich als Effort-Parameter jeder Modellanfrage**. Es wird kein Text in den Prompt geschrieben, der Claude „mehr nachdenken“ lässt. Ziel ist nicht möglichst viel Reasoning, sondern genau so viel, wie der Auftrag braucht.

Entwickelt und getestet gegen **Claude Code 2.1.321** (Function-Hooks-Mod-API, Early Access).

---

## 1. Ergebnis der API-Prüfung: Ist eine echte Effort-Änderung möglich?

**Ja, pro Modellanfrage.** Die Typdefinitionen der installierten Version (`claude-code.d.ts`) beschreiben das Event `turn.step`:

> Fires when the engine is about to send a model request of a turn … `next({ ...e, model })` or `effort` sends another.

`TurnStepInput.effort` enthält die Stufe, mit der die Anfrage gesendet würde: die Sitzungsstufe aus `/effort` oder den Modellstandard. Bei Modellen ohne Effort fehlt das Feld. Die Mod ruft `next({ ...e, effort })` auf und ersetzt damit den echten API-Parameter (`output_config.effort`). Das ist keine Empfehlung an das Modell.

Was es **nicht** gibt bzw. was die Mod bewusst **nicht** nutzt:

| Geprüft | Ergebnis |
|---|---|
| `prompt.submit` | Liefert den Auftragstext, kann aber keinen Effort setzen. Wird nicht benötigt, weil `turn.start` denselben Text mit `turnId` liefert. |
| `turn.step` | **Echte Effort-Änderung pro Anfrage.** Die Änderung gilt nur für diese eine Anfrage, deshalb setzt die Mod jeden Schritt eines Turns. |
| `settings.read` | Nur lesend. Der Effort ließe sich darüber nur indirekt beeinflussen, das wäre unnötig und riskant. |
| `/effort` | Bleibt die Sitzungsstufe. Im AUTO-Modus dient sie als Ausgangspunkt, im MANUAL-Modus mit `session` bleibt sie unangetastet. |
| `$.model.fork/complete` | Haben eigene `effort`-Parameter, betreffen aber nur Nebenanfragen. Nur für die optionale KI-Klassifizierung relevant. |

### Grenzen (bewusst dokumentiert, nicht vorgetäuscht)

1. **Effort pro Nachricht** (wenn du Claude Code selbst so eingerichtet hast): Laut API-Doku wird eine geänderte Stufe auf einem Schritt, der nur Tool-Ergebnisse enthält, nicht gesendet. Eine **Eskalation mitten im Auftrag wirkt dann erst ab der nächsten Benutzernachricht**. Die Mod prüft oder ändert diese Einstellung nicht; ihre Antwort an Claude nennt beide Fälle.
2. **Prompt-Cache:** Bei Modellen mit Effort pro Anfrage (Standard) macht ein Stufenwechsel zwischen Aufträgen den Nachrichten-Cache ungültig. Deshalb gibt es eine Hysterese (knappe Entscheidungen behalten die alte Stufe), und in langen Verläufen (ab 40 Nachrichten) wird nicht um nur eine Stufe abgesenkt. Wer oft wechselt, kann Claude Code auf der First-Party-API auf Effort pro Nachricht umstellen (siehe Claude-Code-Dokumentation); dann ist der Wechsel cache-neutral.
3. **Subagenten** behalten ihren eigenen Effort, der in ihrer Agent-Definition festgelegt ist. Die Mod steuert nur die Hauptkonversation.
4. **Übergeordnete Grenzen bleiben wirksam:** Organisationsrichtlinien, die Einstellung `maxEffortLevel` und die Stufen des Modells. Claude Code senkt eine nicht unterstützte Stufe still ab. Die Mod wählt vorher selbst die nächstliegende unterstützte Stufe und zeigt das an.
5. **Numerische Effort-Werte** (interne Builds) werden nicht verändert.
6. Die Mod-API ist **Early Access** und kann sich zwischen Versionen ändern.

---

## 2. Funktionsweise

```
turn.start (Hauptkonversation) ─▶ lokale Analyse des Auftrags (+ ausstehende /reasoning-Überschreibung)
turn.step  Index 0           ─▶ Entscheidung: Modell, Sitzungsstufe, Verlaufslänge, Einstellungen
turn.step  jeder Schritt     ─▶ next({ ...e, effort: <Stufe> })   ← echte Konfiguration
tool.call                    ─▶ Eskalation bei wiederholten Fehlern / auf Anforderung von Claude
```

Aufbau:

| Datei | Aufgabe |
|---|---|
| `hooks/lib/classifier.ts` | Lokale Aufgabenanalyse: 7 Dimensionen, Aufgabentyp und Konfidenz |
| `hooks/lib/policy.ts` | Auswahlstrategie: Modi, Priorität, Min/Max, Hysterese, Modell-Mapping, Eskalation |
| `hooks/lib/models.ts` | Effort-Stufen und Standard je Modellfamilie (erweiterbar) |
| `hooks/lib/settings.ts` | Einstellungen (userConfig) mit Validierung |
| `hooks/lib/format.ts` | Anzeigetexte, `/reasoning`-Parser und anonyme Statistik |
| `hooks/register.tsx` | Verdrahtung der Hooks, Statuszeile über dem Prompt und Einstellungsfenster |

### Aufgabenanalyse (lokal, ohne KI-Aufruf)

Jeder Auftrag wird auf einer Skala von 0 bis 3 bewertet, und zwar nach **Komplexität, Umfang, Fehleranfälligkeit, Korrektheitsanforderung, Autonomie, Unklarheit und Verifikationsaufwand**. Der Aufgabentyp liefert Grundwerte (z. B. Debugging, Refactoring, Frage, Sicherheitsanalyse, Mathematik). Formulierungen im Text heben oder senken diese Werte, ebenso die Struktur des Auftrags: Anzahl referenzierter Dateien, nummerierte Schritte, Stacktraces und Länge.

Damit keine bloße Keyword-Erkennung entsteht, gelten drei Regeln:

* Einzelne Wörter wie „komplex“ heben die Komplexität höchstens um eine Stufe. MAX verlangt zusätzlich kritische Korrektheit **und** hohe Schwierigkeit **und** hohes Risiko.
* **Der Umfang zählt nur im Verhältnis zur Schwierigkeit.** Eine lange, aber einfache Liste bleibt LOW, ein kurzer, aber schwieriger Beweis wird mindestens HIGH.
* „Einfach“, „kurz“ oder „nur“ senken die Schwierigkeit nur, wenn nichts Gegenteiliges im Text steht. „Kurz, aber schwierig“ bleibt also schwierig.

Kurze Folgeanweisungen wie „ja, mach weiter“ behalten die Stufe des laufenden Auftrags. Ist die Analyse unsicher, nimmt die Mod die Sitzungsstufe und nicht automatisch die höchste.

### Modellunterstützung (`hooks/lib/models.ts`)

| Modell | Stufen | API-Standard |
|---|---|---|
| Fable/Mythos 5.x, Opus 5, Opus 4.7/4.8, Sonnet 5/5.5 | low–max (alle) | high |
| Opus 5.5, Haiku 5.5 | low–max (alle) | medium |
| Opus 4.6, Sonnet 4.6 | low, medium, high, max (kein xhigh) | high |
| Opus 4.5 | low, medium, high | high |
| Haiku 4.5, Sonnet 4.5 und älter | keine | – |

Quelle: die Modelldokumentation von Anthropic, die mit Claude Code 2.1.321 ausgeliefert wird (Stand 2026-11-03). Ein neues Modell braucht nur eine neue Zeile. Unbekannte Modelle gelten als „alle Stufen“; Claude Code passt nicht unterstützte Stufen dann selbst an.

---

## 3. Bedienung

### Statuszeile über dem Prompt

```
Reasoning · AUTO | Currently · HIGH | Max Limit · MAX
```

Sie zeigt nur Modus, aktive Stufe (↑ nach einer Eskalation) und Obergrenze; Aufgabe und Begründung stehen in der Anzeige vor dem Auftrag und unter `/reasoning`.

### Anzeige vor jedem Auftrag (abschaltbar)

```
AUTO MODE
Erkannte Aufgabe: Komplexes Debugging
Ausgewählte Reasoning-Stufe: HIGH (Sitzungsstandard: MEDIUM)
Begründung: hohe inhaltliche Schwierigkeit; relevante Seiteneffekte möglich; mehrere mögliche Ursachen oder Lösungswege; umfangreiche Verifikation nötig.
```

Die Begründung nennt nur Eigenschaften der Aufgabe, keine internen Gedankengänge und keinen Prompt-Text.

### `/reasoning`

| Befehl | Wirkung |
|---|---|
| `/reasoning` | Status, letzte Entscheidung, Statistik |
| `/reasoning high` | HIGH **für den nächsten Auftrag** (einmalig). Hat Vorrang vor der Automatik und vor Min/Max |
| `/reasoning auto` | Ausstehende Überschreibung verwerfen |
| `/reasoning mode auto\|balanced\|quality\|speed\|manual` | Arbeitsmodus (wird gespeichert) |
| `/reasoning max-level medium\|high\|xhigh\|max` | Obergrenze |
| `/reasoning min-level low\|medium\|high` | Untergrenze |
| `/reasoning priority efficiency\|balanced\|quality` | Kosten-/Zeitpriorität |
| `/reasoning manual session\|low…max` | Stufe im Modus MANUAL (`session` = `/effort` unverändert lassen) |
| `/reasoning escalation on\|off` · `display on\|off` · `ai on\|off` | Schalter |
| `/reasoning settings` | Einstellungsfenster öffnen |
| `/reasoning reset-stats` | Statistik löschen |

### Einstellungen

Alle Einstellungen werden dauerhaft in `settings.json` gespeichert (unter `pluginConfigs`) und erscheinen als native Zeilen in **`/config`** („Reasoning: …“). Ändern lassen sie sich dort, über `/reasoning settings` oder über die Befehle oben.

| Einstellung | Werte | Standard |
|---|---|---|
| Arbeitsmodus | AUTO, BALANCED (ohne MAX), QUALITY FIRST (+1 Stufe, min. MEDIUM), SPEED FIRST (−1 Stufe, max. HIGH), MANUAL | AUTO |
| Maximale Stufe | MEDIUM, HIGH, XHIGH, MAX | MAX (nur bei klarem Bedarf genutzt) |
| Minimale Stufe | LOW, MEDIUM, HIGH | LOW |
| Kosten-/Zeitpriorität (wirkt in AUTO) | Maximale Effizienz, Ausgewogen, Maximale Qualität | Ausgewogen |
| Stufe bei MANUAL | `session` (/effort), LOW … MAX | `session` |
| Automatische Eskalation | an/aus | an |
| Entscheidung anzeigen | an/aus | an |
| KI-Klassifizierung | an/aus | aus |

**Automatische Eskalation:** Nach 3 fehlgeschlagenen Tool-Aufrufen in einem Auftrag oder wenn Claude das Tool `request_more_reasoning` aufruft (höchstens zweimal pro Auftrag), steigt die Stufe für die weiteren Anfragen um eine unterstützte Stufe. Dabei gilt die Obergrenze. Manuelle Entscheidungen werden nie eskaliert. Die erhöhte Stufe bleibt für Folgeanweisungen erhalten. Ist die Eskalation aus, wird das Tool gar nicht registriert und kostet keine Tokens.

**KI-Klassifizierung (optional):** Nur bei unklaren Aufträgen (Konfidenz < 0,6) fragt die Mod einmal das kleine, schnelle Modell (`$.model.classify`). Das kostet eine kurze Anfrage und etwas Latenz vor der ersten Antwort. Dabei werden die ersten 4000 Zeichen des Auftrags an dieses Modell gesendet. Standardmäßig ist die Funktion aus.

### Zusammenspiel mit effort-cycle (Strg+↑/↓)

Ist das Plugin [effort-cycle](https://github.com/Anerco/claude-code-effort-cycle) installiert, **hat eine per Tastatur gewählte Stufe immer Vorrang**:

* Solange effort-cycle für das aktuelle Modell eine Wahl hält, gibt der Controller jede Anfrage unverändert weiter, und effort-cycle setzt die gewählte Stufe. Es gibt dann keine Eskalation, und auch eine ausstehende `/reasoning`-Überschreibung tritt zurück (das wird angezeigt). Die Anzeige vor dem Auftrag lautet „Tastatur-Wahl (effort-cycle)“.
* effort-cycle merkt sich die Engine-Stufe (`base`) und verwirft eine Tastenwahl, sobald sich diese ändert, etwa durch `/effort`. Läuft der Controller in der Hook-Kette über effort-cycle, würde effort-cycle die automatisch gewählte Stufe für eine Engine-Änderung halten und die Wahl löschen. Deshalb korrigiert der Controller über einen `state.set`-Hook genau diesen einen Wert auf die echte Engine-Stufe. Das funktioniert unabhängig von der Ladereihenfolge.
* Folge: Ohne Tastenwahl zeigt das Effort-Meter von effort-cycle die Sitzungsstufe, nicht die automatisch gewählte. Die tatsächlich gesendete Stufe steht in der Statuszeile des Controllers.
* Ohne effort-cycle hat das alles keine Wirkung.

### Datenschutz und Ressourcen

* Die Analyse läuft lokal mit Regeln. Es gibt **keine zusätzliche KI-Anfrage**, solange die KI-Klassifizierung aus ist.
* Es wird **kein Prompt-Text gespeichert**. `$.state` (nur für die Sitzung) enthält die letzte Entscheidung als Eigenschaften. `$.store` (dauerhaft) enthält nur Zähler (Anzahl pro Stufe, Eskalationen, Überschreibungen).
* Der Prompt wird nicht verändert. Effort-Konfiguration (`turn.step`) und Prompt sind strikt getrennt. Das Einzige, was das Modell zusätzlich sieht, ist die kurze Beschreibung des Eskalations-Tools (nur bei aktivierter Eskalation).
* Die Mod liest keine Zugangsdaten und keine Umgebungsvariablen und stellt keine eigenen Netzwerkanfragen.

### Was die Mod verändert

* **Prompts:** Die Mod sendet **keine eigenen Prompts** ab. `/reasoning <stufe>` merkt die Stufe nur für den nächsten Auftrag vor, den du selbst sendest.
* **Einstellungen:** nur die eigenen acht `/config`-Zeilen (`reasoning-controller.<feld>`), und nur, wenn du sie über `/reasoning …` oder das Einstellungsfenster änderst. Umgebungsvariablen werden weder gesetzt noch gelesen.
* **Tools:** nur das eigene `request_more_reasoning`. Alle anderen Tool-Aufrufe laufen unverändert durch.
* **Hooks:** Die vollständige Liste mit dem Zweck jedes Hooks steht im englischen [README](../README.md#hooks).

---

## 4. Installation

Voraussetzung: Claude Code 2.1.275 oder neuer (Function-Hooks-Mods; entwickelt und getestet mit 2.1.321).

Am Prompt einer Terminal-Sitzung:

```
/plugin install reasoning-controller --marketplace XxRexRaptorxX/claude-reasoning-controller
```

Die Frage `Add marketplace?` mit `y` bestätigen, dann den Scope wählen (Enter = User).

Aus einer Shell:

```bash
claude plugin install reasoning-controller --marketplace XxRexRaptorxX/claude-reasoning-controller
```

In der Desktop-App (dort läuft `/plugin` nicht): auf **+** neben dem Eingabefeld klicken, **Plugins** wählen, dann **Add marketplace** mit `XxRexRaptorxX/claude-reasoning-controller`, dann **Add plugin**.

Zum Entwickeln aus einem lokalen Ordner: `claude --plugin-dir <ordner>`.

## 5. Prüfen und Testen

```bash
claude plugin validate <ordner>
```

```bash
claude plugin test <ordner>
```

Die 61 Tests (`tests/*.test.ts[x]`) decken ab:

* die 8 Referenzaufträge,
* Keyword-Robustheit,
* Folgeanweisungen,
* manuelle Überschreibung (einmalig, Vorrang, `/reasoning auto`),
* nicht unterstützte Stufen,
* Modellfamilien und Modelle ohne Effort,
* Benutzerprofile (Modi, Min/Max, Priorität, MANUAL),
* Hysterese und Cache-Schutz,
* Eskalation an/aus (Tool-Fehler und Tool-Aufruf),
* Persistenz der Einstellungen (`/config`-Zeilen, Einstellungsfenster),
* die Statistik ohne Prompt-Inhalt,
* die Statuszeile auf allen Oberflächen,
* das Zusammenspiel mit effort-cycle (Tastenwahl hat Vorrang, Engine-Stufe bleibt korrekt),
* den tatsächlich gesendeten `effort` jeder Anfrage über die Hook-Kette der Engine.

Die Typprüfung läuft gegen die API-Deklarationen mit `tsc` (strict). Die passende `tsconfig.json` legt die Engine nach dem ersten Laden unter `.claude-plugin/types/` an.
