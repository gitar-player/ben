/**
 * Headless checks for allwyn-api.html's logic: the .pbn/.lin readers, the
 * auction rules, scoring, and a whole deal driven through DealRunner into
 * GameState with a stand-in for gameapi.py.
 *
 *   node src/frontend/allwyn.api.test.mjs [file.pbn|file.lin ...]
 *
 * Any files named are parsed as well, and their deal count printed.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePbn, parseLin, parseDealFile, boardDealer, boardVulnerability } from './allwyn.dealfile.js';
import {
    normaliseCall, auctionToCtx, auctionIsOver, isLegalCall, contractFromAuction,
    contractString, scoreContract, BenApi, DealRunner, ApiError,
    impsFor, reviewDecisions, playBenVersion, compareResults,
} from './allwyn.api.js';
import { GameState } from './allwyn.state.js';
import { Card, Trick } from './allwyn.model.js';

const results = [];
async function check(name, fn) {
    try {
        await fn();
        results.push(['ok', name]);
    } catch (error) {
        results.push(['FAIL', `${name}: ${error.stack}`]);
    }
}

const HANDS = ['T5.982.874.AQ632', 'K43.73.KQ5.KJT54', 'AJ9.AQT6.JT62.98', 'Q8762.KJ54.A93.7'];

const PBN = `% PBN 2.1
[Event "Camrose"]
[Board "1"]
[Dealer "N"]
[Vulnerable "None"]
[Deal "N:T5.982.874.AQ632 K43.73.KQ5.KJT54 AJ9.AQT6.JT62.98 Q8762.KJ54.A93.7"]
[Auction "N"]
Pass 1C 1S Pass

[Event "#"]
[Board "2"]
[Dealer "E"]
[Vulnerable "NS"]
[Deal "E:J2.T9875.J4.AQ82 A73.AQJ43.T32.96 KQ9865..A76.KJ73 T4.K62.KQ985.T54"]
`;

const LIN = 'pn|Ann,Bob,Cat,Dan|st||md|3SAJ9HAQT6DJT62C98,SQ8762HKJ54DA93C7,ST5H982D874CAQ632,|'
    + 'rh||ah|Board 1|sv|o|mb|p|mb|1C|pg||';

/* ------------------------------------------------------------------ files */

await check('PBN: two boards, rotated to N E S W, "#" repeats a tag', () => {
    const { boards, errors } = parsePbn(PBN);
    assert.deepEqual(errors, []);
    assert.equal(boards.length, 2);
    assert.deepEqual(boards[0].hands, HANDS);
    assert.equal(boards[0].dealer, 'N');
    assert.equal(boards[0].vul, 'None');
    assert.equal(boards[0].label, 'Board 1 - Camrose');
    // Deal given from East: North is the fourth hand in the string.
    assert.equal(boards[1].hands[0], 'T4.K62.KQ985.T54');
    assert.equal(boards[1].hands[1], 'J2.T9875.J4.AQ82');
    assert.equal(boards[1].vul, 'NS');
    assert.equal(boards[1].label, 'Board 2 - Camrose');
});

await check('PBN: a missing hand is filled in, a bad deal is reported not thrown', () => {
    const { boards } = parsePbn('[Board "3"]\n[Deal "N:T5.982.874.AQ632 - AJ9.AQT6.JT62.98 Q8762.KJ54.A93.7"]');
    assert.equal(boards[0].hands[1], 'K43.73.KQ5.KJT54');
    assert.equal(boards[0].dealer, 'S');           // from the board number
    assert.equal(boards[0].vul, 'EW');
    const bad = parsePbn('[Board "4"]\n[Deal "N:AKQ... - - -"]');
    assert.equal(bad.boards.length, 0);
    assert.equal(bad.errors.length, 1);
});

await check('LIN: S W N E order, dealer digit, blank East worked out', () => {
    const { boards, errors } = parseLin(LIN);
    assert.deepEqual(errors, []);
    assert.equal(boards.length, 1);
    assert.deepEqual(boards[0].hands, HANDS);
    assert.equal(boards[0].dealer, 'N');
    assert.equal(boards[0].vul, 'None');
    assert.equal(boards[0].board, '1');
});

