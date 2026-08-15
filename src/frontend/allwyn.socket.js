/**
 * Websocket transport.
 *
 * Owns the connection and nothing else: it validates inbound frames through
 * allwyn.protocol.js and hands typed messages to a listener. Connection
 * problems are reported through onStatus rather than through alert(), so the
 * page can show them in place - a modal alert during play blocks the game loop
 * and cannot be dismissed by a script.
 */

import { parseMessage, ProtocolError } from './allwyn.protocol.js';

/** @typedef {'connecting'|'open'|'closed'|'error'} ConnectionStatus */

export class GameSocket {
    /**
     * @param {string} url            ws:// or wss:// endpoint
     * @param {object} handlers
     * @param {(msg: object) => void} handlers.onMessage  validated server message
     * @param {(status: ConnectionStatus, detail: string) => void} handlers.onStatus
     */
    constructor(url, { onMessage, onStatus }) {
        this.url = url;
        this.onMessage = onMessage;
        this.onStatus = onStatus;
        this.socket = null;
    }

    connect() {
        this.onStatus('connecting', this.url);
        try {
            this.socket = new WebSocket(this.url);
        } catch (error) {
            this.onStatus('error', `Could not open ${this.url}: ${error.message}`);
            return;
        }

        this.socket.addEventListener('open', () => this.onStatus('open', this.url));

        this.socket.addEventListener('message', (event) => {
            let message;
            try {
                message = parseMessage(event.data);
            } catch (error) {
                if (error instanceof ProtocolError) {
                    console.error('[protocol]', error.message, error.raw);
                    this.onStatus('error', error.message);
                    return;
                }
                throw error;
            }
            this.onMessage(message);
        });

        this.socket.addEventListener('error', () => {
            // The browser deliberately withholds the reason; the port is the
            // only actionable detail we can offer.
            const port = new URL(this.url).port;
            this.onStatus('error', `No BEN server answering on port ${port}. Is gameserver.py running?`);
        });

        this.socket.addEventListener('close', (event) => {
            if (event.wasClean && event.code === 1000) {
                this.onStatus('closed', 'Connection closed.');
            } else if (event.code === 1011) {
                this.onStatus('error', 'The server hit an internal error and dropped the game (code 1011). Check logs/gameserver.log.');
            } else {
                this.onStatus('error', `Connection lost (code ${event.code}).`);
            }
        });
    }

    /** @returns {boolean} whether the message could be sent */
    send(payload) {
        if (this.socket?.readyState !== WebSocket.OPEN) {
            this.onStatus('error', 'Not connected to the server.');
            return false;
        }
        this.socket.send(payload);
        return true;
    }
}

/** Build the gameserver URL from the page location and options. */
export function gameServerUrl(options, queryString, location = window.location) {
    const protocol = location.protocol === 'https:' ? 'wss://' : 'ws://';
    const port = `444${options.server}`;
    return `${protocol}${location.hostname}:${port}/${queryString}`;
}
