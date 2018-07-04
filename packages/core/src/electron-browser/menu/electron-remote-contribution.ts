/********************************************************************************
 * Copyright (C) 2017 TypeFox and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
 ********************************************************************************/

import Axios, { AxiosRequestConfig } from 'axios';
import { inject, injectable } from 'inversify';
import URI from '../../common/uri';
import {
    Command, CommandContribution, CommandRegistry,
    MenuModelRegistry, MenuContribution, ILogger
} from '../../common';
import { KeybindingContribution, KeybindingRegistry, QuickOpenService, QuickOpenModel, QuickOpenItem, QuickOpenMode, StorageService } from '../../browser';
import { CommonMenus } from '../../browser';
import { WindowService } from '../../browser/window/window-service';
import { delay } from '../../common/promise-util';

export namespace ElectronRemoteCommands {
    export const CONNECT_TO_REMOTE: Command = {
        id: 'electron.remote.connect',
        label: 'Remote: Connect to a Server'
    };
    export const CLEAR_REMOTE_HISTORY: Command = {
        id: 'electron.remote.history.clear',
        label: 'Remote: Clear host history'
    };
}

export namespace ElectronMenus {
    export const CONNECT_TO_REMOTE = [...CommonMenus.FILE_OPEN, 'z_connect'];
}

export namespace ElectronRemoteHistory {
    export const KEY = 'theia.remote.history';
}

export interface ResponseStatus {
    url: string;
    status?: string;
    error?: Error;
}
export namespace ResponseStatus {
    export function OK(status: ResponseStatus): boolean {
        return status.status ? /^2/.test(status.status) : false;
    }
    export function display(status: ResponseStatus): string {
        if (!status.error && !status.status) {
            status.error = new Error('Unresolved');
        }
        return status.error ? `Error: ${status.error.message}` : `Status: ${status.status}`;
    }
}

@injectable()
export class ElectronRemoteContribution implements QuickOpenModel, CommandContribution, MenuContribution, KeybindingContribution {

    @inject(StorageService) protected readonly localStorageService: StorageService;
    @inject(QuickOpenService) protected readonly quickOpenService: QuickOpenService;
    @inject(WindowService) protected readonly windowService: WindowService;
    @inject(ILogger) protected readonly logger: ILogger;

    protected historyCache: Promise<ResponseStatus[]>;
    protected schemeTest: RegExp = /^https?$/;
    protected timeout: number = 500; // ms

    protected get history(): Promise<string[]> {
        return this.localStorageService.getData<string[]>(ElectronRemoteHistory.KEY, [])
            .then(history => history.map(entry => decodeURI(entry)));
    }

    protected async remember(url: string): Promise<void> {
        const history = await this.localStorageService.getData<string[]>(ElectronRemoteHistory.KEY, []);
        const encoded = encodeURI(url);
        if (encoded) {
            const currentIndex = history.indexOf(encoded);
            if (currentIndex !== -1) {
                history.splice(currentIndex, 1);
            }

            history.push(encoded);
            return this.localStorageService.setData(ElectronRemoteHistory.KEY, history);
        }
    }

    protected async clearHistory(): Promise<void> {
        return this.localStorageService.setData(ElectronRemoteHistory.KEY, undefined);
    }

    protected async getHttpStatus(url: string, config?: AxiosRequestConfig): Promise<ResponseStatus> {
        try {
            return Axios.get<string>(url, config)
                .then(response => ({ url, status: response.statusText }))
                .catch(error => ({ url, error }));
        } catch (error) { // in case the async-request creation itself failed
            return { url, error };
        }
    }

    protected convertUrlToQuickOpenItem(url: string, description?: string): QuickOpenItem {
        return new QuickOpenItem({
            label: url,
            description,
            run: mode => {
                if (mode === QuickOpenMode.OPEN) {
                    this.windowService.openNewWindow(url);
                    this.remember(url);
                }
                return true;
            }
        });
    }

    protected async accumulateStatus(accumulator: ResponseStatus[], urls: string[]): Promise<void> {
        await Promise.all(urls
            .map(url => this.getHttpStatus(url, { timeout: this.timeout })
                .then(status => {
                    accumulator.push(status);
                })
            )
        );
    }

    protected async computeHistoryCache(): Promise<ResponseStatus[]> {
        const cache: ResponseStatus[] = [];
        this.accumulateStatus(cache, await this.history);
        await delay(this.timeout);
        return cache.slice(0);
    }

    async onType(lookFor: string, acceptor: (items: QuickOpenItem[]) => void): Promise<void> {
        const autocompleteStatus: ResponseStatus[] = [];
        const defaultSchemes = ['http', 'https'];
        const autocomplete = [];

        if (lookFor) {
            let url = new URI(lookFor);
            if (!this.schemeTest.test(url.scheme)) {
                const reformated = new URI(`//${lookFor}`);
                for (const scheme of defaultSchemes) {
                    url = reformated.withScheme(scheme);
                    autocomplete.push(url.toString());
                }
            }

            this.accumulateStatus(autocompleteStatus, autocomplete);
            await delay(this.timeout);
        }

        const items = [];
        if (lookFor) {
            items.push(this.convertUrlToQuickOpenItem(lookFor, `Direct connect`));
        }
        items.push(...
            [...autocompleteStatus, ...await this.historyCache]
                // for some reason the sorting seems to be without effect
                .sort((a, b) => ResponseStatus.OK(a) === ResponseStatus.OK(b) ?
                    0 : ResponseStatus.OK(a) ? -1 : 1)
                .map(status => this.convertUrlToQuickOpenItem(status.url, ResponseStatus.display(status)))
        );
        acceptor(items);
    }

    registerCommands(registry: CommandRegistry): void {
        registry.registerCommand(ElectronRemoteCommands.CONNECT_TO_REMOTE, {
            execute: () => {
                this.historyCache = this.computeHistoryCache();
                this.quickOpenService.open(this, {
                    placeholder: 'Type the URL to connect to...',
                    fuzzyMatchLabel: true,
                });
            }
        });
        registry.registerCommand(ElectronRemoteCommands.CLEAR_REMOTE_HISTORY, {
            execute: () => this.clearHistory()
        });
    }

    registerKeybindings(registry: KeybindingRegistry): void {
        registry.registerKeybindings({
            command: ElectronRemoteCommands.CONNECT_TO_REMOTE.id,
            keybinding: "ctrl+alt+r"
        });
    }

    registerMenus(registry: MenuModelRegistry) {
        registry.registerMenuAction(ElectronMenus.CONNECT_TO_REMOTE, {
            commandId: ElectronRemoteCommands.CONNECT_TO_REMOTE.id,
            order: 'z4',
        });
    }
}
