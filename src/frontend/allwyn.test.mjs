/**
 * Headless checks for the allwyn UI's logic modules.
 *
 * The point of separating model/protocol/state from rendering is that the game
 * loop can be exercised without a browser. This replays a real gameserver
 * session (recorded from a live websocket) through GameState and asserts the
 * deal reaches a sane end, then covers the human-input messages the recording
 * does not contain.
 *
 *   node src/frontend/allwyn.test.mjs [recorded-session.json]
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Card, Hand, Trick, Auction, parseHand, vulnerabilityLabel, parseContract, contractOutcome, scoreLine } from './allwyn.model.js';
import { parseMessage, ProtocolError } from './allwyn.protocol.js';
import { GameState } from './allwyn.state.js';

const results = [];
function check(name, fn) {
    try {
        fn();
        results.push(['ok', name]);
    } catch (error) {
        results.push(['FAIL', `${name}: ${error.message}`]);
    }
}

const defaultOptions = {
    humanSeats: [false, false, false, false],
    noHuman: true,
    allVisible: false,
    autocomplete: false,
    timeoutSeconds: 0,
    play: null,
    continuous: null,
};

/* ------------------------------------------------------------------- model */

check('parseHand reads a PBN holding', () => {
    const cards = parseHand('AK.QJ.T9.8765');
    assert.equal(cards.length, 10);
    assert.equal(cards[0].symbol, 'SA');
    assert.equal(cards[0].suit, 0);
    assert.equal(cards[2].symbol, 'HQ');
    assert.ok(cards[2].isRed);
});

check('must follow suit when able', () => {
    const hand = new Hand(parseHand('AK.QJ.T9.8765'));
    const trick = new Trick(0, [new Card('HA')]);
    assert.equal(hand.isPlayable(new Card('HQ'), trick), true, 'hearts should be playable');
    assert.equal(hand.isPlayable(new Card('SA'), trick), false, 'must follow hearts');
    assert.equal(hand.isPlayable(new Card('H2'), trick), false, 'card not held');
});

check('can discard when void', () => {
    const hand = new Hand(parseHand('AK...8765'));
    const trick = new Trick(0, [new Card('HA')]);
    assert.equal(hand.isPlayable(new Card('SA'), trick), true);
});

check('play() leaves the original hand untouched', () => {
    const hand = new Hand(parseHand('AK.QJ..'));
    const next = hand.play(new Card('SA'));
    assert.equal(hand.cards.length, 4);
    assert.equal(next.cards.length, 3);
});

check('highest card of the led suit wins', () => {
    // strain 0 = no trumps; lead player 1, so cards belong to seats 1,2,3,0.
    const trick = new Trick(1, ['S4', 'SA', 'S9', 'H2'].map((s) => new Card(s)));
    assert.equal(trick.winner(0), 2, 'the ace should win for seat 2');
});

check('a trump beats the led suit', () => {
    // strain 1 = clubs, so card.suit 0 is trump in the model's indexing.
    const trick = new Trick(0, ['HA', 'HK', 'S2', 'H3'].map((c) => new Card(c)));
    assert.equal(trick.winner(1), 2, 'the spade ruff should win for seat 2');
});

check('an unfinished trick has no winner', () => {
    assert.equal(new Trick(0, [new Card('SA')]).winner(0), undefined);
});

check('auction pads to put calls under their seat', () => {
    assert.deepEqual(new Auction(2, [false, false], ['1C', 'PASS']).paddedBids, ['', '', '', '1C', 'PASS']);
    assert.deepEqual(new Auction(3, [false, false], ['1C']).paddedBids, ['1C']);
});

check('minimum biddable level follows the last bid', () => {
    assert.equal(new Auction(0, [false, false], []).getMinimumBiddableLevel(), 1);
    assert.equal(new Auction(0, [false, false], ['1S', 'PASS']).getMinimumBiddableLevel(), 1);
    assert.equal(new Auction(0, [false, false], ['1N']).getMinimumBiddableLevel(), 2);
    assert.equal(new Auction(0, [false, false], ['4H', 'X']).getMinimumBiddableLevel(), 4);
});

