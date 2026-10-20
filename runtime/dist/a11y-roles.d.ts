/** The attributes of the `accessibility…` namespace on View, by role-free
 *  name: what a contract may require. */
export declare const A11Y_MEMBERS: readonly ["accessibilityValue", "accessibilityMin", "accessibilityMax", "accessibilityStep", "accessibilityValueText", "accessibilityChecked", "accessibilityPressed", "accessibilitySelected", "accessibilityLevel", "accessibilityExpanded", "accessibilityPosInSet", "accessibilitySetSize"];
export interface RoleContract {
    /** Attributes the role reads that the declaring class must set. */
    readonly needs: readonly string[];
    /** Attributes the role reads when set. */
    readonly may: readonly string[];
    /** Methods the role's actions call, which the class must have. */
    readonly methods: readonly string[];
    /** Methods that are actions where the view has them, and not required: a
     *  separator a person can drag (a splitter) is adjusted, one that only rules
     *  a line is not. */
    readonly mayMethods?: readonly string[];
    /** A view of this role with no accessibilityLabel takes its name from the
     *  text of its descendants (§3.4 rule 3). */
    readonly nameFromContent?: true;
    /** The role names something a person acts on, so it should have a name. */
    readonly named?: true;
}
export declare const ROLE_CONTRACTS: Readonly<Record<string, RoleContract>>;
export { ROLES, LIVE } from "./a11y-vocab.js";
/** The members `role` reads, needed and optional — every contract member the
 *  semantic node reports for a view of that role. */
export declare function roleReads(role: string): readonly string[];
/** What a class or view declaring `role` lacks, given what it sets and which
 *  methods it has: one line per missing member, empty when it meets the
 *  contract. The compiler and the runtime say it in the same words. */
export declare function contractGaps(role: string, sets: (name: string) => boolean, has: (method: string) => boolean): string[];
/** The sentence a contract gap reads as, wherever it is found. */
export declare function contractMessage(owner: string, role: string, gaps: readonly string[]): string;