await check('LIN: vugraph file with several deals, and a handviewer URL', () => {
    const vugraph = `vg|Match,,I,1,2,A,0,B,0|\nqx|o1|md|3SAJ9HAQT6DJT62C98,SQ8762HKJ54DA93C7,ST5H982D874CAQ632,|sv|n|ah|Board 1|mb|p|pg||\n`
        + `qx|c1|md|3SAJ9HAQT6DJT62C98,SQ8762HKJ54DA93C7,ST5H982D874CAQ632,|sv|e|mb|p|pg||\n`;
    const { boards } = parseLin(vugraph);
    assert.equal(boards.length, 2);
    assert.equal(boards[0].vul, 'NS');
    assert.equal(boards[0].label, 'Board 1 - Open room');
    assert.equal(boards[1].vul, 'EW');
    assert.equal(boards[1].label, 'Deal - Closed room');

    const url = 'https://www.bridgebase.com/tools/handviewer.html?lin=' + encodeURIComponent(LIN);
    assert.deepEqual(parseLin(url).boards[0].hands, HANDS);
});

await check('parseDealFile picks by extension, then by content', () => {
    assert.equal(parseDealFile('x.lin', LIN).boards.length, 1);
    assert.equal(parseDealFile('x.pbn', PBN).boards.length, 2);
    assert.equal(parseDealFile('x.txt', PBN).boards.length, 2);
    assert.equal(parseDealFile('x.txt', LIN).boards.length, 1);
});

const RECORDED_PBN = `[Board "1"]
[Dealer "N"]
[Vulnerable "None"]
[Deal "N:T5.982.874.AQ632 K43.73.KQ5.KJT54 AJ9.AQT6.JT62.98 Q8762.KJ54.A93.7"]
[Declarer "W"]
[Contract "3S"]
[Result "9"]
[Score "EW 140"]
[Auction "N"]
PASS 1C =1= X =2= XX =3=
PASS 1N =4= PASS 2S
PASS 3S PASS PASS
PASS
[Note "1: 3+ !C"]
[Play "N"]
ST SK SA S6
S5 S3 S9 SQ
CA C4 C8 C7
D4 D5 DT DA
D7 DQ D6 D3
C6 CK C9 H4
H2 H7 H6 HJ
D8 DK D2 D9
H8 H3 HA H5
C2 S4 SJ S7
C3 C5 DJ S8
H9 CT HT HK
CQ CJ HQ S2
`;

await check('PBN: the recorded contract, result, score and auction are read', () => {
    const [board] = parsePbn(RECORDED_PBN).boards;
    assert.deepEqual(board.recorded, {
        auction: ['PASS', '1C', 'X', 'XX', 'PASS', '1N', 'PASS', '2S', 'PASS', '3S', 'PASS', 'PASS', 'PASS'],
        contract: { level: 3, strain: 'S', doubling: '', declarer: 3 },
        passedOut: false, tricks: 9, score: -140, hasResult: true,
    });
});

await check('PBN: tricks counted from [Play] when there is no [Result]; the contract from the auction', () => {
    const noResult = RECORDED_PBN.replace('[Result "9"]\n', '').replace('[Contract "3S"]\n', '').replace('[Declarer "W"]\n', '');
    const [board] = parsePbn(noResult).boards;
    assert.deepEqual(board.recorded.contract, { level: 3, strain: 'S', doubling: '', declarer: 3 });
    assert.equal(board.recorded.tricks, 9);
    assert.equal(board.recorded.score, -140);
});

await check('PBN: AP, {commentary}, passed out, contract only, nothing recorded', () => {
    const base = `[Board "1"]\n[Dealer "N"]\n[Vulnerable "Both"]\n[Deal "N:${HANDS.join(' ')}"]\n`;
    const ap = parsePbn(base + '[Auction "N"]\n1H {opens\nhearts} PASS 4H AP\n[Result "11"]\n').boards[0].recorded;
    assert.deepEqual(ap.auction, ['1H', 'PASS', '4H', 'PASS', 'PASS', 'PASS']);
    assert.deepEqual(ap.contract, { level: 4, strain: 'H', doubling: '', declarer: 0 });
    assert.equal(ap.score, 650);                         // 4H+1 vulnerable, N-S

    const passed = parsePbn(base + '[Contract "Pass"]\n[Auction "N"]\nAP\n').boards[0].recorded;
    assert.equal(passed.passedOut, true);
    assert.equal(passed.score, 0);
    assert.equal(passed.hasResult, true);

    const contractOnly = parsePbn(base + '[Declarer "S"]\n[Contract "2SX"]\n').boards[0].recorded;
    assert.deepEqual(contractOnly.contract, { level: 2, strain: 'S', doubling: 'X', declarer: 2 });
    assert.equal(contractOnly.hasResult, false);
    assert.equal(contractOnly.score, null);

    assert.equal(parsePbn(base).boards[0].recorded, null);
    assert.equal(parsePbn(base + '[Contract ""]\n[Result ""]\n').boards[0].recorded, null);
});

