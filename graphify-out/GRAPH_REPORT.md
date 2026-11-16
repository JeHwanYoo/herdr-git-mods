# Graph Report - herdr-git-mods  (2026-11-16)

## Corpus Check
- 96 files · ~112,748 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 4 file(s) not represented in the graph (top: (none) 3, .lock 1)

## Summary
- 2598 nodes · 7216 edges · 110 communities (93 shown, 17 thin omitted)
- Extraction: 92% EXTRACTED · 8% INFERRED · 0% AMBIGUOUS · INFERRED: 545 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- WorkspacesBox
- changes.ts
- main.js
- commands.ts
- FilesTab
- ChangesTab
- GraphTab
- FilesPane
- code-view.ts
- Shell
- style
- WorkspacesBox
- Look
- Services
- Overlay
- history.ts
- ChangesTab
- FilesPane
- SplitDiff
- SplitDiff
- GraphTab
- .set
- Commands
- document.ts
- pane.ts
- showResult
- Inspect
- Shell
- comparison.ts
- graph.ts
- BranchManager
- files.ts
- steps
- LineHistoryDialog
- RebaseEditor
- CodeView
- readSummary
- Overlay
- parseHistory
- inspect.ts
- workflows.ts
- BranchManager
- .render
- files-pane.ts
- FilesTab
- compilerOptions
- CodeView
- repository.test.ts
- confirm.ts
- .diffBoxes
- .selection
- Look
- displayWidth
- commit.ts
- CommitDialog
- RemoteList
- .rows
- scripts
- .context
- .applyPage
- cols
- CommandHandler
- pane-target.ts
- widgets.ts
- theme.ts
- ci.yml
- Session
- operations.test.ts
- preview.ts
- CompareDialog
- staging.ts
- overlay.ts
- ResetFlow
- LineHistoryDialog
- CompareDialog
- AGENTS.md
- startArgs
- Dialog
- inspectWorktree
- .sync
- Herdr layout research
- Findings
- treeRows
- dialogFooter
- build.ts
- Findings
- workspaces.test.ts
- parseStatus
- SettingsTab
- Herdr Git Mods
- GitPlacement
- performance.ts
- Agents
- Testing
- .constructor
- Herdr Git Mods
- Contributing
- Architecture
- Design
- Research method
- Sharing on herdr.dev/mods
- tests/tsconfig.json
- check-comments.ts
- Coding standards
- bug_report.md
- feature_request.md
- CLAUDE.md
- .claude/CLAUDE.md
- changes.test.ts

## God Nodes (most connected - your core abstractions)
1. `Look` - 136 edges
2. `FilesTab` - 75 edges
3. `GraphTab` - 69 edges
4. `FilesTab` - 67 edges
5. `GraphTab` - 63 edges
6. `ChangesTab` - 58 edges
7. `WorkspacesBox` - 49 edges
8. `ChangesTab` - 46 edges
9. `SplitDiff` - 46 edges
10. `SplitDiff` - 43 edges

## Surprising Connections (you probably didn't know these)
- `Cell grid` --references--> `Palette`  [INFERRED]
  docs/DESIGN.md → src/ui/theme.ts
- `Module dependencies` --references--> `TabView`  [INFERRED]
  docs/ARCHITECTURE.md → src/ui/shell.ts
- `What you see` --references--> `Filter`  [INFERRED]
  RECIPE.md → src/ui/explorer.ts
- `Module dependencies` --references--> `CommandHandler`  [INFERRED]
  docs/ARCHITECTURE.md → src/ui/shell.ts
- `Module dependencies` --references--> `RefreshScope`  [INFERRED]
  docs/ARCHITECTURE.md → src/ui/shell.ts

## Import Cycles
- None detected.

## Communities (110 total, 17 thin omitted)

### Community 0 - "WorkspacesBox"
Cohesion: 0.05
Nodes (39): aheadBehind(), BranchStatus, branchStatus(), ChangeOverview, changeOverview(), CLEAN, inspectProject(), inspectWorktree() (+31 more)

