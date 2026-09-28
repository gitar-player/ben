/**
 * Reading deals out of .pbn and .lin files. No DOM, no network.
 *
 * Both parsers return the same shape, one entry per board found:
 *
 *   { label, board, dealer: 'N'|'E'|'S'|'W', vul: 'None'|'NS'|'EW'|'Both',
 *     hands: [north, east, south, west] }      // PBN holdings, "AK4.QJ.T98.65432"
 *
 * plus, when the file records how the board went at the table:
 *
 *   recorded: { auction: [...calls], contract: {level, strain, doubling,
 *               declarer: seat index} | null, passedOut, tricks (declarer's,
 *               or null if not known), score (N-S's, or null), hasResult }
 *
 * The recording is only ever compared against: BEN bids and plays the deal
 * afresh whatever the file says happened.
 */

import { normaliseCall, auctionIsOver, isLegalCall, contractFromAuction, scoreContract } from './allwyn.api.js';
import { Card, Trick } from './allwyn.model.js';

const SEATS = 'NESW';
const RANKS = 'AKQJT98765432';

/** Dealer and vulnerability from the board number, as printed on a board. */
export function boardDealer(board) {
    const n = Number(board);
    return Number.isInteger(n) && n > 0 ? SEATS[(n - 1) % 4] : 'N';
}

export function boardVulnerability(board) {
    // The standard 16-board cycle.
    const cycle = ['None', 'NS', 'EW', 'Both', 'NS', 'EW', 'Both', 'None',
                   'EW', 'Both', 'None', 'NS', 'Both', 'None', 'NS', 'EW'];
    const n = Number(board);
    return Number.isInteger(n) && n > 0 ? cycle[(n - 1) % 16] : 'None';
}

/** "None", "Love", "-", "NS", "N-S", "EW", "E-W", "All", "Both" -> the four names. */
export function normaliseVulnerability(value) {
    const v = String(value ?? '').toUpperCase().replace(/[^A-Z]/g, '');
    if (v === 'NS') return 'NS';
    if (v === 'EW') return 'EW';
    if (v === 'ALL' || v === 'BOTH' || v === 'B') return 'Both';
    return 'None';
}

/** Sort each suit high to low, so hands read the same whatever the source. */
function sortHolding(holding) {
    return [...holding.toUpperCase().replace(/10/g, 'T')]
        .filter((c) => RANKS.includes(c))
        .sort((a, b) => RANKS.indexOf(a) - RANKS.indexOf(b))
        .join('');
}

function normaliseHand(hand) {
    const suits = hand.split('.');
    if (suits.length !== 4) return null;
    return suits.map(sortHolding).join('.');
}

/** The cards none of the other three hands hold - for a file that leaves one out. */
function missingHand(hands) {
    return [0, 1, 2, 3].map((suit) => {
        const seen = new Set(hands.filter(Boolean).flatMap((h) => [...h.split('.')[suit]]));
        return [...RANKS].filter((r) => !seen.has(r)).join('');
    }).join('.');
}

/** Complete and check four hands: 13 cards each, 52 different cards between them. */
function finishHands(hands) {
    const known = hands.filter(Boolean);
    if (known.length === 3) hands = hands.map((h) => h ?? missingHand(hands));
    if (hands.some((h) => !h)) throw new Error('the deal does not give all four hands');

    const all = new Set();
    hands.forEach((hand, seat) => {
        const cards = hand.split('.').flatMap((holding, suit) => [...holding].map((r) => 'SHDC'[suit] + r));
        if (cards.length !== 13) {
            throw new Error(`${'North East South West'.split(' ')[seat]} has ${cards.length} cards, not 13`);
        }
        cards.forEach((card) => all.add(card));
    });
    if (all.size !== 52) throw new Error('the same card appears in more than one hand');
    return hands;
}

/* --------------------------------------------------------------------- PBN */

/**
 * Parse PBN text. Games are the runs of [Tag "value"] lines; a value of "#"
 * repeats the previous game's value, as the PBN standard allows.
 */
