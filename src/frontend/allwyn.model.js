/**
 * Domain model - bridge rules and deal state. No DOM, no network.
 *
 * Ported from the classes in bridge.js so this UI does not depend on that
 * file's globals. The rules (following suit, trick winner, minimum biddable
 * bid) are deliberately kept identical; only the rendering was left behind,
 * which lives in allwyn.render.js.
 */

export const SUITS = ['S', 'H', 'D', 'C'];
export const RANKS = 'AKQJT98765432';
export const SEATS = ['north', 'east', 'south', 'west'];
export const NORTH = 0, EAST = 1, SOUTH = 2, WEST = 3;

/**
 * How the deal is vulnerable, as the scoresheet writes it.
 * @param {[boolean, boolean]} vuln [north-south, east-west], as deal_start sends
 *   it and as the 'N E-W' half of a ?deal= parameter encodes it.
 */
export function vulnerabilityLabel(vuln = []) {
    const [ns, ew] = vuln;
    if (ns && ew) return 'Both';
    if (ns) return 'N-S';
    if (ew) return 'E-W';
    return 'None';
}

/**
 * Split the contract the server reports, e.g. "4HXS" -> 4 hearts doubled by
 * South, "3NN" -> 3NT by North. Returns null for a passed-out deal.
 */
export function parseContract(contract) {
    const m = /^([1-7])([CDHSN])(XX|X)?([NESW])$/.exec(contract ?? '');
    if (!m) return null;
    return { level: Number(m[1]), strain: m[2], doubling: m[3] ?? '', declarer: m[4] };
}

/** "made exactly", "made +2", "down 1" - from the tricks declarer took. */
export function contractOutcome(level, tricksByDeclarer) {
    const difference = tricksByDeclarer - (level + 6);
    if (difference === 0) return 'made exactly';
    if (difference > 0) return `made +${difference}`;
    return `down ${-difference}`;
}

/**
 * Read a North-South-relative score the way a scoresheet does: whichever side
 * the points went to, and how many. Null when there is no score to show.
 */
export function scoreLine(score) {
    if (!Number.isFinite(score)) return null;
    if (score === 0) return 'No score';
    return score > 0 ? `N-S +${score}` : `E-W +${-score}`;
}

/** A single card. `suit` is an index into SUITS, `value` orders A(0) to 2(12). */
export class Card {
    constructor(symbol) {
        this.symbol = symbol;
        this.suit = SUITS.indexOf(symbol[0]);
        this.rank = symbol[1];
        this.value = RANKS.indexOf(symbol[1]);
    }

    get isRed() {
        return this.suit === 1 || this.suit === 2;
    }
}

/** Parse a PBN holding, e.g. "AK4.QJ.T98.65432". */
export function parseHand(pbnString) {
    const cards = [];
    pbnString.split('.').forEach((holding, suitIndex) => {
        for (const rank of holding) cards.push(new Card(SUITS[suitIndex] + rank));
    });
    return cards;
}

/** One player's cards. Immutable in play(): returns a new Hand. */
export class Hand {
    constructor(cards = [], isPublic = false, rendered = false) {
        this.isPublic = isPublic;
        this.rendered = rendered;
        this.cards = cards;
    }

    get cards() {
        return this._cards;
    }

    set cards(newCards) {
        this._cards = newCards;
        this.suits = [[], [], [], []];
        for (const card of this._cards) this.suits[card.suit].push(card);
    }

    hasCard(card) {
        return this._cards.some((c) => c.symbol === card.symbol);
    }

    /** Legal to play into `trick`? Must follow suit when able. */
    isPlayable(card, trick) {
        if (!this.hasCard(card)) return false;
        if (!trick || trick.cards.length === 0) return true;
        if (trick.cards.length >= 4) return false;
        const leadSuit = trick.cards[0].suit;
        if (this.suits[leadSuit].length === 0) return true;
        return card.suit === leadSuit;
    }

    play(card) {
        const remaining = this._cards.filter((c) => c.symbol !== card.symbol);
        return new Hand(remaining, this.isPublic, this.rendered);
    }
}

/** Cards played to one trick, in play order starting from leadPlayer. */
export class Trick {
    constructor(leadPlayer, cards = []) {
        this.leadPlayer = leadPlayer;
        this.cards = cards;
    }

    isComplete() {
        return this.cards.length === 4;
    }

    /**
     * Seat that won the trick, or undefined if it is not finished.
     * `strain` is 0=NT, 1=C, 2=D, 3=H, 4=S, matching the server, so the trump
     * suit index is strain - 1 in SUITS order... note SUITS is S,H,D,C while
     * strain counts from clubs, which is why the original code compares
     * card.suit to strain - 1 directly. Kept identical on purpose.
     */
    winner(strain) {
        if (!this.isComplete()) return undefined;
        const trump = strain - 1;
        const trumpPlayed = trump >= 0 && this.cards.some((c) => c.suit === trump);
        const relevantSuit = trumpPlayed ? trump : this.cards[0].suit;

        let bestValue = 100;
        let bestIndex = -1;
        this.cards.forEach((card, i) => {
            if (card.suit !== relevantSuit) return;
            if (card.value < bestValue) {
                bestValue = card.value;
                bestIndex = i;
            }
        });
        return (this.leadPlayer + bestIndex) % 4;
    }
}

/** The auction so far, with the padding that puts each call under its seat. */
export class Auction {
    constructor(dealer, vuln, bids = []) {
        this.dealer = dealer;
        this.vuln = vuln;
        this.bids = bids.filter((b) => b !== 'PAD_START');

        const padCount = [1, 2, 3, 0][dealer];
        this.paddedBids = [...Array(padCount).fill(''), ...this.bids];
    }

    /** Lowest level that can still be bid. */
    getMinimumBiddableLevel() {
        for (let i = this.bids.length - 1; i >= 0; i--) {
            const level = parseInt(this.bids[i][0], 10);
            if (isNaN(level)) continue;
            return this.bids[i][1] === 'N' ? level + 1 : level;
        }
        return 1;
    }

    /** Index into 'CDHSN' of the lowest strain biddable at `level`. */
    getMinBiddableSuitForLevel(level) {
        for (let i = this.bids.length - 1; i >= 0; i--) {
            const lastLevel = parseInt(this.bids[i][0], 10);
            if (isNaN(lastLevel)) continue;
            if (lastLevel < level) return 0;
            return 'CDHSN'.indexOf(this.bids[i][1]) + 1;
        }
        return 0;
    }
}

/** Everything known about the deal in progress. */
export class Deal {
    constructor(dealer, vuln, handStrings, boardNo) {
        this.dealer = dealer;
        this.vuln = vuln;
        this.boardNo = boardNo;

        this.hands = handStrings.map((pbn) => new Hand(pbn ? parseHand(pbn) : []));

        this.turn = dealer;
        this.auction = [];
        this.tricks = [];
        this.currentTrick = undefined;
        this.tricksCount = [0, 0];

        this.declarer = undefined;
        this.dummy = undefined;
        this.strain = undefined;

        this.canDouble = false;
        this.canRedouble = false;
    }

    get auctionModel() {
        return new Auction(this.dealer, this.vuln, this.auction);
    }

    advanceTurn() {
        this.turn = (this.turn + 1) % 4;
    }
}
