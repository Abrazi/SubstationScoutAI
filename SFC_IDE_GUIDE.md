# Professional SFC Script IDE Guide

## Overview

The SFC (Sequential Function Chart) editor has been refactored into a professional scripting IDE with enhanced code editing capabilities, multiline support, **per-action qualifier configuration**, **multiple transition criteria management**, **step active time tracking**, and **professional code editor layout**.

## Key Features

### 1. **Per-Action Qualifiers**

Each action within a step can have **its own qualifier**, allowing for complex execution patterns. For example, you can have P1 actions that run once on step entry, N actions that run every cycle, and P0 actions that run once on step exit.

**Supported Qualifiers:**
- **N** (Non-stored) - Action executes every cycle while step is active
- **P1** (Pulse Rising) - Execute once on step entry (rising edge)
- **P0** (Pulse Falling) - Execute once on step exit (falling edge)
- **S** (Set/Stored) - Action activates on step entry and remains active
- **R** (Reset) - Deactivates a stored action
- **L** (Time Limited) - Action active for specified duration
- **D** (Time Delayed) - Action starts after specified delay
- **P** (Pulse) - Single execution on step entry
- **DS** (Delayed & Stored) - Combination of D and S
- **SL** (Stored & Limited) - Combination of S and L

**Execution Order:**
1. **P1 actions** execute first (once on entry, when stepTime < 100ms)
2. **N, S, R, L, D, P, DS, SL actions** execute every cycle
3. **P0 actions** execute last (once when any transition condition becomes true)

### 2. **Multiline Code Editor**

Each action can now contain multiple lines of IEC 61131-3 Structured Text code. Click the **"Open Code Editor"** button to launch the professional code editor modal.

**Code Editor Features:**
- ✅ Line numbers for easy navigation
- ✅ Syntax highlighting hints
- ✅ Large editing area (90% viewport height)
- ✅ Character and line count display
- ✅ Syntax reference guide
- ✅ Auto-focus on open
- ✅ Cancel and Save options

### 3. **Action Management**

**Adding Actions:**
1. Open a step's action editor
2. Click **"Add Action"**
3. Select the **qualifier** (N, P1, P0, S, etc.) for this action
4. If using time-based qualifiers (L, D, DS, SL), enter the duration
5. Click **"Open Code Editor"** on the action
6. Write your multiline Structured Text code
7. Click **"Save Code"**
8. Reorder actions using up/down arrows if needed

**Editing Actions:**
- Each action has its own qualifier selector
- Each action displays a preview of its code
- Click **"Open Code Editor"** to modify the code
- Use the trash icon to delete an action
- Use arrow buttons to reorder actions

**Typical Action Pattern:**
```
P1 Action: Initialize variables on step entry
N Action 1: Read inputs every cycle
N Action 2: Process logic every cycle  
N Action 3: Write outputs every cycle
P0 Action: Cleanup on step exit
```

**Example Action Code:**
```
temp_val := Device.ReadInput('30001') / 100.0;
counter := counter + 1;
Device.Log('info', 'Temperature: ' + temp_val);

IF temp_val > 80.0 THEN
    Device.WriteCoil('00001', TRUE);
    Device.Log('warning', 'High temperature alert!');
END_IF;
```

### 4. **Multiple Transition Criteria (Multi-Branch)**

Each step can now have **multiple transitions** to different target steps, allowing for complex branching logic.

**Adding Transitions:**
1. Click the **"+" button** below existing transitions
2. Enter the target state name
3. Enter the transition condition
4. The new transition appears with its own priority

**Deleting Transitions:**
- Hover over a transition condition box
- Click the **trash icon** that appears
- Confirm deletion

**Managing Priorities:**
- Each transition has a priority number in square brackets `[1]`
- Click the priority to edit it inline
- Higher priority transitions are evaluated first
- Use **"Normalize"** button to auto-assign sequential priorities

**Example Transitions:**
```
IF temp > 80.0 THEN state := STATE_ALARM; END_IF;     [Priority 1]
IF counter > 100 THEN state := STATE_RESET; END_IF;   [Priority 2]
IF stop_button THEN state := STATE_IDLE; END_IF;      [Priority 3]
```

### 5. **Step Active Time Tracking**

