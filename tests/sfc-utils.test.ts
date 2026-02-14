import { describe, it, expect } from 'vitest';
import { parseSFC, renameStateInCode, removeStateFromCode, reorderTransitionBlocks, analyzeSFC } from '../components/ScriptEditor';
import { GENERATOR_LOGIC_SCRIPT } from '../utils/generatorLogic';
import { engine } from '../services/SimulationEngine';

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

  it('detects initial step when state variable is initialized in VAR', () => {
    const code = `VAR\n  STATE_A : INT := 0;\n  STATE_B : INT := 1;\n  CurrentState : INT := 1;\nEND_VAR\n\nIF CurrentState = STATE_A THEN\n  (* A *)\nEND_IF;\nIF CurrentState = STATE_B THEN\n  (* B *)\nEND_IF;`;
    const nodes = parseSFC(code);
    const initial = nodes.find(n => n.type === 'init');
    expect(initial).toBeDefined();
    expect(initial!.id).toBe('STATE_B');
  });

  it('parses explicit PRI comment on transitions and suppresses IEC-SFC-007', () => {
    const code = `VAR\n  STATE_A : INT := 0;\n  STATE_B : INT := 1;\n  STATE_C : INT := 2;\nEND_VAR\n\nIF state = STATE_A THEN\n  (* PRI: 10 *) IF x = 1 THEN state := STATE_B; END_IF;\n  IF y = 1 THEN state := STATE_C; END_IF;\nEND_IF;`;
    const nodes = parseSFC(code);
    const node = nodes.find(n => n.id === 'STATE_A')!;
    expect(node.transitions.some(t => (t as any).explicitPriority)).toBeTruthy();
    const diags = analyzeSFC(nodes, code);
    expect(diags.find(d => d.code === 'IEC-SFC-007')).toBeUndefined();
  });

  it('generator logic compiles and FAST_TRANSFER/STARTING diagnostics are OK', () => {
    // ensure engine has a script instance for compile()
    engine.registerDevice('TST', 'TST');
    const res = engine.compile('TST', GENERATOR_LOGIC_SCRIPT);
    expect(res.success).toBe(true);

    const nodes = parseSFC(GENERATOR_LOGIC_SCRIPT);
    const diags = analyzeSFC(nodes, GENERATOR_LOGIC_SCRIPT);

    // FAST_TRANSFER should not be reported unreachable
    expect(diags.find(d => d.code === 'IEC-SFC-003' && d.nodes?.includes('STATE_FAST_TRANSFER'))).toBeUndefined();

    // STARTING should not have IEC-SFC-007 because explicit PRI comments are present
    expect(diags.find(d => d.code === 'IEC-SFC-007' && d.nodes?.includes('STATE_STARTING'))).toBeUndefined();
  });
});