### Community 1 - "changes.ts"
Cohesion: 0.08
Nodes (32): Module dependencies, DiffTarget, BlameEntry, blameRevision(), DiffSide, parseBlameRecord(), preview(), readBlameRange() (+24 more)

### Community 2 - "main.js"
Cohesion: 0.05
Nodes (63): aheadBehind(), args(), branchStatus(), Builder2, buildLayout(), cellSegments(), color(), commitTarget() (+55 more)

### Community 3 - "commands.ts"
Cohesion: 0.05
Nodes (49): RebaseTarget, BranchTarget, must(), readBranches(), readBranchTargets(), must(), readRemotes(), Remote (+41 more)

### Community 4 - "FilesTab"
Cohesion: 0.08
Nodes (10): countedTitle(), emptyFilter(), FilesTab, pathStatuses(), previewNotice(), readFiles(), resultRows(), resultText() (+2 more)

### Community 5 - "ChangesTab"
Cohesion: 0.13
Nodes (5): ComparisonMode, ChangesTab, errorMessage(), filterTree(), CommandTargets

### Community 7 - "FilesPane"
Cohesion: 0.11
Nodes (9): changeKey(), FilesHost, FilesPane, rowKey(), compareNames(), emit(), insert(), node() (+1 more)

### Community 8 - "code-view.ts"
Cohesion: 0.12
Nodes (26): Cell, expandTabs(), cellSegments(), CodeMatch, CodeTone, CodeViewOptions, ColumnSpec, DiffSelection (+18 more)

### Community 9 - "Shell"
Cohesion: 0.12
Nodes (10): actionBar(), actionButton(), actionContent(), appShortcut(), firstLine(), identityText(), languageName(), Shell (+2 more)

### Community 10 - "style"
Cohesion: 0.04
Nodes (45): source, assist, actions, enabled, noExcessiveCognitiveComplexity, noUnusedFunctionParameters, noUnusedImports, noUnusedVariables (+37 more)

### Community 11 - "WorkspacesBox"
Cohesion: 0.09
Nodes (13): buildRows(), currentRow(), fitted(), label(), line2(), pathLabel(), rowElement2(), rowHeight() (+5 more)

### Community 12 - "Look"
Cohesion: 0.10
Nodes (20): activePlan(), must(), quote(), readRebasePlan(), REBASE_ACTIONS, REBASE_DESCRIPTIONS, REBASE_LABELS, RebaseAction (+12 more)

### Community 13 - "Services"
Cohesion: 0.17
Nodes (7): CommandId, progressLabel(), statusLabel(), unavailable(), Commands, listStatus(), QuickAction

### Community 14 - "Overlay"
Cohesion: 0.12
Nodes (5): Dialog, lineElement(), lines(), Overlay, toneColor()

### Community 15 - "history.ts"
Cohesion: 0.11
Nodes (31): commitMatches(), CommitRef, CommitRefKind, count(), daysFromCivil(), filteredCommitIndices(), GitRef, HISTORY_PAGE_SIZE (+23 more)

### Community 16 - "ChangesTab"
Cohesion: 0.11
Nodes (6): ChangesTab, errorMessage(), filterTree(), stagingLabel(), stagingMessage(), stagingPreview()

### Community 17 - "FilesPane"
Cohesion: 0.12
Nodes (7): changeKey(), discardPaths(), FilesPane, rowKey(), stagingOperation(), summarySpans(), viewportOffset()

### Community 18 - "SplitDiff"
Cohesion: 0.12
Nodes (6): cellWidth(), clamp(), foldId(), paneWidths(), sideCell(), SplitDiff

### Community 19 - "SplitDiff"
Cohesion: 0.10
Nodes (4): blameText(), foldId(), sideCell(), SplitDiff