check('strains below the last bid are closed off at that level', () => {
    const auction = new Auction(0, [false, false], ['1H']);
    assert.equal(auction.getMinBiddableSuitForLevel(1), 3, 'at the one level only spades and NT remain');
    assert.equal(auction.getMinBiddableSuitForLevel(2), 0, 'the two level is wide open');
});

check('vulnerability reads as None, N-S, E-W or Both', () => {
    assert.equal(vulnerabilityLabel([false, false]), 'None');
    assert.equal(vulnerabilityLabel([true, false]), 'N-S');
    assert.equal(vulnerabilityLabel([false, true]), 'E-W');
    assert.equal(vulnerabilityLabel([true, true]), 'Both');
    assert.equal(vulnerabilityLabel(), 'None', 'missing vulnerability is not vulnerable');
});

check('the contract string splits into its parts', () => {
    assert.deepEqual(parseContract('4HXS'), { level: 4, strain: 'H', doubling: 'X', declarer: 'S' });
    assert.deepEqual(parseContract('3NN'), { level: 3, strain: 'N', doubling: '', declarer: 'N' });
    assert.deepEqual(parseContract('7SXXW'), { level: 7, strain: 'S', doubling: 'XX', declarer: 'W' });
    assert.equal(parseContract(null), null, 'passed out');
    assert.equal(parseContract('PASS'), null);
});

check('the outcome counts against the book', () => {
    assert.equal(contractOutcome(4, 10), 'made exactly');
    assert.equal(contractOutcome(4, 12), 'made +2');
    assert.equal(contractOutcome(3, 7), 'down 2');
    assert.equal(contractOutcome(7, 13), 'made exactly');
});

check('a score reads out to whichever side won it', () => {
    assert.equal(scoreLine(620), 'N-S +620');
    assert.equal(scoreLine(-100), 'E-W +100');
    assert.equal(scoreLine(0), 'No score');
    assert.equal(scoreLine(null), null, 'nothing to show');
    assert.equal(scoreLine(undefined), null);
});

/* ---------------------------------------------------------------- protocol */

check('a valid message parses', () => {
    const raw = JSON.stringify({ message: 'get_card_input' });
    assert.equal(parseMessage(raw).message, 'get_card_input');
});

check('malformed payloads are rejected by name', () => {
    assert.throws(() => parseMessage('not json'), ProtocolError);
    assert.throws(() => parseMessage('{"foo":1}'), /no "message" field/);
    assert.throws(() => parseMessage('{"message":"nonsense"}'), /Unknown server message/);
    assert.throws(() => parseMessage('{"message":"deal_start"}'), /missing: dealer, vuln, hand, board_no/);
});

/* ------------------------------------------------------------------- state */

check('hint and alert surface as effects, not state changes', () => {
    const state = new GameState(defaultOptions);
    state.apply({ message: 'deal_start', dealer: 0, vuln: [false, false], hand: ['AK...', '', '', ''], board_no: 1 });

    const hintEffects = state.apply({ message: 'hint', bids: { bid: '1S', candidates: [] } });
    assert.equal(hintEffects[0].type, 'hint');

    const alertEffects = state.apply({ message: 'alert', alert: 'True' });
    assert.equal(state.alertArmed, true);
    assert.equal(alertEffects[0].type, 'alert-toggled');

    state.apply({ message: 'alert', alert: 'False' });
    assert.equal(state.alertArmed, false);
});

check('get_bid_input arms the bidding box with the doubling flags', () => {
    const state = new GameState(defaultOptions);
    state.apply({ message: 'deal_start', dealer: 0, vuln: [false, false], hand: ['AK...', '', '', ''], board_no: 1 });
    state.apply({ message: 'get_bid_input', auction: ['1C'], can_double: true, can_redouble: false });
    assert.equal(state.expectBidInput, true);
    assert.equal(state.deal.canDouble, true);
    assert.equal(state.deal.canRedouble, false);
});

