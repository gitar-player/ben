/**
 * The session scorecard for allwyn-api.html: for each board played, a line
 * for your table, the table recorded in the file and BEN's table - contract,
 * result, and the score split into We and They. No DOM, no storage - allwyn.apimain.js
 * does those - so the arithmetic can be tested under node.
 *
 * A row keeps each table's result as {contract, tricks, score}, where
 * contract is {level, strain, doubling, declarer: seat index} or null for a
 * passed-out board, and score is North-South's. Who "we" are is worked out
 * when the row is shown, from the seat it was played from.
 */

const SEATS = 'NESW';

/** A table's result in the row's form, from a DealRunner or a recording. */
export function tableResult(contract, tricks, score) {
    return {
        contract: contract ? { ...contract } : null,
        tricks: Number.isFinite(tricks) ? tricks : null,
        score: Number.isFinite(score) ? score : null,
    };
}

/**
 * One scorecard row. `seat` is the seat played from (-1 when BEN played all
 * four, which counts North-South as "we"). `recorded` lists the tables the
 * file records - [{label: 'Open room', result}, ...], empty when none - and
 * `ben` may be null.
 */
export function scorecardRow({ key, board, label, seat, ours, recorded = [], ben = null }) {
    return { key, board, label, seat, ours, recorded, ben, when: new Date().toISOString() };
}

/**
 * A row's recorded tables. Rows saved before team matches were handled hold
 * one result, or null, rather than a list; they read as one "Recorded" table.
 */
export function recordedTables(row) {
    if (Array.isArray(row.recorded)) return row.recorded;
    return row.recorded ? [{ label: 'Recorded', result: row.recorded }] : [];
}

/**
 * {we, they} from a North-South score and the seat played from: whichever
 * side scored gets the points, the other nothing. Null when there is no
 * score to split; a passed-out board (0) leaves both empty.
 */
export function weThey(score, seat) {
    if (!Number.isFinite(score)) return null;
    const weAreNS = seat < 0 || seat % 2 === 0;
    const ours = weAreNS ? score : -score;
    return { we: ours > 0 ? ours : null, they: ours < 0 ? -ours : null };
}

/**
 * The result as a scorecard writes it: "3DN-1", "4HS+2", "3NTS=", "4SXW-3",
 * "Pass". `suitText` maps a strain letter to how it is shown (letters by
 * default; the page swaps in pips).
 */
export function resultText(result, suitText = (s) => (s === 'N' ? 'NT' : s)) {
    if (!result) return '';
    if (!result.contract) return 'Pass';
    const { level, strain, doubling, declarer } = result.contract;
    const made = result.tricks === null ? '' : madeText(level, result.tricks);
    return `${level}${suitText(strain)}${doubling}${SEATS[declarer]}${made}`;
}

function madeText(level, tricks) {
    const over = tricks - (level + 6);
    return over === 0 ? '=' : over > 0 ? `+${over}` : `-${-over}`;
}

/** The contract with its declarer, "3DN", "4SXW", "3NTS", or "Pass". */
export function contractText(result, suitText = (s) => (s === 'N' ? 'NT' : s)) {
    if (!result) return '';
    if (!result.contract) return 'Pass';
    const { level, strain, doubling, declarer } = result.contract;
    return `${level}${suitText(strain)}${doubling}${SEATS[declarer]}`;
}

/** How the contract went: "=", "+2", "-1"; empty when passed out or not known. */
export function outcomeText(result) {
    if (!result?.contract || result.tricks === null) return '';
    return madeText(result.contract.level, result.tricks);
}

/**
 * The lines a board shows, in order: your table, the recorded one, BEN's.
 * With BEN at all four seats the first line is BEN's own table already, so
 * there is no separate BEN line.
 */
export function boardLines(row) {
    const lines = [{ table: 'ours', label: row.seat < 0 ? 'BEN (all four)' : 'You', result: row.ours, missing: '' }];
    const recorded = recordedTables(row);
    if (recorded.length === 0) {
        lines.push({ table: 'recorded', label: 'Recorded', result: null, missing: 'not in file' });
    }
    for (const { label, result } of recorded) {
        lines.push({ table: 'recorded', label, result, missing: 'no result recorded' });
    }
    if (row.seat >= 0) lines.push({ table: 'ben', label: 'BEN', result: row.ben, missing: 'not compared yet' });
    return lines;
}

/**
 * We and They totals for each table that has any scores - You, each recorded
 * table by name (Open room, Closed room, Recorded), BEN - in that order.
 */
export function totals(rows) {
    const sums = new Map();
    for (const row of rows) {
        for (const line of boardLines(row)) {
            const split = weThey(line.result?.score, row.seat);
            if (!split) continue;
            const key = line.table === 'recorded' ? `recorded:${line.label}` : line.table;
            const label = line.table === 'ours' ? 'You' : line.label;
            const sum = sums.get(key) ?? { key, label, we: 0, they: 0 };
            sum.we += split.we ?? 0;
            sum.they += split.they ?? 0;
            sums.set(key, sum);
        }
    }
    const rank = (key) => (key === 'ours' ? 0 : key === 'ben' ? 2 : 1);
    return [...sums.values()].sort((a, b) => rank(a.key) - rank(b.key));
}

/**
 * The scorecard as CSV, laid out as the page shows it: a line per table per
 * board (You, Recorded, BEN), contracts in letters. A table with nothing to
 * show - not in the file, BEN not asked - has its line with empty cells.
 */
export function toCsv(rows) {
    const header = ['Board', 'Played as', 'Table', 'Contract', 'Result', 'We', 'They'];
    const cell = (v) => {
        const text = v === null || v === undefined ? '' : String(v);
        return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const lines = [header.map(cell).join(',')];
    for (const row of rows) {
        for (const line of boardLines(row)) {
            const split = weThey(line.result?.score, row.seat) ?? { we: null, they: null };
            lines.push([
                row.board || row.label,
                row.seat < 0 ? 'BEN (all four)' : SEATS[row.seat],
                line.label,
                contractText(line.result),
                outcomeText(line.result),
                split.we, split.they,
            ].map(cell).join(','));
        }
    }
    return lines.join('\n') + '\n';
}
