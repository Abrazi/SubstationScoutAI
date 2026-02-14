
export const GENERATOR_LOGIC_SCRIPT = `(* 
   Generator Controller Simulation 
   Standard: IEC 61131-3 Structured Text (ST) 
   State Machine: Standstill -> Pre-Lube -> Cranking -> Running -> Cooldown -> Stop
*)

(* --- Variable Declaration Block --- *)
VAR
  (* State Constants *)
  STATE_STANDSTILL : INT := 0;
  STATE_STARTING   : INT := 1;
  STATE_RUNNING    : INT := 2;
  STATE_SHUTDOWN   : INT := 3;
  STATE_FAULT      : INT := 4;
  STATE_FAST_TRANSFER : INT := 5;

  (* Physics Constants *)
  NOMINAL_VOLT     : REAL := 10500.0;
  NOMINAL_FREQ     : REAL := 50.0;
  NOMINAL_RPM      : REAL := 1500.0;
  NOMINAL_POWER    : REAL := 3500.0;
  NOMINAL_REACTIVE : REAL := 2100.0;

  (* Ramp Rates *)
  RAMP_RPM_START : REAL := 50.0;
  RAMP_RPM_RUN   : REAL := 100.0;
  RAMP_V         : REAL := 200.0;
  RAMP_P         : REAL := 50.0;
  RAMP_Q         : REAL := 30.0;
  DT             : INT  := 100; (* ms *)
END_VAR

(* --- Initialization --- *)
IF state = undefined THEN
  state := STATE_STANDSTILL;
  
  (* Physics State *)
  rpm := 0.0;
  voltage := 0.0;
  frequency := 0.0;
  power := 0.0;
  reactive := 0.0;
  current := 0.0;
  
  (* Mechanical State *)
  oil_pressure := 0.0;
  coolant_temp := 25.0;
  
  (* Timers *)
  timer_seq := 0;
  
  (* Flags *)
  flg_GcbClosed := FALSE;
  flg_Ready := TRUE;
  flg_Alarm := FALSE;
  flg_Excitation := FALSE;
END_IF;

(* --- Inputs Mapping --- *)
(* Read Word 192 and mask bits *)
r192 := Device.ReadRegister('192');
cmd_Start   := (r192 AND 1) > 0;
cmd_DeadBus := (r192 AND 8) > 0;
cmd_LoadRej := (r192 AND 16) > 0;
cmd_BusLive := (r192 AND 512) > 0;

r95 := Device.ReadRegister('95');
sim_FailStart := (r95 AND 1) > 0;
sim_Reset     := (r95 AND 16) > 0;

(* --- Physics Simulation --- *)
frequency := (rpm / NOMINAL_RPM) * NOMINAL_FREQ;

(* Oil Pressure Logic *)
IF rpm > 100.0 THEN
    IF oil_pressure < 5.0 THEN 
        oil_pressure := oil_pressure + 0.5; 
    END_IF;
ELSE
    IF oil_pressure > 0.0 THEN 
        oil_pressure := oil_pressure - 0.1; 
    END_IF;
END_IF;

(* Temperature Logic *)
target_temp := 25.0;
IF rpm > 100.0 THEN 
    target_temp := 85.0 + (power / NOMINAL_POWER) * 15.0; 
END_IF;

IF coolant_temp < target_temp THEN 
    coolant_temp := coolant_temp + 0.05; 
END_IF;
IF coolant_temp > target_temp THEN 
    coolant_temp := coolant_temp - 0.02; 
END_IF;


(* --- State Machine --- *)

IF state = STATE_FAULT THEN
    (* 1. FAULT STATE *)
    flg_GcbClosed := FALSE;
    flg_Excitation := FALSE;
    
    (* Coast Down *)
    IF rpm > 0.0 THEN rpm := rpm - RAMP_RPM_RUN; END_IF;
    IF rpm < 0.0 THEN rpm := 0.0; END_IF;
    
    (* Voltage Decay *)
    IF voltage > 0.0 THEN voltage := voltage - 500.0; END_IF;
    IF voltage < 0.0 THEN voltage := 0.0; END_IF;
    
    power := 0.0;
    reactive := 0.0;

    IF sim_Reset THEN
        state := STATE_STANDSTILL;
        flg_Alarm := FALSE;
        Device.Log('info', 'Fault Reset. Ready to Start.');
    END_IF;

ELSIF state = STATE_STANDSTILL THEN
    (* 2. STANDSTILL *)
    rpm := 0.0;
    voltage := 0.0;
    power := 0.0;
    timer_seq := 0;
    flg_GcbClosed := FALSE;
    
    IF cmd_Start AND NOT flg_Alarm THEN
        state := STATE_STARTING;
        timer_seq := 0;
        Device.Log('info', 'Sequence Initiated: Pre-Lube...');
    END_IF;

ELSIF state = STATE_STARTING THEN
    (* 3. STARTING SEQUENCE *)
    timer_seq := timer_seq + DT;
    
    (* A. Pre-Lube (0-2s) *)
    IF timer_seq < 2000 THEN
       IF sim_FailStart AND timer_seq > 1500 THEN
           state := STATE_FAULT;
           flg_Alarm := TRUE;
           Device.Log('error', 'Start Fail: Pre-lube timeout');
       END_IF;
    
    (* B. Cranking (2-4s) *)
    ELSIF timer_seq < 4000 THEN
       IF rpm < 300.0 THEN 
           rpm := rpm + RAMP_RPM_START; 
       END_IF;
    
    (* C. Firing & Run-up (4s+) *)
    ELSE
       IF rpm < NOMINAL_RPM THEN 
           rpm := rpm + RAMP_RPM_RUN; 
       END_IF;
       IF rpm > NOMINAL_RPM THEN 
           rpm := NOMINAL_RPM; 
       END_IF;
       
       (* Excitation Logic *)
       IF rpm > (NOMINAL_RPM * 0.9) THEN
           flg_Excitation := TRUE;
       END_IF;
       
       IF flg_Excitation THEN
           IF voltage < NOMINAL_VOLT THEN 
               voltage := voltage + RAMP_V; 
           END_IF;
           IF voltage > NOMINAL_VOLT THEN 
               voltage := NOMINAL_VOLT; 
           END_IF;
       END_IF;
       
       (* Ready for Load? *)
       IF voltage >= (NOMINAL_VOLT * 0.98) AND frequency >= (NOMINAL_FREQ * 0.98) THEN
            (* Sync Check *)
            can_close := FALSE;
            
            IF cmd_DeadBus THEN 
                can_close := TRUE; 
            END_IF;
            
            IF cmd_BusLive THEN
                (* Wait for Sync *)
                IF timer_seq > 8000 THEN 
                    can_close := TRUE; 
                END_IF;
            ELSE
                can_close := TRUE; (* Island Mode *)
            END_IF;
            
            IF can_close THEN
                state := STATE_RUNNING;
                flg_GcbClosed := TRUE;
                Device.Log('success', 'Synchronized. GCB Closed.');
            END_IF;
       END_IF;
    END_IF;
    
    IF NOT cmd_Start THEN 
        state := STATE_SHUTDOWN; 
        timer_seq := 0; 
    END_IF;

ELSIF state = STATE_RUNNING THEN
    (* 4. RUNNING *)
    rpm := NOMINAL_RPM;
    voltage := NOMINAL_VOLT;

    (* Load Ramping *)
    IF power < NOMINAL_POWER THEN 
        power := power + RAMP_P; 
    END_IF;
    IF reactive < NOMINAL_REACTIVE THEN 
        reactive := reactive + RAMP_Q; 
    END_IF;
    
    (* Limits *)
    IF power > NOMINAL_POWER THEN 
        power := NOMINAL_POWER; 
    END_IF;
    IF reactive > NOMINAL_REACTIVE THEN 
        reactive := NOMINAL_REACTIVE; 
    END_IF;

    (* Load Rejection *)
    IF cmd_LoadRej THEN
        state := STATE_FAST_TRANSFER;
        flg_GcbClosed := FALSE;
        power := 0.0;
        reactive := 0.0;
        Device.Log('warning', 'Load Rejection! Breaker Trip.');
    END_IF;
    
    IF NOT cmd_Start THEN 
        state := STATE_SHUTDOWN; 
        timer_seq := 0;
        Device.Log('info', 'Stop received. Unloading...');
    END_IF;

ELSIF state = STATE_SHUTDOWN THEN
    (* 5. SHUTDOWN *)
    timer_seq := timer_seq + DT;

    (* A. Soft Unload *)
    IF power > 0.0 THEN 
        power := power - RAMP_P; 
        IF power < 0.0 THEN power := 0.0; END_IF;
    END_IF;
    
    (* Open Breaker at low load *)
    IF power < (NOMINAL_POWER * 0.05) AND flg_GcbClosed THEN
        flg_GcbClosed := FALSE;
        Device.Log('info', 'Breaker Open. Entering Cooldown.');
        timer_seq := 0;
    END_IF;
    
    (* B. Cooldown *)
    IF NOT flg_GcbClosed THEN
        power := 0.0;
        reactive := 0.0;
        
        IF timer_seq > 5000 THEN
            (* C. Stop *)
            flg_Excitation := FALSE;
            voltage := voltage - 500.0;
            rpm := rpm - RAMP_RPM_RUN;
            
            IF rpm <= 0.0 THEN
                rpm := 0.0;
                voltage := 0.0;
                state := STATE_STANDSTILL;
                Device.Log('info', 'Engine Stopped.');
            END_IF;
        END_IF;
    END_IF;
    
    IF cmd_Start AND NOT flg_Alarm THEN 
        state := STATE_STARTING; 
    END_IF;

ELSIF state = STATE_FAST_TRANSFER THEN
    (* 6. FAST TRANSFER (Island) *)
    rpm := NOMINAL_RPM;
    voltage := NOMINAL_VOLT;
    power := 0.0;
    
    IF NOT cmd_LoadRej AND cmd_Start THEN
        state := STATE_STARTING;
        Device.Log('info', 'Load Rejection Reset. Resyncing.');
    END_IF;
    
    IF NOT cmd_Start THEN 
        state := STATE_SHUTDOWN; 
    END_IF;
END_IF;

(* --- Calculations --- *)
IF voltage > 100.0 THEN
    (* Apparent Power S = SQRT(P^2 + Q^2) *)
    s_mag := SQRT((power * power) + (reactive * reactive));
    current := (s_mag * 1000.0) / (voltage * 1.732);
ELSE
    current := 0.0;
END_IF;

(* --- Write Output Registers --- *)

(* Analog Values (Convert REAL to INT) *)
Device.WriteRegister('78', TO_INT(voltage));
Device.WriteRegister('76', TO_INT(frequency * 100.0));
Device.WriteRegister('129', TO_INT(power));
Device.WriteRegister('130', TO_INT(reactive));
Device.WriteRegister('77', TO_INT(current));

(* R14: Status Word 1 *)
r14 := 0;
IF state = STATE_STANDSTILL THEN r14 := r14 OR 1; END_IF;
r14 := r14 OR 4; (* Auto *)
IF flg_GcbClosed THEN 
    r14 := r14 OR 16; 
ELSE 
    r14 := r14 OR 32; 
END_IF;

IF state = STATE_RUNNING OR state = STATE_FAST_TRANSFER THEN 
    r14 := r14 OR 256; 
END_IF;

IF state = STATE_FAULT THEN 
    r14 := r14 OR 2048; 
END_IF;
Device.WriteRegister('14', r14);

(* R15: Status Word 2 *)
r15 := 0;
IF state = STATE_STARTING THEN r15 := r15 OR 4; END_IF;
IF flg_Ready THEN r15 := r15 OR 8; END_IF;
IF rpm > 100.0 THEN r15 := r15 OR 256; END_IF;
Device.WriteRegister('15', r15);

(* R31: Engine Status Enum *)
r31 := 0;
IF state = STATE_STANDSTILL THEN r31 := 1; END_IF;
IF state = STATE_STARTING THEN r31 := 2; END_IF;
IF state = STATE_RUNNING AND NOT flg_GcbClosed THEN r31 := 3; END_IF;
IF state = STATE_RUNNING AND flg_GcbClosed THEN r31 := 4; END_IF;
IF state = STATE_SHUTDOWN AND flg_GcbClosed THEN r31 := 5; END_IF;
IF state = STATE_SHUTDOWN AND NOT flg_GcbClosed THEN r31 := 6; END_IF;
IF state = STATE_FAULT THEN r31 := 7; END_IF;
Device.WriteRegister('31', r31);

(* R29: Alarms *)
r29 := 0;
IF flg_Alarm THEN r29 := r29 OR 1; END_IF;
Device.WriteRegister('29', r29);
`;