### Community 20 - "GraphTab"
Cohesion: 0.05
Nodes (12): commitMatches(), emptyState(), filteredCommitIndices(), GraphTab, graphViewWidth(), Inspect, isHead(), layoutWidth() (+4 more)

### Community 21 - ".set"
Cohesion: 0.11
Nodes (18): buildDiff(), Builder, codeCell(), CodeHighlighter, collapseContext(), contextRun(), expandTabs(), foldLabel() (+10 more)

### Community 22 - "Commands"
Cohesion: 0.07
Nodes (15): Commands, Git, GitPlacement, launchGitPane(), listStatus(), openPane(), preview(), progressLabel() (+7 more)

### Community 23 - "document.ts"
Cohesion: 0.15
Nodes (17): BLANK, buildDiff(), Builder, CellTone, codeCell(), collapseContext(), contextRun(), DiffRow (+9 more)

### Community 24 - "pane.ts"
Cohesion: 0.13
Nodes (8): RepositoryContext, launchGitPane(), openPane(), textProperty(), RepositoryFocus, RepositoryLocation, RepositoryPane, RepositorySelection

### Community 25 - "showResult"
Cohesion: 0.09
Nodes (25): branchGuard(), closeButton(), color2(), commitSubject(), fingerprint(), guard(), headMessage(), historyArgs() (+17 more)

### Community 26 - "Inspect"
Cohesion: 0.13
Nodes (4): ChangedPath, Commit, Inspect, message()

### Community 27 - "Shell"
Cohesion: 0.19
Nodes (4): appShortcut(), identityText(), Shell, ShellHost

### Community 28 - "comparison.ts"
Cohesion: 0.17
Nodes (27): attempt(), branchStart(), ChangesSnapshot, commitChanges(), CommitTarget, comparisonBetween(), difference(), emptyTree() (+19 more)

### Community 29 - "graph.ts"
Cohesion: 0.12
Nodes (27): HistoryCursor, GraphState, blank(), Cell, clipMarks(), curveLanes(), dot(), glyphCells() (+19 more)

### Community 30 - "BranchManager"
Cohesion: 0.18
Nodes (4): BranchInfo, branchName(), BranchManager, isLocal()

### Community 31 - "files.ts"
Cohesion: 0.17
Nodes (16): ContentMatch, hunkRange(), LineChange, LineHistoryCommit, matchRange(), parseLineChanges(), readLineChanges(), readLineHistory() (+8 more)

### Community 32 - "steps"
Cohesion: 0.08
Nodes (25): concurrency, cancel-in-progress, group, PERF_REPORT, jobs, performance, name, on (+17 more)

### Community 33 - "LineHistoryDialog"
Cohesion: 0.19
Nodes (8): fileLanguage(), LineHistoryDialog, openCompareDialog(), openCopySelection(), openLineHistory(), plural(), readLineHistory(), relativeTime()

### Community 35 - "CodeView"
Cohesion: 0.13
Nodes (6): cellWidth(), clamp(), CodeView, moveKey(), Selection, Wheel

### Community 36 - "readSummary"
Cohesion: 0.13
Nodes (24): attempt(), branchStart(), commitChanges(), comparisonBetween(), difference(), emptyTree(), lastCommitTarget(), optionalCommit() (+16 more)

### Community 37 - "Overlay"
Cohesion: 0.14
Nodes (8): box(), dialogFrame(), filterBar(), lineElement(), lines2(), Overlay, textInput(), toneColor()

### Community 38 - "parseHistory"
Cohesion: 0.13
Nodes (18): changeLine(), changeSection(), commitLines(), field(), historyCursor(), objectId(), parseChanges(), parseHistory() (+10 more)

### Community 39 - "inspect.ts"
Cohesion: 0.18
Nodes (15): DiffDocument, statusLetter(), RunGit, PathRow, changeLine(), changeSection(), commitLines(), field() (+7 more)

