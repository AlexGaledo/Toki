---------------------------- MODULE CutOff ----------------------------
(* One bot's request in a room, from first run until it is finished, handed to the coordinator, or stopped.
   Mirrors RoomRouter.afterCutOff and BotRunner's rotation (packages/hub/src/rooms/RoomRouter.ts,
   packages/hub/src/agent/BotRunner.ts, services/SessionRotation.ts). Run: node scripts/formal.mjs (CutOffBroken.cfg is the pre-#227 always-fresh retry; it must fail) *)
EXTENDS Naturals

CONSTANTS Retries,      \* CUTOFF_RETRIES
          AlwaysFresh   \* TRUE = the pre-#227 behaviour (every retry starts a fresh session); must fail NoLostContext

VARIABLES phase,        \* "running" | "cut" | "done" | "coordinator" | "stopped" | "silent"
          tries,        \* cut-offs counted for this request (RoomRouter.cutOffs)
          cutBy,        \* "none" | "steps" | "tokens": what stopped the last run
          large,        \* the session's context is past ROTATE_CONTEXT_TOKENS (or never measured)
          session,      \* "same" | "fresh": how the last retry started
          noted,        \* the room got a note about the last cut-off
          routine,      \* the request is a routine run (ownerRef): left to its schedule
          member,       \* the bot is still in the room
          hasCoord,     \* the room has a coordinator other than this bot
          wasLarge      \* the context was large when the last retry started

vars == <<phase, tries, cutBy, large, session, noted, routine, member, hasCoord, wasLarge>>

Init == /\ phase = "running" /\ tries = 0 /\ cutBy = "none" /\ session = "same" /\ noted = FALSE
        /\ large \in BOOLEAN /\ routine \in BOOLEAN /\ member = TRUE /\ hasCoord \in BOOLEAN /\ wasLarge = FALSE

Grow     == phase = "running" /\ ~large /\ large' = TRUE /\ UNCHANGED <<phase, tries, cutBy, session, noted, routine, member, hasCoord, wasLarge>>
Leave    == member /\ phase \in {"running", "cut"} /\ member' = FALSE /\ UNCHANGED <<phase, tries, cutBy, large, session, noted, routine, hasCoord, wasLarge>>
Finish   == phase = "running" /\ phase' = "done" /\ UNCHANGED <<tries, cutBy, large, session, noted, routine, member, hasCoord, wasLarge>>
Cut(k)   == phase = "running" /\ phase' = "cut" /\ cutBy' = k /\ noted' = FALSE
            /\ UNCHANGED <<tries, large, session, routine, member, hasCoord, wasLarge>>

\* afterCutOff: routine runs and bots no longer in the room end without a note, by design.
Quiet    == phase = "cut" /\ (routine \/ ~member) /\ phase' = "silent" /\ UNCHANGED <<tries, cutBy, large, session, noted, routine, member, hasCoord, wasLarge>>

Fresh    == AlwaysFresh \/ cutBy = "tokens" \/ large
Retry    == phase = "cut" /\ ~routine /\ member /\ tries + 1 <= Retries
            /\ tries' = tries + 1 /\ phase' = "running" /\ noted' = TRUE
            /\ session' = (IF Fresh THEN "fresh" ELSE "same")
            /\ large' = (IF Fresh THEN FALSE ELSE large)
            /\ wasLarge' = large
            /\ UNCHANGED <<cutBy, routine, member, hasCoord>>
GiveUp   == phase = "cut" /\ ~routine /\ member /\ tries + 1 > Retries
            /\ tries' = tries + 1 /\ noted' = TRUE
            /\ phase' = (IF hasCoord THEN "coordinator" ELSE "stopped")
            /\ UNCHANGED <<cutBy, large, session, routine, member, hasCoord, wasLarge>>

Next == Grow \/ Leave \/ Finish \/ Cut("steps") \/ Cut("tokens") \/ Quiet \/ Retry \/ GiveUp
        \/ (phase \in {"done", "coordinator", "stopped", "silent"} /\ UNCHANGED vars)

Spec == Init /\ [][Next]_vars /\ WF_vars(Finish \/ Cut("steps") \/ Cut("tokens")) /\ WF_vars(Quiet \/ Retry \/ GiveUp)

\* ---- What the owner was promised ----
Bounded       == tries <= Retries + 1
\* A retry starts a fresh session exactly when the token brake cut it or its context was large;
\* a step-limit cut of a normal-sized session keeps its context.
FreshOnlyWhenNeeded == (phase = "running" /\ tries > 0) => ((session = "fresh") <=> (cutBy = "tokens" \/ wasLarge))
\* Never just stops: a request that the owner started and the bot is still in ends with a note or a coordinator.
NeverSilent   == (phase \in {"stopped", "coordinator"}) => noted
Ends          == <>(phase \in {"done", "coordinator", "stopped", "silent"})
=============================================================================
