/**
 * Driving a whole deal through the stateless BEN REST API (src/gameapi.py).
 *
 * The websocket UI (allwyn.html) has the gameserver run the table. Here the
 * browser runs it, as WEBSITE-INTEGRATION.md describes: this file keeps the
 * auction and the played cards, works out whose turn it is, who declares and
 * who won each trick, and asks BEN only "given this state, what next?".
 *
 * To reuse the existing state and renderer unchanged, DealRunner reports what
 * happens as the same messages the gameserver sends (deal_start, bid_made,
 * card_played, trick_confirm, deal_end...), which the page feeds straight into
 * GameState.apply(). No DOM here, and fetch is injectable, so the whole loop
 * runs under node - see allwyn.api.test.mjs.
 */

import { Card, Trick, parseHand } from './allwyn.model.js';

const SEATS = 'NESW';
const STRAINS = 'CDHSN';

/* ----------------------------------------------------------------- auction */

/** "P", "--", "Pass" -> "PASS"; "Db" -> "X"; "Rd" -> "XX"; "1NT" -> "1N". */
export function normaliseCall(call) {
    const c = String(call ?? '').trim().toUpperCase();
    if (c === 'P' || c === '--' || c === 'PASS' || c === 'PA') return 'PASS';
    if (c === 'X' || c === 'D' || c === 'DB') return 'X';
    if (c === 'XX' || c === 'R' || c === 'RD') return 'XX';
    const bid = /^([1-7])(C|D|H|S|N|NT)$/.exec(c);
    return bid ? bid[1] + bid[2][0] : c;
}

/** The auction as gameapi.py's ctx parameter: dash separated, "P" for pass. */
export function auctionToCtx(auction) {
    return auction.map((call) => (call === 'PASS' ? 'P' : call)).join('-');
}

/** Four passes, or three after anything else. */
export function auctionIsOver(auction) {
    if (auction.length < 4) return false;
    return auction.slice(-3).every((c) => c === 'PASS');
}

/**
 * Is `call` legal after `auction`, which started with `dealer`?
 * A bid must outrank the last one; X only of an opponent's undoubled bid;
 * XX only of an opponent's double.
 */
export function isLegalCall(auction, call) {
    if (call === 'PASS') return true;
    const lastBidIndex = auction.findLastIndex((c) => /^[1-7]/.test(c));
    if (/^[1-7][CDHSN]$/.test(call)) {
        if (lastBidIndex < 0) return true;
        const rank = (c) => (Number(c[0]) - 1) * 5 + STRAINS.indexOf(c[1]);
        return rank(call) > rank(auction[lastBidIndex]);
    }
    // The last call that was not a pass, and whether an opponent made it.
    const lastActionIndex = auction.findLastIndex((c) => c !== 'PASS');
    if (lastActionIndex < 0) return false;
    const byOpponent = (auction.length - lastActionIndex) % 2 === 1;
    if (call === 'X') return byOpponent && /^[1-7]/.test(auction[lastActionIndex]);
    if (call === 'XX') return byOpponent && auction[lastActionIndex] === 'X';
    return false;
}

/**
 * The final contract: level, strain letter, doubling and declarer seat index,
 * or null when the deal is passed out. Declarer is the first of the winning
 * side to name the strain.
 */
export function contractFromAuction(dealer, auction) {
    const lastBidIndex = auction.findLastIndex((c) => /^[1-7]/.test(c));
    if (lastBidIndex < 0) return null;
    const bid = auction[lastBidIndex];
    const side = (dealer + lastBidIndex) % 2;

    let declarer = (dealer + lastBidIndex) % 4;
    for (let i = 0; i <= lastBidIndex; i++) {
        const seat = (dealer + i) % 4;
        if (seat % 2 === side && auction[i][1] === bid[1] && /^[1-7]/.test(auction[i])) {
            declarer = seat;
            break;
        }
    }

    const after = auction.slice(lastBidIndex + 1);
    const doubling = after.includes('XX') ? 'XX' : after.includes('X') ? 'X' : '';
    return { level: Number(bid[0]), strain: bid[1], doubling, declarer };
}

