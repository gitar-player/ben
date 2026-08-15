/**
 * Game state - the single source of truth for the page.
 *
 * Every server message goes through `apply()`, which updates state and returns
 * the side effects the UI still has to perform (open a dialog, start the
 * auto-confirm timer). Nothing here touches the DOM, so the whole game loop can
 * be replayed and asserted on outside a browser - see allwyn.test.mjs.
 *
 * bridge.html interleaves state updates with render calls inside one 250-line
 * onmessage handler, which is why a change to the auction has to remember to
 * re-render the auction, the table, and the bidding box by hand. Here the
 * caller renders once from state after every message.
 */

import { Deal, Trick, Card, parseHand } from './allwyn.model.js';

export class GameState {
    constructor(options) {
        this.options = options;
        this.deal = null;

        this.expectBidInput = false;
        this.expectCardInput = false;
        this.expectTrickConfirm = false;

        this.alertArmed = false;
        // Which bid level the player has picked, so the strain row can be shown.
        // Held in state rather than as a class on the DOM: the box is rebuilt on
        // every render, and an imperative tweak would be lost by the next message.
        this.selectedLevel = null;
        this.explanations = [];
        this.claimAvailable = false;
        this.concedeAvailable = false;
        this.showLastTrick = false;
        // A completed trick stays on the table until the player acknowledges it.
        // Held separately from currentTrick, which the server has already moved
        // on from: rendering straight from currentTrick would wipe the four
        // cards the instant the trick finished.
        this.pendingTrick = null;
        this.busy = false;

        this.connection = { status: 'connecting', detail: '' };
        this.listeners = new Set();
    }

    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    notify() {
        for (const listener of this.listeners) listener(this);
    }

    setConnection(status, detail) {
        this.connection = { status, detail };
        this.notify();
    }

    /**
     * Fold a validated server message into the state.
     * @returns {Array<{type: string, [key: string]: any}>} effects for the caller
     */
    apply(message) {
        const effects = [];
        this.busy = false;

        switch (message.message) {
            case 'deal_start': {
                this.deal = new Deal(message.dealer, message.vuln, message.hand, message.board_no);
                this.options.humanSeats.forEach((isHuman, seat) => {
                    if (isHuman) this.deal.hands[seat].isPublic = true;
                });
                this.explanations = [];
                this.alertArmed = false;
                this.claimAvailable = false;
                this.concedeAvailable = false;
                break;
            }

            case 'bid_made': {
                this.deal.auction = message.auction;
                const lastCall = message.auction[message.auction.length - 1];
                this.explanations.push({ call: lastCall, text: message.explanation ?? '' });
                this.deal.advanceTurn();
                this.alertArmed = false;
                this.selectedLevel = null;
                break;
            }

            case 'get_bid_input': {
                this.deal.auction = message.auction;
                this.deal.canDouble = Boolean(message.can_double);
                this.deal.canRedouble = Boolean(message.can_redouble);
                this.expectBidInput = true;
                this.selectedLevel = null;
                break;
            }

            case 'hint':
                effects.push({ type: 'hint', bids: message.bids });
                break;

            case 'alert':
                this.alertArmed = message.alert === 'True';
                effects.push({ type: 'alert-toggled', armed: this.alertArmed });
                break;

            case 'auction_end': {
                this.deal.auction = message.auction;
                this.deal.declarer = message.declarer;
                this.deal.strain = message.strain;
                this.deal.turn = (message.declarer + 1) % 4;
                this.deal.currentTrick = new Trick(this.deal.turn, []);
                this.expectBidInput = false;
                this.busy = true;
                break;
            }

            case 'show_dummy': {
                this.deal.dummy = (this.deal.declarer + 2) % 4;
                this.deal.hands[message.player].cards = parseHand(message.dummy);
                this.deal.hands[message.player].isPublic = true;
                break;
            }

            case 'card_played': {
                const card = new Card(message.card);
                this.deal.currentTrick.cards.push(card);
                this.showLastTrick = false;
                this.claimAvailable = false;
                this.concedeAvailable = false;

                // Remove the card from whichever hand we are tracking. Hands we
                // cannot see hold no cards, so this is a no-op for them.
                const hand = this.deal.hands[message.player];
                if (hand && hand.cards.length > 0) {
                    this.deal.hands[message.player] = hand.play(card);
                }

                this.deal.turn = (message.player + 1) % 4;
                this.expectCardInput = false;
                this.busy = true;
                break;
            }

            case 'get_card_input': {
                // Claiming is only offered on lead, and not on the opening lead.
                const onLead = this.deal.currentTrick.cards.length === 0;
                this.claimAvailable = onLead && this.deal.tricks.length > 0;
                this.concedeAvailable = !this.claimAvailable;
                this.expectCardInput = true;
                break;
            }

            case 'claim_rejected':
                this.expectCardInput = true;
                effects.push({ type: 'claim-rejected' });
                break;

            case 'trick_confirm': {
                const completed = this.deal.currentTrick;
                const winner = completed.winner(this.deal.strain);
                this.deal.turn = winner;
                this.deal.tricks.push(completed);
                this.deal.tricksCount[winner % 2] += 1;
                this.deal.currentTrick = new Trick(winner, []);
                this.pendingTrick = completed;      // keep it on the table
                this.expectTrickConfirm = true;
                this.showLastTrick = false;
                if (this.options.autocomplete) {
                    effects.push({ type: 'schedule-trick-confirm', seconds: this.options.timeoutSeconds });
                }
                break;
            }

            case 'deal_end': {
                this.deal.turn = -1;
                this.expectBidInput = false;
                this.expectCardInput = false;
                this.claimAvailable = false;
                this.concedeAvailable = false;

                const hands = message.pbn.split(' ');
                for (let seat = 0; seat < 4; seat++) {
                    this.deal.hands[seat].cards = parseHand(hands[seat]);
                    this.deal.hands[seat].isPublic = true;
                }

                const claimed = message.dict?.claimed;
                if (claimed) {
                    const side = this.deal.tricks.length > 0
                        ? this.deal.tricks[this.deal.tricks.length - 1].winner(this.deal.strain) % 2
                        : 0;
                    this.deal.tricksCount[side] += claimed;
                    this.deal.tricksCount[(side + 1) % 2] = 13 - this.deal.tricksCount[side];
                    effects.push({ type: 'claim-accepted' });
                }
                effects.push({ type: 'deal-end', dict: message.dict });
                break;
            }
        }

        this.notify();
        return effects;
    }

    /** Called when the player clicks a card; validates before sending. */
    canPlay(card) {
        if (!this.expectCardInput || !this.deal) return false;
        const hand = this.deal.hands[this.deal.turn];
        return Boolean(hand && hand.isPlayable(card, this.deal.currentTrick));
    }
}