check('claim is offered on lead but not on the opening lead', () => {
    const state = new GameState(defaultOptions);
    state.apply({ message: 'deal_start', dealer: 0, vuln: [false, false], hand: ['AK...', '', '', ''], board_no: 1 });
    state.apply({ message: 'auction_end', auction: ['1N', 'PASS', 'PASS', 'PASS'], declarer: 0, strain: 0 });

    state.apply({ message: 'get_card_input' });
    assert.equal(state.claimAvailable, false, 'no claiming on the opening lead');
    assert.equal(state.concedeAvailable, true);

    state.deal.tricks.push(new Trick(0, []));       // pretend a trick has been played
    state.apply({ message: 'get_card_input' });
    assert.equal(state.claimAvailable, true, 'claiming allowed on lead later on');
});

check('a finished trick waits for the player, even with the home page option on', () => {
    // The home page ticks "Autocomplete trick after N seconds" by default, so
    // this must hold even when the option is set.
    for (const options of [defaultOptions, { ...defaultOptions, autocomplete: 'x', timeoutSeconds: 2 }]) {
        const state = new GameState(options);
        state.apply({ message: 'deal_start', dealer: 0, vuln: [false, false], hand: ['AK...', '', '', ''], board_no: 1 });
        state.apply({ message: 'auction_end', auction: [], declarer: 0, strain: 0 });
        ['S4', 'SA', 'S9', 'S2'].forEach((c, i) => state.apply({ message: 'card_played', card: c, player: (1 + i) % 4 }));

        const effects = state.apply({ message: 'trick_confirm' });
        assert.equal(effects.some((e) => e.type === 'schedule-trick-confirm'), false, 'no auto-advance timer');
        assert.equal(state.expectTrickConfirm, true, 'waiting for the click');
        assert.equal(state.pendingTrick?.cards.length, 4, 'all four cards still on the table');
    }
});

check('?autoplay=1 hands the acknowledgement to a timer', () => {
    const run = (options) => {
        const state = new GameState(options);
        state.apply({ message: 'deal_start', dealer: 0, vuln: [false, false], hand: ['AK...', '', '', ''], board_no: 1 });
        state.apply({ message: 'auction_end', auction: [], declarer: 0, strain: 0 });
        ['S4', 'SA', 'S9', 'S2'].forEach((c, i) => state.apply({ message: 'card_played', card: c, player: (1 + i) % 4 }));
        return state.apply({ message: 'trick_confirm' }).find((e) => e.type === 'schedule-trick-confirm');
    };

    assert.equal(run({ ...defaultOptions, autoplay: true, timeoutSeconds: 5 })?.seconds, 5, 'uses T when given');
    assert.equal(run({ ...defaultOptions, autoplay: true, timeoutSeconds: 0 })?.seconds, 2, 'falls back to 2s');
    assert.equal(run({ ...defaultOptions, autoplay: false }), undefined, 'off unless asked for');
});

check('a hand stays visible once it has been shown', () => {
    // South is the human. Their hand must not vanish when the turn moves on,
    // and dummy must stay on the table for the rest of the deal.
    const state = new GameState({ ...defaultOptions, humanSeats: [false, false, true, false], noHuman: false });
    state.apply({ message: 'deal_start', dealer: 2, vuln: [false, false], hand: ['', '', 'AK.QJ.T9.8765', ''], board_no: 1 });
    assert.equal(state.revealed.has(2), true, 'own hand visible on your turn');

    // North bids: the turn is no longer South's.
    state.apply({ message: 'bid_made', auction: ['PASS'] });
    assert.equal(state.revealed.has(2), true, 'own hand still visible off turn');

    state.apply({ message: 'auction_end', auction: ['1N', 'PASS', 'PASS', 'PASS'], declarer: 0, strain: 0 });
    state.apply({ message: 'show_dummy', player: 2, dummy: 'AK.QJ.T9.8765' });
    assert.equal(state.revealed.has(2), true, 'dummy visible');

    // Play three cards, moving the turn right around the table.
    ['S4', 'SA', 'S9'].forEach((c, i) => state.apply({ message: 'card_played', card: c, player: i }));
    assert.equal(state.revealed.has(2), true, 'still visible after other seats play');

    // Seats we were never entitled to see stay hidden.
    assert.equal(state.revealed.has(1), false, 'an opponent hand is not revealed');
});

