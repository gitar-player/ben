[Start Playing](http://localhost:8080/app/allwyn-api.html)


# Bridge Engine

This is a game engine for [bridge](https://en.wikipedia.org/wiki/Contract_bridge).
It can be used as a robot player, to do analysis, or to develop AI for bridge.

The engine is built using machine learning (neural networks) and [double dummy solver](https://github.com/dds-bridge/dds) through the python wrapper [python-dds](https://github.com/Afwas/python-dds).

To get a first impression of how the engine plays, please take a look at the [demo](https://lorserker.github.io/ben/demo/demo.html), or watch the bridge streamer Peter Hollands [demo the robot](https://www.youtube.com/watch?v=onG_V7vwxUk&t=150s) on IntoBridge.

For a few examples of how you can use the engine for analysis or development, see the [tutorials](#tutorials).

If you like the software, please consider making a donation to support the developers.

[![Donate](https://img.shields.io/badge/Donate-PayPal-green.svg)](https://www.paypal.com/donate/?business=Z7G6CCTFK2XXS&no_recurring=0&currency_code=EUR)

## Getting Started

### Installation

The engine runs on **Python 3.12**, with the neural networks using TensorFlow 2.18.1 (Keras 3.5.x). All platforms standardise on Python 3.12.

The recommended way of installing is in a [conda environment](https://docs.conda.io/en/latest/miniconda.html) (see [conda_setup.sh](conda_setup.sh)), but it can also be run in a plain `venv` / system Python 3.12 via `pip install -r requirements.txt`.

For __Windows__ users: After installing anaconda, you  will have a new application called "Anaconda Prompt". Henceforth, you will have to run all commands in "Anaconda Prompt" not in "cmd". The title bar of your command prompt window should read *"Administrator: Anaconda Prompt (Miniconda3)"*

After installing conda, execute the commands in the [conda_setup.sh](conda_setup.sh) script to create an environment and install the dependencies.

The bridge engine was developed on Linux. It will likely work on any other platform which runs Python, but was only tested on Windows 10 and Windows 11 and Mac M1/M2.

For __Mac M1/M2__ users: you need to install [Homebrew](https://brew.sh/) if you don't have it already, then `brew install boost`.

On __Amazon__, there is an image Public_Ben_Bot_V1.2 for starting an instance of BEN. After starting the instance just log in and execute [start_ben_bot_screens.sh].

For __Ubuntu__ users: you might have to install libboost using `sudo apt install libboost-thread-dev`.

> **Double-dummy solver:** BEN's double-dummy solver uses the `dds3` extension (DDS 3.0.0), not the old `dds.dll` / `libdds.so`. Prebuilt copies are vendored per platform under `bin/dds3-win/`, `bin/dds3-linux/`, `bin/dds3-darwin/` and are loaded automatically. Each is a compiled extension **locked to Python 3.12**; to use a different Python or build for an unsupported platform, see [src/ddsolver/README.md](src/ddsolver/README.md). The `libdds` libraries kept under `bin/` are used only by the BGADLL/PIMC engine.

#### Running natively on Linux (including WSL)

Docker users need to do nothing — the image is built on Ubuntu 24.04 / Python 3.12. For a **native** (non-Docker) Linux install, note that the vendored `bin/dds3-linux/_dds3.so` is built on **Ubuntu 24.04** and therefore requires:

- **glibc ≥ 2.38** — i.e. Ubuntu 24.04+, Debian 13+, Fedora 38+. On an older distro (e.g. Ubuntu 22.04, glibc 2.35) it fails at import with `version 'GLIBC_2.38' not found`. Run on a newer distro, or rebuild `dds3` against your glibc (see [src/ddsolver/README.md](src/ddsolver/README.md)).
- **Python 3.12** — the extension is locked to the CPython minor version.

**WSL quick start (Ubuntu 24.04)** — the simplest way to run/test the Linux build outside Docker.

Fully automated, from **Windows PowerShell** in the repo root — [setup_wsl.ps1](setup_wsl.ps1) installs the distro (if needed) and then runs the Linux provisioning inside it:

```powershell
powershell -ExecutionPolicy Bypass -File setup_wsl.ps1
```

(First run installs `Ubuntu-24.04` and opens its one-time username/password setup; complete that and re-run the script. If the distro already exists it provisions straight away.)

Or do it in two steps — install the distro once on Windows, then run the setup script inside it:

```powershell
wsl --install Ubuntu-24.04        # Windows; installs alongside any existing distro
```
```bash
# Inside Ubuntu 24.04 - the repo on your Windows drive is at /mnt/<drive>/...
cd /mnt/d/GitHub/ben && bash setup_linux.sh
```

[setup_linux.sh](setup_linux.sh) is idempotent and does everything: system packages (incl. `python3-gdbm`), a Python 3.12 venv at `~/ben` with `requirements.txt`, and the .NET runtime for the ACE/BBA engines. When it finishes:

```bash
source ~/ben/bin/activate        # or 'ben-activate' in a new shell
cd /mnt/d/GitHub/ben/src
python game.py --boards ../Challenges/martens_declarer_first10.pbn --auto true
```

### Running the Web App

The engine has a (very basic) UI which enables you to play as a human agains three bots and then review the games you played.

The app runs in the browser, and the service has two components: (1) "appserver" which serves the UI through http, and (2) "gameserver" which serves the API to interface with the bots through websockets.

#### Quick start (macOS / Linux)

`start_ben.sh` starts both components, waits until they are actually listening, and opens the browser:

```bash
./start_ben.sh                          # random boards
./start_ben.sh --boards Boards/x.pbn    # deal from a file
./start_ben.sh --force                  # restart if it is already running
./start_ben.sh --no-browser             # don't open a browser window
./start_ben.sh --api                    # also start gameapi.py, for allwyn-api.html (or BEN_API=1)
```

Ctrl-C stops all the servers. Output goes to `logs/gameserver.log` and `logs/appserver.log`
(and `logs/gameapi.log` with `--api`). If any one of them exits, the others are stopped too.
Any option other than the ones listed is passed through to `gameserver.py`.

The interpreter is resolved in this order: `BEN_PYTHON`, an activated virtualenv, `./.venv`,
a conda env named `TF2` or `ben`, then `python3`. `BEN_APP_PORT` / `BEN_WS_PORT` /
`BEN_API_PORT` override the ports, but note the UI expects the gameserver on 4443 (see the dropdown note below).

#### Choosing the play UI

There are two front ends for the same game. They speak the same websocket protocol but have
separate markup, client code and stylesheets, so they can look nothing alike:

| `--ui` | Page | |
| --- | --- | --- |
| `allwyn` (default) | `allwyn.html` | Rewrite: ES modules, no jQuery, native `<dialog>`, no CDN. |
| `bridge` | `bridge.html` | The original UI, unmodified. Upstream's version, kept working. |

```bash
BEN_UI=bridge ./start_ben.sh          # or: python appserver.py --ui bridge
```

If anything looks off in `allwyn.html`, `BEN_UI=bridge ./start_ben.sh --force` puts you back on
the old UI immediately.

`appserver.py` takes `--ui`, defaulting to `$BEN_UI` and then to `allwyn`; `start_ben.sh` passes
`BEN_UI` through. The setting decides where every "play" link points, so it applies to the home
page, the deal list and the replay links alike. The banner in `logs/appserver.log` says which one
is live.

`allwyn.html` splits the ~600 lines that were inline in `bridge.html` into modules with one job
each - `allwyn.model.js` (bridge rules), `allwyn.protocol.js` (the message contract),
`allwyn.socket.js` (the wire), `allwyn.state.js` (game state), `allwyn.render.js` (state to DOM),
`allwyn.theme.js` (the theme toggle). It has its own stylesheet, `allwyn.css`: dark by default,
with a Dark / Light / Auto button in the header that remembers the choice in localStorage.
`style.css` is left to `bridge.html`.

Nothing but the renderer touches the DOM, so the game loop can be tested without a browser:

```bash
node src/frontend/allwyn.test.mjs                       # model, protocol and state checks
node src/frontend/allwyn.test.mjs recorded-session.json # plus a replay of a real deal
```

A finished trick stays on the table in `allwyn.html` until you click, whatever the home page's
"Autocomplete trick after N seconds" box says - that box ships ticked, and honouring it clears
every trick before you have read it. `bridge.html` still obeys it.

Hands you are entitled to see - your own, dummy once it is down - stay on screen for the rest of
the deal. `bridge.html` re-tests visibility on every message and hides a hand as soon as the turn
moves on, so declarer's cards vanish while the other seats play.

For hands-free viewing, add `&autoplay=1` to the play URL: each trick is then acknowledged for
you after `T` seconds (2 if no `T` is given). It is opt-in precisely because the home page's
box is not.

`bridge.html` is deliberately untouched by all of this, so upstream changes to it still merge.

#### Playing a deal from a file: `allwyn-api.html`

`allwyn-api.html` has BEN bid and play a deal read from a `.pbn` or `.lin` file - all four
seats, or the three you leave it when you take one. It needs no gameserver: the browser runs the table itself and asks the REST API in
`gameapi.py` for each call and card, as [WEBSITE-INTEGRATION.md](WEBSITE-INTEGRATION.md)
describes (endpoints in [README-api.md](README-api.md)).

1. Start `appserver.py` (port 8080) and `gameapi.py` (port 8085):

   ```bash
   ./start_ben.sh --api
   ```

   `gameapi.py` is opt-in because it loads its own copy of the models. It listens on
   localhost only; to reach it by another name, run it by hand from `src/` with
   `python gameapi.py --host 0.0.0.0 --allowed-hosts '*'` (on macOS, with `DYLD_LIBRARY_PATH` set
   as `start_ben.sh` sets it). In Docker, `start_ben_all.sh` starts both.
2. Open `http://localhost:8080/app/allwyn-api.html`.
3. Choose a `.pbn` or `.lin` file, pick a board from the list, then **Play hand**.
   **Pause**/**Resume**, **Step** (one call or card at a time) and **Restart** control the deal;
   **Pace** sets the delay between actions and **Scoring** sends `tournament=mp` or `imps`.
4. To play a seat yourself, pick it under **You play** (default **None**: BEN plays all four).
   Changing it starts the board again; `?seat=S` in the URL sets it too.

With a seat of your own:

- Only your hand is shown, and dummy's once the opening lead is made; all four are shown when
  the deal ends.
- When it is your call the bidding box appears (level, then strain; **Hint** shows what BEN
  would call and what it considered; **Choice** lists every call open to you with what it would
  show in BEN's bidding system - name, shape and points, alerts flagged - from `/bids`, and
  clicking one makes it). Your call is explained through `/explain` like BEN's.
- When it is your card, click it. If you declare you also play dummy's cards. If your partner
  declares, you play the hand for them - declarer's cards and your own as dummy - as on BBO with
  a robot partner, and partner's hand is shown from the end of the auction.
- After your call or card BEN carries on by itself; **Pause** stops it between actions.
- If the file records how the board went at the table - PBN `[Contract]`, `[Declarer]`,
  `[Result]`, `[Auction]` and `[Play]` (tricks are counted from the play when there is no
  `[Result]`), or LIN `mb|` calls, `pc|` cards and an `mc|` claim - your result is compared with
  it as soon as the deal ends, with no requests to BEN: a **Recorded** row on the result box (its
  contract, score and the difference from yours in IMPs) and, in the side panel, both results
  and both auctions side by side. Comparing with BEN is then offered as a button (**Compare
  with BEN**) rather than started by itself. A file that records only the contract and auction
  (bidding challenges) gets those compared, without scores. With BEN playing all four seats,
  BEN's result is compared with the recorded one the same way.
- When the deal ends - straight away when the file has no recorded result, otherwise when you
  ask - the side panel compares your deal with BEN's, in two
  ways. First, BEN is asked what it would have done at each of your calls and cards, in the
  same position (same hand, same auction or play so far); every place it would have chosen
  differently is listed with BEN's reason, and forced cards are not counted. Then the board is
  played again with BEN at all four seats, and the two tables are set side by side: contract,
  declarer's tricks, score from your side, the difference in points and IMPs (the scale in
  `src/scoring.py`), and both auctions with the calls that differ underlined. This takes a
  request per decision plus a whole deal, so allow a minute or two.

The API address defaults to `http://<this host>:8085`; change it in the **BEN API** box
(remembered in localStorage) or pass `?api=http://host:8085` in the page URL. The page can be
served by any static web server - it only needs the API to be reachable and CORS to allow it.

What it reads and does:

- **PBN**: every game with a `[Deal]` tag. `[Dealer]` and `[Vulnerable]` are used when present,
  otherwise they follow the board number; `"#"` repeats the previous game's value, and a deal
  with one hand given as `-` has it filled in.
- **LIN**: single hand records, vugraph/tournament files with many `md|` deals (labelled
  open/closed room), and BBO handviewer URLs with the lin in the query string. A blank East hand
  is worked out from the other three.
- Any auction or play already in the file is ignored - BEN bids and plays the deal afresh.
- Player names in the file - PBN `[North]`, `[East]`, `[South]`, `[West]`, or LIN `pn|`
  (South, West, North, East; a vugraph's closed room takes the second four) - are shown beside
  the seats on the felt. BBO robots (`~~M...`) show as "Robot", with the full name on hover; the
  seat you play is marked "(you)", or "You" when the file has no name for it.
- Dummy's cards are asked of declarer (`seat` = declarer, `dummy` = dummy's hand), since
  `/play` refuses a call made as dummy. A card that is the only legal play is played without a
  request.
- The side panel logs every decision with the engine that made it (NN, Simulation, PIMC,
  Forced..., or You). The result is scored in the page, matching `src/scoring.py`.
- An illegal or failed answer stops the deal without changing it; **Resume** or **Step** retries.

A **Scorecard** under the table keeps every board played from the loaded file, the latest at the
bottom. Each board has a line for **You**, the **Recorded** table in the file, and **BEN**'s
table, each with the contract and declarer (e.g. `3♦N`, `Pass`), the result (`=`, `+2`, `-1`)
and the score under **We** or **They** - whichever side scored. "We" is your side (North-South
when BEN plays all four, when the board has no separate BEN line). A table with nothing yet says
so - *not in file*, or *not compared yet* until you compare with BEN - and a total per table is
kept at the bottom. Playing a board again replaces it. The scorecard is kept in the browser for
each file name, so it survives a reload; **Download CSV** saves it in the same layout (a line per
table per board) and **Clear** starts it again.

The **Debug** button in the header shows a panel under the table that records every
request to `gameapi.py` (the choice is remembered; `?debug=true` or `?debug=false` in the URL
overrides it). Requests are recorded all the time, so opening the panel mid-deal shows what has
already happened - including the hints and both halves of the comparison with BEN. Each row
shows time, what the request was for, endpoint, seat, BEN's answer (or the error), HTTP status and
duration. Click a row for the full URL, the parameters and the JSON response. **Copy JSON** puts
the whole log on the clipboard, or downloads it as a file where the clipboard is not available,
and **Clear** empties it. The last 500 requests are kept.

The first request after `gameapi.py` starts is slow (models load lazily), and a whole deal
takes about a minute on a laptop. The logic runs without a browser:

```bash
node src/frontend/allwyn.api.test.mjs                        # parsers, rules, scoring, a full deal
node src/frontend/allwyn.api.test.mjs demo/Camrose24_1.pbn   # also parse the files named
```

The code: `allwyn.dealfile.js` (PBN/LIN reading), `allwyn.api.js` (the API client, auction
rules, scoring and `DealRunner`, which plays the deal and reports it as the gameserver's
messages so `allwyn.state.js` and `allwyn.render.js` are reused unchanged), and
`allwyn.apimain.js` (the page wiring), with `allwyn-api.css` on top of `allwyn.css`.

#### Starting it automatically at login (macOS)

`~/Library/LaunchAgents/com.ben.app.plist` runs the same script at login and restarts it if it
dies. The file is machine specific (it holds absolute paths), so it is not part of the repo.

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ben.app.plist   # enable
launchctl kickstart -k gui/$(id -u)/com.ben.app                            # restart
launchctl bootout gui/$(id -u)/com.ben.app                                 # disable
```

Startup output goes to `logs/launchd.log`.

While the agent is loaded it owns ports 8080 and 4443, so a manual `./start_ben.sh` stops at
the "already in use" guard. Don't use `--force` to get around it - the agent restarts its own
copy 30s later and the two fight over the ports. Run `launchctl bootout` first.

Following are instructions to start the service by hand:

First, make sure that you are located in the `src` directory

```bash
cd src
```

Activate the conda environment

(If you are on __Windows__, make sure that you are in the *"Anaconda Prompt"*, not in the default Windows command prompt)

```bash
conda activate ben
```

Start the game server

(If you are on __Windows__ you  can omit `sudo` from the following commands)

```bash
python gameserver.py
```
By default you will just get random boards, but you can start the server with a parameter, and read boards from a file:

```bash
python gameserver.py --boards file.pbn
```
Only pbn and BEN's own internal format is supported (See input.ben)
adding --boardno will start from that number in the file.

And start the app server

```bash
cd frontend
python appserver.py
```

Now you can use the browser to navigate to `http://127.0.0.1:8080/home`
There will be a link "Play now". If you click that, a new board will be started and you can start playing bridge (you are South).
After playing a hand, a link to an analysis page will appear on the home page. The UI was tested on Firefox, Chrome and Android.

![image](ben_screenshot.png)

#### Running the Web App using container (Linux & Windows WSL2 ...)

It could be tricky to setup them all correctly in your environment, container env (like `docker`, `podman`) is another choice. 

`ghcr.io/lorserker/ben` [container package](https://github.com/lorserker/ben/pkgs/container/ben) is auto generated for each release. Inside it will execute the [start_ben_all.sh](start_ben_all.sh) to start above scripts automatically.

````
$ podman run --rm -it -p 8080:8080 -p 4443:4443 -p 8085:8085 ghcr.io/lorserker/ben  # <CTRL-C> to stop
Reading deals from: /app/src/gamedb
Bottle v0.12.25 server starting up (using GeventServer())...
Listening on http://0.0.0.0:8080/
Hit Ctrl-C to quit.
...
Playing random deals or deals from the client
models loaded
Listening on port:  4443
````

The container exposes three services:
- **Web UI**: http://localhost:8080 - Play bridge in your browser
- **WebSocket**: ws://localhost:4443 - Real-time game server
- **REST API**: http://localhost:8085 - API for bidding, play, and analysis (see [README-api.md](README-api.md)) 

You can build it locally like below to test local changes. New Mac is ARM based (not x86), you need to build locally as well.

````
$ podman build -t ben .
$ podman run --rm -it -p 8080:8080 -p 4443:4443 ben
````

If you want to debug in container env, then you need to map code repo into it, `-v $PWD:/app`.

### Tutorials

The tutorials serve as illustration of the engine's API and functionality, and should be helpful as a starting point if you would like to use the engine in a more customized way for analysis or for development.

The examples run in jupyter notebooks, but it's also possible to just read them without installing anything.

- __[Bidding](src/examples/Bidding.ipynb)__ shows how you can use the engine to bid hands and to sample hands which are consistent with a given auction
- __[Opening Leads](src/examples/OpeningLead.ipynb)__ illustrates how the engine "decides" which card to lead
- __[Card-by-card Analysis](src/examples/CardByCardAnalysis.ipynb)__ this example shows how the engine can go through an already played hand, analyse every bid made and every card played, and find possible mistakes. You can also give it a hand you played on BBO to see what the engine "thinks" about your play
- __[Single Dummy Estimates](src/examples/SingleDummyEstimates.ipynb)__ this exemplifies the use of a neural network to predict how many tricks declarer will take in a given contract on a given opening lead. As opposed to double dummy solvers, the results are approximate, but much faster.

## Play against itself and against other bots

To make the engine play against itself, execute this command:

```bash
python game.py
```

After each board, it's possible to go through the play using the web UI.

You can send a PBN-file as parameter, when starting the game.

To make the engine play against other bots:

First run the [bridge monitor](http://www.wbridge5.com/bm.htm) table manager server.

Then, run the command below to connect to the table manager using the [blue chip bridge protocol version 18](https://web.archive.org/web/20210514012054/http://www.bluechipbridge.co.uk/protocol.htm)

```
python table_manager_client.py --host 127.0.0.1 --port 2000 --name BEN --seat North
```

that will connect to the table as North - the other seats can be taken similarly.

## What the engine cannot do (yet)

Below is a list of features which aren't implemented in this engine yet, but you would probably expect them from a bridge robot:

- can't understand explanations of bids
- can't use or interpret defensive signals
- isn't deployed as a service which you could play with on the internet (you have to install it to use it)

## Articles

- [Free and Open Source Bridge AI Engine Released](https://bridgewinners.com/article/view/free-and-open-source-bridge-ai-engine-released/)
- [Bridge AI: How Neural Networks Learn to Bid](https://bridgewinners.com/article/view/bridge-ai-how-neural-networks-learn-to-bid/)
- [Play with Ben on IntoBridge](https://intobridge.com/news/play-with-robots-on-intobridge/)
- [Meet Ben, a Bridge AI with a Difference](https://greatbridgelinks.com/meet-ben-a-bridge-ai-with-a-difference/)

## How to cite

```
@misc{Dali2022,
  author = {Dali, Lorand},
  title = {Bridge Engine},
  year = {2022},
  publisher = {GitHub},
  journal = {GitHub repository},
  howpublished = {\url{https://github.com/lorserker/ben}},
}
```
## Using Mac
On Mac i use python3 and pip3

## Notes on this fork

This is [gitar-player/ben](https://github.com/gitar-player/ben), a fork of
[lorserker/ben](https://github.com/lorserker/ben). Branches:

| Branch | What it is |
| --- | --- |
| `port-to-0.8.8.4` | Working branch. Upstream 0.8.8.4 plus the local changes below. |
| `allwyn-main` | The old line, based on 0.8.7.4. Kept for reference; superseded. |
| `main` | Clean mirror of upstream. Don't commit here - `git fetch upstream && git merge upstream/main`. |

`origin` is this fork, `upstream` is lorserker/ben. The push URL on `upstream` is deliberately
set to a bogus value so a stray `git push upstream` can't target the original repo.

### Things that will bite you again

**The launchd agent follows whatever branch is checked out.** The plist runs `start_ben.sh`
from the working tree - there is no branch pinning. Check out a different branch and the agent
silently starts serving that one after its next restart.

**macOS 26.5 or newer is required.** `bin/dds3-darwin/dds3/_dds3.so` (DDS 3.0.0, arrived in
0.8.8.0) is built against a newer libc++ than earlier releases ship. On macOS 26.3 it fails with
`Symbol not found: __ZNSt3__113__hash_memoryEPKvm ... built for macOS 26.5`, and the gameserver
exits at startup. There is no fallback to the old libdds, and no dds3 wheel on PyPI - the only
alternatives are to update macOS or build it yourself with `bazelisk build -c opt //python:_dds3`.

**Notebooks need the same `DYLD_LIBRARY_PATH` as the servers.** A Jupyter kernel does not
inherit it from `start_ben.sh`, so `card_by_card.analyze()` fails with
`RuntimeError: PIMC SetupEvaluation failed` - PIMC loads, but its DDS backend cannot dlopen
`libdds`. Setting the variable inside the notebook is too late; dyld reads it at process start.
Put it in the kernel instead, in the `env` block of
`~/anaconda3/envs/TF2/share/jupyter/kernels/python3/kernel.json`:

```json
"env": { "DYLD_LIBRARY_PATH": "/Users/allwynsequeira/AllwynDev/ben/bin/BGA/macos/arm64" }
```

Then restart the kernel. That file is outside the repo, like the launchd plist, so it is one to
recreate on a new machine. To check from a notebook:
`import os; os.environ.get('DYLD_LIBRARY_PATH')`. The alternative, if you would rather not
touch the kernel, is to turn PIMC off for the analysis with
`models.pimc_use_declaring = models.pimc_use_defending = False`.

**PIMC needs `DYLD_LIBRARY_PATH` pointing at `bin/BGA/macos/arm64`.** BGADLL is a NativeAOT .NET
library whose `[DllImport("dds")]` goes through dlopen, and dlopen doesn't search the assembly's
own directory on macOS. Without it the banner says `DDS: error: Unable to load shared library
'dds'` and the server dies with SIGABRT partway through the first trick. `start_ben.sh` exports
it; **if you run `python gameserver.py` by hand, you have to set it yourself**, because dyld only
reads it at process start. A healthy start says `PIMC enabled. Version 0.9.9.1 DDS: haglund`.

**The `?server=` dropdown maps to ports 4440-4443.** Options "BEN 2/1", "BEN SAYC" and "GIB-BBO"
only exist if you started those instances with `src/runservers.sh`; `start_ben.sh` runs one
gameserver on 4443. The default is set to "Default (21GF)" here, but the dropdown remembers an
explicit choice in browser localStorage, so if the pre-flight says "No BEN server found on port
444x", pick "Default (21GF)" once.

**Two runtime-generated symlinks show up as untracked** - `bin/BGA/macos/arm64/dds.dylib` and
`libdds.dylib`, created by `BGADLL_Native` on first load. Harmless; don't commit them.

**`0.8.8.x` enables BBA, PIMC and SuitC on macOS**, which 0.8.7.4 disabled outright on every
non-Windows platform. Several code paths therefore run for the first time on Mac, which is where
the local fixes below came from. Expect more of these.

### Local changes not in upstream

The three bug fixes affect every platform where BBA is enabled, not just macOS, and were sent
upstream on 2026-08-14 - see "Upstream PRs in flight" below.

- `start_ben.sh` and its launchd plist - not upstream at all. Upstream's `src/runservers.sh`
  launches eight processes for a multi-instance deployment; this is a single-instance dev
  launcher with a readiness wait and clean teardown.
- **Hint crash**: clicking Hint sent the literal string `"Hint"` into the bid explainer, which
  raised `KeyError: 'Hint'` in BBA and killed the connection with a 1011. Invisible before
  0.8.8.x because `explain()` returns early when BBA is off, and until the auction has a real
  bid - so a hint on the first turn worked and a later one didn't.
- **Runaway loop on disconnect**: the card-input loops only exited when the error text contained
  `"going away"`, but a normal browser close reports `"received 1000 (OK)"`. The server then
  pinned a core at 99%, stopped answering new connections, and wrote 3.2M log lines in two
  minutes. Any player closing a tab mid-trick took the server down for everyone.
- **Server dropdown default**, as described above.

Tracebacks from the websocket handler are swallowed: `gameserver.py` sets the `websockets.server`
logger to `CRITICAL`. To debug a 1011, copy `gameserver.py`, change that line to `DEBUG`, and run
the copy on a spare port.

### Upstream PRs in flight

> **TODO** - opened 2026-08-14 against `lorserker/ben`, all four still open and waiting on the
> maintainer. Check back; act on whatever he says using the table below. Nothing here breaks if
> it stays open indefinitely - the fixes are already in `port-to-0.8.8.4`.

| | Branch | What |
| --- | --- | --- |
| [PR #184](https://github.com/lorserker/ben/pull/184) | `fix/hint-keyerror` | `KeyError: 'Hint'` closes the connection with a 1011 |
| [PR #185](https://github.com/lorserker/ben/pull/185) | `fix/disconnect-spin` | Disconnect spins the server at 100% CPU, locking everyone out |
| [PR #186](https://github.com/lorserker/ben/pull/186) | `fix/server-dropdown-default` | Dropdown defaults to a port nothing listens on |
| [Issue #187](https://github.com/lorserker/ben/issues/187) | - | PIMC's DDS backend can't load on macOS; asks him to pick one of three fixes |

Check status:

```bash
gh pr list --repo lorserker/ben --author gitar-player --state all
gh issue view 187 --repo lorserker/ben --comments
gh pr view 184 --repo lorserker/ben --json body --jq .body   # the writeups live on GitHub now
```

| He | You |
| --- | --- |
| merges one | `git fetch upstream`, rebase `port-to-0.8.8.4` onto `upstream/main`; the local copy of that commit drops out |
| requests changes | edit the `fix/*` branch, `git commit --amend`, `git push --force-with-lease` - the PR updates itself |
| answers #187 | new work: option 1 is a launcher/Dockerfile change, 2 needs a BGADLL rebuild, 3 changes load order |
| goes quiet | nothing to do; this fork keeps working |

Gotchas when you pick this back up:

- #184 and #185 both touch `src/human.py`, so whichever merges second needs a rebase. Different
  methods, so it resolves trivially.
- After any rebase or branch switch, `launchctl kickstart -k gui/$(id -u)/com.ben.app`, since the
  agent serves whatever is checked out.
- Don't delete the `fix/*` branches on the fork while the PRs are open - that closes them.
- Not yet offered upstream: `start_ben.sh` itself (overlaps his `runservers.sh`/`stopservers.sh`,
  so it is a design conversation rather than a bug fix) and the `.gitignore` entry for the
  generated dds symlinks (cosmetic; commit `36eb8ab8` if you want it as a fourth PR).

## Discord
You are welcome to join our Discord server "BEN the bridge engine" at https://discord.gg/9vaTn2Em 