/** "4HXS" - the form GameState/parseContract read on deal_end. */
export function contractString(contract) {
    return `${contract.level}${contract.strain}${contract.doubling}${SEATS[contract.declarer]}`;
}

/* ----------------------------------------------------------------- scoring */

/**
 * Duplicate score for declarer. The integration guide leaves scoring to the
 * frontend, and this page may be served somewhere without appserver.py's
 * /api/score, so it is worked out here. Mirrors src/scoring.py.
 */
export function scoreContract({ level, strain, doubling }, vulnerable, tricks) {
    const needed = level + 6;
    const multiplier = doubling === 'XX' ? 4 : doubling === 'X' ? 2 : 1;

    if (tricks < needed) {
        const down = needed - tricks;
        if (multiplier === 1) return -down * (vulnerable ? 100 : 50);
        let penalty = 0;
        for (let i = 1; i <= down; i++) {
            if (vulnerable) penalty += i === 1 ? 200 : 300;
            else penalty += i === 1 ? 100 : i <= 3 ? 200 : 300;
        }
        return -penalty * (multiplier / 2);
    }

    const perTrick = strain === 'C' || strain === 'D' ? 20 : 30;
    const trickScore = (perTrick * level + (strain === 'N' ? 10 : 0)) * multiplier;

    let score = trickScore;
    score += trickScore >= 100 ? (vulnerable ? 500 : 300) : 50;
    if (level === 6) score += vulnerable ? 750 : 500;
    if (level === 7) score += vulnerable ? 1500 : 1000;
    if (multiplier === 2) score += 50;
    if (multiplier === 4) score += 100;

    const over = tricks - needed;
    if (multiplier === 1) score += over * perTrick;
    else score += over * (vulnerable ? 200 : 100) * (multiplier / 2);
    return score;
}

/** IMPs for a points difference, signed. Same scale as IMP_SCALE in src/scoring.py. */
export function impsFor(diff) {
    const limits = [10, 40, 80, 120, 160, 210, 260, 310, 360, 420, 490, 590, 740, 890,
                    1090, 1290, 1490, 1740, 1990, 2240, 2490, 2990, 3490, 3990];
    const index = limits.findIndex((limit) => Math.abs(diff) <= limit);
    const imps = index < 0 ? 24 : index;
    return diff < 0 && imps > 0 ? -imps : imps;
}

/* --------------------------------------------------------------------- API */

export class ApiError extends Error {
    constructor(message, detail) {
        super(message);
        this.name = 'ApiError';
        this.detail = detail;
    }
}

/**
 * Thin client for gameapi.py. Every call carries the full state; nothing is
 * remembered between calls, because the API remembers nothing either.
 */
export class BenApi {
    /**
     * @param {string} base e.g. "http://localhost:8085"
     * @param {{fetch?: Function, tournament?: string}} options
     */
    constructor(base, { fetch: fetchImpl = globalThis.fetch?.bind(globalThis), tournament = '' } = {}) {
        this.base = String(base).replace(/\/+$/, '');
        this.fetch = fetchImpl;
        this.tournament = tournament;
    }

    async get(path, params) {
        const query = new URLSearchParams({ ...params, details: 'true' });
        if (this.tournament) query.set('tournament', this.tournament);
        const url = `${this.base}${path}?${query}`;

        let response;
        try {
            response = await this.fetch(url);
        } catch (cause) {
            // A refused connection, a CORS failure and a Host-header rejection
            // (HTTP 444, which the browser sees as a network error) all land here.
            throw new ApiError(`Could not reach BEN at ${this.base} (${cause.message}). `
                + 'Is gameapi.py running, and started with --allowed-hosts for this host?', url);
        }

        let data;
        try {
            data = await response.json();
        } catch (_) {
            throw new ApiError(`${path} answered HTTP ${response.status} with something that is not JSON`, url);
        }
        if (!response.ok || data?.error) {
            throw new ApiError(`${path}: ${data?.error ?? `HTTP ${response.status}`}`, url);
        }
        // gameapi.py reports a request it will not act on as 200 + {message}.
        if (data?.message && !data.bid && !data.card) {
            throw new ApiError(`${path}: ${data.message}`, url);
        }
        return data;
    }

