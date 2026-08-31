/**
 * Wiring: socket -> state -> render, and user input -> socket.
 *
 * Everything specific to this page lives here. The modules it pulls in have no
 * knowledge of each other's concerns: the model knows bridge rules, the state
 * knows the game, the renderer knows the DOM, the socket knows the wire.
 */

import { Card } from './allwyn.model.js';
import { OUTBOUND, readOptions, buildQueryString } from './allwyn.protocol.js';
import { GameSocket, gameServerUrl } from './allwyn.socket.js';
import { GameState } from './allwyn.state.js';
import { collectDom, render, renderClaimOptions, appendSuitText, appendCall } from './allwyn.render.js';
import { initTheme } from './allwyn.theme.js';

const options = readOptions();
const dom = collectDom();
const state = new GameState(options);

let trickTimer = null;
let pendingDealRecord = null;

document.querySelector('#result-continue')?.addEventListener('click', (event) => {
    event.stopPropagation();
    state.result = null;                 // take the summary off the felt
    state.notify();
    openFeedbackDialog(pendingDealRecord);
});

initTheme(document.querySelector('#theme-toggle'));

/* Show/hide the auction panel on the felt. The explanations have their own
   button below.
   Labelled with what clicking it does, as the theme button is, and remembered
   between deals. */
const auctionToggle = document.querySelector('#auction-toggle');
const AUCTION_KEY = 'allwyn.auctionHidden';

function paintAuctionToggle() {
    if (!auctionToggle) return;
    auctionToggle.textContent = state.auctionHidden ? 'Show Auction' : 'Hide Auction';
    auctionToggle.setAttribute('aria-pressed', String(state.auctionHidden));
    auctionToggle.setAttribute('aria-label',
        state.auctionHidden ? 'Show the auction panel' : 'Hide the auction panel');
}

try {
    state.auctionHidden = localStorage.getItem(AUCTION_KEY) === '1';
} catch (_) { /* private mode: start with it shown */ }
paintAuctionToggle();

auctionToggle?.addEventListener('click', (event) => {
    event.stopPropagation();          // don't also acknowledge a finished trick
    state.auctionHidden = !state.auctionHidden;
    try {
        if (state.auctionHidden) localStorage.setItem(AUCTION_KEY, '1');
        else localStorage.removeItem(AUCTION_KEY);
    } catch (_) { /* nothing to remember it with */ }
    paintAuctionToggle();
    state.notify();
});

/* The same again for the bid explanations, on their own button. */
const helpToggle = document.querySelector('#help-toggle');
const HELP_KEY = 'allwyn.helpHidden';

function paintHelpToggle() {
    if (!helpToggle) return;
    helpToggle.textContent = state.helpHidden ? 'Show Help' : 'Hide Help';
    helpToggle.setAttribute('aria-pressed', String(state.helpHidden));
    helpToggle.setAttribute('aria-label',
        state.helpHidden ? 'Show the bid explanations' : 'Hide the bid explanations');
}

try {
    state.helpHidden = localStorage.getItem(HELP_KEY) === '1';
} catch (_) { /* private mode: start with it shown */ }
paintHelpToggle();

helpToggle?.addEventListener('click', (event) => {
    event.stopPropagation();          // don't also acknowledge a finished trick
    state.helpHidden = !state.helpHidden;
    try {
        if (state.helpHidden) localStorage.setItem(HELP_KEY, '1');
        else localStorage.removeItem(HELP_KEY);
    } catch (_) { /* nothing to remember it with */ }
    paintHelpToggle();
    state.notify();
});

const socket = new GameSocket(
    gameServerUrl(options, buildQueryString(options)),
    {
        onMessage: (message) => handle(message),
        onStatus: (status, detail) => state.setConnection(status, detail),
    },
);

state.subscribe(() => render(state, dom));

function handle(message) {
    for (const effect of state.apply(message)) {
        switch (effect.type) {
            case 'hint':
                showHint(effect.bids);
                break;
            case 'alert-toggled':
                showNotice(effect.armed ? 'Your bid will be alerted.' : 'Your bid will NOT be alerted.');
                break;
            case 'claim-rejected':
                showNotice('Claim rejected.');
                break;
            case 'claim-accepted':
                showNotice('Claim accepted.');
                break;
            case 'schedule-trick-confirm':
                clearTimeout(trickTimer);
                trickTimer = setTimeout(confirmTrick, Math.max(0, effect.seconds) * 1000);
                break;
            case 'score-needed':
                fetchScore(effect);
                break;
            case 'deal-end':
                // Show the result and stop there. The feedback dialog, and the
                // navigation that follows it, wait for the player to continue.
                pendingDealRecord = effect.dict;
                break;
        }
    }
}

/* ---------------------------------------------------------------- messages */

/**
 * Transient in-page notice. bridge.html uses alert() here, which freezes the
 * game loop until the player dismisses it and cannot be closed by the page.
 */
function showNotice(text, ms = 4000) {
    const el = dom.root.querySelector('#notice');
    if (!el) return;
    el.textContent = text;
    el.hidden = false;
    clearTimeout(showNotice.timer);
    showNotice.timer = setTimeout(() => { el.hidden = true; }, ms);
}

