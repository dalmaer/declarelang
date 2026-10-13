/** What `onMessage` receives. `data` is always a string — parsing is app
 *  semantics (streams.md §2: an app that streams JSON parses in the handler).
 *  `type` is the SSE named event ("message" for unnamed/default messages and
 *  for every socket frame); `id` is the SSE last-event-id ("" on sockets). */
export interface StreamMessage {
    readonly data: string;
    readonly type: string;
    readonly id: string;
}
/** A live connection, as the factory hands it back: closeable, and — for
 *  sockets — sendable. */
export interface StreamHandle {
    close(): void;
    send?(text: string): void;
}
/** What a factory calls back into the runtime. `end` reports the connection
 *  going down: `error` is the failure reason ("" for a clean close — nothing
 *  for the error channel); `final` false means the PLATFORM will bring the
 *  connection back on its own (EventSource's native retry), so the stream
 *  just reads "retrying" until `open` fires again. */
export interface StreamCallbacks {
    open(): void;
    message(m: StreamMessage): void;
    end(error: string, final: boolean): void;
}
export type EventSourceFactory = (url: string, listen: readonly string[], cb: StreamCallbacks) => StreamHandle;
export type SocketFactory = (url: string, cb: StreamCallbacks) => StreamHandle;
/** What an EventStream asks of its request when it is more than a plain GET:
 *  the verb, the headers, the body (already encoded) and the credentials mode
 *  — the same four a DataSource sends. */
export interface StreamRequest {
    method: string;
    headers: Record<string, string>;
    body: string | null;
    credentials?: "omit" | "same-origin" | "include";
}
/** One request whose reply is an event stream, read as it arrives: open when
 *  the reply's head is good, a message per event, and a final end when the
 *  reply ends (a request is not replayed — `retry` is the author's to declare). */
export type RequestStreamFactory = (url: string, req: StreamRequest, listen: readonly string[], cb: StreamCallbacks) => StreamHandle;
export interface StreamFactories {
    eventSource: EventSourceFactory;
    socket: SocketFactory;
    /** Absent = the platform fetch (streams.ts requestStreamOverFetch). */
    request?: RequestStreamFactory;
}
/** Swap the connection factories (headless installs refusers; tests install
 *  stubs; the mac host injects its native pair). Returns the PREVIOUS pair so
 *  a scoped caller can restore it — the provideTransport contract. */
export declare function provideStreams(f: StreamFactories): StreamFactories;
/** Is `eventSource` still the browser default (not a host's or a test's)? —
 *  where there is no EventSource to back it, a plain GET stream reads over
 *  fetch instead (streams.ts). */
export declare function defaultEventSource(): boolean;
/** The pair in force — what a Stream dials through (streams.ts). */
export declare function currentStreams(): StreamFactories;