    bid({ hand, seat, dealer, vul, auction }) {
        return this.get('/bid', { hand, seat, dealer, vul: apiVul(vul), ctx: auctionToCtx(auction) });
    }

    lead({ hand, seat, dealer, vul, auction }) {
        return this.get('/lead', { hand, seat, dealer, vul: apiVul(vul), ctx: auctionToCtx(auction) });
    }

    /** What the bidding system says the last call of `auction` shows. */
    explain({ seat, dealer, vul, auction }) {
        return this.get('/explain', { seat, dealer, vul: apiVul(vul), ctx: auctionToCtx(auction) });
    }

    play({ hand, dummy, seat, dealer, vul, auction, played }) {
        return this.get('/play', {
            hand, dummy, seat, dealer, vul: apiVul(vul),
            ctx: auctionToCtx(auction),
            played: played.join(''),
        });
    }
}

/** parse_vuln() in gameapi.py takes "", "NS", "EW" or "Both". */
function apiVul(vul) {
    return vul === 'None' ? '' : vul;
}

/* ------------------------------------------------------------------ runner */

/**
 * Plays one board from a parsed file, a call or a card per step().
 *
 * `emit(message)` receives gameserver-shaped messages for GameState.
 * `log(entry)` receives one line per decision, for the page's play log.
 * `humanSeats` are the seat indices a person plays. When one of them is to
 * act, step() asks BEN nothing and resolves to {kind: 'input'}; the page then
 * hands the decision in with submitCall() or submitCard(). A person who
 * declares also plays dummy's cards, as declarer does at the table; one who is
 * dummy watches BEN declare.
 */
export class DealRunner {
    constructor(board, api, { emit = () => {}, log = () => {}, localForcedPlays = true, humanSeats = [] } = {}) {
        this.board = board;
        this.api = api;
        this.emit = emit;
        this.log = log;
        this.humanSeats = new Set(humanSeats);
        // A card that is the only legal play is played without asking BEN -
        // one fewer round trip, and the same thing gameapi.py does ("Forced").
        this.localForcedPlays = localForcedPlays;

        this.dealer = SEATS.indexOf(board.dealer);
        this.hands = board.hands.map((pbn) => parseHand(pbn).map((c) => c.symbol));
        this.auction = [];
        this.contract = null;
        this.played = [];
        this.tricks = [];            // {leader, cards, winner}
        this.trick = null;           // {leader, cards}
        this.tricksWon = [0, 0];     // N-S, E-W
        // Every call and card in order, whoever made it, with where in the
        // auction or play it came - enough to ask BEN about it afterwards.
        this.decisions = [];
        this.phase = 'start';
    }

    get done() {
        return this.phase === 'done';
    }

    get dummy() {
        return this.contract ? (this.contract.declarer + 2) % 4 : -1;
    }

    /** Whose decision `seat`'s call or card is: declarer's, for dummy. */
    controller(seat) {
        return seat === this.dummy ? this.contract.declarer : seat;
    }

    /**
     * The seat to act and what it has to do, or null between tricks and once
     * the deal is over. `human` says whether the page must supply it.
     */
    get turn() {
        let seat;
        let need;
        if (this.phase === 'bidding') {
            seat = (this.dealer + this.auction.length) % 4;
            need = 'bid';
        } else if ((this.phase === 'lead' || this.phase === 'play') && this.trick.cards.length < 4) {
            seat = (this.trick.leader + this.trick.cards.length) % 4;
            need = 'card';
        } else {
            return null;
        }
        const human = this.humanSeats.has(need === 'card' ? this.controller(seat) : seat);
        return { seat, need, human };
    }