function showHint(bids) {
    const dialog = dom.root.querySelector('#hint-dialog');
    const body = dom.root.querySelector('#hint-body');
    if (!dialog || !body) return;

    body.replaceChildren();
    const suggestion = document.createElement('p');
    suggestion.appendChild(document.createTextNode('BEN suggests: '));
    appendCall(suggestion, bids.bid);
    body.appendChild(suggestion);

    if (bids.explanation) {
        const explanation = document.createElement('p');
        appendSuitText(explanation, bids.explanation);
        body.appendChild(explanation);
    }

    if (bids.candidates?.length) {
        const heading = document.createElement('p');
        heading.textContent = 'BEN considered:';
        body.appendChild(heading);

        const list = document.createElement('ul');
        for (const candidate of bids.candidates) {
            const item = document.createElement('li');
            appendCall(item, candidate.call);
            item.appendChild(document.createTextNode(` - score ${candidate.insta_score}`));
            list.appendChild(item);
        }
        body.appendChild(list);
    }
    dialog.showModal();
}

/**
 * Score a claimed or conceded deal through the server, which has scoring.py.
 * Failure is quiet: the result panel simply shows no score, which is what it
 * would have shown anyway.
 */
async function fetchScore({ contract, vulnerable, tricks }) {
    try {
        const query = new URLSearchParams({
            contract,
            vul: vulnerable ? '1' : '0',
            tricks: String(tricks),
        });
        const response = await fetch(`/api/score?${query}`);
        if (!response.ok) throw new Error(`server said ${response.status}`);
        const data = await response.json();
        if (state.result && Number.isFinite(data.score)) {
            state.result.score = data.score;
            state.notify();
        }
    } catch (error) {
        console.warn('Could not score the claimed deal:', error);
    }
}

/* ------------------------------------------------------------ user actions */

function send(payload) {
    return socket.send(payload);
}

function confirmTrick() {
    if (!state.expectTrickConfirm) return;
    state.expectTrickConfirm = false;
    state.pendingTrick = null;          // clear the trick off the table
    state.showLastTrick = false;
    state.busy = true;
    clearTimeout(trickTimer);
    if (send(OUTBOUND.confirmTrick())) state.notify();
}

// Clicking anywhere acknowledges a finished trick, as in bridge.html.
document.body.addEventListener('click', confirmTrick);

function onCardActivate(event) {
    const element = event.target.closest('.card');
    if (!element) return;
    const card = new Card(element.getAttribute('symbol'));
    if (!state.canPlay(card)) return;
    if (send(OUTBOUND.card(card.symbol))) {
        state.expectCardInput = false;
        state.busy = true;
        state.notify();
    }
}

// One delegated listener instead of re-binding every card after each render.
document.body.addEventListener('click', onCardActivate);
document.body.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
        if (event.target.classList?.contains('card')) {
            event.preventDefault();
            onCardActivate(event);
        }
    }
});

/** Bidding box: levels reveal the strains that are still legal. */
dom.bidding?.addEventListener('click', (event) => {
    const target = event.target;
    if (!state.expectBidInput || target.classList.contains('invalid')) return;

    if (target.dataset.level) {
        // Record the choice and re-render; the renderer reveals the strain row
        // and greys out the strains too low to be a legal call.
        state.selectedLevel = Number(target.dataset.level);
        state.notify();
        return;
    }

    const symbol = target.getAttribute('symbol');
    if (symbol) {
        if (state.selectedLevel === null) return;
        if (send(OUTBOUND.bid(`${state.selectedLevel}${symbol}`))) {
            state.expectBidInput = false;
            state.selectedLevel = null;
            state.busy = true;
            state.notify();
        }
        return;
    }

    const text = target.textContent?.trim();
    if (!text) return;
    if (text === 'Hint') {
        if (send(OUTBOUND.hint())) { state.busy = true; state.notify(); }
    } else if (text === 'Alert') {
        send(OUTBOUND.toggleAlert());
    } else if (['PASS', 'X', 'XX'].includes(text)) {
        if (send(OUTBOUND.bid(text))) {
            state.expectBidInput = false;
            state.selectedLevel = null;
            state.busy = true;
            state.notify();
        }
    }
});

dom.lastTrick?.addEventListener('click', (event) => {
    event.stopPropagation();
    state.showLastTrick = true;
    state.notify();
});

dom.claim?.addEventListener('click', (event) => {
    event.stopPropagation();
    renderClaimOptions(state, dom);
});

dom.claimTricks?.addEventListener('click', (event) => {
    event.stopPropagation();
    const tricks = event.target.getAttribute('tricks');
    if (tricks !== null) send(OUTBOUND.claim(tricks));
});

dom.concede?.addEventListener('click', (event) => {
    event.stopPropagation();
    send(OUTBOUND.concede());
});

/* ------------------------------------------------------- end-of-deal dialog */

function openFeedbackDialog(dict) {
    const dialog = dom.dialog;
    if (!dialog) return;
    dialog.returnValue = '';
    dialog.showModal();

    dialog.addEventListener('close', () => {
        const quality = dialog.returnValue;
        if (!quality || quality === 'nosave') {
            navigateOn();
            return;
        }
        saveDeal(dict, dom.comment?.value ?? '', quality).finally(navigateOn);
    }, { once: true });
}

async function saveDeal(dict, feedback, quality) {
    try {
        const response = await fetch('/api/save/deal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...dict, feedback, quality }),
        });
        if (!response.ok) throw new Error(`server said ${response.status}`);
    } catch (error) {
        console.error('Could not save the deal:', error);
        showNotice(`Could not save the deal: ${error.message}`);
    }
}

function navigateOn() {
    const home = options.play ? '/play' : '/home';
    if (!options.continuous) {
        window.location.href = home;
        return;
    }
    const url = new URL(window.location.href);
    const boardNo = url.searchParams.get('board_no');
    if (boardNo) {
        url.searchParams.set('board_no', String(Number(boardNo) + 1));
        window.location.href = url.href;
    } else {
        window.location.href = home;
    }
}

/* ------------------------------------------------------------------- start */

render(state, dom);
socket.connect();
