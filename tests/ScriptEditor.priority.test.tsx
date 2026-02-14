import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ScriptEditor } from '../components/ScriptEditor';
import { engine } from '../services/SimulationEngine';

const BRANCH_SCRIPT = `VAR
  STATE_A : INT := 0;
  STATE_B : INT := 1;
  STATE_C : INT := 2;
  state : INT := STATE_A;
END_VAR

IF state = STATE_A THEN
   IF x = 1 THEN state := STATE_B; END_IF;
   IF y = 1 THEN state := STATE_C; END_IF;
END_IF;`;

describe('SFC priority inline edit', () => {
  beforeEach(() => {
    engine.updateScriptConfig({ deviceId: 'P1', code: BRANCH_SCRIPT, tickRate: 100 });
  });

  it('edits transition priority inline and writes PRI comment into ST', async () => {
    render(<ScriptEditor ieds={[{ id: 'P1', name: 'Device P1', type: 'IED' } as any]} initialDeviceId="P1" />);

    // Switch to SFC view
    userEvent.click(screen.getByRole('button', { name: /SFC Diagram/i }));

    // Wait for step label
    await screen.findByText('A');

    // open inline editor for the first transition priority (should show [1])
    const priorityBtn = screen.getAllByText(/\[1\]/)[0];
    userEvent.click(priorityBtn);

    // spinbutton (number input) appears
    const spin = await screen.findByRole('spinbutton', { name: /edit-priority-STATE_A-0/i });
    // set to 10 and commit via Enter
    await userEvent.clear(spin);
    await userEvent.type(spin, '10');
    await userEvent.keyboard('{Enter}');

    // Switch to code view and assert PRI comment inserted
    userEvent.click(screen.getByRole('button', { name: /ST Code/i }));
    const codeArea = await screen.findByRole('textbox');
    expect(codeArea.value).toContain('(* PRI: 10 *)');
  });
});