    /** Do the next thing. Resolves to what was done, for the page to pace itself. */
    async step() {
        const turn = this.turn;
        if (turn?.human) return this.awaitInput(turn);
        switch (this.phase) {
            case 'start': return this.start();
            case 'bidding': return this.nextCall();
            case 'lead': return this.openingLead();
            case 'play': return this.nextCard();
            default: return { kind: 'done' };
        }
    }

    start() {
        const { board } = this;
        const vul = board.vul;
        this.emit({
            message: 'deal_start',
            dealer: this.dealer,
            vuln: [vul === 'NS' || vul === 'Both', vul === 'EW' || vul === 'Both'],
            hand: board.hands,
            board_no: board.board || '',
        });
        this.phase = 'bidding';
        return { kind: 'start' };
    }

    async nextCall() {
        const seat = (this.dealer + this.auction.length) % 4;
        const response = await this.api.bid({
            hand: this.board.hands[seat],
            seat: SEATS[seat],
            dealer: this.board.dealer,
            vul: this.board.vul,
            auction: this.auction,
        });

        const call = normaliseCall(response.bid);
        if (!isLegalCall(this.auction, call)) {
            throw new ApiError(`BEN (${SEATS[seat]}) answered ${response.bid}, which is not a legal call here`);
        }
        this.decisions.push({ kind: 'bid', seat, action: call, index: this.auction.length, human: false });
        this.auction.push(call);
        this.emit({ message: 'bid_made', auction: [...this.auction], explanation: response.explanation ?? '' });
        this.log({ phase: 'bid', seat, action: call, who: response.who, explanation: response.explanation, response });

        if (auctionIsOver(this.auction)) this.endAuction();
        return { kind: 'bid', seat, call };
    }

    /** Tell GameState a person is to act, so it offers the bidding box or the cards. */
    awaitInput({ seat, need }) {
        if (need === 'bid') {
            this.emit({
                message: 'get_bid_input',
                auction: [...this.auction],
                can_double: isLegalCall(this.auction, 'X'),
                can_redouble: isLegalCall(this.auction, 'XX'),
            });
        } else {
            this.emit({ message: 'get_card_input' });
        }
        return { kind: 'input', need, seat };
    }

    /** A person's call. Throws, changing nothing, if it is not theirs to make or not legal. */
    submitCall(rawCall, explanation = '') {
        const turn = this.turn;
        if (!turn?.human || turn.need !== 'bid') throw new ApiError('It is not your turn to call');
        const call = normaliseCall(rawCall);
        if (!isLegalCall(this.auction, call)) throw new ApiError(`${rawCall} is not a legal call here`);

        this.decisions.push({ kind: 'bid', seat: turn.seat, action: call, index: this.auction.length, human: true });
        this.auction.push(call);
        this.emit({ message: 'bid_made', auction: [...this.auction], explanation });
        this.log({ phase: 'bid', seat: turn.seat, action: call, who: 'You', explanation });
        if (auctionIsOver(this.auction)) this.endAuction();
        return { kind: 'bid', seat: turn.seat, call };
    }

    /** A person's card, for their own seat or, as declarer, for dummy. */
    submitCard(rawCard) {
        const turn = this.turn;
        if (!turn?.human || turn.need !== 'card') throw new ApiError('It is not your turn to play');
        const card = normaliseCard(rawCard);
        this.playCard(turn.seat, card, { who: 'You' }, true);
        if (this.phase === 'lead') {
            this.emit({ message: 'show_dummy', player: this.dummy, dummy: this.board.hands[this.dummy] });
            this.phase = 'play';
        }
        return { kind: 'card', seat: turn.seat, card };
    }

