import { describe, it, expect } from 'vitest';
import { parseSFC, renameStateInCode, removeStateFromCode, reorderTransitionBlocks } from '../components/ScriptEditor';
import { GENERATOR_LOGIC_SCRIPT } from '../utils/generatorLogic';

describe('SFC helpers & parsing', () => {
  it('parseSFC should detect states from generator script', () => {
    const nodes = parseSFC(GENERATOR_LOGIC_SCRIPT);
    const ids = nodes.map(n => n.id);
    expect(ids).toContain('STATE_STANDSTILL');
    expect(ids).toContain('STATE_RUNNING');
    const running = nodes.find(n => n.id === 'STATE_RUNNING');
    expect(running).toBeTruthy();
    expect(running!.transitions.length).toBeGreaterThanOrEqual(1);
  });

  it('renameStateInCode replaces constant and all references', () => {
    const original = GENERATOR_LOGIC_SCRIPT;
    const replaced = renameStateInCode(original, 'STATE_STANDSTILL', 'STATE_PARKED');
    expect(replaced).toContain('STATE_PARKED');
    expect(replaced).not.toContain('STATE_STANDSTILL');
  });

  it('removeStateFromCode removes the state definition and step block', () => {
    const original = GENERATOR_LOGIC_SCRIPT;
    const removed = removeStateFromCode(original, 'STATE_FAST_TRANSFER', 'CurrentState');
    expect(removed).not.toContain('STATE_FAST_TRANSFER');
    const nodes = parseSFC(removed);
    expect(nodes.find(n => n.id === 'STATE_FAST_TRANSFER')).toBeUndefined();
  });

  it('reorderTransitionBlocks swaps transition blocks inside a step', () => {
    const code = `VAR\n  STATE_A : INT := 0;\n  STATE_B : INT := 1;\n  STATE_C : INT := 2;\nEND_VAR\n\nIF state = undefined THEN state := STATE_A; END_IF;\n\nIF state = STATE_A THEN\n   (* Actions *)\n   IF x = 1 THEN state := STATE_B; END_IF;\n   IF y = 1 THEN state := STATE_C; END_IF;\nEND_IF;`;
    const parsed = parseSFC(code);
    const node = parsed.find(n => n.id === 'STATE_A')!;
    expect(node.transitions.length).toBe(2);
    // move second transition (index 1) to be first (index 0)
    const out = reorderTransitionBlocks(code, 'STATE_A', 1, 0);
    // now y=1 block should appear before x=1
    expect(out.indexOf('y = 1')).toBeLessThan(out.indexOf('x = 1'));
  });
});