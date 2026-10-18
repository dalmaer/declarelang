/** Call `changed` whenever devicePixelRatio changes, until the returned
 *  function is called or `alive()` stops holding. */
export declare function onDprChange(alive: () => boolean, changed: () => void): () => void;
