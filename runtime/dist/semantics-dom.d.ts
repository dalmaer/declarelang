/** Install the DOM realization for this document — once, by the DOM backend. */
export declare function installDomSemantics(doc: Document): void;
/** For tests: how many views wait for their rule now. */
export declare function pendingAnnotations(): number;
/** For tests: install every waiting rule now, instead of after the frame. */
export declare function flushAnnotations(): void;