await check('LIN: mb| calls with alerts, and the result from mc| or from 52 pc| cards', () => {
    const md = 'md|3SAJ9HAQT6DJT62C98,SQ8762HKJ54DA93C7,ST5H982D874CAQ632,|sv|o|';
    const calls = 'mb|p|mb|1C!|an|3+ C|mb|d|mb|r|mb|p|mb|1N|mb|p|mb|2S|mb|p|mb|3S|mb|p|mb|p|mb|p|';
    const claimed = parseLin(md + calls + 'pc|ST|pc|SK|pc|SA|pc|S6|mc|9|').boards[0].recorded;
    assert.deepEqual(claimed.contract, { level: 3, strain: 'S', doubling: '', declarer: 3 });
    assert.equal(claimed.tricks, 9);
    assert.equal(claimed.score, -140);

    // The same play as the PBN, in the order played: leader first each trick.
    const [board] = parsePbn(RECORDED_PBN).boards;
    const played = [];
    const rows = RECORDED_PBN.split('[Play "N"]\n')[1].trim().split('\n').map((l) => l.trim().split(/\s+/));
    let leader = 0;                                     // W declares: North leads
    for (const row of rows) {
        const order = [0, 1, 2, 3].map((i) => row[(leader + i) % 4]);
        played.push(...order);
        leader = new Trick(leader, order.map((c) => new Card(c))).winner('NSHDC'.indexOf('S'));
    }
    const full = parseLin(md + calls + played.map((c) => `pc|${c}|`).join('')).boards[0].recorded;
    assert.equal(full.tricks, board.recorded.tricks);

    const noResult = parseLin(md + calls).boards[0].recorded;
    assert.equal(noResult.hasResult, false);
    assert.ok(noResult.contract);
    assert.equal(parseLin(md).boards[0].recorded, null);
});

await check('board number gives dealer and vulnerability', () => {
    assert.deepEqual([1, 2, 3, 4, 5].map(boardDealer), ['N', 'E', 'S', 'W', 'N']);
    assert.deepEqual([1, 2, 3, 4, 7, 16].map(boardVulnerability), ['None', 'NS', 'EW', 'Both', 'Both', 'EW']);
});

/* ---------------------------------------------------------------- auction */

await check('calls normalise and encode for ctx', () => {
    assert.deepEqual(['p', '--', 'Pass', 'Db', 'rd', '3NT', '1s'].map(normaliseCall),
        ['PASS', 'PASS', 'PASS', 'X', 'XX', '3N', '1S']);
    assert.equal(auctionToCtx(['PASS', '1S', 'X', 'XX']), 'P-1S-X-XX');
    assert.equal(auctionToCtx([]), '');
});

await check('auction end and legality', () => {
    assert.equal(auctionIsOver(['PASS', 'PASS', 'PASS']), false);
    assert.equal(auctionIsOver(['PASS', 'PASS', 'PASS', 'PASS']), true);
    assert.equal(auctionIsOver(['1S', 'PASS', 'PASS', 'PASS']), true);
    assert.equal(isLegalCall(['1S'], '1H'), false);
    assert.equal(isLegalCall(['1S'], '1N'), true);
    assert.equal(isLegalCall(['1S'], 'X'), true);
    assert.equal(isLegalCall(['1S', 'PASS'], 'X'), false);            // partner's bid
    assert.equal(isLegalCall(['1S', 'PASS', 'PASS'], 'X'), true);     // balancing
    assert.equal(isLegalCall(['1S', 'X'], 'XX'), true);
    assert.equal(isLegalCall(['1S', 'X', 'PASS'], 'XX'), false);
    assert.equal(isLegalCall([], 'X'), false);
});