The system automatically tracks how long each step has been active and exposes it via the **`stepTime`** variable and state-based accessors.

**Using stepTime:**
- `stepTime` is available in all action code and transition conditions
- Value is in **milliseconds** (integer)
- Resets to 0 when entering a new state
- Updates every execution cycle (~50ms)
- Can also access as `STATE_NAME.stepTime` for the currently active state

**Example Usage in Actions:**
```
(* Q:N *) Device.Log('info', 'Time in state: ' + stepTime + 'ms');

(* Check if we've been here for 30 seconds *)
IF stepTime > 30000 THEN
    Device.Log('warning', 'State timeout - 30 seconds elapsed!');
END_IF;

(* Alternative: Access via state name *)
IF STATE_RUNNING.stepTime > 5000 THEN
    Device.Log('info', 'Running for 5+ seconds');
END_IF;
```

**Example Usage in Transitions:**
```
(* Timeout transition after 10 seconds *)
IF stepTime > 10000 THEN
    state := STATE_TIMEOUT;
END_IF;

(* Condition with time guard *)
IF temp > 100.0 AND stepTime > 5000 THEN
    state := STATE_EMERGENCY;
END_IF;

(* Using state name accessor *)
IF STATE_INIT.stepTime > 2000 THEN
    state := STATE_RUN;
END_IF;
```

### 6. **Professional Code Editor**

The multiline code editor has been redesigned for professional use:

✅ **Fixed Layout** - No more overlapping buttons or keys
✅ **Synchronized Scrolling** - Line numbers scroll with code
✅ **Proper Sizing** - Uses available space efficiently
✅ **Clean Interface** - Reduced padding, larger editing area
✅ **Quick Reference** - Syntax guide shows `stepTime` variable
✅ **Line Counter** - See exactly how many lines of code

**Keyboard Shortcuts in Code Editor:**
- `Tab` - Insert 4 spaces (tab size configured)
- `Ctrl/Cmd + Enter` - Save and close (future enhancement)
- `Esc` - Cancel (loses changes)

## Code Structure

### Step Format with Multiple Qualifiers (Generated)

```
ELSIF state = STATE_RUN THEN
   (* P1 Actions - Execute once on entry *)
   (* Q:P1 *) IF stepTime < 100 THEN
       counter := 0;
       Device.Log('info', 'Step started');
   END_IF;
   
   (* N Actions - Execute every cycle *)
   (* Q:N *) temp_val := Device.ReadInput('30001') / 100.0;
   counter := counter + 1;
   Device.Log('info', 'Running... Counter: ' + counter);
   
   (* Q:S *) Device.WriteCoil('00001', TRUE);
   
   (* P0 Actions - Execute on step exit *)
   IF (temp_val > 100.0) OR (counter > 50) THEN
       (* Q:P0 *) Device.Log('info', 'Exiting step');
       Device.WriteCoil('00002', FALSE);
   END_IF;
   
   (* Transitions *)
   IF temp_val > 100.0 THEN 
       state := STATE_ALARM; 
   ELSIF counter > 50 THEN
       state := STATE_NEXT;
   END_IF;
END_IF;
```

**Key Points:**
- **P1 actions** are automatically wrapped in `IF stepTime < 100 THEN ... END_IF;`
- **Normal actions** (N, S, R, L, D, P, DS, SL) execute every cycle with their qualifier comment
- **P0 actions** are automatically wrapped in a condition checking if any transition will fire
- Each action has its own `(* Q:X *)` qualifier comment
- Transitions are evaluated after all actions execute

### With Time Qualifiers

For time-based qualifiers (L, D, DS, SL), you can specify a duration on each action:

```
(* Q:D T:T#2s *) Device.WriteCoil('00001', TRUE);
Device.Log('info', 'Delayed action executed');
```

**Duration Format:**
- `T#2s` - 2 seconds
- `T#500ms` - 500 milliseconds
- `T#1m` - 1 minute

## Workflow Example

### Creating a New Step with P1, N, and P0 Actions

1. **Add P1 Action (Entry Initialization)**
   - Click "Add Action"
   - Select qualifier: **P1 — Pulse Rising**
   - Click "Open Code Editor"
   - Write initialization code:
     ```
     counter := 0;
     start_time := Device.GetTime();
     Device.Log('info', 'Entering running state');
     ```
   - Click "Save Code"
   - This code will execute **once** when the step becomes active