### Community 40 - "workflows.ts"
Cohesion: 0.17
Nodes (18): branchGuard(), fingerprint(), FIXED, guard(), headMessage(), historyArgs(), local(), must() (+10 more)

### Community 41 - "BranchManager"
Cohesion: 0.23
Nodes (4): BranchManager, branchName(), inputBox(), readBranches()

### Community 43 - "files-pane.ts"
Cohesion: 0.11
Nodes (15): ChangeSection, DiffSummary, WorkingChange, changesPaneWidths(), discardPaths(), sliceSpans(), stagingOperation(), summarySpans() (+7 more)

### Community 44 - "FilesTab"
Cohesion: 0.06
Nodes (24): readFiles(), ChangeKind, emptyFilter(), FilesTab, previewNotice(), resultText(), fuzzySpread(), MatchType (+16 more)

### Community 45 - "compilerOptions"
Cohesion: 0.09
Nodes (21): compilerOptions, allowImportingTsExtensions, isolatedModules, lib, module, moduleDetection, moduleResolution, noEmit (+13 more)

### Community 46 - "CodeView"
Cohesion: 0.18
Nodes (4): CodeView, moveKey(), Selection, Wheel

### Community 47 - "repository.test.ts"
Cohesion: 0.14
Nodes (22): changed(), combineChanges(), fields(), FileChange, KINDS, lastField(), parseStatus(), READ (+14 more)

### Community 48 - "confirm.ts"
Cohesion: 0.25
Nodes (11): commitSubject(), operationPreview(), commitTarget(), describe(), Facts, facts(), historyText(), openConfirm() (+3 more)

### Community 49 - ".diffBoxes"
Cohesion: 0.18
Nodes (4): blameRevision(), blameText(), changesPaneWidths(), isChord()

### Community 50 - ".selection"
Cohesion: 0.24
Nodes (3): CopyDialog, copyText(), lineNumbersText()

### Community 51 - "Look"
Cohesion: 0.16
Nodes (8): selectionHint(), inputBox(), ResetFlow, Look, rows(), box(), filterBar(), textInput()

### Community 52 - "displayWidth"
Cohesion: 0.18
Nodes (18): authorRelative(), badgeSpans(), badgeStyle(), charWidth(), commitDetail(), commitTitle(), displayWidth(), line() (+10 more)

### Community 55 - "RemoteList"
Cohesion: 0.24
Nodes (4): must4(), openAddRemote(), readRemotes(), RemoteList

### Community 57 - "scripts"
Cohesion: 0.06
Nodes (36): devDependencies, @biomejs/biome@2.6.4, oxc-parser@0.154.0, testcontainers@^12.2.1, @types/bun@1.4.4, typescript@7.0.2, engines, bun (+28 more)

### Community 58 - ".context"
Cohesion: 0.16
Nodes (3): emptyState(), message(), readPages()

### Community 61 - "cols"
Cohesion: 0.19
Nodes (14): blank(), clipMarks(), cols(), curveLanes(), dot(), glyphCells(), glyphLanes(), glyphLine() (+6 more)

### Community 63 - "pane-target.ts"
Cohesion: 0.20
Nodes (11): documentReply(), documentValue(), gitPane(), PaneTarget, readGitPaneTarget(), record(), RunCommand, tabRoot() (+3 more)

### Community 64 - "widgets.ts"
Cohesion: 0.06
Nodes (52): authorRelative(), Span, Segment, DEFAULT_SPLITS, GRAPH_ACTIONS, DetailLine, firstLine(), paneWidths() (+44 more)

### Community 65 - "theme.ts"
Cohesion: 0.08
Nodes (15): EMPTY_FACTS, NEXT_COMMANDS, SettingRow, AppShortcut, RepositoryFacts, TabView, VERSION, color() (+7 more)

### Community 66 - "ci.yml"
Cohesion: 0.13
Nodes (14): runs-on, steps, jobs, checks, name, on, pull_request, push (+6 more)