export function parsePbn(text) {
    const boards = [];
    const errors = [];
    let tags = {};
    let previous = {};

    const flush = () => {
        if (!tags.Deal) {
            tags = {};
            return;
        }
        for (const [key, value] of Object.entries(tags)) {
            if (value === '#' && previous[key] !== undefined) tags[key] = previous[key];
        }
        try {
            boards.push(pbnGame(tags));
        } catch (error) {
            errors.push(`Board ${tags.Board ?? '?'}: ${error.message}`);
        }
        previous = tags;
        tags = {};
    };

    // The lines under [Auction] and [Play] are the calls and cards; anything
    // in {braces}, which may run over several lines, is commentary.
    let section = null;
    let inComment = false;
    for (const raw of text.split(/\r?\n/)) {
        let line = raw.trim();
        if (inComment) {
            const end = line.indexOf('}');
            if (end < 0) continue;
            line = line.slice(end + 1).trim();
            inComment = false;
        }
        line = line.replace(/\{[^}]*\}/g, ' ');
        if (line.includes('{')) {
            line = line.slice(0, line.indexOf('{'));
            inComment = true;
        }
        line = line.trim();
        if (!line || line.startsWith('%') || line.startsWith(';')) continue;
        const tag = /^\[(\w+)\s+"(.*)"\]$/.exec(line);
        if (!tag) {
            if (section === 'Auction' || section === 'Play') {
                (tags[`_${section}`] ??= []).push(line);
            }
            continue;
        }
        // A new [Event] or [Board] after a deal starts the next game, whether
        // or not there was a blank line between them.
        if ((tag[1] === 'Event' || tag[1] === 'Board') && tags.Deal) flush();
        tags[tag[1]] = tag[2];
        section = tag[1];
    }
    flush();
    return { boards, errors };
}

function pbnGame(tags) {
    const deal = /^([NESW]):\s*(.+)$/i.exec(tags.Deal.trim());
    if (!deal) throw new Error(`cannot read the deal "${tags.Deal}"`);

    const first = SEATS.indexOf(deal[1].toUpperCase());
    const parts = deal[2].trim().split(/\s+/);
    if (parts.length !== 4) throw new Error('the deal does not give four hands');

    const hands = [null, null, null, null];
    parts.forEach((part, i) => {
        hands[(first + i) % 4] = part === '-' ? null : normaliseHand(part);
    });

    const board = (tags.Board ?? '').trim();
    const dealerTag = (tags.Dealer ?? '').trim().toUpperCase();
    const dealer = /^[NESW]$/.test(dealerTag) ? dealerTag : boardDealer(board || 1);
    const vul = tags.Vulnerable !== undefined
        ? normaliseVulnerability(tags.Vulnerable)
        : boardVulnerability(board || 1);

    const event = tags.Event && tags.Event !== '?' ? tags.Event : '';
    return {
        label: [board ? `Board ${board}` : 'Deal', event].filter(Boolean).join(' - '),
        board,
        dealer,
        vul,
        hands: finishHands(hands),
        recorded: pbnRecorded(tags, dealer, vul),
    };
}

/**
 * How the board went at the table, from [Contract], [Declarer], [Result] and
 * the [Auction] and [Play] sections. Null when the file says nothing.
 */
function pbnRecorded(tags, dealer, vul) {
    const dealerIndex = SEATS.indexOf(dealer);

    // Calls, from the auction's first seat - which should be the dealer.
    let auction = [];
    const auctionSeat = SEATS.indexOf((tags.Auction ?? '').trim().toUpperCase());
    if (auctionSeat === dealerIndex && tags._Auction) {
        auction = readCalls(tags._Auction.join(' ').split(/\s+/));
    }

    // The contract, from the tags when they give it, else from the auction.
    let contract = null;
    let passedOut = false;
    const contractTag = (tags.Contract ?? '').trim().toUpperCase();
    const declarerTag = SEATS.indexOf((tags.Declarer ?? '').trim().toUpperCase());
    const m = /^([1-7])(NT|[CDHSN])(XX|X)?$/.exec(contractTag);
    if (m && declarerTag >= 0) {
        contract = { level: Number(m[1]), strain: m[2][0], doubling: m[3] ?? '', declarer: declarerTag };
    } else if (contractTag === 'PASS' || contractTag === 'AP') {
        passedOut = true;
    } else if (auction.length && auctionIsOver(auction)) {
        contract = contractFromAuction(dealerIndex, auction);
        passedOut = !contract;
    }

    // Declarer's tricks: [Result] if given, else counted from a full [Play].
    let tricks = null;
    if (/^\d+$/.test((tags.Result ?? '').trim())) tricks = Number(tags.Result.trim());
    else if (contract && tags._Play) tricks = pbnPlayTricks(tags, contract);

    return recording(auction, contract, passedOut, tricks, vul);
}

