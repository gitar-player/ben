/**
 * Wiring for allwyn-api.html: file -> board -> DealRunner -> GameState -> render.
 *
 * allwyn.main.js wires a websocket to the gameserver. This page has no
 * gameserver: it reads a deal from a .pbn or .lin file and has BEN bid and play
 * all four seats through the REST API in gameapi.py (see README-api.md and
 * WEBSITE-INTEGRATION.md). The renderer and GameState are the websocket UI's,
 * unchanged; DealRunner speaks their message format.
 */

import { GameState } from './allwyn.state.js';
import { collectDom, render, appendCall } from './allwyn.render.js';
import { initTheme } from './allwyn.theme.js';
import { parseDealFile } from './allwyn.dealfile.js';
import { BenApi, DealRunner } from './allwyn.api.js';

const SEAT_NAMES = ['North', 'East', 'South', 'West'];
const SUIT_PIPS = { S: '♠', H: '♥', D: '♦', C: '♣' };
const API_KEY = 'allwyn.apiBase';
const TRICK_PAUSE_MS = 1200;

const $ = (sel) => document.querySelector(sel);
const dom = collectDom();
const ui = {
    file: $('#deal-file'),
    board: $('#board-select'),
    api: $('#api-base'),
    tournament: $('#tournament'),
    pace: $('#pace'),
    play: $('#play-button'),
    step: $('#step-button'),
    restart: $('#restart-button'),
    progress: $('#progress'),
    log: $('#play-log'),
    logList: $('#play-log-list'),
};

// Every seat is BEN's and every hand is on show: this page is for watching.
const state = new GameState({
    humanSeats: [false, false, false, false],
    noHuman: true,
    allVisible: true,
    autoplay: false,
    timeoutSeconds: 0,
});
state.connection = { status: 'idle', detail: 'Choose a .pbn or .lin file, pick a board, then Play hand.' };
state.subscribe(() => render(state, dom));

let boards = [];
let runner = null;
let running = false;          // playing continuously, as opposed to stepping
let stepping = false;         // a request to BEN is in flight
let driving = false;          // drive() is running, perhaps paused between steps
let generation = 0;           // bumped on restart, so a stale request is ignored

initTheme($('#theme-toggle'));
initPanelToggle($('#auction-toggle'), 'allwyn.auctionHidden', 'auctionHidden', 'Auction', 'the auction panel');
initPanelToggle($('#help-toggle'), 'allwyn.helpHidden', 'helpHidden', 'Help', 'the bid explanations');

/* ----------------------------------------------------------------- API URL */

function defaultApiBase() {
    const fromQuery = new URLSearchParams(window.location.search).get('api');
    if (fromQuery) return fromQuery;
    try {
        const saved = localStorage.getItem(API_KEY);
        if (saved) return saved;
    } catch (_) { /* private mode */ }
    const host = window.location.hostname || 'localhost';
    return `http://${host}:8085`;
}

ui.api.value = defaultApiBase();
ui.api.addEventListener('change', () => {
    try { localStorage.setItem(API_KEY, ui.api.value.trim()); } catch (_) { /* nothing to keep it in */ }
});

/* -------------------------------------------------------------- deal file */

ui.file.addEventListener('change', async () => {
    const file = ui.file.files?.[0];
    if (!file) return;
    let parsed;
    try {
        parsed = parseDealFile(file.name, await file.text());
    } catch (error) {
        setStatus('error', `Could not read ${file.name}: ${error.message}`);
        return;
    }

    boards = parsed.boards;
    ui.board.replaceChildren(...boards.map((board, i) => {
        const option = document.createElement('option');
        option.value = String(i);
        option.textContent = `${board.label} (dealer ${board.dealer}, vul ${board.vul})`;
        return option;
    }));
    ui.board.disabled = boards.length === 0;

    if (boards.length === 0) {
        const option = document.createElement('option');
        option.textContent = 'No deals found';
        ui.board.replaceChildren(option);
        setStatus('error', [`No deals found in ${file.name}.`, ...parsed.errors].join(' '));
        runner = null;
        paintControls();
        return;
    }
    const skipped = parsed.errors.length ? ` Skipped ${parsed.errors.length}: ${parsed.errors.join('; ')}` : '';
    setStatus(parsed.errors.length ? 'error' : 'idle',
        `${file.name}: ${boards.length} deal${boards.length === 1 ? '' : 's'}.${skipped}`);
    loadBoard();
});

