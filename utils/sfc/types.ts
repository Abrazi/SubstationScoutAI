
export const ACTION_QUALIFIERS = ['N', 'S', 'R', 'L', 'D', 'P', 'P1', 'P0', 'DS', 'SL'] as const;
export const TIME_QUALIFIERS = ['L', 'D', 'DS', 'SL'];

export interface SFCTransition {
    target: string;
    condition: string;
    priority: number;
    explicitPriority?: boolean;
    fullText: string;
    lineIndex: number; 
    blockEndIndex: number;
}

export interface SFCAction {
    qualifier: typeof ACTION_QUALIFIERS[number];
    time?: string;
    text: string;
    lineIndex: number;
}

export interface EditableAction {
    id: string;
    code: string; // multiline code
    qualifier: string; // Action-level qualifier (N, P1, P0, S, R, etc.)
    time?: string;     // Optional duration for time qualifiers (L, D, DS, SL)
}

export interface SFCNode {
    id: string;
    label: string;
    type: 'init' | 'step';
    value?: number;
    actions: SFCAction[];
    transitions: SFCTransition[];
    stepStartLine: number;
    stepEndLine: number;
}
