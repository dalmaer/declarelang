/** Run `fn` watching for a read of `view`'s content size on `size`. */
export declare function watchingContentRead<T>(view: object, size: string, fn: () => T): {
    value: T;
    hit: boolean;
};
/** The content walk (view.ts extentOf) reports itself. */
export declare function noteContentRead(view: object, size: string): void;
