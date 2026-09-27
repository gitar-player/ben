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
} from './allwyn.api.js';
import { GameState } from './allwyn.state.js';

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