2. **Add N Actions (Cyclic Logic)**
   - Click "Add Action"
   - Select qualifier: **N — Non-stored** (default)
   - Click "Open Code Editor"
   - Write cyclic code that runs every scan:
     ```
     temp := Device.ReadInput('30001') / 100.0;
     counter := counter + 1;
     Device.Log('info', 'Cycle: ' + counter + ', Temp: ' + temp + ', Time: ' + stepTime + 'ms');
     
     IF temp > 75.0 THEN
         Device.WriteCoil('00001', TRUE);
     END_IF;
     ```
   - Click "Save Code"
   - Add more N actions as needed for different aspects of your control logic

3. **Add P0 Action (Exit Cleanup)**
   - Click "Add Action"
   - Select qualifier: **P0 — Pulse Falling**
   - Click "Open Code Editor"
   - Write cleanup code:
     ```
     Device.WriteCoil('00001', FALSE);
     Device.Log('info', 'Exiting running state after ' + stepTime + 'ms');
     final_counter := counter;
     ```
   - Click "Save Code"
   - This code will execute **once** when any transition condition becomes true

4. **Add Multiple Transitions**
   - The first transition is created automatically
   - Click the **"+"** button to add more branches
   - For each transition:
     - Enter target state (e.g., `STATE_ALARM`)
     - Enter condition (can use `stepTime` in milliseconds):
       - `temp > 100.0` (Priority 1 - High temp)
       - `stepTime > 120000` (Priority 2 - Timeout after 2 minutes)
       - `stop_button = TRUE` (Priority 3 - Manual stop)
   - Adjust priorities using inline editor if needed
   - Click **"Normalize"** to auto-sequence priorities

5. **Apply Changes**
   - Click "Apply & Save"
   - The code is generated and saved to your script

## Best Practices

### 1. **Use Appropriate Qualifiers Per Action**
- **P1** (Pulse Rising) for initialization tasks that should run once on step entry
  - Examples: Reset counters, log entry message, start timers
- **N** (Non-stored) for most regular cyclic logic that runs every scan
  - Examples: Read inputs, process calculations, control outputs
- **P0** (Pulse Falling) for cleanup tasks that run once on step exit
  - Examples: Log exit message, save final values, turn off outputs
- **S** (Set) when you want an output to remain active even after leaving the step
- **R** (Reset) to clear a stored action from another step

### 2. **Organize Actions by Execution Phase**
Structure your actions in a logical order:
1. **P1 Actions First**: Entry initialization
   - Initialize variables
   - Log entry messages
   - Set initial output states
2. **N Actions**: Main cyclic logic
   - Read inputs
   - Process calculations
   - Control outputs
   - Monitor conditions
3. **P0 Actions Last**: Exit cleanup
   - Log exit messages  
   - Save final values
   - Reset outputs

**Example Pattern:**
```
Action 1 (P1): counter := 0; Device.Log('info', 'Starting');
Action 2 (N):  temp := Device.ReadInput('30001') / 100.0;
Action 3 (N):  counter := counter + 1;
Action 4 (N):  Device.WriteCoil('00001', temp > 50.0);
Action 5 (P0): Device.Log('info', 'Final count: ' + counter);
```

### 3. **Use Comments in Multiline Code**
```
(* Read sensor values *)
temp := Device.ReadInput('30001') / 100.0;
pressure := Device.ReadInput('30002');

(* Safety check *)
IF temp > 100.0 OR pressure > 50.0 THEN
    Device.WriteCoil('ALARM', TRUE);
END_IF;
```

### 4. **Keep Actions Focused**
- Each action should have a clear purpose
- Avoid mixing unrelated logic in one action
- Use descriptive variable names
- Consider separating different control aspects into different actions

### 5. **Leverage stepTime for Timing Logic**
```
(* P1: Entry *)
start_temp := Device.ReadInput('30001');

(* N: Monitor with timeout *)
current_temp := Device.ReadInput('30001');
IF stepTime > 30000 AND current_temp = start_temp THEN
    Device.Log('warning', 'No temperature change in 30 seconds!');
END_IF;

(* P0: Exit report *)
Device.Log('info', 'Step duration: ' + stepTime + 'ms');
```

