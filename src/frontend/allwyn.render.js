/**
 * Rendering - state in, DOM out.
 *
 * One entry point, `render(state, dom)`, called after every state change. It
 * builds nodes with the DOM API rather than string concatenation, so a hand or
 * an explanation containing markup characters cannot rewrite the page. The
 * element ids and class names match style.css, which is shared with bridge.html.
 */

import { SEATS, vulnerabilityLabel, scoreLine } from './allwyn.model.js';

const SUIT_ENTITIES = ['♠', '♥', '♦', '♣']; // S H D C
const SEAT_LABELS = ['.label-north', '.label-east', '.label-south', '.label-west'];

/** Cache the elements we touch; ids come from allwyn.html. */
export function collectDom(root = document) {
    const $ = (sel) => root.querySelector(sel);
    return {
        root,
        hands: SEATS.map((seat) => $(`#${seat}`)),
        trickSlots: SEATS.map((seat) => $(`.trick-${seat}`)),
        seatLabels: SEAT_LABELS.map((sel) => $(`${sel} .seat-label`)),
        boardNumber: $('.label-number'),
        vuln: $('#vuln'),
        result: $('#result'),
        resultContract: $('#result-contract'),
        resultOutcome: $('#result-outcome'),
        resultScore: $('#result-score'),
        auction: $('#auction-container'),
        auctionPanel: $('#auction-main'),
        bidding: $('#bidding'),
        tricks: $('.tricks'),
        lastTrick: $('#last-trick'),
        claim: $('#claim'),
        claimTricks: $('#claim-tricks'),
        concede: $('#conceed'),
        explain: $('#explain'),
        status: $('#status'),
        loader: $('#loader'),
        dialog: $('#feedback-dialog'),
        comment: $('#commentInput'),
    };
}

function clear(element) {
    if (element) element.replaceChildren();
}

function cardElement(card) {
    const el = document.createElement('div');
    el.className = card.isRed ? 'card red' : 'card';
    el.dataset.value = card.rank;
    el.setAttribute('symbol', card.symbol);
    el.textContent = SUIT_ENTITIES[card.suit];
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.setAttribute('aria-label', `${card.rank} of ${['spades', 'hearts', 'diamonds', 'clubs'][card.suit]}`);
    return el;
}

/** Which hands the player may see - decided in GameState.updateRevealed(). */
function handIsVisible(state, seat) {
    return state.revealed.has(seat);
}

function renderHands(state, dom) {
    const { deal } = state;
    deal.hands.forEach((hand, seat) => {
        const element = dom.hands[seat];
        if (!element) return;

        if (!handIsVisible(state, seat)) {
            element.style.visibility = 'hidden';
            return;
        }

        element.style.visibility = 'visible';
        clear(element);

        // Trumps to the left, as in bridge.js Hand.render.
        let order = [0, 1, 3, 2];
        if (deal.strain === 2) order = [1, 0, 3, 2];
        if (deal.strain === 3) order = [2, 0, 1, 3];
        if (deal.strain === 4) order = [3, 1, 0, 2];

        for (const suitIndex of order) {
            const container = document.createElement('div');
            container.style.display = 'flex';
            if (hand.suits[suitIndex].length === 0) container.classList.add('empty-suit');
            else hand.suits[suitIndex].forEach((card) => container.appendChild(cardElement(card)));
            element.appendChild(container);
        }
        hand.rendered = true;
    });
}

function renderTrick(state, dom) {
    // Priority: a finished trick waiting to be acknowledged, then the trick the
    // player asked to see again, then the one in progress.
    const trick = state.pendingTrick
        ?? (state.showLastTrick ? state.deal.tricks[state.deal.tricks.length - 1] : state.deal.currentTrick);

    dom.trickSlots.forEach((slot) => {
        if (!slot) return;
        clear(slot);
        slot.style.visibility = 'visible';
    });
    if (!trick) return;
    for (let seat = trick.leadPlayer, i = 0; i < trick.cards.length; seat = (seat + 1) % 4, i++) {
        dom.trickSlots[seat]?.appendChild(cardElement(trick.cards[i]));
    }
}

function formatCall(call) {
    const span = document.createElement('span');
    if (!call || call === 'PASS' || call === 'X' || call === 'XX') {
        span.textContent = call === 'PASS' ? 'P' : (call ?? '');
        return span;
    }
    const strain = call[1];
    span.textContent = call[0];
    const symbol = document.createElement('span');
    if (strain === 'N') {
        symbol.textContent = 'NT';
    } else {
        const index = 'SHDC'.indexOf(strain);
        symbol.textContent = SUIT_ENTITIES[index];
        if (index === 1 || index === 2) symbol.className = 'red';
    }
    span.appendChild(symbol);
    return span;
}