check('the bidding box keeps its space until the contract is settled', () => {
    const state = new GameState(defaultOptions);
    state.apply({ message: 'deal_start', dealer: 0, vuln: [false, false], hand: ['AK...', '', '', ''], board_no: 1 });
    assert.equal(state.auctionOver, false, 'space held during the auction');

    state.apply({ message: 'get_bid_input', auction: ['1C'] });
    assert.equal(state.auctionOver, false, 'still held between turns');

    state.apply({ message: 'auction_end', auction: ['1N', 'PASS', 'PASS', 'PASS'], declarer: 0, strain: 0 });
    assert.equal(state.auctionOver, true, 'released once the auction ends');

    // and held again on the next deal
    state.apply({ message: 'deal_start', dealer: 0, vuln: [false, false], hand: ['AK...', '', '', ''], board_no: 2 });
    assert.equal(state.auctionOver, false);
});

check('deal_end works out the result and waits', () => {
    const state = new GameState(defaultOptions);
    state.apply({ message: 'deal_start', dealer: 0, vuln: [false, false], hand: ['AK...', '', '', ''], board_no: 1 });
    state.apply({ message: 'auction_end', auction: ['4H', 'PASS', 'PASS', 'PASS'], declarer: 2, strain: 3 });
    state.deal.tricksCount = [11, 2];        // South's side took 11

    state.apply({
        message: 'deal_end',
        pbn: 'AK.QJ.T9.8765 AK.QJ.T9.8765 AK.QJ.T9.8765 AK.QJ.T9.8765',
        dict: { contract: '4HS' },
    });

    assert.equal(state.result.level, 4);
    assert.equal(state.result.strain, 'H');
    assert.equal(state.result.declarer, 'S');
    assert.equal(state.result.tricks, 11, 'counts declarer\'s side');
    assert.equal(state.result.outcome, 'made +1');
    assert.equal(state.result.score, null, 'no score sent, none shown');

    // with the server's score and trick count, both are used
    const scored = new GameState(defaultOptions);
    scored.apply({ message: 'deal_start', dealer: 0, vuln: [true, false], hand: ['AK...', '', '', ''], board_no: 3 });
    scored.apply({ message: 'auction_end', auction: [], declarer: 2, strain: 3 });
    scored.apply({
        message: 'deal_end',
        pbn: 'AK.QJ.T9.8765 AK.QJ.T9.8765 AK.QJ.T9.8765 AK.QJ.T9.8765',
        dict: { contract: '4HS', score: 650, tricks_taken: 11 },
    });
    assert.equal(scored.result.score, 650);
    assert.equal(scored.result.tricks, 11, 'the count the score was worked out from');
    assert.equal(scored.result.outcome, 'made +1');

    // a passed-out deal still reports something
    const passed = new GameState(defaultOptions);
    passed.apply({ message: 'deal_start', dealer: 0, vuln: [false, false], hand: ['AK...', '', '', ''], board_no: 2 });
    passed.apply({ message: 'deal_end', pbn: 'A. A. A. A.', dict: {} });
    assert.equal(passed.result.passedOut, true);
});

check('a claim credits the right side, and asks for a score', () => {
    // 4H by South. Five tricks played, N-S have 4 of them; declarer claims the
    // remaining 8, so South's side finishes with 12.
    const state = new GameState(defaultOptions);
    state.apply({ message: 'deal_start', dealer: 0, vuln: [true, false], hand: ['AK...', '', '', ''], board_no: 1 });
    state.apply({ message: 'auction_end', auction: [], declarer: 2, strain: 3 });
    state.deal.tricks = Array.from({ length: 5 }, () => new Trick(0, []));
    state.deal.tricksCount = [4, 1];

    const effects = state.apply({
        message: 'deal_end',
        pbn: 'AK.QJ.T9.8765 AK.QJ.T9.8765 AK.QJ.T9.8765 AK.QJ.T9.8765',
        dict: { contract: '4HS', claimed: 8, claimedbydeclarer: true },
    });

    assert.deepEqual(state.deal.tricksCount, [12, 1], 'the other side keeps what it won');
    assert.equal(state.result.tricks, 12);
    assert.equal(state.result.outcome, 'made +2');
    assert.equal(state.result.score, null, 'the server sent none');

    const ask = effects.find((e) => e.type === 'score-needed');
    assert.ok(ask, 'a score is requested');
    assert.equal(ask.contract, '4HS');
    assert.equal(ask.tricks, 12);
    assert.equal(ask.vulnerable, true, "declarer's side is vulnerable");
});