### Community 68 - "Session"
Cohesion: 0.31
Nodes (4): errorMessage(), readFacts(), Session, TabId

### Community 69 - "operations.test.ts"
Cohesion: 0.39
Nodes (7): commit(), ENV, folders, git(), must(), repo(), subjects()

### Community 70 - "preview.ts"
Cohesion: 0.15
Nodes (14): CodeLine, highlight(), sourceLines(), SplitRows, FilePreview, mergeChanges(), readPreview(), highlighter() (+6 more)

### Community 71 - "CompareDialog"
Cohesion: 0.33
Nodes (3): BranchTarget, CompareDialog, openCompareDialog()

### Community 72 - "staging.ts"
Cohesion: 0.23
Nodes (12): args(), listed(), output(), runStaging(), stages(), stagingLabel(), stagingMessage(), StagingOperation (+4 more)

### Community 74 - "overlay.ts"
Cohesion: 0.13
Nodes (16): ConfirmSpec, CustomSpec, DialogLine, DialogSpec, FormField, FormSpec, PickerSpec, dialogFooter() (+8 more)

### Community 76 - "LineHistoryDialog"
Cohesion: 0.18
Nodes (9): fileLanguage(), BLANK, DialogSize, LineHistoryDialog, LineHistoryTarget, openLineHistory(), splitPatch(), Pane (+1 more)

### Community 80 - "AGENTS.md"
Cohesion: 0.33
Nodes (3): How tested, What changed, Why

### Community 81 - "startArgs"
Cohesion: 0.31
Nodes (11): activePlan(), must3(), quote(), readRebasePlan(), rebaseActive(), recoveryArgs(), runRebase(), shell() (+3 more)

### Community 83 - "inspectWorktree"
Cohesion: 0.17
Nodes (13): changeOverview(), gitAt(), inspectProject(), inspectWorktree(), load(), message3(), numstat(), ProjectRegistry (+5 more)

### Community 84 - ".sync"
Cohesion: 0.18
Nodes (5): entryText(), parseBlameRecord(), readBlameRange(), sameTarget(), SelectionBlame

### Community 85 - "Herdr layout research"
Cohesion: 0.20
Nodes (8): Footnotes, Herdr layout research, Intent analysis, Research topics, Footnotes, Herdr mods research, Intent analysis, Research topics

### Community 86 - "Findings"
Cohesion: 0.20
Nodes (10): Checking a mod, Findings, Full-height pane beside a split tab, How this repository opens Git, Open questions, Placing the mod, Publish checklist, Two Herdrs (+2 more)

### Community 87 - "treeRows"
Cohesion: 0.22
Nodes (8): compareNames(), compareNames2(), emit(), insert(), node(), node2(), PathTree, treeRows()

### Community 88 - "dialogFooter"
Cohesion: 0.33
Nodes (4): dialogFooter(), footerButton(), footerHint(), PushConfirm

### Community 89 - "build.ts"
Cohesion: 0.15
Nodes (14): bundle(), check(), HOST_MODULES, options, write(), fail(), flags(), run() (+6 more)

### Community 90 - "Findings"
Cohesion: 0.22
Nodes (9): After a Herdr update, Build it by hand, Credit, Findings, Shipping a layout instead, The changes, Undo, Verify (+1 more)

### Community 92 - "workspaces.test.ts"
Cohesion: 0.33
Nodes (8): GitAt, ENV, folder(), folders, git(), gitAt(), must(), project()

### Community 93 - "parseStatus"
Cohesion: 0.40
Nodes (5): combineChanges(), fields(), lastField(), parseStatus(), readBranchHeader()

### Community 95 - "Herdr Git Mods"
Cohesion: 0.25
Nodes (7): Built from, Done when, Herdr Git Mods, How it behaves, Watch out, What you see, Branch

### Community 97 - "performance.ts"
Cohesion: 0.18
Nodes (8): command(), env, git(), repo, report, rows, setupStarted, startedAt