    endAuction() {
        this.contract = contractFromAuction(this.dealer, this.auction);
        if (!this.contract) {
            this.finish();
            return;
        }
        const { declarer, strain } = this.contract;
        this.emit({
            message: 'auction_end',
            auction: [...this.auction],
            declarer,
            strain: 'NSHDC'.indexOf(strain),     // gameserver numbering: NT, S, H, D, C
        });
        this.trick = { leader: (declarer + 1) % 4, cards: [] };
        this.phase = 'lead';
    }

    async openingLead() {
        const seat = (this.contract.declarer + 1) % 4;
        const response = await this.api.lead({
            hand: this.board.hands[seat],
            seat: SEATS[seat],
            dealer: this.board.dealer,
            vul: this.board.vul,
            auction: this.auction,
        });
        this.playCard(seat, response.card, response);

        // Dummy goes down after the opening lead. Every hand is on show on
        // this page anyway; this tells GameState which one is dummy.
        this.emit({ message: 'show_dummy', player: this.dummy, dummy: this.board.hands[this.dummy] });
        this.phase = 'play';
        return { kind: 'card', seat, card: normaliseCard(response.card) };
    }

    async nextCard() {
        if (this.trick.cards.length === 4) return this.completeTrick();

        const seat = (this.trick.leader + this.trick.cards.length) % 4;
        const legal = this.legalCards(seat);

        let response;
        if (this.localForcedPlays && legal.length === 1) {
            response = { card: legal[0], who: 'Forced' };
        } else {
            response = await this.api.play(this.cardRequest(seat, this.played));
        }
        this.playCard(seat, response.card, response);
        return { kind: 'card', seat, card: normaliseCard(response.card) };
    }

    /**
     * The /play request for `seat`'s card after `played`. Declarer decides for
     * dummy: send declarer's seat and hand, with dummy's hand as `dummy` -
     * gameapi.py refuses a call "as dummy".
     */
    cardRequest(seat, played) {
        const acting = this.controller(seat);
        return {
            hand: this.board.hands[acting],
            dummy: this.board.hands[this.dummy],
            seat: SEATS[acting],
            dealer: this.board.dealer,
            vul: this.board.vul,
            auction: this.auction,
            played,
        };
    }

    /** The cards `seat` may play to the current trick. */
    legalCards(seat) {
        const hand = this.hands[seat];
        const led = this.trick.cards[0]?.[0];
        const following = led ? hand.filter((c) => c[0] === led) : [];
        return following.length > 0 ? following : hand;
    }

    playCard(seat, rawCard, response, human = false) {
        const card = normaliseCard(rawCard);
        const legal = this.legalCards(seat);
        if (!legal.includes(card)) {
            throw new ApiError(`BEN (${SEATS[seat]}) answered ${rawCard}, which ${SEATS[seat]} cannot play here`);
        }
        this.decisions.push({
            kind: 'card', seat, action: card, index: this.played.length,
            forced: legal.length === 1, human,
        });
        this.hands[seat] = this.hands[seat].filter((c) => c !== card);
        this.trick.cards.push(card);
        this.played.push(card);
        this.emit({ message: 'card_played', card, player: seat });
        this.log({ phase: 'play', seat, action: card, who: response?.who, trick: this.tricks.length + 1, response });
    }

    completeTrick() {
        const { leader, cards } = this.trick;
        // Same winner rule GameState uses, so the two can never disagree.
        const winner = new Trick(leader, cards.map((c) => new Card(c)))
            .winner('NSHDC'.indexOf(this.contract.strain));
        this.tricks.push({ leader, cards, winner });
        this.tricksWon[winner % 2] += 1;
        this.emit({ message: 'trick_confirm' });

        if (this.tricks.length === 13) {
            this.finish();
        } else {
            this.trick = { leader: winner, cards: [] };
        }
        return { kind: 'trick', winner, number: this.tricks.length };
    }