## Per-Action Qualifier System

The system now supports **different qualifiers for each action within a step**, enabling complex control patterns:

**Execution Semantics:**
- **P1 (Pulse Rising)**: Code executes **once** when step becomes active
  - Automatically wrapped in: `IF stepTime < 100 THEN ... END_IF;`
  - Perfect for: Initialization, entry logging, counter resets
  
- **N (Non-stored)**: Code executes **every cycle** while step is active
  - No automatic wrapping
  - Perfect for: Reading inputs, calculations, control logic, monitoring
  
- **P0 (Pulse Falling)**: Code executes **once** when step is about to exit
  - Automatically wrapped in condition checking if any transition will fire
  - Perfect for: Cleanup, exit logging, final value storage
  
- **Other qualifiers** (S, R, L, D, P, DS, SL): Execute with standard IEC 61131-3 semantics

**Benefits:**
- Clear separation between entry, cyclic, and exit logic
- Automatic execution control for P1 and P0
- No manual stepTime checks needed for entry/exit actions
- Follows IEC 61131-3 SFC standard behavior

## Troubleshooting

### Code Not Saving
- Ensure you clicked "Save Code" in the code editor modal
- Then click "Apply & Save" in the action editor
- Check the console output for any errors

### Qualifier Not Working as Expected
- **P1** actions only run when `stepTime < 100ms` (first ~2 cycles)
- **P0** actions only run when at least one transition condition is true
- **N** and other actions run every cycle
- Each action can have its own qualifier - check the dropdown for each action

### P0 Actions Not Executing
- **P0** actions only execute when a transition condition becomes true
- Verify that your step has at least one transition defined
- If no transitions exist, P0 actions will never execute (a comment warning will be added to the code)

### Multiline Code Not Working
- Ensure each line is valid IEC 61131-3 syntax
- Use semicolons to end statements
- Check for matching IF/END_IF, FOR/END_FOR pairs

### Code Editor Layout Issues
- **Fixed in latest version!** Layout now uses proper flex sizing
- Line numbers scroll in sync with code
- No more overlapping buttons or keys
- If still seeing issues, try refreshing the page

### Transitions Not Deleting
- Hover over the transition condition box
- The trash icon appears on the right side (next to the code icon)
- Click the trash icon and confirm deletion
- Make sure you're not clicking on the transition line itself

### stepTime Not Updating
- `stepTime` only updates when the script is running
- Check that the engine is started (not paused)
- `stepTime` resets when the state changes to a new value
- In debug mode, `stepTime` will pause when execution pauses

## Advanced Features

### Step Time Variable (`stepTime`)

The `stepTime` variable is automatically maintained by the simulation engine:

**Behavior:**
- Initialized to `0` when entering a state
- Incremented every cycle (typically 50ms)
- Value in **milliseconds** (integer)
- Accessible in all action code and transition conditions
- Persists within the state, resets on state change
- Can access as `stepTime` (global) or `STATE_NAME.stepTime` (state-specific)

**Use Cases:**
1. **Timeouts:** Automatic transition after a duration
   ```
   (* 30 second timeout = 30000ms *)
   IF stepTime > 30000 THEN state := STATE_TIMEOUT; END_IF;
   
   (* Alternative: using state name *)
   IF STATE_RUNNING.stepTime > 30000 THEN state := STATE_TIMEOUT; END_IF;
   ```

2. **Delayed Actions:** Execute after a delay
   ```
   (* 5 second delay = 5000ms *)
   IF stepTime > 5000 THEN
       Device.WriteCoil('DELAYED_OUTPUT', TRUE);
   END_IF;
   ```

3. **Time-based Logic:** Different behavior based on elapsed time
   ```
   IF stepTime < 10000 THEN
       (* Initialization phase - first 10 seconds *)
       Device.Log('info', 'Initializing...');
   ELSIF stepTime < 60000 THEN
       (* Normal operation - 10s to 60s *)
       Device.WriteCoil('RUNNING', TRUE);
   ELSE
       (* Extended operation - after 60s *)
       Device.Log('warning', 'Extended run time');
   END_IF;
   ```