/**
 * Tricks declarer took, from a [Play] section: one line per trick, the
 * columns in seat order from the [Play] seat - not in the order played. Null
 * unless all 13 tricks are there.
 */
function pbnPlayTricks(tags, contract) {
    const first = SEATS.indexOf((tags.Play ?? '').trim().toUpperCase());
    if (first < 0) return null;
    const rows = tags._Play.join(' ').split(/\s+/).filter((t) => t && t !== '*');
    const strain = 'NSHDC'.indexOf(contract.strain);
    let leader = (contract.declarer + 1) % 4;
    let won = 0;
    for (let trick = 0; trick < 13; trick++) {
        const row = rows.slice(trick * 4, trick * 4 + 4);
        if (row.length < 4 || row.some((c) => !/^[SHDC][2-9TJQKA]$/i.test(c))) return null;
        const bySeat = [];
        row.forEach((card, column) => { bySeat[(first + column) % 4] = card.toUpperCase(); });
        const played = [0, 1, 2, 3].map((i) => new Card(bySeat[(leader + i) % 4]));
        leader = new Trick(leader, played).winner(strain);
        if (leader % 2 === contract.declarer % 2) won += 1;
    }
    return won;
}

/** Tokens from an auction section or mb| tags -> calls, stopping at anything unreadable. */
function readCalls(tokens) {
    const calls = [];
    for (let token of tokens) {
        token = token.replace(/!+$/, '').trim();
        // Note references (=1=), annotations ($1) and the end marker (*) are not calls.
        if (!token || /^=\d+=$/.test(token) || /^\$\d+$/.test(token) || token === '*' || token === '-') continue;
        if (token.toUpperCase() === 'AP') {
            // "All pass": passes until the auction is over.
            do calls.push('PASS'); while (!auctionIsOver(calls));
            break;
        }
        const call = normaliseCall(token);
        if (!/^(PASS|X|XX|[1-7][CDHSN])$/.test(call) || !isLegalCall(calls, call)) break;
        calls.push(call);
        if (auctionIsOver(calls)) break;
    }
    return calls;
}

/** The recorded result with its N-S score worked out, or null if there is nothing to go on. */
function recording(auction, contract, passedOut, tricks, vul) {
    if (!contract && !passedOut && auction.length === 0) return null;
    let score = null;
    if (passedOut) score = 0;
    else if (contract && Number.isInteger(tricks) && tricks >= 0 && tricks <= 13) {
        const vulnerable = vul === 'Both' || vul === (contract.declarer % 2 === 0 ? 'NS' : 'EW');
        const declarerScore = scoreContract(contract, vulnerable, tricks);
        score = contract.declarer % 2 === 0 ? declarerScore : -declarerScore;
    } else {
        tricks = null;
    }
    return { auction, contract, passedOut, tricks, score, hasResult: score !== null };
}

/* --------------------------------------------------------------------- LIN */

/**
 * Parse BBO .lin text - a single hand record, a vugraph/tournament file with
 * many, or a handviewer URL with the lin in its query string.
 *
 * Each `md|` starts a deal: a dealer digit (1=S 2=W 3=N 4=E) then the hands
 * South, West, North, East, comma separated. East is often left blank.
 */
export function parseLin(text) {
    let lin = text.trim();
    if (/%7C/i.test(lin)) {
        try { lin = decodeURIComponent(lin.replace(/\+/g, ' ')); } catch (_) { /* leave it */ }
    }
    const urlLin = /[?&]lin=([^&]*)/.exec(lin);
    if (urlLin) lin = urlLin[1];
    lin = lin.replace(/\r?\n/g, '');

    const boards = [];
    const errors = [];
    const starts = [...lin.matchAll(/md\|/gi)].map((m) => m.index);

    starts.forEach((start, i) => {
        // A deal's own tags (board number, vulnerability) mostly follow its
        // md|, up to the next one. Some writers put qx|, ah| or sv| just ahead
        // of md| instead: that is the file header for the first deal, and
        // from the last qx| on for the others.
        const segment = lin.slice(start, starts[i + 1] ?? lin.length);
        const before = lin.slice(i === 0 ? 0 : starts[i - 1], start);
        const qx = before.lastIndexOf('qx|');
        const lookBack = qx >= 0 ? before.slice(qx) : (i === 0 ? before : '');
        try {
            boards.push(linDeal(segment, lookBack));
        } catch (error) {
            errors.push(`Deal ${i + 1}: ${error.message}`);
        }
    });
    if (starts.length === 0) errors.push('No md| (deal) found in the file');
    return { boards, errors };
}

