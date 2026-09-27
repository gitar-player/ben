/**
 * Reading deals out of .pbn and .lin files. No DOM, no network.
 *
 * Both parsers return the same shape, one entry per board found:
 *
 *   { label, board, dealer: 'N'|'E'|'S'|'W', vul: 'None'|'NS'|'EW'|'Both',
 *     hands: [north, east, south, west] }      // PBN holdings, "AK4.QJ.T98.65432"
 *
 * Only the deal is read. Any auction or play recorded in the file is ignored:
 * the point of allwyn-api.html is to have BEN bid and play the cards afresh.
 */

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

    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (line.startsWith('%') || line.startsWith(';')) continue;
        const tag = /^\[(\w+)\s+"(.*)"\]$/.exec(line);
        if (!tag) continue;
        // A new [Event] or [Board] after a deal starts the next game, whether
        // or not there was a blank line between them.
        if ((tag[1] === 'Event' || tag[1] === 'Board') && tags.Deal) flush();
        tags[tag[1]] = tag[2];
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
    };
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
    };
}

/* ------------------------------------------------------------------ either */

/** Pick the parser from the file name, falling back to sniffing the text. */
export function parseDealFile(name, text) {
    const lower = String(name ?? '').toLowerCase();
    if (lower.endsWith('.lin')) return parseLin(text);
    if (lower.endsWith('.pbn')) return parsePbn(text);
    return /\[Deal\s+"/i.test(text) ? parsePbn(text) : parseLin(text);
}
