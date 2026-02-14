
export const GENERATOR_LOGIC_SCRIPT = `(*
   GeneratorController - adapted for SubstationScoutAI simulation runtime
   Notes: converted TON/CASE/TIME to integer timers and IF/ELSIF so it runs in
   the in-browser ST -> JS translator used by SimulationEngine.
*)

VAR
  (* Configuration Constants *)
  VOLTAGE_EPSILON       : REAL := 10.0;
  FREQUENCY_EPSILON     : REAL := 0.1;
  POWER_EPSILON         : REAL := 10.0;

  DeExcitedVoltage      : REAL := 3500.0;
  ExcitedVoltage        : REAL := 10500.0;
  NominalFrequency      : REAL := 50.0;
  NominalPower          : REAL := 3500.0;
  NominalReactivePower  : REAL := 2100.0;

  RampRateVoltage       : REAL := 10000.0; (* V/s equivalent when scaled by DT *)
  RampRateFrequency     : REAL := 200.0;   (* Hz/s *)
  RampRatePowerUp       : REAL := 10000.0; (* kW/s *)
  RampRatePowerDown     : REAL := 10000.0; (* kW/s *)

  StartDelayMs          : INT := 100;      (* ms *)
  StopDelayMs           : INT := 100;      (* ms *)
  DeadBusWindowMs       : INT := 3000;     (* ms *)
  CycleInterval         : INT := 100;      (* ms - matches engine tick used for generators *)

  (* State Ids *)
  STATE_STANDSTILL      : INT := 0;
  STATE_STARTING        : INT := 1;
  STATE_RUNNING         : INT := 2;
  STATE_SHUTDOWN        : INT := 3;
  STATE_FAULT           : INT := 4;
  STATE_FAST_TRANSFER   : INT := 5;

  (* Internal state *)
  CurrentState          : INT := 0;
  LastProcessedState    : INT := -1;

  (* Timers implemented as ms counters (increment by CycleInterval) *)
  StartTimerElapsedMs   : INT := 0;
  StopTimerElapsedMs    : INT := 0;
  DeadBusWindowElapsedMs: INT := 0;

  (* Simulation physics/state *)
  rVoltage              : REAL := 0.0; (* desired setpoint *)
  SimulatedVoltage      : REAL := 0.0; (* analog output R78 *)
  SimulatedFrequency    : REAL := 0.0; (* analog output R76 (x100) *)
  SimulatedCurrent      : REAL := 0.0; (* R77 *)
  SimulatedActivePower  : REAL := 0.0; (* R129 kW *)
  SimulatedReactivePower: REAL := 0.0; (* R130 kVAr *)

  (* Command registers read *)
  r95                   : INT := 0;    (* holding register 95 *)
  r192                  : INT := 0;    (* holding register 192 *)

  (* Parsed command bits *)
  SimulateFailToStart   : BOOL := FALSE;
  FailRampUp            : BOOL := FALSE;
  FailRampDown          : BOOL := FALSE;
  FailStartTime         : BOOL := FALSE;
  ResetFaultCmd         : BOOL := FALSE;

  SSL701_DemandModule_CMD          : BOOL := FALSE;
  SSL703_MainsCBClosed_CMD         : BOOL := FALSE;
  SSL704_EnGenBreakerActToDeadBus_CMD : BOOL := FALSE;
  SSL705_LoadRejectGenCBOpen_CMD   : BOOL := FALSE;
  SSL709_GenExcitationOff_CMD      : BOOL := FALSE;
  SSL710_OthGCBClosedandExcitOn_CMD : BOOL := FALSE;

  (* SSL Status flags (internal) - select subset used by UI/register packing *)
  SSL429_GenCBClosed     : BOOL := FALSE;
  SSL430_GenCBOpen       : BOOL := TRUE;
  SSL431_OperOn          : BOOL := FALSE;
  SSL432_OperOff         : BOOL := TRUE;
  SSL443_EngineInStartingPhase : BOOL := FALSE;
  SSL444_ReadyforAutoDem : BOOL := TRUE;
  SSL447_unused          : BOOL := FALSE;
  SSL448_ModuleisDemanded: BOOL := FALSE;
  SSL547_GenDeexcited    : BOOL := FALSE;
  SSL550_GenSyncLoadReleas: BOOL := FALSE;
  SSL592_EngineAtStandStill : BOOL := TRUE;

  (* Helpers/flags *)
  VoltageInRange        : BOOL := FALSE;
  FrequencyInRange      : BOOL := FALSE;
  BusIsLive             : BOOL := FALSE;
  PhaseAngleOK          : BOOL := TRUE;
  PowerBelow10Percent   : BOOL := FALSE;
  FaultDetected         : BOOL := FALSE;

  (* Temporary counters *)
  CycleCount            : UDINT := 0;
  timer_seq             : INT := 0; (* used for sequences requiring ms accumulation *)

  (* Register packing helpers *)
  r14                   : INT := 0;
  r15                   : INT := 0;
  r29                   : INT := 0;
  r31                   : INT := 0;
END_VAR

(* ----------------------------- *)
(* Main execution - runs every CycleInterval *)
(* ----------------------------- *)

CycleCount := CycleCount + 1;

(* Read inputs *)
r95 := Device.ReadRegister('95');
r192 := Device.ReadRegister('192');

SimulateFailToStart := (r95 AND 1) > 0;
FailRampUp := (r95 AND 2) > 0;
FailRampDown := (r95 AND 4) > 0;
FailStartTime := (r95 AND 8) > 0;
ResetFaultCmd := (r95 AND 16) > 0;

SSL701_DemandModule_CMD := (r192 AND 1) > 0;
SSL703_MainsCBClosed_CMD := (r192 AND 4) > 0;
SSL704_EnGenBreakerActToDeadBus_CMD := (r192 AND 8) > 0;
SSL705_LoadRejectGenCBOpen_CMD := (r192 AND 16) > 0;
SSL709_GenExcitationOff_CMD := (r192 AND 256) > 0;
SSL710_OthGCBClosedandExcitOn_CMD := (r192 AND 512) > 0;

(* Fault reset *)
IF ResetFaultCmd AND FaultDetected THEN
  FaultDetected := FALSE;
  Device.Log('info', 'Fault cleared (reset command)');
END_IF;

(* Validate mutually exclusive service modes simplified: ensure defaults *)
IF SSL592_EngineAtStandStill THEN
  SSL449_OperEngineisRunning := FALSE;
  SSL443_EngineInStartingPhase := FALSE;
END_IF;

(* ----------------------------- *)
(* State machine (IF/ELSIF style)
   - adapted from provided IEC ST, timers implemented as ms counters
*)
(* ----------------------------- *)

(* Update simple timers used in decisions *)
IF SSL710_OthGCBClosedandExcitOn_CMD THEN
  DeadBusWindowElapsedMs := 0; (* start window on command rising elsewhere in app *)
END_IF;

(* Advance sequence timer for START/STOP sequences *)
timer_seq := timer_seq + CycleInterval;

(* State transitions and actions *)
IF FaultDetected AND (CurrentState <> STATE_FAULT) THEN
  CurrentState := STATE_FAULT;
END_IF;

IF CurrentState = STATE_STANDSTILL THEN
  (* Entry actions *)
  IF LastProcessedState <> STATE_STANDSTILL THEN
    SimulatedVoltage := 0.0;
    SimulatedFrequency := 0.0;
    SimulatedCurrent := 0.0;
    SimulatedActivePower := 0.0;
    SimulatedReactivePower := 0.0;
    rVoltage := 0.0;
    SSL429_GenCBClosed := FALSE;
    SSL430_GenCBOpen := TRUE;
    SSL431_OperOn := FALSE;
    SSL432_OperOff := TRUE;
    SSL444_ReadyforAutoDem := TRUE;
    SSL448_ModuleisDemanded := FALSE;
    SSL547_GenDeexcited := FALSE;
    SSL592_EngineAtStandStill := TRUE;
    LastProcessedState := STATE_STANDSTILL;
  END_IF;

  IF SSL701_DemandModule_CMD THEN
    CurrentState := STATE_STARTING;
    timer_seq := 0;
  END_IF;

ELSIF CurrentState = STATE_STARTING THEN
  IF LastProcessedState <> STATE_STARTING THEN
    StartTimerElapsedMs := 0;
    SSL431_OperOn := TRUE;
    SSL432_OperOff := FALSE;
    SSL448_ModuleisDemanded := TRUE;
    SSL592_EngineAtStandStill := FALSE;
    SSL443_EngineInStartingPhase := TRUE;
    LastProcessedState := STATE_STARTING;
  END_IF;

  (* emulate start timer via timer_seq *)
  StartTimerElapsedMs := StartTimerElapsedMs + CycleInterval;

  (* If demand removed -> shutdown *)
  IF NOT SSL701_DemandModule_CMD THEN
    CurrentState := STATE_SHUTDOWN;
  ELSE
    VoltageInRange := ABS(SimulatedVoltage - rVoltage) < VOLTAGE_EPSILON;
    FrequencyInRange := ABS(SimulatedFrequency - NominalFrequency) < FREQUENCY_EPSILON;

    IF (StartTimerElapsedMs >= StartDelayMs OR FailStartTime) AND VoltageInRange AND FrequencyInRange THEN
      IF SimulateFailToStart THEN
        (* block start; stay in STARTING *)
      ELSE
        BusIsLive := SSL710_OthGCBClosedandExcitOn_CMD;
        IF SSL709_GenExcitationOff_CMD THEN
          SSL448_ModuleisDemanded := TRUE;
          SSL547_GenDeexcited := TRUE;
          SSL550_GenSyncLoadReleas := TRUE;
        END_IF;

            (* PRI: 10 *) IF SSL704_EnGenBreakerActToDeadBus_CMD AND NOT BusIsLive AND SSL430_GenCBOpen THEN
          SSL429_GenCBClosed := TRUE;
          SSL430_GenCBOpen := FALSE;
          SSL431_OperOn := TRUE;
          SSL432_OperOff := FALSE;
          CurrentState := STATE_RUNNING;
        (* PRI: 20 *) ELSIF BusIsLive AND NOT SSL709_GenExcitationOff_CMD AND SSL430_GenCBOpen THEN
          SSL441_SyncGenActivated := TRUE;
          SSL547_GenDeexcited := FALSE;
          SSL3630_ReleaseLoadAfterGenExcit := TRUE;
          IF PhaseAngleOK THEN
            SSL429_GenCBClosed := TRUE;
            SSL430_GenCBOpen := FALSE;
            SSL431_OperOn := TRUE;
            SSL432_OperOff := FALSE;
            CurrentState := STATE_RUNNING;
          END_IF;
        END_IF;
      END_IF;
    END_IF;
  END_IF;

ELSIF CurrentState = STATE_RUNNING THEN
  IF LastProcessedState <> STATE_RUNNING THEN
    SSL550_GenSyncLoadReleas := TRUE;
    SSL547_GenDeexcited := TRUE;
    SSL448_ModuleisDemanded := TRUE;
    SSL444_ReadyforAutoDem := FALSE;
    SSL449_OperEngineisRunning := TRUE;
    SSL592_EngineAtStandStill := FALSE;
    SSL443_EngineInStartingPhase := FALSE;
    LastProcessedState := STATE_RUNNING;
  END_IF;

  IF SSL705_LoadRejectGenCBOpen_CMD THEN
    CurrentState := STATE_FAST_TRANSFER;
  ELSIF NOT SSL701_DemandModule_CMD THEN
    CurrentState := STATE_SHUTDOWN;
  END_IF;

  IF SSL703_MainsCBClosed_CMD AND SSL430_GenCBOpen THEN
    VoltageInRange := ABS(SimulatedVoltage - ExcitedVoltage) < VOLTAGE_EPSILON;
    FrequencyInRange := ABS(SimulatedFrequency - NominalFrequency) < FREQUENCY_EPSILON;
    IF VoltageInRange AND FrequencyInRange THEN
      SSL429_GenCBClosed := TRUE;
      SSL430_GenCBOpen := FALSE;
    END_IF;
  END_IF;

ELSIF CurrentState = STATE_SHUTDOWN THEN
  IF LastProcessedState <> STATE_SHUTDOWN THEN
    StopTimerElapsedMs := 0;
    SSL448_ModuleisDemanded := FALSE;
    LastProcessedState := STATE_SHUTDOWN;
  END_IF;

  StopTimerElapsedMs := StopTimerElapsedMs + CycleInterval;

  PowerBelow10Percent := SimulatedActivePower < (NominalPower * 0.1);
  IF PowerBelow10Percent AND SSL429_GenCBClosed THEN
    SSL429_GenCBClosed := FALSE;
    SSL430_GenCBOpen := TRUE;
    SSL448_ModuleisDemanded := FALSE;
    SSL431_OperOn := FALSE;
    SSL432_OperOff := TRUE;
  END_IF;

  IsPowerZero := ABS(SimulatedActivePower) < POWER_EPSILON;
  (* PRI: 10 *) IF IsPowerZero AND (StopTimerElapsedMs >= StopDelayMs) THEN
    CurrentState := STATE_STANDSTILL;
  END_IF;

  (* PRI: 20 *) IF FaultDetected THEN
    CurrentState := STATE_FAULT;
  END_IF;

ELSIF CurrentState = STATE_FAULT THEN
  IF LastProcessedState <> STATE_FAULT THEN
    SimulatedVoltage := 0.0;
    SimulatedFrequency := 0.0;
    SimulatedCurrent := 0.0;
    SimulatedActivePower := 0.0;
    SimulatedReactivePower := 0.0;
    rVoltage := 0.0;
    SSL429_GenCBClosed := FALSE;
    SSL430_GenCBOpen := TRUE;
    SSL449_OperEngineisRunning := FALSE;
    LastProcessedState := STATE_FAULT;
  END_IF;

  (* PRI: 10 *) IF NOT FaultDetected THEN
    CurrentState := STATE_STANDSTILL;
  END_IF;

  (* PRI: 20 *) IF NOT SSL701_DemandModule_CMD THEN
    CurrentState := STATE_SHUTDOWN;
  END_IF;

ELSIF CurrentState = STATE_FAST_TRANSFER THEN
  IF LastProcessedState <> STATE_FAST_TRANSFER THEN
    SSL429_GenCBClosed := FALSE;
    SSL430_GenCBOpen := TRUE;
    SimulatedFrequency := NominalFrequency;
    SimulatedVoltage := ExcitedVoltage;
    SimulatedActivePower := 0.0;
    SimulatedReactivePower := 0.0;
    LastProcessedState := STATE_FAST_TRANSFER;
  END_IF;

  IF SSL429_GenCBClosed THEN
    SSL429_GenCBClosed := FALSE;
    SSL430_GenCBOpen := TRUE;
  END_IF;

  IF NOT SSL705_LoadRejectGenCBOpen_CMD THEN
    SSL429_GenCBClosed := TRUE;
    SSL430_GenCBOpen := FALSE;
    CurrentState := STATE_RUNNING;
  ELSIF NOT SSL701_DemandModule_CMD THEN
    CurrentState := STATE_SHUTDOWN;
  ELSIF FaultDetected THEN
    CurrentState := STATE_FAULT;
  END_IF;

END_IF;

(* ----------------------------- *)
(* Update dynamics / ramping *)
(* ----------------------------- *)

(* Determine rVoltage setpoint by state *)
IF CurrentState = STATE_STANDSTILL OR CurrentState = STATE_FAULT THEN
  rVoltage := 0.0;
ELSIF CurrentState = STATE_STARTING THEN
  IF SSL547_GenDeexcited THEN
    rVoltage := DeExcitedVoltage;
  ELSE
    IF (ABS(SimulatedVoltage - DeExcitedVoltage) < VOLTAGE_EPSILON) OR (SimulatedVoltage > DeExcitedVoltage) THEN
      rVoltage := ExcitedVoltage;
    ELSE
      rVoltage := DeExcitedVoltage;
    END_IF;
  END_IF;
ELSIF CurrentState = STATE_RUNNING THEN
  IF SSL547_GenDeexcited THEN rVoltage := DeExcitedVoltage; ELSE rVoltage := ExcitedVoltage; END_IF;
ELSIF CurrentState = STATE_SHUTDOWN THEN
  rVoltage := 0.0;
ELSIF CurrentState = STATE_FAST_TRANSFER THEN
  rVoltage := ExcitedVoltage;
ELSE
  rVoltage := 0.0;
END_IF;

(* Ramp voltage toward rVoltage (respecting FailRampUp) *)
IF NOT FailRampUp THEN
  Delta := rVoltage - SimulatedVoltage;
  MaxStep := RampRateVoltage * (CycleInterval / 1000.0);
  IF Delta > MaxStep THEN SimulatedVoltage := SimulatedVoltage + MaxStep;
  ELSIF Delta < -MaxStep THEN SimulatedVoltage := SimulatedVoltage - MaxStep;
  ELSE SimulatedVoltage := rVoltage; END_IF;
  IF SimulatedVoltage < 0.0 THEN SimulatedVoltage := 0.0; ELSIF SimulatedVoltage > ExcitedVoltage THEN SimulatedVoltage := ExcitedVoltage; END_IF;
END_IF;

(* Frequency ramping - simplified *)
IF CurrentState = STATE_STARTING OR CurrentState = STATE_RUNNING OR CurrentState = STATE_FAST_TRANSFER THEN
  NewValue := NominalFrequency;
ELSE
  NewValue := 0.0;
END_IF;
IF NOT FailRampUp THEN
  Delta := NewValue - SimulatedFrequency;
  MaxStep := RampRateFrequency * (CycleInterval / 1000.0);
  IF Delta > MaxStep THEN SimulatedFrequency := SimulatedFrequency + MaxStep;
  ELSIF Delta < -MaxStep THEN SimulatedFrequency := SimulatedFrequency - MaxStep;
  ELSE SimulatedFrequency := NewValue; END_IF;
  IF SimulatedFrequency < 0.0 THEN SimulatedFrequency := 0.0; ELSIF SimulatedFrequency > (NominalFrequency * 1.1) THEN SimulatedFrequency := NominalFrequency * 1.1; END_IF;
END_IF;
IF CurrentState = STATE_STANDSTILL OR CurrentState = STATE_FAULT THEN SimulatedFrequency := 0.0; END_IF;

(* Active power setpoint & ramping *)
IF (CurrentState = STATE_RUNNING) AND SSL429_GenCBClosed THEN NewValue := rSetpointPower ELSE NewValue := 0.0; END_IF;
IF (SimulatedActivePower > NewValue) AND (NewValue = 0.0) THEN CurrentRampRate := RampRatePowerDown; FailRampFlag := FailRampDown;
ELSIF CurrentState = STATE_SHUTDOWN THEN CurrentRampRate := RampRatePowerDown; FailRampFlag := FailRampDown;
ELSE CurrentRampRate := RampRatePowerUp; FailRampFlag := FailRampUp; END_IF;
IF NOT FailRampFlag THEN
  Delta := NewValue - SimulatedActivePower;
  MaxStep := CurrentRampRate * (CycleInterval / 1000.0);
  IF Delta > MaxStep THEN SimulatedActivePower := SimulatedActivePower + MaxStep; ELSIF Delta < -MaxStep THEN SimulatedActivePower := SimulatedActivePower - MaxStep; ELSE SimulatedActivePower := NewValue; END_IF;
  IF SimulatedActivePower < 0.0 THEN SimulatedActivePower := 0.0; ELSIF SimulatedActivePower > NominalPower THEN SimulatedActivePower := NominalPower; END_IF;
END_IF;
IF (SSL430_GenCBOpen AND (CurrentState <> STATE_STARTING)) OR (CurrentState = STATE_STANDSTILL) OR (CurrentState = STATE_FAULT) THEN SimulatedActivePower := 0.0; END_IF;

(* Reactive power ramping (mirror active power logic) *)
IF (CurrentState = STATE_RUNNING) AND SSL429_GenCBClosed THEN NewValue := rSetpointReactivePower ELSE NewValue := 0.0; END_IF;
IF (SimulatedReactivePower > NewValue) AND (NewValue = 0.0) THEN CurrentRampRate := RampRatePowerDown; FailRampFlag := FailRampDown;
ELSIF CurrentState = STATE_SHUTDOWN THEN CurrentRampRate := RampRatePowerDown; FailRampFlag := FailRampDown;
ELSE CurrentRampRate := RampRatePowerUp; FailRampFlag := FailRampUp; END_IF;
IF NOT FailRampFlag THEN
  Delta := NewValue - SimulatedReactivePower;
  MaxStep := CurrentRampRate * (CycleInterval / 1000.0);
  IF Delta > MaxStep THEN SimulatedReactivePower := SimulatedReactivePower + MaxStep; ELSIF Delta < -MaxStep THEN SimulatedReactivePower := SimulatedReactivePower - MaxStep; ELSE SimulatedReactivePower := NewValue; END_IF;
  IF SimulatedReactivePower < -NominalReactivePower THEN SimulatedReactivePower := -NominalReactivePower; ELSIF SimulatedReactivePower > NominalReactivePower THEN SimulatedReactivePower := NominalReactivePower; END_IF;
END_IF;
IF (SSL430_GenCBOpen AND (CurrentState <> STATE_STARTING)) OR (CurrentState = STATE_STANDSTILL) OR (CurrentState = STATE_FAULT) THEN SimulatedReactivePower := 0.0; END_IF;

(* Current calc *)
P_kW := SimulatedActivePower; Q_kVAr := SimulatedReactivePower; S_kVA := SQRT(P_kW * P_kW + Q_kVAr * Q_kVAr);
IF SimulatedVoltage > VOLTAGE_EPSILON THEN SimulatedCurrent := (S_kVA * 1000.0) / (SimulatedVoltage * 1.732); ELSE SimulatedCurrent := 0.0; END_IF;

(* Dead bus window: simple timer based on DeadBusWindowMs *)
IF (NOT SSL710_OthGCBClosedandExcitOn_CMD) AND SSL710_OthGCBClosedandExcitOn_CMD THEN DeadBusWindowElapsedMs := 0; END_IF; (* noop but placeholder - external signals control start *)
IF DeadBusWindowElapsedMs < DeadBusWindowMs THEN DeadBusWindowElapsedMs := DeadBusWindowElapsedMs + CycleInterval; END_IF;
IF DeadBusWindowElapsedMs >= DeadBusWindowMs THEN (* expired *) END_IF;

(* ----------------------------- *)
(* Pack output registers *)
(* ----------------------------- *)
Device.WriteRegister('78', TO_INT(SimulatedVoltage));
Device.WriteRegister('76', TO_INT(SimulatedFrequency * 100.0));
Device.WriteRegister('129', TO_INT(SimulatedActivePower));
Device.WriteRegister('130', TO_INT(SimulatedReactivePower));
Device.WriteRegister('77', TO_INT(SimulatedCurrent));

(* Status words *)
r14 := 0;
IF CurrentState = STATE_STANDSTILL THEN r14 := r14 OR 1; END_IF;
r14 := r14 OR 4; (* Auto *)
IF SSL429_GenCBClosed THEN r14 := r14 OR 16; ELSE r14 := r14 OR 32; END_IF;
IF CurrentState = STATE_RUNNING OR CurrentState = STATE_FAST_TRANSFER THEN r14 := r14 OR 256; END_IF;
IF CurrentState = STATE_FAULT THEN r14 := r14 OR 2048; END_IF;
Device.WriteRegister('14', r14);

r15 := 0;
IF CurrentState = STATE_STARTING THEN r15 := r15 OR 4; END_IF;
IF SSL444_ReadyforAutoDem THEN r15 := r15 OR 8; END_IF;
IF SimulatedCurrent > 0.0 THEN r15 := r15 OR 256; END_IF;
Device.WriteRegister('15', r15);

r31 := 0;
IF CurrentState = STATE_STANDSTILL THEN r31 := 1; END_IF;
IF CurrentState = STATE_STARTING THEN r31 := 2; END_IF;
IF CurrentState = STATE_RUNNING AND NOT SSL429_GenCBClosed THEN r31 := 3; END_IF;
IF CurrentState = STATE_RUNNING AND SSL429_GenCBClosed THEN r31 := 4; END_IF;
IF CurrentState = STATE_SHUTDOWN AND SSL429_GenCBClosed THEN r31 := 5; END_IF;
IF CurrentState = STATE_SHUTDOWN AND NOT SSL429_GenCBClosed THEN r31 := 6; END_IF;
IF CurrentState = STATE_FAULT THEN r31 := 7; END_IF;
Device.WriteRegister('31', r31);

r29 := 0;
IF FaultDetected THEN r29 := r29 OR 1; END_IF;
Device.WriteRegister('29', r29);
`;