await check('contract and declarer from the auction', () => {
    // Dealer N: N 1H, E P, S 2H, W P, N 4H -> North declares.
    const c = contractFromAuction(0, ['1H', 'PASS', '2H', 'PASS', '4H', 'X', 'PASS', 'PASS', 'PASS']);
    assert.deepEqual(c, { level: 4, strain: 'H', doubling: 'X', declarer: 0 });
    assert.equal(contractString(c), '4HXN');
    // Dealer E: E P, S 1C, W P, N 1S, E P, S 2S -> North named spades first.
    assert.equal(contractFromAuction(1, ['PASS', '1C', 'PASS', '1S', 'PASS', '2S', 'PASS', 'PASS', 'PASS']).declarer, 0);
    assert.equal(contractFromAuction(0, ['PASS', 'PASS', 'PASS', 'PASS']), null);
});

await check('scoring (full grid cross-checked against src/scoring.py)', () => {
    const s = (c, v, t) => scoreContract({ level: +c[0], strain: c[1], doubling: c.slice(2) }, v, t);
    assert.equal(s('4H', true, 10), 620);
    assert.equal(s('3N', false, 9), 400);
    assert.equal(s('1N', false, 7), 90);
    assert.equal(s('4SX', false, 8), -300);
    assert.equal(s('7NXX', true, 13), 2980);
    assert.equal(s('2CX', false, 9), 280);
});

/* ---------------------------------------------------------------- runner */

/**
 * Stands in for gameapi.py: a fixed auction, and the lowest legal card.
 * Checks each request carries what the integration guide says it must.
 */
function fakeApi(board, script, getRunner, calls) {
    const seats = 'NESW';
    return {
        async bid({ hand, seat, dealer, vul, auction }) {
            calls.push(['bid', seat]);
            assert.equal(hand, board.hands[seats.indexOf(seat)]);
            assert.equal(dealer, board.dealer);
            assert.equal(vul, board.vul);
            return { bid: script[auction.length], who: 'NN', explanation: `call ${auction.length + 1}` };
        },
        async lead({ hand, seat }) {
            calls.push(['lead', seat]);
            const r = getRunner();
            assert.equal(seats.indexOf(seat), (r.contract.declarer + 1) % 4);
            assert.equal(hand, board.hands[seats.indexOf(seat)]);
            return { card: r.legalCards(seats.indexOf(seat)).at(-1), who: 'Simulation' };
        },
        async play({ hand, dummy, seat, played }) {
            const r = getRunner();
            const toPlay = (r.trick.leader + r.trick.cards.length) % 4;
            calls.push(['play', seat, toPlay]);
            assert.notEqual(seats.indexOf(seat), r.dummy, 'never asked as dummy');
            assert.equal(dummy, board.hands[r.dummy]);
            assert.equal(hand, board.hands[seats.indexOf(seat)], 'always the original 13 cards');
            assert.deepEqual(played, r.played);
            return { card: r.legalCards(toPlay).at(-1).toLowerCase(), who: 'Simulation' };
        },
    };
}

await check('a whole deal through DealRunner and GameState', async () => {
    const board = parsePbn(PBN).boards[0];
    const script = ['PASS', '1C', '1S', 'PASS', '2C', 'PASS', '3N', 'PASS', 'PASS', 'PASS'];
    const calls = [];
    let runner;
    const state = new GameState({ humanSeats: [false, false, false, false], noHuman: true, allVisible: true });
    runner = new DealRunner(board, fakeApi(board, script, () => runner, calls), {
        emit: (m) => state.apply(m),
        localForcedPlays: false,
    });

    let guard = 0;
    while (!runner.done && guard++ < 200) {
        const outcome = await runner.step();
        if (outcome.kind === 'trick') {
            // The page clears the finished trick before the next card.
            state.pendingTrick = null;
            state.expectTrickConfirm = false;
        }
    }
    assert.ok(runner.done);
    // Dealer N: N P, E 1C, S 1S, W P, N 2C, E P, S 3N -> South declares 3NT.
    assert.deepEqual(runner.contract, { level: 3, strain: 'N', doubling: '', declarer: 2 });
    assert.equal(calls.filter((c) => c[0] === 'bid').length, 10);
    assert.deepEqual(calls.find((c) => c[0] === 'lead'), ['lead', 'W']);
    assert.equal(calls.filter((c) => c[0] === 'play').length, 51);
    // Dummy (North) cards were asked of declarer (South).
    assert.ok(calls.some((c) => c[0] === 'play' && c[1] === 'S' && c[2] === 0));
    assert.equal(runner.played.length, 52);
    assert.equal(runner.tricksWon[0] + runner.tricksWon[1], 13);

    // GameState agrees with the runner, trick for trick.
    assert.deepEqual(state.deal.tricksCount, runner.tricksWon);
    assert.equal(state.result.declarer, 'S');
    assert.equal(state.result.tricks, runner.tricksWon[0]);
    assert.equal(state.result.score, scoreContract(runner.contract, false, runner.tricksWon[0])
        * 1);                                                            // N-S declared
    assert.equal(state.explanations.length, 10);
    assert.ok(state.deal.hands.every((h) => h.cards.length === 13), 'deal_end shows the full deal');
});

