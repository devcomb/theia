/********************************************************************************
 * Copyright (C) 2018 TypeFox and others.
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

import { inject, injectable } from 'inversify';
import URI from '@theia/core/lib/common/uri';
import { ILogger } from '@theia/core/lib/common/logger';
import { TextEditor } from '@theia/editor/lib/browser/editor';
import { Disposable } from '@theia/core/lib/common/disposable';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import { EditorDecoration, EditorDecorationOptions } from '@theia/editor/lib/browser/decorations';
import { SemanticHighlightingService, SemanticHighlightingRange, Range } from '@theia/editor/lib/browser/semantic-highlight/semantic-highlighting-service';
import { MonacoEditor } from './monaco-editor';
import ITextModel = monaco.editor.ITextModel;
import TokenMetadata = monaco.modes.TokenMetadata;
import StaticServices = monaco.services.StaticServices;

@injectable()
export class MonacoSemanticHighlightingService extends SemanticHighlightingService {

    @inject(ILogger)
    protected readonly logger: ILogger;

    @inject(EditorManager)
    protected readonly editorManager: EditorManager;

    protected readonly decorations = new Map<string, DecorationWithRanges>();
    protected readonly toDisposeOnEditorClose = new Map<string, Disposable>();

    async decorate(uri: URI, ranges: SemanticHighlightingRange[]): Promise<void> {
        const editorWidget = await this.editorManager.getByUri(uri);
        if (!editorWidget) {
            return;
        }
        if (!(editorWidget.editor instanceof MonacoEditor)) {
            return;
        }

        const key = uri.toString();
        const editor = editorWidget.editor;
        const model = editor.getControl().getModel();
        if (!this.toDisposeOnEditorClose.has(key)) {
            this.toDisposeOnEditorClose.set(key, editor.onDispose((() => this.deleteDecorations(key, editor))));
        }

        const oldState = this.decorations.get(key) || DecorationWithRanges.EMPTY;
        // Merge the previous state with the current one.
        const rangesToCache = this.mergeRanges(model, oldState.ranges, ranges);
        // XXX: Why cannot TS infer this type? Perhaps `EditorDecorationOptions` has only optional properties. Just guessing though.
        const newDecorations: EditorDecoration[] = rangesToCache.map(this.toDecoration.bind(this));
        const oldDecorations = oldState.decorations;
        // Do the decorations.
        const newState = editor.deltaDecorations({
            newDecorations,
            oldDecorations
        });

        // Cache the new state.
        this.decorations.set(key, {
            ranges: rangesToCache,
            decorations: newState
        });
    }

    dispose(): void {
        Array.from(this.toDisposeOnEditorClose.values()).forEach(disposable => disposable.dispose());
    }

    protected deleteDecorations(uri: string, editor: TextEditor): void {
        const decorationWithRanges = this.decorations.get(uri);
        if (decorationWithRanges) {
            const oldDecorations = decorationWithRanges.decorations;
            editor.deltaDecorations({
                newDecorations: [],
                oldDecorations
            });
            this.decorations.delete(uri);
        }
        const disposable = this.toDisposeOnEditorClose.get(uri);
        if (disposable) {
            disposable.dispose();
        }
        this.toDisposeOnEditorClose.delete(uri);
    }

    protected mergeRanges(model: ITextModel, oldRanges: SemanticHighlightingRange[], newRanges: SemanticHighlightingRange[]): SemanticHighlightingRange[] {
        // Collect all affected lines based on the new state.
        const affectedLines = new Set(newRanges.map(r => r.start.line));
        const lineCount = model.getLineCount();
        // Discard all ranges from the previous state that are from an affected line from the new state.
        // And merge them with the ranges from the new state. We cache them together.
        // Also filter out everything which exceed the line count in the editor.
        return oldRanges.filter(r => !affectedLines.has(r.start.line) && r.start.line < lineCount).concat(newRanges);
    }

    protected toDecoration(range: SemanticHighlightingRange): EditorDecoration {
        const { start, end } = range;
        const options = this.toOptions(range.scopes);
        return {
            range: Range.create(start, end),
            options
        };
    }

    protected toOptions(scopes: string[]): EditorDecorationOptions {
        // TODO: why for-of? How to pick the right scope? Is it fine to get the first element (with the narrowest scope)?
        for (const scope of scopes) {
            const metadata = this.tokenTheme().match(undefined, scope);
            const inlineClassName = TokenMetadata.getClassNameFromMetadata(metadata);
            return {
                inlineClassName
            };
        }
        return {};
    }

    protected tokenTheme(): monaco.services.TokenTheme {
        return StaticServices.standaloneThemeService.get().getTheme().tokenTheme;
    }

}

/**
 * Helper tuple type with text editor decoration IDs and the raw highlighting ranges.
 */
export interface DecorationWithRanges {
    readonly decorations: string[];
    readonly ranges: SemanticHighlightingRange[];
}

export namespace DecorationWithRanges {
    export const EMPTY: DecorationWithRanges = {
        decorations: [],
        ranges: []
    };
}