ui.board.addEventListener('change', loadBoard);

/** Put the chosen board on the table, ready to play. */
function loadBoard() {
    const board = boards[Number(ui.board.value)];
    if (!board) return;
    generation += 1;
    running = false;
    stepping = false;
    driving = false;

    runner = new DealRunner(board, makeApi(), {
        emit: (message) => state.apply(message),
        log: addLogEntry,
    });
    state.pendingTrick = null;
    state.showLastTrick = false;
    state.expectTrickConfirm = false;
    ui.logList.replaceChildren();
    ui.log.hidden = true;

    runner.step();     // 'start' is synchronous: deals the cards, asks nothing
    paintControls();
}

function makeApi() {
    return new BenApi(ui.api.value.trim(), { tournament: ui.tournament.value });
}

// The API URL and scoring are read when a deal starts; changing them mid-deal
// applies from the next request.
for (const input of [ui.api, ui.tournament]) {
    input.addEventListener('change', () => { if (runner) runner.api = makeApi(); });
}

/* ------------------------------------------------------------------ driving */

ui.play.addEventListener('click', () => {
    if (!runner || runner.done) return;
    running = !running;
    paintControls();
    if (running && !driving) drive();
});

ui.step.addEventListener('click', () => {
    if (!runner || runner.done || driving) return;
    drive();
});

ui.restart.addEventListener('click', loadBoard);

$('#result-continue')?.addEventListener('click', () => {
    state.result = null;
    state.notify();
});

/**
 * Take steps until paused or done - or just one, when stepping. A failed
 * request leaves the runner where it was, so Play or Step retries it.
 */
async function drive() {
    const mine = generation;
    driving = true;
    try {
        await takeSteps(mine);
    } finally {
        if (mine === generation) {
            driving = false;
            running = false;
            paintControls();
        }
    }
}

