# Debug Feature for Logic Editor

## Overview
The Script Editor now includes a comprehensive debugging panel for troubleshooting IEC 61131-3 Structured Text logic.

## Features

### 1. **Debug Panel Toggle**
- Click the **"Debug"** button in the toolbar (bug icon) to show/hide the debug panel
- The panel slides in from the right side of the editor
- Can be toggled while execution is running or stopped

### 2. **Execution Control**
The toolbar provides debug controls:
- **Run All**: Start execution of all device scripts
- **Pause**: Pause execution at any point
- **Resume** (Play): Continue execution after pausing
- **Step Over**: Execute one line at a time (only when paused at a breakpoint)
- **Stop**: Stop all execution

### 3. **Breakpoints**
Set breakpoints to pause execution at specific lines:
- **Add breakpoint**: Click on any line number in the editor
- **Red dot** appears on lines with breakpoints
- When execution hits a breakpoint, it pauses automatically
- **Yellow highlight** shows the current line when paused
- **Auto-scroll**: Editor automatically scrolls to center the current line when paused or stepping

#### Breakpoints Panel Tab
- View all active breakpoints
- See line numbers and code preview
- Jump to breakpoint location in editor
- Remove individual breakpoints or clear all
- Breakpoints persist across runs until manually removed

### 4. **Variables Inspector**
The Variables tab shows all variables in the current scope:
- **Real-time values**: Updated during execution
- **Type-specific formatting**:
  - Booleans: Green (true) / Red (false)
  - Numbers: Blue
  - Strings: Gray
- **Sorted alphabetically** for easy navigation
- Hover to see full variable names and values

### 5. **Watch Expressions**
Monitor specific variables or expressions:
- Add custom watch expressions in the Watch tab
- Enter variable names (e.g., `CurrentState`, `timer_seq`)
- Support for scope notation (e.g., `scope.varName`)
- Real-time evaluation during execution
- Remove individual watches by clicking the × button
- Shows "not available" if variable doesn't exist

### 6. **Execution Status**
The debug panel always shows:
- **State**: STOPPED, RUNNING, or PAUSED
- **Active Device**: Which device is currently being debugged
- **Current Line**: Line number where execution is paused

## Usage Example

### Basic Debugging Session

1. **Set Breakpoints**
   ```
   - Click on line 150 where state transition occurs
   - Click on line 200 to check final values
   ```

2. **Start Execution**
   ```
   - Click "Run All" button
   - Execution starts and runs until first breakpoint
   ```

3. **Inspect Variables**
   ```
   - Open Debug Panel → Variables tab
   - Check values of STATE_STANDSTILL, CurrentState, etc.
   - Verify logic conditions are correct
   ```

4. **Step Through Code**
   ```
   - Click "Step Over" to execute one line
   - Watch variables update in real-time
   - Continue stepping or click "Resume" to run to next breakpoint
   ```

5. **Add Watch Expressions**
   ```
   - Switch to Watch tab
   - Add "SimulatedVoltage" to monitor sensor value
   - Add "FaultDetected" to track alarm state
   ```

6. **Stop Debugging**
   ```
   - Click "Stop" button when finished
   - All breakpoints remain for next session
   ```

## Keyboard Shortcuts (Future Enhancement)
- F9: Toggle breakpoint on current line
- F5: Resume execution
- F10: Step over
- Shift+F5: Stop

## Tips

### Debugging State Machines
- Set breakpoints on state transition lines
- Use Watch expressions for state variables
- Check that transitions fire correctly

### Monitoring Timers
- Watch timer variables (e.g., `StartTimerElapsedMs`)
- Step through timer increment logic
- Verify delay calculations

### Finding Logic Errors
- Set breakpoints before conditional statements
- Inspect boolean variables to see which branch executes
- Use Step Over to follow execution flow

### Performance Debugging
- Check variable values at each cycle
- Monitor how often loops execute
- Verify cycle time stays within limits

### Auto-Scroll Behavior
- Editor automatically centers on the current line when:
  - Execution pauses at a breakpoint
  - You click "Step Over" to execute the next line
  - Any line becomes active during debugging
- Smooth scroll animation for better visual tracking
- Works in both Code and SFC views (Code view only for line tracking)
- Scroll is centered in the viewport for optimal visibility

## Debug Panel Layout

```
┌─────────────────────────────────────┐
│ 🐛 Debug Panel               [×]   │
├─────────────────────────────────────┤
│ Variables │ Breakpoints │ Watch    │
├─────────────────────────────────────┤
│                                     │
│  Execution Status:                  │
│  ├─ State: PAUSED                   │
│  ├─ Device: G1                      │
│  └─ Line: 152                       │
│                                     │
│  [Active Tab Content]               │
│  • Variables list                   │
│  • Breakpoints list                 │
│  • Watch expressions                │
│                                     │
├─────────────────────────────────────┤
│  [Resume]  [Step]    (Quick Actions)│
└─────────────────────────────────────┘
```

## Technical Details

### Variable Scope
- All ST variables are stored in `scope` object
- Variables shown are from the active device script
- Updates happen at each `yield` point in generator function

### Breakpoint Mechanism
- Line-by-line execution using JavaScript generators
- Each ST line is instrumented with `yield <lineNum>`
- Breakpoints checked before each line executes
- Pauses by setting engine to `isPaused` state

### Watch Expression Evaluation
- Evaluated against current `debugState.variables`
- Simple property lookup (no arbitrary code execution)
- Safe evaluation - errors shown as "error" in watch panel

## Troubleshooting

**Q: Variables show "not available"**
- Make sure execution is running
- Variable may not be initialized yet
- Check variable name spelling

**Q: Breakpoint doesn't pause**
- Verify device is selected in dropdown
- Check that line has executable code (not comment/blank)
- Ensure breakpoint is enabled (red dot visible)

**Q: Step Over button disabled**
- Only works when paused and the target device is active
- Click Pause first, then Step Over

**Q: Debug panel overlaps code**
- Panel auto-adjusts editor width
- Close panel to see full editor
- Resize browser window for more space