    finish() {
        const dict = {};
        if (this.contract) {
            const { declarer } = this.contract;
            const tricks = this.tricksWon[declarer % 2];
            const vulnerable = this.board.vul === 'Both'
                || this.board.vul === (declarer % 2 === 0 ? 'NS' : 'EW');
            const declarerScore = scoreContract(this.contract, vulnerable, tricks);
            dict.contract = contractString(this.contract);
            dict.tricks_taken = tricks;
            dict.score = declarer % 2 === 0 ? declarerScore : -declarerScore;   // N-S view
        }
        this.result = dict;
        this.phase = 'done';          // before deal_end, so its listeners see the deal over
        this.emit({ message: 'deal_end', pbn: this.board.hands.join(' '), dict });
    }
}

/** "s7" -> "S7", "C10" -> "CT". */
function normaliseCard(card) {
    return String(card ?? '').toUpperCase().replace('10', 'T');
}

/* ---------------------------------------------------------- comparison */

/**
 * For each of the player's decisions in a finished deal, what BEN would have
 * done in exactly that position: the same hand, the auction or play so far.
 * The API is stateless, so the position is simply sent again.
 *
 * Resolves to one entry per decision: the decision, plus `ben` (BEN's call or
 * card, null if the request failed), `same`, and BEN's explanation or engine.
 * A card that was the only legal one is not asked about.
 */
export async function reviewDecisions(runner, api, { onProgress = () => {}, isCancelled = () => false } = {}) {
    const mine = runner.decisions.filter((d) => d.human);
    const board = runner.board;
    const reviewed = [];

    for (const [i, decision] of mine.entries()) {
        if (isCancelled()) return reviewed;
        onProgress(i, mine.length);
        const entry = { ...decision, ben: null, same: false };
        try {
            if (decision.kind === 'bid') {
                const response = await api.bid({
                    hand: board.hands[decision.seat],
                    seat: SEATS[decision.seat],
                    dealer: board.dealer,
                    vul: board.vul,
                    auction: runner.auction.slice(0, decision.index),
                });
                entry.ben = normaliseCall(response.bid);
                entry.explanation = response.explanation ?? '';
                entry.who = response.who;
            } else if (decision.forced) {
                entry.ben = decision.action;
                entry.who = 'Forced';
            } else if (decision.index === 0) {
                const response = await api.lead({
                    hand: board.hands[decision.seat],
                    seat: SEATS[decision.seat],
                    dealer: board.dealer,
                    vul: board.vul,
                    auction: runner.auction,
                });
                entry.ben = normaliseCard(response.card);
                entry.who = response.who;
            } else {
                const response = await api.play(runner.cardRequest(decision.seat, runner.played.slice(0, decision.index)));
                entry.ben = normaliseCard(response.card);
                entry.who = response.who;
            }
            entry.same = entry.ben === decision.action;
        } catch (error) {
            entry.error = error.message;
        }
        reviewed.push(entry);
    }
    onProgress(mine.length, mine.length);
    return reviewed;
}

/**
 * The same board with BEN in all four seats, played to the end. `onStep`
 * hears about each step, for a progress line.
 */
export async function playBenVersion(board, api, { onStep = () => {}, isCancelled = () => false } = {}) {
    const runner = new DealRunner(board, api);
    while (!runner.done) {
        if (isCancelled()) return null;
        onStep(await runner.step(), runner);
    }
    return runner;
}

/**
 * Your table against BEN's, from `seat`'s side: each score, the difference
 * and its IMPs. A passed-out deal scores 0.
 */
export function compareResults(yours, bens, seat) {
    const side = seat % 2 === 0 ? 1 : -1;          // scores are kept from N-S's side
    const yourScore = (yours.score ?? 0) * side;
    const benScore = (bens.score ?? 0) * side;
    const diff = yourScore - benScore;
    return { yourScore, benScore, diff, imps: impsFor(diff) };
}