function renderAuction(state, dom) {
    const auction = state.deal.auctionModel;
    clear(dom.auction);

    const wrapper = document.createElement('div');
    wrapper.id = 'auction';
    const table = document.createElement('table');

    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    ['West', 'North', 'East', 'South'].forEach((seat, i) => {
        const th = document.createElement('th');
        th.textContent = seat;
        // North/South share vulnerability, as do East/West.
        if (auction.vuln[i % 2 === 0 ? 1 : 0]) th.className = 'red';
        headRow.appendChild(th);
    });
    head.appendChild(headRow);
    table.appendChild(head);

    const body = document.createElement('tbody');
    let row;
    auction.paddedBids.forEach((call, i) => {
        if (i % 4 === 0) {
            row = document.createElement('tr');
            body.appendChild(row);
        }
        const cell = document.createElement('td');
        cell.appendChild(formatCall(call));
        if (call) {
            cell.dataset.call = call;
            cell.dataset.index = String(i);
        }
        row.appendChild(cell);
    });
    table.appendChild(body);
    wrapper.appendChild(table);
    dom.auction.appendChild(wrapper);

    // The panel is only as tall as the clear middle of the felt, so a long
    // auction scrolls - keep the most recent calls in view.
    const panel = dom.auctionPanel;
    if (panel) panel.scrollTop = panel.scrollHeight;
}

function renderBiddingBox(state, dom) {
    clear(dom.bidding);
    // Reserved through the auction so the box appearing and disappearing between
    // turns does not shift the table; released once the contract is settled.
    dom.bidding?.classList.toggle('done', state.auctionOver);
    if (!state.expectBidInput) return;

    const auction = state.deal.auctionModel;
    const box = document.createElement('div');
    box.id = 'bidding-box';

    const levels = document.createElement('div');
    levels.id = 'bidding-levels';
    const minLevel = auction.getMinimumBiddableLevel();
    for (let level = 1; level <= 7; level++) {
        const el = document.createElement('div');
        el.textContent = String(level);
        if (level < minLevel) el.classList.add('invalid');
        else el.dataset.level = String(level);
        if (state.selectedLevel === level) el.classList.add('selected');
        levels.appendChild(el);
    }
    box.appendChild(levels);

    // Always on screen, so it is obvious a bid is level-then-strain. Until a
    // level is picked they are all inactive; after that, only the strains too
    // low to be a legal call stay greyed out. (bridge.html hides the row
    // entirely until a level is clicked, which reads as "there are no suit
    // buttons".)
    const suits = document.createElement('div');
    suits.id = 'bidding-suits';
    [
        ['bid-clubs', 'C', SUIT_ENTITIES[3], false],
        ['bid-diamonds', 'D', SUIT_ENTITIES[2], true],
        ['bid-hearts', 'H', SUIT_ENTITIES[1], true],
        ['bid-spades', 'S', SUIT_ENTITIES[0], false],
        ['bid-nt', 'N', 'NT', false],
    ].forEach(([className, symbol, glyph, red]) => {
        const el = document.createElement('div');
        el.className = red ? `${className} red` : className;
        el.setAttribute('symbol', symbol);
        el.textContent = glyph;
        suits.appendChild(el);
    });
    const minStrain = state.selectedLevel === null
        ? suits.children.length                                   // nothing selected: all inactive
        : auction.getMinBiddableSuitForLevel(state.selectedLevel);
    [...suits.children].forEach((el, i) => {
        if (i < minStrain) el.classList.add('invalid');
    });
    suits.classList.toggle('awaiting-level', state.selectedLevel === null);

    const calls = document.createElement('div');
    calls.id = 'bidding-calls';
    const addCall = (className, text, enabled = true) => {
        const el = document.createElement('div');
        el.className = enabled ? className : `${className} invalid`;
        el.textContent = text;
        calls.appendChild(el);
    };
    addCall('pass', 'PASS');
    addCall('double', 'X', state.deal.canDouble);
    addCall('redouble', 'XX', state.deal.canRedouble);
    addCall('alert', 'Alert');
    addCall('hint', 'Hint');
    box.appendChild(calls);
    box.appendChild(suits);

    dom.bidding.appendChild(box);
}

function renderSeatLabels(state, dom) {
    const { deal } = state;
    dom.seatLabels.forEach((label, seat) => {
        if (!label) return;
        label.classList.toggle('turn', deal.turn === seat);
        label.classList.toggle('dealer', deal.dealer === seat);
        label.classList.toggle('red', deal.vuln[seat % 2 === 0 ? 0 : 1]);
    });
}

/**
 * Append text, turning BBA's suit tokens into pips: "3+!C" -> "3+♣".
 * Built as nodes rather than markup, so the server's text is never parsed as
 * HTML.
 */
export function appendSuitText(parent, text) {
    // split() with a capture group alternates text, letter, text, letter...
    String(text).split(/!([CDHS])/).forEach((part, i) => {
        if (i % 2 === 1) {
            const index = 'SHDC'.indexOf(part);
            const pip = document.createElement('span');
            pip.className = index === 1 || index === 2 ? 'suit red' : 'suit';
            pip.textContent = SUIT_ENTITIES[index];
            pip.setAttribute('aria-label', ['spades', 'hearts', 'diamonds', 'clubs'][index]);
            parent.appendChild(pip);
        } else if (part) {
            parent.appendChild(document.createTextNode(part));
        }
    });
}

