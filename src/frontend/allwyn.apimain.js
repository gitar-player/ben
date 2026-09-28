/**
 * Wiring for allwyn-api.html: file -> board -> DealRunner -> GameState -> render.
 *
 * allwyn.main.js wires a websocket to the gameserver. This page has no
 * gameserver: it reads a deal from a .pbn or .lin file and has BEN bid and play
 * through the REST API in gameapi.py (see README-api.md and
 * WEBSITE-INTEGRATION.md) - all four seats, or all but the one you choose to
 * play. The renderer and GameState are the websocket UI's, unchanged;
 * DealRunner speaks their message format.
 */

import { Card, parseContract } from './allwyn.model.js';
import { GameState } from './allwyn.state.js';
import { collectDom, render, appendCall, appendSuitText } from './allwyn.render.js';
import { initTheme } from './allwyn.theme.js';
import { parseDealFile } from './allwyn.dealfile.js';
import {
    BenApi, DealRunner, reviewDecisions, playBenVersion, compareResults,
} from './allwyn.api.js';

const SEAT_NAMES = ['North', 'East', 'South', 'West'];
const SUIT_PIPS = { S: '♠', H: '♥', D: '♦', C: '♣' };
const API_KEY = 'allwyn.apiBase';
const SEAT_KEY = 'allwyn.apiSeat';
const TRICK_PAUSE_MS = 1200;

const $ = (sel) => document.querySelector(sel);
const dom = collectDom();
const ui = {
    file: $('#deal-file'),
    board: $('#board-select'),
    api: $('#api-base'),
    tournament: $('#tournament'),
    seat: $('#human-seat'),
    pace: $('#pace'),
    play: $('#play-button'),
    step: $('#step-button'),
    restart: $('#restart-button'),
    progress: $('#progress'),
    compare: $('#compare'),
    compareStatus: $('#compare-status'),
    compareResult: $('#compare-result'),
    compareDecisions: $('#compare-decisions'),
    log: $('#play-log'),
    logList: $('#play-log-list'),
};

// humanSeats is set from the "You play" box each time a board is loaded.
const state = new GameState({
    humanSeats: [false, false, false, false],
    noHuman: true,
    allVisible: true,
    autoplay: false,
    timeoutSeconds: 0,
});
state.connection = { status: 'idle', detail: 'Choose a .pbn or .lin file, pick a board, then Play hand.' };
state.subscribe(() => render(state, dom));

/**
 * Which hands are on show. GameState's own rule is written for the
 * gameserver, which never sends the hands a player may not see; here the
 * browser holds all four, so the rule has to be strict: with nobody playing,
 * every hand; otherwise your own, dummy once the lead is made, and the lot
 * when the deal is over.
 */
state.updateRevealed = () => {
    const human = humanSeat();
    if (human < 0 || !runner || runner.done) {
        state.revealed = new Set([0, 1, 2, 3]);
        return;
    }
    const shown = new Set([human]);
    if (state.deal?.dummy !== undefined) shown.add(state.deal.dummy);
    state.revealed = shown;
};

/** The seat index you play, or -1 for none. */
function humanSeat() {
    return 'NESW'.indexOf(ui.seat.value || '-');
}

let boards = [];
let runner = null;
let running = false;          // playing continuously, as opposed to stepping
let driving = false;          // drive() is running, perhaps paused between steps
let generation = 0;           // bumped on restart, so a stale request is ignored
let compared = false;         // the comparison with BEN has been started for this deal

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

// ?seat=S in the URL, else the last choice, else nobody.
{
    const fromQuery = (new URLSearchParams(window.location.search).get('seat') || '').toUpperCase();
    let saved = '';
    try { saved = localStorage.getItem(SEAT_KEY) || ''; } catch (_) { /* private mode */ }
    const seat = 'NESW'.includes(fromQuery) && fromQuery ? fromQuery : saved;
    if ([...ui.seat.options].some((o) => o.value === seat)) ui.seat.value = seat;
}
// A different seat is a different game: start the board again.
ui.seat.addEventListener('change', () => {
    try { localStorage.setItem(SEAT_KEY, ui.seat.value); } catch (_) { /* nothing to keep it in */ }
    loadBoard();
});
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
    driving = false;

    const human = humanSeat();
    state.options.humanSeats = [0, 1, 2, 3].map((seat) => seat === human);
    state.options.noHuman = human < 0;
    state.expectBidInput = false;
    state.expectCardInput = false;
    state.selectedLevel = null;
    if (dom.bidding) dom.bidding.hidden = human < 0;

    runner = new DealRunner(board, makeApi(), {
        emit: (message) => state.apply(message),
        log: addLogEntry,
        humanSeats: human < 0 ? [] : [human],
    });
    state.pendingTrick = null;
    state.showLastTrick = false;
    state.expectTrickConfirm = false;
    ui.logList.replaceChildren();
    ui.log.hidden = true;
    compared = false;
    ui.compare.hidden = true;
    ui.compareStatus.textContent = '';
    ui.compareResult.replaceChildren();
    ui.compareDecisions.replaceChildren();

    runner.step();     // 'start' is synchronous: deals the cards, asks nothing
    promptIfYourTurn();
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
 * Take steps until paused or done - or just one, for Step. A failed
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
            // Waiting for you is not a pause: after your call or card, BEN
            // carries on if it was playing on its own before.
            if (!runner?.turn?.human || runner.done) running = false;
            promptIfYourTurn();
            paintControls();
            if (runner?.done && humanSeat() >= 0 && !compared) compareWithBen();
        }
    }
}

