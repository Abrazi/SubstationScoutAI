
import { SFCNode, SFCTransition } from './types';
import { parseSFC } from './parser';

export const analyzeSFC = (nodes: SFCNode[], code: string) => {
    const diagnostics: Array<{ severity: 'error' | 'warning' | 'info', code: string, message: string, nodes?: string[] }> = [];
    if (nodes.length === 0) return diagnostics;

    // Initial step checks
    const initials = nodes.filter(n => n.type === 'init');
    if (initials.length === 0) diagnostics.push({ severity: 'error', code: 'IEC-SFC-001', message: 'No initial step detected — exactly one required.' });
    if (initials.length > 1) diagnostics.push({ severity: 'error', code: 'IEC-SFC-002', message: `Multiple initial steps detected (${initials.length}) — exactly one required.`, nodes: initials.map(n => n.id) });

    if (initials.length === 1) {
        const initNode = initials[0];
        if (initNode.id !== 'STATE_INITIAL') {
            diagnostics.push({
                severity: 'error',
                code: 'IEC-SFC-008',
                message: `Initial step must be named STATE_INITIAL (found: ${initNode.id}).`,
                nodes: [initNode.id]
            });
        }

        const hasStandstillTransition = initNode.transitions.some(t => t.target === 'STATE_STANDSTILL');
        if (!hasStandstillTransition) {
            diagnostics.push({
                severity: 'error',
                code: 'IEC-SFC-009',
                message: 'Initial step must transition to STATE_STANDSTILL as first operating step.',
                nodes: [initNode.id]
            });
        }
    }

    // Enforce "runtime variable initialization in INITIAL step", not in VAR block
    const varBlock = /VAR([\s\S]*?)END_VAR;/im.exec(code);
    if (varBlock) {
        const nonStateInit = varBlock[1]
            .split('\n')
            .map(l => l.trim())
            .filter(Boolean)
            .filter(l => /:=/.test(l))
            .filter(l => !/^STATE_/i.test(l));
        if (nonStateInit.length > 0) {
            diagnostics.push({
                severity: 'warning',
                code: 'IEC-SFC-010',
                message: 'Move non-state variable initialization from VAR block into STATE_INITIAL actions.'
            });
        }
    }

    // Reachability (BFS)
    const startId = initials[0]?.id;
    if (startId) {
        const visited = new Set<string>();
        const q: string[] = [startId];
        while (q.length) {
            const id = q.shift()!;
            if (visited.has(id)) continue;
            visited.add(id);
            const node = nodes.find(n => n.id === id);
            if (!node) continue;
            node.transitions.forEach(t => { if (!visited.has(t.target)) q.push(t.target); });
        }
        // Determine additional states referenced anywhere by assignment (e.g. `state := STATE_X`) —
        // treat those as reachable to avoid false-positive unreachable diagnostics when parseSFC misses complex patterns.
        const stateVarMatch = code.match(/IF\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*STATE_\w+/i) || code.match(/([A-Za-z_][A-Za-z0-9_]*)\s*:=\s*STATE_\w+/i);
        const possibleStateVar = (stateVarMatch && stateVarMatch[1]) || 'state';
        const assignRe = new RegExp('\\b' + possibleStateVar.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&') + '\\s*:=\\s*(STATE_\\w+)', 'gi');
        const referencedTargets = new Set<string>();
        let am: RegExpExecArray | null;
        while ((am = assignRe.exec(code)) !== null) referencedTargets.add(am[1]);

        nodes.filter(n => !visited.has(n.id)).forEach(n => {
            if (referencedTargets.has(n.id)) return; // referenced somewhere — consider reachable
            diagnostics.push({ severity: 'warning', code: 'IEC-SFC-003', message: `Unreachable step: ${n.label}`, nodes: [n.id] });
        });

        // Deadlock detection (reachable step with no outgoing transitions and not obviously final)
        nodes.filter(n => visited.has(n.id)).forEach(n => {
            if (n.transitions.length === 0) {
                const lname = n.label.toLowerCase();
                if (!lname.includes('end') && !lname.includes('final')) {
                    diagnostics.push({ severity: 'warning', code: 'IEC-SFC-004', message: `Possible deadlock: step '${n.label}' has no outgoing transitions.`, nodes: [n.id] });
                }
            }
        });
    }

    // Nesting depth enforcement (recommendation)
    nodes.forEach(n => {
        if (n.stepStartLine >= 0 && n.stepEndLine >= 0) {
            const lines = code.split('\n').slice(n.stepStartLine, n.stepEndLine + 1);
            let depth = 0;
            let maxDepth = 0;
            for (const l of lines) {
                const t = l.trim();
                if (/^IF\s+/.test(t) && /\s+THEN$/.test(t)) { depth++; maxDepth = Math.max(maxDepth, depth); }
                if (/^END_IF;/.test(t)) depth = Math.max(0, depth - 1);
            }
            if (maxDepth > 8) diagnostics.push({ severity: 'error', code: 'IEC-SFC-005', message: `Nesting depth ${maxDepth} in step '${n.label}' exceeds recommended maximum (8).`, nodes: [n.id] });
        }
    });

    // Branching hints
    nodes.forEach(n => {
        if (n.transitions.length > 1) {
            const priorities = n.transitions.map(t => t.priority);
            const unique = new Set(priorities);
            const hasExplicit = n.transitions.some(t => (t as any).explicitPriority);
            if (unique.size !== priorities.length) {
                diagnostics.push({ severity: 'warning', code: 'IEC-SFC-006', message: `Duplicate transition priorities in step '${n.label}'.`, nodes: [n.id] });
            } else if (!hasExplicit) {
                // Only prompt to verify OR/AND semantics when explicit priorities are NOT present
                diagnostics.push({ severity: 'info', code: 'IEC-SFC-007', message: `Branching detected in step '${n.label}' — verify OR/AND semantics and explicit priorities.`, nodes: [n.id] });
            }
        }
    });

    return diagnostics;
};

// --- SFC Code-manipulation helpers ---
export const renameStateInCode = (code: string, oldStateId: string, newStateId: string) => {
    if (!oldStateId || !newStateId || oldStateId === newStateId) return code;
    const escOld = oldStateId.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
    const wordRe = new RegExp('\\b' + escOld + '\\b', 'g');
    return code.replace(wordRe, newStateId);
};

export const removeStateFromCode = (code: string, stateId: string, stateVarName = 'state') => {
    if (!stateId) return code;
    const escState = stateId.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
    // Remove VAR constant line
    const varRe = new RegExp('^\\s*' + escState + '\\s*:\\s*INT\\s*:=\\s*\\d+;\\s*\\n?', 'm');
    let out = code.replace(varRe, '');
    // Remove step block (IF/ELSIF <stateVarName> = STATE_X THEN ... up to next ELSIF or END_IF;)
    const stepBlockRe = new RegExp('(?:IF|ELSIF)\\s+' + stateVarName + '\\s*=\\s*' + escState + '\\s+THEN[\\s\\S]*?(?=(?:\\n\\s*(?:ELSIF\\s+' + stateVarName + '|END_IF;)|$))', 'i');
    out = out.replace(stepBlockRe, '');
    // Remove direct assignments to the removed state
    const assignRe = new RegExp('\\b' + stateVarName.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&') + '\\s*:=\\s*' + escState + '\\b;?', 'g');
    out = out.replace(assignRe, '');
    // Finally strip any remaining textual references to the removed state (e.g. in OR chains)
    out = out.replace(new RegExp('\\b' + escState + '\\b', 'g'), '');
    return out;
};

export const reorderTransitionBlocks = (code: string, nodeId: string, fromIndex: number, toIndex: number) => {
    const nodes = parseSFC(code);
    const node = nodes.find(n => n.id === nodeId);
    if (!node || node.transitions.length < 2) return code;
    const lines = code.split('\n');
    const blocks = node.transitions.map(t => ({ start: t.lineIndex, end: t.blockEndIndex, text: lines.slice(t.lineIndex, t.blockEndIndex + 1).join('\n') }));
    blocks.sort((a, b) => a.start - b.start);
    if (fromIndex < 0 || fromIndex >= blocks.length || toIndex < 0 || toIndex >= blocks.length) return code;
    const moved = blocks.splice(fromIndex, 1)[0];
    blocks.splice(toIndex, 0, moved);
    // Remove original blocks from code (descending order)
    const originalRanges = node.transitions.map(t => ({ start: t.lineIndex, end: t.blockEndIndex })).sort((a, b) => b.start - a.start);
    for (const r of originalRanges) {
        lines.splice(r.start, r.end - r.start + 1);
    }
    const insertAt = Math.min(...originalRanges.map(r => r.start));
    const insertText = blocks.map(b => b.text).join('\n');
    lines.splice(insertAt, 0, insertText);
    return lines.join('\n');
};