/** The call a line is about: "1D" -> "1♦", but PASS/X/XX left as words. */
export function appendCall(parent, call) {
    const bid = /^([1-7])([CDHSN])$/.exec(call ?? '');
    if (!bid) {
        parent.appendChild(document.createTextNode(call ?? ''));
        return;
    }
    parent.appendChild(document.createTextNode(bid[1]));
    if (bid[2] === 'N') {
        parent.appendChild(document.createTextNode('NT'));
    } else {
        appendSuitText(parent, `!${bid[2]}`);
    }
}

/** The end-of-deal summary: contract, who played it, and how it went. */
function renderResult(state, dom) {
    if (!dom.result) return;
    dom.result.hidden = !state.result;
    if (!state.result) return;

    const seats = { N: 'North', E: 'East', S: 'South', W: 'West' };
    clear(dom.resultContract);
    clear(dom.resultOutcome);

    if (dom.resultScore) dom.resultScore.hidden = true;

    if (state.result.passedOut) {
        dom.resultContract.textContent = 'Passed out';
        dom.resultOutcome.textContent = 'No contract';
        return;
    }

    const { level, strain, doubling, declarer, tricks, outcome, conceded, claimed } = state.result;
    dom.resultContract.appendChild(document.createTextNode(String(level)));
    if (strain === 'N') dom.resultContract.appendChild(document.createTextNode('NT'));
    else appendSuitText(dom.resultContract, `!${strain}`);
    if (doubling) dom.resultContract.appendChild(document.createTextNode(doubling));
    dom.resultContract.appendChild(document.createTextNode(` by ${seats[declarer]}`));

    const note = conceded ? ' (conceded)' : claimed ? ' (claimed)' : '';
    dom.resultOutcome.textContent = `${tricks} tricks - ${outcome}${note}`;

    const line = scoreLine(state.result.score);
    if (dom.resultScore) {
        dom.resultScore.textContent = line ?? '';
        dom.resultScore.hidden = !line;
    }
}

function renderExplanations(state, dom) {
    clear(dom.explain);
    if (state.explanations.length === 0) return;

    // Two columns: the call, then what it showed. The state already holds the
    // two halves separately, so nothing has to be split back apart on the "=".
    const table = document.createElement('table');
    const body = document.createElement('tbody');

    for (const { call, text } of state.explanations) {
        const row = document.createElement('tr');

        const callCell = document.createElement('td');
        callCell.className = 'call';
        appendCall(callCell, call);
        row.appendChild(callCell);

        const meaningCell = document.createElement('td');
        meaningCell.className = 'meaning';
        appendSuitText(meaningCell, text ?? '');
        row.appendChild(meaningCell);

        body.appendChild(row);
    }
    table.appendChild(body);
    dom.explain.appendChild(table);
}

function renderStatus(state, dom) {
    if (!dom.status) return;
    const { status, detail } = state.connection;
    dom.status.textContent = status === 'open' ? '' : detail;
    dom.status.className = status === 'error' ? 'status error' : 'status';
    dom.status.hidden = status === 'open';
}

/** Full render pass. Cheap enough at this size to redo on every message. */
export function render(state, dom) {
    renderStatus(state, dom);
    if (dom.loader) dom.loader.hidden = !state.busy;
    if (!state.deal) return;

    // Labelled, because a bare number in the corner of the felt reads as an
    // error code when the board happens to be numbered 404.
    if (dom.auctionPanel) dom.auctionPanel.hidden = state.auctionHidden;
    if (dom.explain) dom.explain.hidden = state.helpHidden;
    if (dom.vuln) {
        const label = vulnerabilityLabel(state.deal.vuln);
        dom.vuln.textContent = `Vul ${label}`;
        dom.vuln.dataset.vuln = label;          // styles the none/some distinction
    }
    if (dom.boardNumber) {
        dom.boardNumber.textContent = state.deal.boardNo ? `Board ${state.deal.boardNo}` : '';
    }
    renderSeatLabels(state, dom);
    renderHands(state, dom);
    renderTrick(state, dom);
    renderAuction(state, dom);
    renderBiddingBox(state, dom);
    renderExplanations(state, dom);
    renderResult(state, dom);

    if (dom.tricks) {
        dom.tricks.textContent = `Tricks NS:${state.deal.tricksCount[0]} EW:${state.deal.tricksCount[1]}`;
    }
    if (dom.lastTrick) dom.lastTrick.hidden = !state.showLastTrick;
    if (dom.claim) dom.claim.hidden = !state.claimAvailable;
    if (dom.concede) dom.concede.hidden = !state.concedeAvailable;
    if (!state.claimAvailable) clear(dom.claimTricks);
}

/** The claim picker, drawn on demand when the player clicks Claim. */
export function renderClaimOptions(state, dom) {
    clear(dom.claimTricks);
    const played = state.deal.tricksCount[0] + state.deal.tricksCount[1];
    for (let tricks = 0; tricks < 14 - played; tricks++) {
        const el = document.createElement('div');
        el.setAttribute('tricks', String(tricks));
        el.textContent = String(tricks);
        dom.claimTricks.appendChild(el);
    }
}