/** Offer the bidding box or your cards as soon as it is your turn, even between Steps. */
function promptIfYourTurn() {
    if (runner && !runner.done && runner.turn?.human && !state.expectBidInput && !state.expectCardInput) {
        runner.step();     // no request: it only tells GameState to take your input
    }
}

/** After your call or card BEN carries on by itself; Pause still stops it. */
function afterInput() {
    running = true;
    paintControls();
    if (!driving) drive();
}

async function takeSteps(mine) {
    do {
        // A finished trick stays on the table until the next card is asked for.
        if (state.pendingTrick) {
            state.pendingTrick = null;
            state.expectTrickConfirm = false;
        }
        state.busy = true;
        setStatus('open', '');
        paintControls(whoIsNext());

        let outcome;
        try {
            outcome = await runner.step();
        } catch (error) {
            if (mine !== generation) return;
            state.busy = false;
            setStatus('error', error.message);
            return;
        }
        if (mine !== generation) return;
        state.busy = false;
        paintControls();
        state.notify();

        if (runner.done || outcome.kind === 'input') break;
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
    const turn = runner?.turn;
    if (turn?.human) return '';
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
    // Only once the page is taking your input - not while the last trick is
    // still on show, when a click on a card would do nothing.
    const yourTurn = Boolean(runner?.turn?.human) && (state.expectBidInput || state.expectCardInput);
    ui.step.disabled = !ready || done || driving || yourTurn;
    ui.restart.disabled = !ready;
    ui.board.disabled = boards.length === 0;

    if (!runner) {
        ui.progress.textContent = '';
    } else if (yourTurn && !done) {
        ui.progress.textContent = yourTurnText(runner.turn);
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

function yourTurnText({ seat, need }) {
    if (need === 'bid') return 'Your call.';
    if (runner.phase === 'lead') return 'Your lead.';
    return seat === runner.dummy ? 'Your play - from dummy.' : 'Your play.';
}

function setStatus(status, detail) {
    state.setConnection(status, detail);
}

/* ------------------------------------------------------------ comparison */

/**
 * Once a deal you played is over: what BEN would have done at each of your
 * decisions, then the whole board again with BEN at all four seats, scored
 * against yours. Both are plain API calls on positions the page already has.
 */
async function compareWithBen() {
    compared = true;
    const mine = generation;
    const cancelled = () => mine !== generation;
    const played = runner;
    const seat = humanSeat();
    const api = played.api;

    ui.compare.hidden = false;
    const status = (text) => { if (!cancelled()) ui.compareStatus.textContent = text; };

    status('Asking BEN about your decisions...');
    const review = await reviewDecisions(played, api, {
        isCancelled: cancelled,
        onProgress: (done, total) => status(`Asking BEN about your decisions: ${done} of ${total}...`),
    });
    if (cancelled()) return;
    renderDecisions(review, played);

    status("Playing the board with BEN at all four seats...");
    let ben;
    try {
        ben = await playBenVersion(played.board, api, {
            isCancelled: cancelled,
            onStep: (_, r) => status(r.phase === 'bidding'
                ? "BEN's table: bidding..."
                : `BEN's table: trick ${Math.min(r.tricks.length + 1, 13)} of 13...`),
        });
    } catch (error) {
        status(`Could not play BEN's version: ${error.message}`);
        return;
    }
    if (cancelled() || !ben) return;
    renderTables(played, ben, seat);
    status('');
}

/** Your table and BEN's side by side: contract, tricks, score, and the auctions. */
function renderTables(yours, bens, seat) {
    const cmp = compareResults(yours.result, bens.result, seat);
    const table = document.createElement('table');
    const head = table.createTHead().insertRow();
    for (const text of ['', 'You', 'BEN']) {
        const th = document.createElement('th');
        th.textContent = text;
        head.appendChild(th);
    }
    const body = table.createTBody();
    const row = (label, fill) => {
        const tr = body.insertRow();
        const th = document.createElement('th');
        th.textContent = label;
        tr.appendChild(th);
        for (const runner of [yours, bens]) {
            const td = tr.insertCell();
            fill(td, runner);
        }
    };
    row('Contract', (td, r) => appendContract(td, r.result.contract));
    row("Declarer's tricks", (td, r) => {
        td.className = 'num';
        td.textContent = r.contract ? String(r.result.tricks_taken) : '-';
    });
    row('Score', (td, r) => {
        td.className = 'num';
        td.textContent = signed((r.result.score ?? 0) * (seat % 2 === 0 ? 1 : -1));
    });

    const verdict = document.createElement('p');
    verdict.className = 'compare-verdict';
    if (cmp.diff === 0) {
        verdict.textContent = 'Same score as BEN.';
    } else {
        verdict.classList.add(cmp.diff > 0 ? 'better' : 'worse');
        verdict.textContent = `${cmp.diff > 0 ? 'Better' : 'Worse'} than BEN by ${Math.abs(cmp.diff)} points`
            + ` (${signed(cmp.imps)} IMP${Math.abs(cmp.imps) === 1 ? '' : 's'}).`;
    }

    ui.compareResult.replaceChildren(
        table, verdict,
        auctionLine('You', yours.auction, bens.auction, yours.dealer),
        auctionLine('BEN', bens.auction, yours.auction, yours.dealer),
    );
}

function signed(n) {
    return n > 0 ? `+${n}` : String(n);
}

/** "4♥X by South", or "Passed out". */
function appendContract(parent, contract) {
    const c = parseContract(contract);
    if (!c) {
        parent.textContent = 'Passed out';
        return;
    }
    appendCall(parent, `${c.level}${c.strain}`);
    parent.appendChild(document.createTextNode(`${c.doubling} by ${SEAT_NAMES['NESW'.indexOf(c.declarer)]}`));
}

/** One table's calls in order, marking where they part from the other's. */
function auctionLine(label, calls, other, dealer) {
    const p = document.createElement('p');
    p.className = 'compare-auction';
    const name = document.createElement('span');
    name.className = 'label';
    name.textContent = `${label}:`;
    p.appendChild(name);
    calls.forEach((call, i) => {
        const span = document.createElement('span');
        span.className = call === other[i] ? 'call' : 'call differs';
        span.title = `${SEAT_NAMES[(dealer + i) % 4]}${call === other[i] ? '' : ' - differs'}`;
        appendCall(span, call === 'PASS' ? 'Pass' : call);
        p.append(span, ' ');         // somewhere for a long auction to wrap
    });
    return p;
}

/** How often you did what BEN would have, and each place you did not. */
function renderDecisions(review, played) {
    const choices = review.filter((d) => !d.forced && !d.error);
    const agreed = choices.filter((d) => d.same).length;
    const forced = review.filter((d) => d.forced).length;
    const failed = review.filter((d) => d.error).length;

    const summary = document.createElement('p');
    summary.className = 'compare-summary';
    summary.textContent = `You made the same choice as BEN ${agreed} of ${choices.length} times`
        + (forced ? ` (${forced} forced card${forced === 1 ? '' : 's'} not counted)` : '')
        + (failed ? `; ${failed} could not be checked` : '')
        + '.';

    const list = document.createElement('ol');
    let callNumber = 0;
    for (const d of review) {
        if (d.kind === 'bid') callNumber += 1;
        if (d.same || d.forced) continue;

        const item = document.createElement('li');
        const where = document.createElement('span');
        where.className = 'where';
        where.textContent = d.kind === 'bid'
            ? `Your call ${callNumber}`
            : d.index === 0
                ? 'Opening lead'
                : `Trick ${Math.floor(d.index / 4) + 1}${d.seat === played.dummy ? ', from dummy' : ''}`;
        item.appendChild(where);

        const yours = document.createElement('span');
        yours.className = 'yours';
        appendAction(yours, d);
        item.append(document.createTextNode('You '), yours);

        if (d.error) {
            item.appendChild(document.createTextNode(` - BEN could not say (${d.error})`));
        } else {
            const bens = document.createElement('span');
            bens.className = 'bens';
            appendAction(bens, { ...d, action: d.ben });
            item.append(document.createTextNode(', BEN '), bens);
            const why = document.createElement('span');
            why.className = 'why';
            if (d.explanation) appendSuitText(why, d.explanation);
            else if (d.who) why.textContent = d.who;
            if (why.childNodes.length) item.appendChild(why);
        }
        list.appendChild(item);
    }
    ui.compareDecisions.replaceChildren(summary, ...(list.children.length ? [list] : []));
}

function appendAction(parent, { kind, action }) {
    if (kind === 'bid') appendCall(parent, action === 'PASS' ? 'Pass' : action);
    else appendCard(parent, action);
}

/** "♠10" as nodes, the pip coloured. */
function appendCard(parent, card) {
    const suit = card[0];
    const pip = document.createElement('span');
    pip.className = suit === 'H' || suit === 'D' ? 'suit red' : 'suit';
    pip.textContent = SUIT_PIPS[suit];
    parent.append(pip, document.createTextNode(card[1] === 'T' ? '10' : card[1]));
}

/* ------------------------------------------------------------ your turn */

/**
 * Bidding box, as in allwyn.main.js: a level reveals the strains still legal,
 * then a strain, PASS, X or XX makes the call.
 */
dom.bidding?.addEventListener('click', (event) => {
    const target = event.target;
    if (!state.expectBidInput || target.classList.contains('invalid')) return;

    if (target.dataset.level) {
        state.selectedLevel = Number(target.dataset.level);
        state.notify();
        return;
    }
    const symbol = target.getAttribute('symbol');
    if (symbol) {
        if (state.selectedLevel !== null) makeCall(`${state.selectedLevel}${symbol}`);
        return;
    }
    const text = target.textContent?.trim();
    if (text === 'Hint') showHint();
    else if (['PASS', 'X', 'XX'].includes(text)) makeCall(text);
});

async function makeCall(call) {
    const turn = runner?.turn;
    if (!turn?.human || turn.need !== 'bid') return;
    state.expectBidInput = false;
    state.selectedLevel = null;
    state.busy = true;
    state.notify();

    // What the call shows, for the explanations panel. A failure here only
    // costs the explanation, not the call.
    let explanation = '';
    const mine = generation;
    try {
        const response = await runner.api.explain({
            seat: SEAT_NAMES[turn.seat][0],
            dealer: runner.board.dealer,
            vul: runner.board.vul,
            auction: [...runner.auction, call],
        });
        explanation = response.explanation ?? '';
    } catch (_) { /* leave it blank */ }
    if (mine !== generation) return;

    state.busy = false;
    try {
        runner.submitCall(call, explanation);
    } catch (error) {
        state.expectBidInput = true;
        showNotice(error.message);
    }
    state.notify();
    afterInput();
}

/** Clicking one of your cards - or dummy's, when you declare - plays it. */
function onCardActivate(event) {
    const element = event.target.closest('.card');
    if (!element || !runner?.turn?.human || runner.turn.need !== 'card') return;
    const card = new Card(element.getAttribute('symbol'));
    if (!state.canPlay(card)) return;
    // Clear the last trick off the table, or your card would land under it.
    state.pendingTrick = null;
    state.expectTrickConfirm = false;
    try {
        runner.submitCard(card.symbol);
    } catch (error) {
        showNotice(error.message);
        return;
    }
    state.expectCardInput = false;
    state.notify();
    afterInput();
}

document.body.addEventListener('click', onCardActivate);
document.body.addEventListener('keydown', (event) => {
    if ((event.key === 'Enter' || event.key === ' ') && event.target.classList?.contains('card')) {
        event.preventDefault();
        onCardActivate(event);
    }
});

/** BEN's choice for your seat, with what it considered. */
async function showHint() {
    const turn = runner?.turn;
    if (!turn?.human || turn.need !== 'bid') return;
    state.busy = true;
    state.notify();
    let response;
    try {
        response = await runner.api.bid({
            hand: runner.board.hands[turn.seat],
            seat: 'NESW'[turn.seat],
            dealer: runner.board.dealer,
            vul: runner.board.vul,
            auction: runner.auction,
        });
    } catch (error) {
        showNotice(error.message);
        return;
    } finally {
        state.busy = false;
        state.notify();
    }

    const dialog = $('#hint-dialog');
    const body = $('#hint-body');
    if (!dialog || !body) return;
    body.replaceChildren();
    const suggestion = document.createElement('p');
    suggestion.appendChild(document.createTextNode('BEN suggests: '));
    appendCall(suggestion, response.bid);
    body.appendChild(suggestion);
    if (response.explanation) {
        const explanation = document.createElement('p');
        appendSuitText(explanation, response.explanation);
        body.appendChild(explanation);
    }
    if (response.candidates?.length) {
        const heading = document.createElement('p');
        heading.textContent = 'BEN considered:';
        const list = document.createElement('ul');
        for (const candidate of response.candidates) {
            const item = document.createElement('li');
            appendCall(item, candidate.call);
            item.appendChild(document.createTextNode(` - score ${candidate.insta_score}`));
            list.appendChild(item);
        }
        body.append(heading, list);
    }
    dialog.showModal();
}

function showNotice(text, ms = 4000) {
    const el = $('#notice');
    if (!el) return;
    el.textContent = text;
    el.hidden = false;
    clearTimeout(showNotice.timer);
    showNotice.timer = setTimeout(() => { el.hidden = true; }, ms);
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
        appendCard(action, entry.action);
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
