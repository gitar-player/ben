/**
 * The session scorecard for allwyn-api.html: one row per board played, with
 * the score at your table, at the table recorded in the file, and at BEN's
 * table, each split into We and They. No DOM, no storage - allwyn.apimain.js
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
 * four, which counts North-South as "we"). `recorded` and `ben` may be null.
 */
export function scorecardRow({ key, board, label, seat, ours, recorded = null, ben = null }) {
    return { key, board, label, seat, ours, recorded, ben, when: new Date().toISOString() };
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

/** Column totals for We and They at each table, over rows that have that table. */
export function totals(rows) {
    const sum = { ours: { we: 0, they: 0 }, recorded: { we: 0, they: 0 }, ben: { we: 0, they: 0 } };
    for (const row of rows) {
        for (const table of ['ours', 'recorded', 'ben']) {
            const split = weThey(row[table]?.score, row.seat);
            if (!split) continue;
            sum[table].we += split.we ?? 0;
            sum[table].they += split.they ?? 0;
        }
    }
    return sum;
}

/** The scorecard as CSV, one line per board, results in letters. */
export function toCsv(rows) {
    const header = ['Board', 'Played as', 'Result', 'We', 'They',
        'Recorded result', 'Recorded We', 'Recorded They', 'BEN result', 'BEN We', 'BEN They'];
    const cell = (v) => {
        const text = v === null || v === undefined ? '' : String(v);
        return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const lines = [header.map(cell).join(',')];
    for (const row of rows) {
        const split = (table) => weThey(row[table]?.score, row.seat) ?? { we: null, they: null };
        const ours = split('ours');
        const rec = split('recorded');
        const ben = split('ben');
        lines.push([
            row.board || row.label,
            row.seat < 0 ? 'BEN (all four)' : SEATS[row.seat],
            resultText(row.ours),
            ours.we, ours.they,
            resultText(row.recorded), rec.we, rec.they,
            resultText(row.ben), ben.we, ben.they,
        ].map(cell).join(','));
    }
    return lines.join('\n') + '\n';
}
