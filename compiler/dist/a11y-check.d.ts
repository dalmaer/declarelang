import type { Program } from "../../runtime/dist/parser.js";
import { type ClassSchema } from "../../runtime/dist/schema.js";
import type { DeclareError } from "../../runtime/dist/errors.js";
export interface A11yFindings {
    errors: DeclareError[];
    warnings: DeclareError[];
}
export declare function accessibilityDiagnostics(program: Program, schemas: Record<string, ClassSchema>, opts: {
    libraryEnd: number;
    warnings: boolean;
}): A11yFindings;
