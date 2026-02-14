import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ScriptEditor, parseSFC } from '../components/ScriptEditor';
import { engine } from '../services/SimulationEngine';

const TEST_SCRIPT = `VAR
  STATE_A : INT := 0;
  STATE_B : INT := 1;
  state : INT := STATE_A;
END_VAR

IF state = STATE_A THEN
  (* Q:N *) Device.Log('info','A');
  IF x = 1 THEN state := STATE_B; END_IF;
END_IF;

IF state = STATE_B THEN
  (* Q:N *) Device.Log('info','B');
END_IF;`;

describe('ScriptEditor — component interactions (SFC modals)', () => {
  beforeEach(() => {
    // preload engine script for the device id used in tests
    engine.updateScriptConfig({ deviceId: 'D1', code: TEST_SCRIPT, tickRate: 100 });
  });

  it('renames a step using the modal and updates source', async () => {
    render(<ScriptEditor ieds={[{ id: 'D1', name: 'Device 1', type: 'IED' } as any]} initialDeviceId="D1" />);

    // Switch to SFC view
    const sfcBtn = screen.getByRole('button', { name: /SFC Diagram/i });
    userEvent.click(sfcBtn);

    // Wait for step label 'A' to appear
    await screen.findByText('A');

    // Click rename button for first step (there are multiple rename buttons; the first corresponds to the first step)
    const renameButtons = screen.getAllByTitle('Rename step');
    userEvent.click(renameButtons[0]);

    // Modal should open with input
    const input = await screen.findByRole('textbox');
    userEvent.clear(input);
    userEvent.type(input, 'PARKED');

    // Click Rename action
    const renameAction = screen.getByRole('button', { name: /Rename/i });
    userEvent.click(renameAction);

    // Switch to code view and assert code contains new state name
    const codeBtn = screen.getByRole('button', { name: /ST Code/i });
    userEvent.click(codeBtn);

    const codeArea = await screen.findByRole('textbox') as HTMLTextAreaElement;
    expect(codeArea).toHaveValue(expect.stringContaining('STATE_PARKED'));
  });

  it('deletes a non-initial step via modal and removes STATE constant', async () => {
    render(<ScriptEditor ieds={[{ id: 'D1', name: 'Device 1', type: 'IED' } as any]} initialDeviceId="D1" />);

    // Switch to SFC view
    userEvent.click(screen.getByRole('button', { name: /SFC Diagram/i }));
    await screen.findByText('A');

    // Find delete button for step 'B' (second rename/delete group)
    const deleteButtons = screen.getAllByTitle('Delete step');
    // Click second delete (corresponds to second step)
    userEvent.click(deleteButtons[1]);

    // Confirm modal appears and click Delete
    const delModalBtn = await screen.findByRole('button', { name: /Delete/i });
    userEvent.click(delModalBtn);

    // Verify in code view STATE_B no longer exists
    userEvent.click(screen.getByRole('button', { name: /ST Code/i }));
    const codeArea = await screen.findByRole('textbox') as HTMLTextAreaElement;
    expect(codeArea.value).not.toContain('STATE_B');

    // parseSFC should not return STATE_B
    const nodes = parseSFC(codeArea.value);
    expect(nodes.find(n => n.id === 'STATE_B')).toBeUndefined();
  });

  it('forces a step via modal and shows FORCED badge', async () => {
    render(<ScriptEditor ieds={[{ id: 'D1', name: 'Device 1', type: 'IED' } as any]} initialDeviceId="D1" />);

    // Switch to SFC view
    userEvent.click(screen.getByRole('button', { name: /SFC Diagram/i }));
    await screen.findByText('A');

    // Click Force button for first step
    const forceButtons = screen.getAllByTitle('Force step (UI-only)');
    userEvent.click(forceButtons[0]);

    // Modal appears - apply force
    const applyBtn = await screen.findByRole('button', { name: /Apply Force/i });
    userEvent.click(applyBtn);

    // Expect FORCED badge to be visible for the step
    await waitFor(() => expect(screen.getByText('FORCED')).toBeInTheDocument());
  });
});
