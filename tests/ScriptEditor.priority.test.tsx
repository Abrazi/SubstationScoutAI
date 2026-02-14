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
    const codeArea = await screen.findByRole('textbox') as HTMLTextAreaElement;
    expect(codeArea.value).toContain('(* PRI: 10 *)');
  });

  it('detects duplicate inline priority and auto-resolves on request', async () => {
    render(<ScriptEditor ieds={[{ id: 'P1', name: 'Device P1', type: 'IED' } as any]} initialDeviceId="P1" />);
    userEvent.click(screen.getByRole('button', { name: /SFC Diagram/i }));
    await screen.findByText('A');

    // second transition priority button should be [2]
    const secondPriorityBtn = screen.getAllByText(/\[2\]/)[0];
    userEvent.click(secondPriorityBtn);

    const spin = await screen.findByRole('spinbutton', { name: /edit-priority-STATE_A-1/i });
    await userEvent.clear(spin);
    await userEvent.type(spin, '1');

    // duplicate warning & Auto-resolve shown
    expect(screen.getByText(/Duplicate priority/)).toBeInTheDocument();
    const autoBtn = screen.getByText(/Auto-resolve/);
    userEvent.click(autoBtn);

    // After auto-resolve, both PRI comments must exist and be unique
    userEvent.click(screen.getByRole('button', { name: /ST Code/i }));
    const codeArea = await screen.findByRole('textbox') as HTMLTextAreaElement;
    expect(codeArea.value).toMatch(/\(\* PRI: 1 \*\)/);
    expect(codeArea.value).toMatch(/\(\* PRI: 2 \*\)/);
  });

  it('allows editing priority from transition modal and prevents duplicates until auto-resolve', async () => {
    render(<ScriptEditor ieds={[{ id: 'P1', name: 'Device P1', type: 'IED' } as any]} initialDeviceId="P1" />);
    userEvent.click(screen.getByRole('button', { name: /SFC Diagram/i }));
    await screen.findByText('A');

    // open transition modal for second transition
    const transBars = screen.getAllByTitle('Click to edit condition');
    userEvent.click(transBars[1]);

    // modal priority input present
    const priInput = await screen.findByLabelText('transition-priority');
    await userEvent.clear(priInput);
    await userEvent.type(priInput, '1');

    // Apply should be disabled due to duplicate
    const applyBtn = screen.getByRole('button', { name: /Apply Changes/i });
    expect(applyBtn).toBeDisabled();

    // Use Auto-resolve in modal
    const modalAuto = screen.getByText(/Auto-resolve/);
    userEvent.click(modalAuto);

    // Now Apply should be enabled
    expect(screen.getByRole('button', { name: /Apply Changes/i })).not.toBeDisabled();

    // Save changes
    userEvent.click(screen.getByRole('button', { name: /Apply Changes/i }));

    // Check ST contains PRI comments
    userEvent.click(screen.getByRole('button', { name: /ST Code/i }));
    const codeArea = await screen.findByRole('textbox') as HTMLTextAreaElement;
    expect(codeArea.value).toMatch(/\(\* PRI: 1 \*\)/);
    expect(codeArea.value).toMatch(/\(\* PRI: 2 \*\)/);
  });

  it('normalizes priorities for a step to tidy spacing (10,20,30...)', async () => {
    render(<ScriptEditor ieds={[{ id: 'P1', name: 'Device P1', type: 'IED' } as any]} initialDeviceId="P1" />);
    userEvent.click(screen.getByRole('button', { name: /SFC Diagram/i }));
    await screen.findByText('A');

    // click Normalize button for the step
    const normalizeBtn = screen.getAllByTitle('Normalize priorities')[0];
    userEvent.click(normalizeBtn);

    // Check ST contains normalized PRI comments
    userEvent.click(screen.getByRole('button', { name: /ST Code/i }));
    const codeArea = await screen.findByRole('textbox') as HTMLTextAreaElement;
    expect(codeArea.value).toMatch(/\(\* PRI: 10 \*\)/);
    expect(codeArea.value).toMatch(/\(\* PRI: 20 \*\)/);
  });

  it('respects configured normalize step size', async () => {
    render(<ScriptEditor ieds={[{ id: 'P1', name: 'Device P1', type: 'IED' } as any]} initialDeviceId="P1" />);
    userEvent.click(screen.getByRole('button', { name: /SFC Diagram/i }));
    await screen.findByText('A');

    // change normalize step size to 5
    const select = screen.getByLabelText('normalize-step-size');
    userEvent.selectOptions(select, '5');

    // click Normalize button for the step
    const normalizeBtn = screen.getAllByTitle('Normalize priorities')[0];
    userEvent.click(normalizeBtn);

    // Check ST contains normalized PRI comments with step 5
    userEvent.click(screen.getByRole('button', { name: /ST Code/i }));
    const codeArea = await screen.findByRole('textbox') as HTMLTextAreaElement;
    expect(codeArea.value).toMatch(/\(\* PRI: 5 \*\)/);
    expect(codeArea.value).toMatch(/\(\* PRI: 10 \*\)/);
  });
});