await check('forced plays skip the API; a passed-out deal ends after the auction', async () => {
    const board = parsePbn(PBN).boards[0];
    const calls = [];
    let runner;
    runner = new DealRunner(board, fakeApi(board, ['1C', 'PASS', 'PASS', 'PASS'], () => runner, calls));
    while (!runner.done) await runner.step();
    assert.ok(calls.filter((c) => c[0] === 'play').length < 51);

    const state = new GameState({ humanSeats: [false, false, false, false], noHuman: true, allVisible: true });
    const passed = new DealRunner(board, fakeApi(board, ['PASS', 'PASS', 'PASS', 'PASS'], () => passed, []),
        { emit: (m) => state.apply(m) });
    while (!passed.done) await passed.step();
    assert.deepEqual(state.result, { passedOut: true });
});

await check('an illegal answer from BEN stops the runner without changing it', async () => {
    const board = parsePbn(PBN).boards[0];
    let runner;
    runner = new DealRunner(board, fakeApi(board, ['1S', '1C'], () => runner, []));
    await runner.step();            // deal
    await runner.step();            // 1S
    await assert.rejects(runner.step(), ApiError);
    assert.deepEqual(runner.auction, ['1S']);
});

await check('BenApi builds the documented query and surfaces errors', async () => {
    const seen = [];
    const ok = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
    let reply = ok({ bid: '1S' });
    const api = new BenApi('http://ben:8085/', { fetch: async (url) => { seen.push(new URL(url)); return reply; }, tournament: 'mp' });

    await api.bid({ hand: 'AK97543.K.T3.AK7', seat: 'S', dealer: 'N', vul: 'None', auction: ['PASS', 'PASS'] });
    const q = seen[0].searchParams;
    assert.equal(seen[0].pathname, '/bid');
    assert.equal(q.get('ctx'), 'P-P');
    assert.equal(q.get('vul'), '');
    assert.equal(q.get('tournament'), 'mp');
    assert.equal(q.get('details'), 'true');

    reply = ok({ card: 'S7' });
    await api.play({ hand: 'h', dummy: 'd', seat: 'S', dealer: 'N', vul: 'Both', auction: ['4S', 'PASS', 'PASS', 'PASS'], played: ['DJ', 'DK'] });
    assert.equal(seen[1].searchParams.get('played'), 'DJDK');
    assert.equal(seen[1].searchParams.get('vul'), 'Both');

    reply = ok({ error: 'An error occurred: bad hand' }, 400);
    await assert.rejects(api.bid({ hand: 'x', seat: 'S', dealer: 'N', vul: 'None', auction: [] }), /bad hand/);
    reply = ok({ message: 'Called as dummy or with wrong dealer / seat 4SN' });
    await assert.rejects(api.play({ hand: 'h', dummy: 'd', seat: 'S', dealer: 'N', vul: 'None', auction: [], played: [] }), /dummy/);

    const down = new BenApi('http://ben:8085', { fetch: async () => { throw new TypeError('Failed to fetch'); } });
    await assert.rejects(down.bid({ hand: 'x', seat: 'S', dealer: 'N', vul: 'None', auction: [] }), /allowed-hosts/);
});