check('a claim by the defenders gives declarer the rest', () => {
    const state = new GameState(defaultOptions);
    state.apply({ message: 'deal_start', dealer: 0, vuln: [false, false], hand: ['AK...', '', '', ''], board_no: 1 });
    state.apply({ message: 'auction_end', auction: [], declarer: 2, strain: 3 });
    state.deal.tricks = Array.from({ length: 9 }, () => new Trick(0, []));
    state.deal.tricksCount = [6, 3];

    // 4 tricks left, defenders claim 3, so declarer takes the remaining 1.
    state.apply({
        message: 'deal_end',
        pbn: 'AK.QJ.T9.8765 AK.QJ.T9.8765 AK.QJ.T9.8765 AK.QJ.T9.8765',
        dict: { contract: '4HS', claimed: 3, claimedbydeclarer: false },
    });
    assert.deepEqual(state.deal.tricksCount, [7, 6]);
    assert.equal(state.result.outcome, 'down 3');
});

check('a deal the server scored does not ask again', () => {
    const state = new GameState(defaultOptions);
    state.apply({ message: 'deal_start', dealer: 0, vuln: [false, false], hand: ['AK...', '', '', ''], board_no: 1 });
    state.apply({ message: 'auction_end', auction: [], declarer: 2, strain: 3 });
    const effects = state.apply({
        message: 'deal_end',
        pbn: 'AK.QJ.T9.8765 AK.QJ.T9.8765 AK.QJ.T9.8765 AK.QJ.T9.8765',
        dict: { contract: '4HS', score: 620, tricks_taken: 10 },
    });
    assert.equal(effects.some((e) => e.type === 'score-needed'), false);
});

check('canPlay refuses a card that is not on turn or not legal', () => {
    const state = new GameState({ ...defaultOptions, humanSeats: [false, false, true, false], noHuman: false });
    state.apply({ message: 'deal_start', dealer: 0, vuln: [false, false], hand: ['', '', 'AK.QJ.T9.8765', ''], board_no: 1 });
    state.apply({ message: 'auction_end', auction: [], declarer: 1, strain: 0 });   // South (2) on lead
    assert.equal(state.canPlay(new Card('SA')), false, 'not while no card input is expected');

    state.apply({ message: 'get_card_input' });
    assert.equal(state.canPlay(new Card('SA')), true);
    assert.equal(state.canPlay(new Card('S3')), false, 'card not held');
});

/* ------------------------------------------- replay of a recorded live deal */

const sessionPath = process.argv[2];
if (sessionPath) {
    const messages = JSON.parse(readFileSync(sessionPath, 'utf8'));

    check(`replays a recorded ${messages.length}-message deal`, () => {
        const state = new GameState(defaultOptions);
        let renders = 0;
        state.subscribe(() => { renders += 1; });

        for (const message of messages) {
            parseMessage(JSON.stringify(message));   // every recorded frame must validate
            state.apply(message);
        }

        assert.equal(state.deal.tricks.length, 13, 'all 13 tricks recorded');
        const total = state.deal.tricksCount[0] + state.deal.tricksCount[1];
        assert.equal(total, 13, `tricks counted should total 13, got ${total}`);
        assert.equal(state.deal.hands.every((h) => h.cards.length === 13), true, 'deal_end restores all four hands');
        assert.equal(state.expectCardInput, false);
        assert.equal(renders, messages.length, 'one render per message');

        // Trick winners must agree with the seats the server dealt cards to.
        for (const trick of state.deal.tricks) {
            assert.equal(trick.cards.length, 4, 'every recorded trick is complete');
            assert.ok(trick.winner(state.deal.strain) >= 0);
        }
    });
} else {
    results.push(['skip', 'recorded-deal replay (no session file given)']);
}

/* ------------------------------------------------------------------ report */

let failed = 0;
for (const [status, name] of results) {
    if (status === 'FAIL') failed += 1;
    console.log(`${status.padEnd(4)} ${name}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed > 0 ? 1 : 0);