### Community 98 - "Agents"
Cohesion: 0.29
Nodes (7): Agents, Docs, Documentation guidelines, graphify, Local testing, Pull requests, Review responsibility

### Community 99 - "Testing"
Cohesion: 0.25
Nodes (8): Constrained Linux runner, How this project tests, Linux performance gate, Structure-sensitive tests, Tautological tests, Testing, Tests that cannot fail, Tests to avoid

### Community 100 - ".constructor"
Cohesion: 0.21
Nodes (4): errorMessage3(), readFacts(), readRepository(), Session

### Community 101 - "Herdr Git Mods"
Cohesion: 0.29
Nodes (7): Contributing, Development, Features, Herdr Git Mods, Install, Keyboard shortcuts, License

### Community 102 - "Contributing"
Cohesion: 0.33
Nodes (6): Before you start, Contributing, Make a change, Open a pull request, References, Set up development

### Community 103 - "Architecture"
Cohesion: 0.33
Nodes (6): Adding features, Architecture, Build, Pane presentation, Runtime rules, Source layout

### Community 104 - "Design"
Cohesion: 0.29
Nodes (7): Cell grid, Color, Design, Differences from the TUI, Motion and refresh, Screen, Filter

### Community 105 - "Research method"
Cohesion: 0.33
Nodes (5): Findings by topic, Intent analysis, Research method, Research topics, Source footnotes

### Community 106 - "Sharing on herdr.dev/mods"
Cohesion: 0.33
Nodes (6): How a person installs it, How the listing works, keys.json, RECIPE.md, Sharing on herdr.dev/mods, Why repositories go unlisted

### Community 108 - "tests/tsconfig.json"
Cohesion: 0.33
Nodes (5): ../tsconfig.json, compilerOptions, types, extends, include

### Community 109 - "check-comments.ts"
Cohesion: 0.53
Nodes (5): check(), lineAndColumn(), ROOTS, sourceFiles(), violations()

### Community 111 - "Coding standards"
Cohesion: 0.40
Nodes (5): Coding standards, Deep modules, Lint and format, No comments, TypeScript

### Community 112 - "bug_report.md"
Cohesion: 0.50
Nodes (3): Environment, Expected and actual behavior, Steps to reproduce

### Community 116 - "changes.test.ts"
Cohesion: 0.48
Nodes (6): commitFile(), ENV, folders, git(), must(), repo()

## Knowledge Gaps
- **1 isolated node(s):** `../tsconfig.json`
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 426 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **17 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Look` connect `Look` to `WorkspacesBox`, `changes.ts`, `commands.ts`, `GraphTab`, `code-view.ts`, `Look`, `Overlay`, `SplitDiff`, `Shell`, `graph.ts`, `BranchManager`, `CodeView`, `inspect.ts`, `files-pane.ts`, `FilesTab`, `confirm.ts`, `commit.ts`, `.repository`, `widgets.ts`, `theme.ts`, `preview.ts`, `CompareDialog`, `overlay.ts`, `LineHistoryDialog`, `SettingsTab`?**
  _High betweenness centrality (0.068) - this node is a cross-community bridge._
- **What connects `../tsconfig.json` to the rest of the system?**
  _1 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `WorkspacesBox` be split into smaller, more focused modules?**
  _Cohesion score 0.05493827160493827 - nodes in this community are weakly interconnected._
- **Why does `Module dependencies` connect `changes.ts` to `theme.ts`, `CommandHandler`, `Architecture`?**
  _High betweenness centrality (0.046) - this node is a cross-community bridge._
- **Should `changes.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.07755102040816327 - nodes in this community are weakly interconnected._
- **Why does `Architecture` connect `Architecture` to `AGENTS.md`, `changes.ts`?**
  _High betweenness centrality (0.045) - this node is a cross-community bridge._
- **Should `main.js` be split into smaller, more focused modules?**
  _Cohesion score 0.04946727549467275 - nodes in this community are weakly interconnected._