await check('a human seat: step() waits, submit validates, declarer plays dummy too', async () => {
    const board = parsePbn(PBN).boards[0];
    // Dealer N: N P, E 1C, S 1S, W P, N 2C, E P, S 3N -> South declares.
    const script = ['PASS', '1C', '1S', 'PASS', '2C', 'PASS', '3N', 'PASS', 'PASS', 'PASS'];
    const calls = [];
    let runner;
    const state = new GameState({ humanSeats: [false, false, true, false], noHuman: false, allVisible: false });
    runner = new DealRunner(board, fakeApi(board, script, () => runner, calls), {
        emit: (m) => state.apply(m),
        humanSeats: [2],
        localForcedPlays: false,
    });

    let inputs = 0;
    let guard = 0;
    while (!runner.done && guard++ < 300) {
        const outcome = await runner.step();
        if (outcome.kind !== 'input') continue;
        inputs += 1;
        assert.ok(runner.turn.human);
        if (outcome.need === 'bid') {
            assert.equal(outcome.seat, 2);
            assert.ok(state.expectBidInput, 'GameState offers the bidding box');
            if (runner.auction.length === 2) {
                // 1C was just bid by East: 1C again is not legal, and nothing changes.
                const before = runner.auction.length;
                assert.throws(() => runner.submitCall('1C'), /not a legal call/);
                assert.equal(runner.auction.length, before);
            }
            runner.submitCall(script[runner.auction.length], 'mine');
        } else {
            // South declares, so South plays South's cards and North's (dummy).
            assert.ok(outcome.seat === 2 || outcome.seat === 0, `asked for seat ${outcome.seat}`);
            assert.ok(state.expectCardInput, 'GameState offers the cards');
            const illegal = runner.hands[outcome.seat].find((c) => !runner.legalCards(outcome.seat).includes(c));
            if (illegal) assert.throws(() => runner.submitCard(illegal), /cannot play/);
            runner.submitCard(runner.legalCards(outcome.seat)[0]);
        }
    }
    assert.ok(runner.done);
    assert.equal(runner.contract.declarer, 2);
    // BEN was never asked to call for South, nor to play for North or South.
    assert.ok(!calls.some((c) => c[0] === 'bid' && c[1] === 'S'));
    assert.ok(!calls.some((c) => c[0] === 'play' && (c[2] === 0 || c[2] === 2)));
    assert.equal(inputs, 2 + 26);          // 1S and 3N, then 13 cards each for S and N
    assert.equal(state.explanations.filter((e) => e.text === 'mine').length, 2);
    assert.equal(runner.played.length, 52);
});

await check('a human defender makes the opening lead; a human dummy only watches', async () => {
    const board = parsePbn(PBN).boards[0];
    const script = ['PASS', '1C', '1S', 'PASS', '2C', 'PASS', '3N', 'PASS', 'PASS', 'PASS'];
    for (const [human, expectedCards] of [[3, 13], [0, 0]]) {
        let runner;
        const bidScript = [...script];
        runner = new DealRunner(board, fakeApi(board, bidScript, () => runner, []), { humanSeats: [human] });
        let cards = 0;
        let firstCardInput = null;
        while (!runner.done) {
            const outcome = await runner.step();
            if (outcome.kind !== 'input') continue;
            if (outcome.need === 'bid') runner.submitCall(script[runner.auction.length]);
            else {
                firstCardInput ??= runner.phase;
                cards += 1;
                runner.submitCard(runner.legalCards(outcome.seat)[0]);
            }
        }
        assert.equal(cards, expectedCards, `seat ${human}`);
        if (human === 3) assert.equal(firstCardInput, 'lead', 'West, on declarer\'s left, leads');
    }
});

await check('submitting when it is not your turn is refused', async () => {
    const board = parsePbn(PBN).boards[0];
    let runner;
    runner = new DealRunner(board, fakeApi(board, ['PASS', '1C'], () => runner, []), { humanSeats: [2] });
    await runner.step();                                   // deal; North (BEN) to call
    assert.throws(() => runner.submitCall('1S'), /not your turn/);
    assert.throws(() => runner.submitCard('SA'), /not your turn/);
});