4. **Logging/Monitoring:** Track state residence time
   ```
   Device.Log('info', 'State active for ' + stepTime + ' milliseconds');
   (* Or convert to seconds for display *)
   Device.Log('info', 'Active for ' + (stepTime / 1000.0) + ' seconds');
   ```

### Multiple Transitions (Branching)

Create complex state machines with multiple exit paths from each state:

**Priority Evaluation:**
- Transitions are evaluated in **priority order** (lowest number first)
- First matching condition causes the transition
- Remaining transitions are not evaluated

**Example State Machine:**
```
ELSIF state = STATE_RUNNING THEN
   (* Actions *)
   (* Q:N *) Device.WriteCoil('RUN', TRUE);
   
   (* Multiple possible next states *)
   IF error_detected THEN 
       state := STATE_ERROR;        (* Priority 1 *)
   END_IF;
   
   IF stepTime > 300000 THEN 
       state := STATE_MAINTENANCE;  (* Priority 2 - 5 min timeout *)
   END_IF;
   
   IF stop_requested THEN 
       state := STATE_STOPPING;     (* Priority 3 *)
   END_IF;
   
   IF cycle_complete THEN 
       state := STATE_IDLE;         (* Priority 4 *)
   END_IF;
END_IF;
```

### Transition Management

**Reordering Transitions:**
- Use up/down arrow buttons to change evaluation order
- Affects which condition is checked first
- Critical for overlapping conditions

**Normalizing Priorities:**
- Click "Normalize" button
- Auto-assigns sequential priorities (1, 2, 3, ...)
- Useful after reordering or adding/deleting transitions

**Deleting Transitions:**
- Hover over transition condition box
- Click trash icon
- Requires confirmation
- Cannot be undone (use version control!)

### Syntax Reference
The code editor displays a syntax reference at the bottom:
- **Operators:** `:=`, `=`, `<>`, `<`, `>`, `AND`, `OR`, `NOT`
- **Types:** `BOOL`, `INT`, `REAL`
- **Control:** `IF...THEN...ELSIF...END_IF`, `FOR...DO...END_FOR`
- **Functions:** `Device.ReadInput()`, `Device.WriteCoil()`, `Device.Log()`
- **Special Variables:** 
  - `stepTime` - Time in current state in **milliseconds** (e.g., 5000 = 5 seconds)
  - `STATE_NAME.stepTime` - Access time of currently active state by name
  - `state` - Current state value (integer)

### Line Numbers
- Automatically displayed on the left side of the code editor
- Synchronized scrolling with code content
- Updates as you add or remove lines
- Helps with debugging and code navigation

### Character & Line Count
- Displayed at the bottom of the code editor
- Useful for tracking code complexity
- Helps ensure actions stay focused and concise

## Recent Updates (v3.0)

### ✅ Per-Action Qualifiers (NEW!)
- **Each action** can now have its own qualifier (P1, N, P0, S, R, etc.)
- **P1 actions** execute once on step entry (rising edge)
- **N actions** execute every cycle (normal operation)
- **P0 actions** execute once on step exit (falling edge)
- Automatic execution control: P1 wrapped in stepTime check, P0 wrapped in transition check
- Enables complex control patterns: init → process → cleanup
- Follows IEC 61131-3 SFC standard behavior

### ✅ Fixed Code Editor Layout
- Proper flex container sizing
- No more overlapping buttons or input areas
- Line numbers scroll in sync with code
- Improved spacing and padding
- Modal uses fixed positioning for better overlay

### ✅ Multiple Transition Criteria
- Add unlimited transitions from each step
- Delete transitions with trash icon
- Each transition has its own priority
- Normalize priorities with one click
- Visual indicators for transition targets

### ✅ Step Time Tracking
- Automatic `stepTime` variable in all scopes
- Tracks time since state entry in **milliseconds**
- Available in actions and transition conditions
- Resets automatically on state change
- Access as `stepTime` or `STATE_NAME.stepTime`
- Useful for timeouts and delayed actions (e.g., `IF stepTime > 30000` for 30 seconds)

---

**Happy Coding! 🚀**

For more information, see the main README.md and DEBUG_FEATURE.md files.
