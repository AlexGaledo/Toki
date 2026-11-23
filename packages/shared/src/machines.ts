import { z } from 'zod';

/** What the owner allows on a machine. `always` never removes the sign-in approval or the PC's own prompt. */
export const MACHINE_POLICIES = ['never', 'ask', 'always'] as const;
export type MachinePolicy = (typeof MACHINE_POLICIES)[number];
export const DEFAULT_MACHINE_POLICY: MachinePolicy = 'ask';

export const VPS_MACHINE_ID = 'vps';
export const PC_MACHINE_ID = 'pc';

export interface MachineInfo {
  id: string;
  label: string;
  kind: 'own' | 'pc';
  online: boolean;
  paired: boolean;
  policy: MachinePolicy;
}

export const MachinePolicyInputSchema = z.object({ policy: z.enum(MACHINE_POLICIES) });
export type MachinePolicyInput = z.infer<typeof MachinePolicyInputSchema>;