await check('onTrace sees every request go out and come back, errors included', async () => {
    const events = [];
    let reply = { ok: true, status: 200, json: async () => ({ bid: '1S', who: 'NN' }) };
    const api = new BenApi('http://ben:8085', {
        fetch: async () => { if (reply instanceof Error) throw reply; return reply; },
        onTrace: (e) => events.push(e),
    });
    await api.bid({ hand: 'AK97543.K.T3.AK7', seat: 'S', dealer: 'N', vul: 'None', auction: ['PASS'] });
    assert.deepEqual(events.map((e) => e.event), ['request', 'response']);
    assert.equal(events[0].id, events[1].id);
    assert.equal(events[0].path, '/bid');
    assert.equal(events[0].params.ctx, 'P');
    assert.equal(events[0].params.seat, 'S');
    assert.ok(events[0].url.startsWith('http://ben:8085/bid?'));
    assert.equal(events[1].status, 200);
    assert.deepEqual(events[1].body, { bid: '1S', who: 'NN' });
    assert.ok(events[1].ms >= 0);

    events.length = 0;
    reply = { ok: false, status: 400, json: async () => ({ error: 'An error occurred: bad hand' }) };
    await assert.rejects(api.bid({ hand: 'x', seat: 'S', dealer: 'N', vul: 'None', auction: [] }));
    assert.deepEqual(events.map((e) => e.event), ['request', 'error']);
    assert.equal(events[1].status, 400);
    assert.match(events[1].error, /bad hand/);
    assert.deepEqual(events[1].body, { error: 'An error occurred: bad hand' });
    assert.ok(events[1].id > 0);

    events.length = 0;
    reply = new TypeError('Failed to fetch');
    await assert.rejects(api.bid({ hand: 'x', seat: 'S', dealer: 'N', vul: 'None', auction: [] }));
    assert.equal(events[1].event, 'error');
    assert.match(events[1].error, /Could not reach BEN/);

    // A listener that throws must not break the request it is watching.
    const fragile = new BenApi('http://ben:8085', {
        fetch: async () => ({ ok: true, status: 200, json: async () => ({ card: 'SA' }) }),
        onTrace: () => { throw new Error('panel broke'); },
    });
    assert.equal((await fragile.lead({ hand: 'h', seat: 'W', dealer: 'N', vul: 'None', auction: [] })).card, 'SA');
});

/** Play the board with a person at `human` who takes the first legal card and follows `script` for calls. */
async function playAsHuman(board, script, human) {
    let runner;
    runner = new DealRunner(board, fakeApi(board, script, () => runner, []), { humanSeats: [human] });
    while (!runner.done) {
        const outcome = await runner.step();
        if (outcome.kind !== 'input') continue;
        if (outcome.need === 'bid') runner.submitCall(script[runner.auction.length]);
        else runner.submitCard(runner.legalCards(outcome.seat)[0]);
    }
    return runner;
}

await check('every decision is recorded, with who made it', async () => {
    const board = parsePbn(PBN).boards[0];
    const script = ['PASS', '1C', '1S', 'PASS', '2C', 'PASS', '3N', 'PASS', 'PASS', 'PASS'];
    const runner = await playAsHuman(board, script, 2);
    assert.equal(runner.decisions.length, 10 + 52);
    assert.deepEqual(runner.decisions.slice(0, 3).map((d) => [d.kind, d.seat, d.action, d.index, d.human]),
        [['bid', 0, 'PASS', 0, false], ['bid', 1, '1C', 1, false], ['bid', 2, '1S', 2, true]]);
    // South declares: South's and North's cards are the person's.
    const cards = runner.decisions.filter((d) => d.kind === 'card');
    assert.ok(cards.every((d) => d.human === (d.seat === 0 || d.seat === 2)));
    assert.deepEqual(cards.map((d) => d.action), runner.played);
    assert.ok(cards.every((d, i) => d.index === i));
});