function linTag(tag, ...texts) {
    for (const text of texts) {
        const m = new RegExp(`(?:^|\\|)${tag}\\|([^|]*)\\|`, 'i').exec(text);
        if (m) return m[1];
    }
    return undefined;
}

function linDeal(segment, lookBack) {
    const md = /^md\|([^|]*)\|/i.exec(segment);
    if (!md) throw new Error('empty md|');
    const value = md[1];

    const linHand = (text) => {
        if (!text) return null;
        const m = /^S([^HDC]*)H([^SDC]*)D([^SHC]*)C([^SHD]*)$/i.exec(text.trim());
        if (!m) throw new Error(`cannot read the hand "${text}"`);
        return [m[1], m[2], m[3], m[4]].map(sortHolding).join('.');
    };

    // Dealer digit is optional in some files; hands are always S, W, N, E.
    const digit = /^[1-4]/.test(value) ? value[0] : null;
    const [south, west, north, east] = (digit ? value.slice(1) : value).split(',');
    const hands = finishHands([linHand(north), linHand(east), linHand(south), linHand(west)]);

    const title = linTag('ah', segment, lookBack) ?? '';
    const boardMatch = /(\d+)/.exec(title);
    const board = boardMatch ? boardMatch[1] : '';
    const room = /^qx\|([oc])\d+/i.exec(lookBack)?.[1];

    const dealer = digit ? { 1: 'S', 2: 'W', 3: 'N', 4: 'E' }[digit] : boardDealer(board || 1);

    const sv = linTag('sv', segment, lookBack);
    const vul = sv !== undefined
        ? ({ n: 'NS', e: 'EW', b: 'Both' }[sv.toLowerCase()] ?? 'None')
        : boardVulnerability(board || 1);

    const roomName = room ? (room.toLowerCase() === 'o' ? 'Open room' : 'Closed room') : '';
    return {
        label: [board ? `Board ${board}` : 'Deal', roomName].filter(Boolean).join(' - '),
        board,
        dealer,
        vul,
        hands,
        recorded: linRecorded(segment, dealer, vul),
    };
}

/**
 * How the board went, from the deal's mb| calls, pc| cards (in the order
 * played) and mc| claim (declarer's total tricks). Null when there are none.
 */
function linRecorded(segment, dealer, vul) {
    const dealerIndex = SEATS.indexOf(dealer);
    const tokens = [...segment.matchAll(/(?<=^|\|)mb\|([^|]*)\|/gi)].map((m) => {
        const t = m[1].replace(/!+$/, '').trim().toUpperCase();
        return { P: 'PASS', D: 'X', R: 'XX' }[t] ?? t;
    });
    const auction = readCalls(tokens);
    if (!auctionIsOver(auction)) return recording(auction, null, false, null, vul);

    const contract = contractFromAuction(dealerIndex, auction);
    if (!contract) return recording(auction, null, true, null, vul);

    const claim = /(?:^|\|)mc\|(\d+)\|/i.exec(segment);
    let tricks = claim ? Number(claim[1]) : null;
    if (tricks === null) {
        const cards = [...segment.matchAll(/(?<=^|\|)pc\|([^|]*)\|/gi)]
            .map((m) => m[1].trim().toUpperCase().replace('10', 'T'));
        if (cards.length === 52 && cards.every((c) => /^[SHDC][2-9TJQKA]$/.test(c))) {
            const strain = 'NSHDC'.indexOf(contract.strain);
            let leader = (contract.declarer + 1) % 4;
            tricks = 0;
            for (let i = 0; i < 52; i += 4) {
                leader = new Trick(leader, cards.slice(i, i + 4).map((c) => new Card(c))).winner(strain);
                if (leader % 2 === contract.declarer % 2) tricks += 1;
            }
        }
    }
    return recording(auction, contract, false, tricks, vul);
}

/* ------------------------------------------------------------------ either */

/** Pick the parser from the file name, falling back to sniffing the text. */
export function parseDealFile(name, text) {
    const lower = String(name ?? '').toLowerCase();
    if (lower.endsWith('.lin')) return parseLin(text);
    if (lower.endsWith('.pbn')) return parsePbn(text);
    return /\[Deal\s+"/i.test(text) ? parsePbn(text) : parseLin(text);
}
