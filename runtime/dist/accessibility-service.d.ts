export type Politeness = "polite" | "assertive";
/** The platform's voice, given by the host that has one. */
export declare function provideAnnouncer(fn: (text: string, politeness: Politeness) => void): void;
export declare const Accessibility: {
    /** Say `text` to whoever is listening, without moving the focus: `polite` waits
     *  for a pause in what is being read, `assertive` interrupts. */
    announce(text: string, politeness?: Politeness): void;
    /** What was said lately, oldest first — for a test, and for the semantic
     *  tree's readers to see what a program announced. */
    announced(): readonly {
        text: string;
        politeness: Politeness;
    }[];
};