async function takeSteps(mine) {
    do {
        // A finished trick stays on the table until the next card is asked for.
        if (state.pendingTrick) {
            state.pendingTrick = null;
            state.expectTrickConfirm = false;
        }
        stepping = true;
        state.busy = true;
        setStatus('open', '');
        paintControls(whoIsNext());

        let outcome;
        try {
            outcome = await runner.step();
        } catch (error) {
            if (mine !== generation) return;
            stepping = false;
            state.busy = false;
            setStatus('error', error.message);
            return;
        }
        if (mine !== generation) return;
        stepping = false;
        state.busy = false;
        paintControls();
        state.notify();

        if (runner.done) break;
        if (running) {
            await sleep(outcome.kind === 'trick' ? TRICK_PAUSE_MS : Number(ui.pace.value));
            if (mine !== generation) return;
        }
    } while (running && !runner.done);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** "North to bid", "West to lead" - for the progress line while BEN thinks. */
function whoIsNext() {
    if (!runner) return '';
    if (runner.phase === 'bidding') {
        return `${SEAT_NAMES[(runner.dealer + runner.auction.length) % 4]} to bid`;
    }
    if (runner.phase === 'lead') return `${SEAT_NAMES[(runner.contract.declarer + 1) % 4]} to lead`;
    if (runner.phase === 'play' && runner.trick.cards.length < 4) {
        const seat = (runner.trick.leader + runner.trick.cards.length) % 4;
        const forDummy = seat === runner.dummy ? ` (declarer plays dummy)` : '';
        return `${SEAT_NAMES[seat]} to play${forDummy}`;
    }
    return '';
}

function paintControls(thinking = '') {
    const ready = Boolean(runner);
    const done = Boolean(runner?.done);
    ui.play.disabled = !ready || done;
    const started = Boolean(runner?.auction.length);
    ui.play.textContent = running ? 'Pause' : started ? 'Resume' : 'Play hand';
    ui.step.disabled = !ready || done || driving;
    ui.restart.disabled = !ready;
    ui.board.disabled = boards.length === 0;

    if (!runner) {
        ui.progress.textContent = '';
    } else if (thinking) {
        ui.progress.textContent = `Asking BEN: ${thinking}...`;
    } else if (done) {
        ui.progress.textContent = 'Deal complete.';
    } else if (runner.phase === 'bidding') {
        ui.progress.textContent = runner.auction.length ? `Bidding, ${runner.auction.length} calls` : 'Ready to bid.';
    } else {
        ui.progress.textContent = `Trick ${Math.min(runner.tricks.length + 1, 13)} of 13`;
    }
}

function setStatus(status, detail) {
    state.setConnection(status, detail);
}

/* -------------------------------------------------------------- the log */

function addLogEntry(entry) {
    ui.log.hidden = false;
    const item = document.createElement('li');

    const when = document.createElement('span');
    when.className = 'when';
    const seat = document.createElement('span');
    seat.className = 'seat';
    seat.textContent = 'NESW'[entry.seat];
    const action = document.createElement('span');
    action.className = 'action';
    const who = document.createElement('span');
    who.className = 'who';

    if (entry.phase === 'bid') {
        when.textContent = 'Bid';
        appendCall(action, entry.action === 'PASS' ? 'Pass' : entry.action);
    } else {
        when.textContent = `T${entry.trick}`;
        const suit = entry.action[0];
        const pip = document.createElement('span');
        pip.className = suit === 'H' || suit === 'D' ? 'suit red' : 'suit';
        pip.textContent = SUIT_PIPS[suit];
        action.append(pip, document.createTextNode(entry.action[1] === 'T' ? '10' : entry.action[1]));
        if (runner && runner.trick.cards.length === 1) item.classList.add('trick-start');
    }

    who.textContent = describe(entry);
    who.title = who.textContent;
    item.append(when, seat, action, who);
    ui.logList.appendChild(item);
    ui.logList.scrollTop = ui.logList.scrollHeight;
}

/** "Simulation - 72% to make" or the engine name alone when that's all there is. */
function describe({ who, response }) {
    const parts = [who || 'BEN'];
    const top = response?.candidates?.[0];
    if (top && Number.isFinite(top.p_make_contract)) {
        parts.push(`${Math.round(top.p_make_contract * 100)}% make`);
    }
    if (top && Number.isFinite(top.expected_tricks_sd)) {
        parts.push(`${top.expected_tricks_sd.toFixed(1)} tricks`);
    }
    return parts.join(' - ');
}

/* --------------------------------------------------------- panel toggles */

/** Show/hide buttons, remembered between visits - as in allwyn.main.js. */
function initPanelToggle(button, key, field, noun, description) {
    if (!button) return;
    try { state[field] = localStorage.getItem(key) === '1'; } catch (_) { /* shown */ }
    const paint = () => {
        button.textContent = `${state[field] ? 'Show' : 'Hide'} ${noun}`;
        button.setAttribute('aria-pressed', String(state[field]));
        button.setAttribute('aria-label', `${state[field] ? 'Show' : 'Hide'} ${description}`);
    };
    paint();
    button.addEventListener('click', () => {
        state[field] = !state[field];
        try {
            if (state[field]) localStorage.setItem(key, '1');
            else localStorage.removeItem(key);
        } catch (_) { /* nothing to remember it with */ }
        paint();
        state.notify();
    });
}

render(state, dom);
paintControls();