await check('reviewDecisions asks BEN about each of your decisions in its own position', async () => {
    const board = parsePbn(PBN).boards[0];
    const script = ['PASS', '1C', '1S', 'PASS', '2C', 'PASS', '3N', 'PASS', 'PASS', 'PASS'];
    const played = await playAsHuman(board, script, 3);       // West: on lead against 3NT
    const requests = [];
    // BEN agrees with every call and card except South's... no: West's second call and trick 2.
    const api = {
        async bid({ seat, auction }) {
            requests.push(['bid', seat, auction.length]);
            return { bid: auction.length === 7 ? '3S' : script[auction.length], explanation: 'why' };
        },
        async lead({ seat, auction }) {
            requests.push(['lead', seat, auction.length]);
            return { card: played.played[0], who: 'Simulation' };
        },
        async play({ seat, hand, played: sofar }) {
            requests.push(['play', seat, sofar.length]);
            assert.equal(hand, board.hands['NESW'.indexOf(seat)]);
            assert.deepEqual(sofar, played.played.slice(0, sofar.length), 'the play as it stood then');
            const theirs = played.played[sofar.length];
            if (sofar.length === 4) {                           // disagree once
                const other = played.decisions[4 + 10].forced ? theirs
                    : [...'SHDC'].flatMap((suit) => [...'AKQJT98765432'].map((r) => suit + r)).find((c) => c !== theirs);
                return { card: other, who: 'PIMC' };
            }
            return { card: theirs, who: 'PIMC' };
        },
    };
    const progress = [];
    const review = await reviewDecisions(played, api, { onProgress: (i, n) => progress.push([i, n]) });

    const mine = played.decisions.filter((d) => d.human);
    assert.equal(review.length, mine.length);
    assert.deepEqual(progress.at(-1), [mine.length, mine.length]);
    // West's calls: indexes 3 and 7. BEN would have bid 3S at index 7.
    const calls = review.filter((d) => d.kind === 'bid');
    assert.deepEqual(calls.map((d) => [d.index, d.action, d.ben, d.same]), [[3, 'PASS', 'PASS', true], [7, 'PASS', '3S', false]]);
    assert.equal(calls[1].explanation, 'why');
    assert.deepEqual(requests.filter((r) => r[0] === 'bid'), [['bid', 'W', 3], ['bid', 'W', 7]]);
    // The opening lead goes to /lead, forced cards are not asked about at all.
    assert.deepEqual(requests.find((r) => r[0] !== 'bid'), ['lead', 'W', 10]);
    const forced = review.filter((d) => d.forced);
    assert.ok(forced.every((d) => d.same && d.who === 'Forced'));
    assert.equal(requests.filter((r) => r[0] === 'play').length,
        review.filter((d) => d.kind === 'card' && !d.forced && d.index > 0).length);
    const trick2 = review.find((d) => d.index === 4 && d.kind === 'card');
    if (trick2 && !trick2.forced) assert.equal(trick2.same, false);
    assert.ok(review.filter((d) => d.kind === 'card' && d.index !== 4).every((d) => d.same));
});

await check('a failed request marks that decision and the review carries on', async () => {
    const board = parsePbn(PBN).boards[0];
    const script = ['PASS', '1C', '1S', 'PASS', '2C', 'PASS', '3N', 'PASS', 'PASS', 'PASS'];
    const played = await playAsHuman(board, script, 3);
    let n = 0;
    const api = {
        async bid() { if (n++ === 0) throw new ApiError('down'); return { bid: 'PASS' }; },
        async lead() { return { card: played.played[0] }; },
        async play({ played: sofar }) { return { card: played.played[sofar.length] }; },
    };
    const review = await reviewDecisions(played, api);
    assert.equal(review[0].error, 'down');
    assert.equal(review[0].ben, null);
    assert.equal(review.length, played.decisions.filter((d) => d.human).length);
});

await check('BEN\'s version of the board, and the comparison with yours', async () => {
    const board = parsePbn(PBN).boards[0];
    const script = ['PASS', '1C', '1S', 'PASS', '2C', 'PASS', '3N', 'PASS', 'PASS', 'PASS'];
    let ben;
    const steps = [];
    ben = await playBenVersion(board, fakeApi(board, script, () => ben, []), {
        onStep: (outcome, runner) => { ben = runner; steps.push(outcome.kind); },
    });
    assert.ok(ben.done);
    assert.equal(ben.decisions.filter((d) => d.human).length, 0);
    assert.equal(steps.filter((k) => k === 'trick').length, 13);

    // Scores are kept N-S; the comparison is from the person's side.
    assert.deepEqual(compareResults({ score: 400 }, { score: -100 }, 2), { yourScore: 400, benScore: -100, diff: 500, imps: 11 });
    assert.deepEqual(compareResults({ score: 400 }, { score: -100 }, 1), { yourScore: -400, benScore: 100, diff: -500, imps: -11 });
    assert.deepEqual(compareResults({}, { score: 50 }, 0), { yourScore: 0, benScore: 50, diff: -50, imps: -2 });
    assert.equal(impsFor(10), 0);
    assert.equal(Object.is(impsFor(-10), -0), false);
    assert.equal(impsFor(4000), 24);
});

/* ---------------------------------------------------------- files on disk */

for (const path of process.argv.slice(2)) {
    await check(`parse ${path}`, () => {
        const { boards, errors } = parseDealFile(path, readFileSync(path, 'latin1'));
        console.log(`  ${path}: ${boards.length} deals, ${errors.length} skipped${errors.length ? ` (${errors[0]})` : ''}`);
        assert.ok(boards.length > 0);
    });
}

for (const [status, name] of results) console.log(`${status.padEnd(4)} ${name}`);
const failed = results.filter(([s]) => s === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exitCode = failed ? 1 : 0;
